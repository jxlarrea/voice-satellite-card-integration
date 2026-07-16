/** Timer UI bridge: pills, ticking, and finished-alert lifecycle. */

import { playChime, CHIME_ALERT, getChimeDuration } from '../audio/chime.js';
import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';
import { playRemote, stopRemote } from '../tts/comms.js';
import { getSelectState } from '../shared/satellite-state.js';
import { BlurReason, DEFAULT_CONFIG, Timing } from '../constants.js';
import * as kiosk from '../kiosk/index.js';

let _alertLoopTimer = null;
let _alertLoopToken = null;
let _timerTtsPromise = null;
let _timerTtsAudio = null;
let _timerTtsRemoteTimer = null;
let _timerTtsRemoteActive = false;
// Screensaver keepalive: while the alert is on screen we ping the
// in-app idle timer (notifyActivity) AND the kiosk browser's native
// screensaver every 4 s so neither covers the alert UI before the user sees it.
// Same cadence the media-player overlays use for video/image playback.
let _screensaverKeepaliveTimer = null;
const SCREENSAVER_KEEPALIVE_MS = 4000;
const TIMER_NAME_TOKEN = '%%TIMER_NAME%%';
const TIMER_TTS_SYNTH_TIMEOUT_MS = 15000;
const TIMER_TTS_REMOTE_FALLBACK_MS = 2500;
const TIMER_TTS_REMOTE_PAD_MS = 750;
const TIMER_TTS_TO_CHIME_DELAY_MS = 500;

/** @param {import('./index.js').TimerManager} mgr */
export function removeContainer(mgr) {
  mgr.card.ui.removeTimerContainer();
}

/**
 * @param {import('./index.js').TimerManager} mgr
 * @param {string} timerId
 */
export function removePill(mgr, timerId) {
  mgr.card.ui.expireTimerPill(timerId, Timing.PILL_EXPIRE_ANIMATION);

  const timer = mgr.timers.find((t) => t.id === timerId);
  if (timer) timer.el = null;
}

/** @param {import('./index.js').TimerManager} mgr */
export function syncDOM(mgr) {
  if (mgr.card.config?.hide_timer_pills) {
    // Pills suppressed via the side-panel toggle. Tear down anything that
    // may already be on screen so flipping the flag mid-run hides existing
    // pills too. The countdown still ticks internally and the alert still
    // fires when timers finish.
    mgr.card.ui.removeTimerContainer();
    return;
  }
  mgr.card.ui.syncTimerPills(
    mgr.timers,
    (timerId) => () => mgr.cancelTimer(timerId),
  );
}

/** @param {import('./index.js').TimerManager} mgr */
export function tick(mgr) {
  const now = Date.now();

  for (const t of mgr.timers) {
    const elapsed = Math.max(0, Math.floor((now - t.startedAt) / 1000));
    const left = Math.max(0, t.totalSeconds - elapsed);
    t.secondsLeft = left;
  }

  if (mgr.card.config?.hide_timer_pills) {
    // Toggling the flag mid-run should hide existing pills, not just stop
    // updating them. Idempotent when no container exists.
    mgr.card.ui.removeTimerContainer();
    return;
  }
  mgr.card.ui.tickTimerPills(mgr.timers);
}

/**
 * @param {import('./index.js').TimerManager} mgr
 * @param {string[]} [names] - Names of timers that just finished, shown as
 *   the alert label.
 */
export function showAlert(mgr, names) {
  if (mgr.alertActive) {
    mgr.log.log('timer', 'Alert already active, skipping duplicate');
    return;
  }

  mgr.alertActive = true;
  mgr.log.log('timer', `Showing finished alert${names?.length ? `: ${names.join(', ')}` : ''}`);

  // Bring the app forward so a timer that fires while another app is in front
  // actually surfaces its alert (no-op when already foreground).
  kiosk.bringToFront();

  // Dismiss the in-app screensaver and keep both it and Fully Kiosk's
  // native one suppressed for the duration of the alert.  Otherwise the
  // chime fires unattended behind whichever screensaver re-activates on
  // its idle timeout.  Mirrors the media-player video/image keepalive.
  startScreensaverKeepalive(mgr);

  const wakeWord = mgr.card.wakeWord;
  if (wakeWord?.active && wakeWord._inference) {
    wakeWord.enableStopModel(false);
  }

  mgr.card.ui.showBlurOverlay(BlurReason.TIMER);

  const labelNames = mgr.card.config?.hide_timer_name_on_alert ? [] : names;
  mgr.card.ui.showTimerAlert(() => mgr.clearAlert(), labelNames);

  startAlertLoop(mgr, names);
}

/** @param {import('./index.js').TimerManager} mgr */
export function clearAlert(mgr) {
  if (!mgr.alertActive) return;
  mgr.alertActive = false;

  stopScreensaverKeepalive(mgr);
  mgr.card.wakeWord?.disableStopModel();
  // Re-arm stop word if media is playing in the background - disabling
  // above clears it for everyone.
  mgr.card.mediaPlayer?.refreshStopWord();

  stopAlertLoop(mgr);

  mgr.card.ui.clearTimerAlert();
  mgr.card.ui.hideBlurOverlay(BlurReason.TIMER);

  // Only tear down pills/container if no timers remain active
  if (mgr.timers.length === 0) {
    mgr.stopTick();
    removeContainer(mgr);
  }

  // Restore the user's pre-alert remote media in normal_playback mode.
  // No-op when no snapshot was captured (announcement mode, browser TTS,
  // or speaker was idle when the alert fired).
  mgr.card.tts?.scheduleRemoteRestoreIfNeeded(1);

  mgr.log.log('timer', 'Alert dismissed');
}

/** @param {import('./index.js').TimerManager} mgr */
function playAlertChime(mgr) {
  // In normal_playback mode, snapshot the remote before the chime fires
  // (chime.js writes to the remote via play_media with announce=false,
  // wiping any user music). Idempotent across loop iterations.
  mgr.card.tts?.ensureRemoteSnapshot();
  playChime(mgr.card, CHIME_ALERT, mgr.log);
  mgr.log.log('timer', 'Alert chime played');
}

/** @param {import('./index.js').TimerManager} mgr */
function startAlertLoop(mgr, names) {
  stopAlertLoop();

  const ttsText = buildTimerTtsText(mgr, names);
  if (!ttsText) {
    playAlertChime(mgr);
    _alertLoopTimer = setInterval(() => playAlertChime(mgr), Timing.TIMER_CHIME_INTERVAL);
    return;
  }

  const pipelineId = getTimerAlertPipelineId(mgr, names);
  _timerTtsPromise = synthesizeTimerTts(mgr, ttsText, pipelineId).catch((e) => {
    mgr.log.error('timer', `Timer TTS synthesis failed: ${e?.message || e}`);
    return null;
  });

  const token = Symbol('timer-alert-loop');
  _alertLoopToken = token;

  const run = async () => {
    if (!mgr.alertActive || _alertLoopToken !== token) return;

    playAlertChime(mgr);
    await waitWhileAlertActive(mgr, token, Timing.TIMER_CHIME_INTERVAL);
    if (!mgr.alertActive || _alertLoopToken !== token) return;

    playAlertChime(mgr);
    await waitWhileAlertActive(mgr, token, getChimeDuration(CHIME_ALERT) * 1000 + 250);

    if (mgr.alertActive && _alertLoopToken === token && _timerTtsPromise) {
      const media = await _timerTtsPromise;
      if (media) await playTimerTtsMedia(mgr, token, media);
    }

    if (!mgr.alertActive || _alertLoopToken !== token) return;
    await waitWhileAlertActive(mgr, token, TIMER_TTS_TO_CHIME_DELAY_MS);
    run();
  };

  run();
}

/** @param {import('./index.js').TimerManager} [mgr] */
function stopAlertLoop(mgr) {
  _alertLoopToken = null;
  _timerTtsPromise = null;

  if (_alertLoopTimer) {
    clearTimeout(_alertLoopTimer);
    clearInterval(_alertLoopTimer);
    _alertLoopTimer = null;
  }

  if (_timerTtsAudio) {
    try { _timerTtsAudio.pause(); } catch (_) { /* ignore */ }
    _timerTtsAudio = null;
  }

  if (_timerTtsRemoteTimer) {
    clearTimeout(_timerTtsRemoteTimer);
    _timerTtsRemoteTimer = null;
  }

  if (_timerTtsRemoteActive && mgr) {
    try { stopRemote(mgr.card); } catch (_) { /* best-effort */ }
  }
  _timerTtsRemoteActive = false;
}

function buildTimerTtsText(mgr, names) {
  if (mgr.card.config?.timer_tts_enabled !== true) return '';

  const cleanedNames = (names || [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);

  if (cleanedNames.length > 0) {
    const template = mgr.card.config.timer_named_tts_text
      || DEFAULT_CONFIG.timer_named_tts_text;
    const timerName = cleanedNames.join(', ');
    return template.replaceAll(TIMER_NAME_TOKEN, timerName).trim();
  }

  return (mgr.card.config.timer_tts_text || DEFAULT_CONFIG.timer_tts_text).trim();
}

function getTimerAlertPipelineId(mgr, names) {
  const cleanedNames = (names || [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
  const finished = mgr._lastFinishedTimers || [];
  const named = cleanedNames.length
    ? finished.find((t) => cleanedNames.includes((t.name || '').trim()))
    : null;
  return (named || finished[0] || {}).pipelineId || '';
}

async function synthesizeTimerTts(mgr, text, pipelineId) {
  const connection = mgr.card.connection;
  if (!connection || !text) return null;

  let unsubscribe = null;
  let timeoutId = null;

  return new Promise((resolve, reject) => {
    const done = (value, error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (unsubscribe) {
        try { unsubscribe().catch(() => {}); } catch (_) { /* ignore */ }
        unsubscribe = null;
      }
      if (error) reject(error);
      else resolve(value);
    };

    timeoutId = setTimeout(
      () => done(null, new Error('Timed out waiting for timer TTS')),
      TIMER_TTS_SYNTH_TIMEOUT_MS,
    );

    const message = {
      type: 'assist_pipeline/run',
      start_stage: 'tts',
      end_stage: 'tts',
      input: { text },
    };
    if (pipelineId) message.pipeline = pipelineId;

    connection.subscribeMessage((event) => {
      const eventType = event?.type;
      const data = event?.data || {};
      if (eventType === 'tts-end') {
        const output = data.tts_output || data;
        const url = output.url || output.url_path || '';
        if (!url) {
          done(null, new Error('Timer TTS finished without an audio URL'));
          return;
        }
        done({
          url,
          mediaId: output.media_id || '',
          text,
        });
      } else if (eventType === 'error') {
        done(null, new Error(data.message || data.code || 'Timer TTS failed'));
      } else if (eventType === 'run-end') {
        done(null, new Error('Timer TTS ended before audio was generated'));
      }
    }, message).then((unsub) => {
      unsubscribe = unsub;
      mgr.log.log('timer', `Timer TTS requested${pipelineId ? ` (pipeline=${pipelineId})` : ''}`);
    }).catch((e) => {
      done(null, e);
    });
  });
}

async function playTimerTtsMedia(mgr, token, media) {
  if (!media?.url || !mgr.alertActive || _alertLoopToken !== token) return;

  const card = mgr.card;
  const url = buildMediaUrl(media.url);
  card.mediaPlayer.notifyAudioStart('timer-tts');

  try {
    if (card.ttsTarget) {
      const durationMs = await getAudioDurationMs(url);
      // Match the chime path's mode-aware announce flag, and ensure the
      // pre-alert snapshot exists so clearAlert can restore the music.
      card.tts?.ensureRemoteSnapshot();
      const mode = getSelectState(
        card.hass,
        card.config?.satellite_entity,
        'tts_output_mode_remote',
        'announcement',
      );
      const announce = mode !== 'normal_playback';
      await playRemote(card, media.mediaId || url, { announce }).catch((e) => {
        mgr.log.error('timer', `Timer TTS remote playback failed: ${e?.message || e}`);
      });
      _timerTtsRemoteActive = true;
      await new Promise((resolve) => {
        _timerTtsRemoteTimer = setTimeout(() => {
          _timerTtsRemoteTimer = null;
          _timerTtsRemoteActive = false;
          resolve();
        }, (durationMs || estimateSpeechMs(media.text)) + TIMER_TTS_REMOTE_PAD_MS);
      });
      return;
    }

    await new Promise((resolve) => {
      _timerTtsAudio = playMediaUrl(url, card.mediaPlayer.volume, {
        onStart: () => mgr.log.log('timer', 'Timer TTS playback started'),
        onEnd: () => {
          _timerTtsAudio = null;
          resolve();
        },
        onError: (e) => {
          _timerTtsAudio = null;
          mgr.log.error('timer', `Timer TTS playback failed: ${e?.message || e}`);
          resolve();
        },
      });
    });
  } finally {
    card.mediaPlayer.notifyAudioEnd('timer-tts');
  }
}

function getAudioDurationMs(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      try { audio.load(); } catch (_) { /* ignore */ }
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(TIMER_TTS_REMOTE_FALLBACK_MS);
    }, 3000);
    audio.onloadedmetadata = () => {
      clearTimeout(timeout);
      const seconds = Number(audio.duration);
      cleanup();
      resolve(Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : TIMER_TTS_REMOTE_FALLBACK_MS);
    };
    audio.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(TIMER_TTS_REMOTE_FALLBACK_MS);
    };
    audio.preload = 'metadata';
    audio.src = url;
  });
}

function estimateSpeechMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return TIMER_TTS_REMOTE_FALLBACK_MS;
  return Math.max(TIMER_TTS_REMOTE_FALLBACK_MS, words * 420);
}

function waitWhileAlertActive(mgr, token, ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      if (!mgr.alertActive || _alertLoopToken !== token) {
        resolve();
        return;
      }
      resolve();
    }, ms);
  });
}

/**
 * Suppress both the in-app screensaver and Fully Kiosk's native one for
 * as long as the timer alert is up.  Pings every 4 s - same cadence the
 * media-player uses for video/image overlays.
 * @param {import('./index.js').TimerManager} mgr
 */
function startScreensaverKeepalive(mgr) {
  stopScreensaverKeepalive(mgr);
  pingScreensaver(mgr);
  _screensaverKeepaliveTimer = setInterval(
    () => pingScreensaver(mgr),
    SCREENSAVER_KEEPALIVE_MS,
  );
}

/** @param {import('./index.js').TimerManager} _mgr */
function stopScreensaverKeepalive(_mgr) {
  if (_screensaverKeepaliveTimer) {
    clearInterval(_screensaverKeepaliveTimer);
    _screensaverKeepaliveTimer = null;
    // Re-enable the kiosk screensaver if we paused it (Kiosker only;
    // no-op on Fully Kiosk).
    kiosk.releaseScreensaver();
  }
}

/** @param {import('./index.js').TimerManager} mgr */
function pingScreensaver(mgr) {
  mgr.card.screensaver?.notifyActivity?.();
  // Suppress the kiosk browser's own screensaver (FK one-shot stop /
  // Kiosker pause) so it can't cover the timer-alert UI.
  kiosk.stopScreensaver();
}
