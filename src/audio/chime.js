/**
 * Chime Utility
 *
 * Plays pre-rendered sound files from /voice_satellite/sounds/.
 * Each chime is pre-cached as an Audio element on first use for
 * instant playback with no synthesis overhead.
 *
 * Routing rules when TTS output is a remote media_player:
 *   - Announcement mode (default): chime fires on the remote via
 *     media_player.play_media with announce=true, matching the TTS
 *     path so both ride the speaker's announce-mode handling.
 *   - Normal Playback mode: chime also fires on the remote, but with
 *     announce=false. TtsManager.playChime captures a snapshot of the
 *     remote BEFORE this fires and schedules a deferred restore that
 *     runs after the last activity in the interaction (typically the
 *     done chime), so the user's prior music can be resumed even on
 *     speakers that don't honor the announce flag.
 */

import { buildMediaUrl } from './media-playback.js';
import { getSelectState } from '../shared/satellite-state.js';
import { supportsNativeSound, playNativeSound, prefetchNativeSound } from '../kiosk/index.js';

const SOUNDS_BASE = '/voice_satellite/sounds';

/** Chime definitions.
 *
 *  Only the URL is canonical.  The `duration` field is a conservative
 *  fallback used before the browser has loaded the MP3's metadata -
 *  callers that schedule a post-chime unmute should prefer
 *  `getChimeDuration(chime)` which returns the real file length read
 *  off the cached Audio element's `duration` property.
 *
 *  Why it matters: users can drop their own chime files into
 *  `/config/voice_satellite/sounds/` and the integration (see
 *  `_sync_custom_sounds()` in __init__.py) copies them over the
 *  built-in ones at startup.  Those custom files can be any length.
 *  A hardcoded duration would under-declare them, re-arming the mic
 *  mid-chime and bleeding audio into STT.
 */
export const CHIME_WAKE = { url: `${SOUNDS_BASE}/wake.mp3`, duration: 0.29 };
export const CHIME_DONE = { url: `${SOUNDS_BASE}/done.mp3`, duration: 0.29 };
export const CHIME_ERROR = { url: `${SOUNDS_BASE}/error.mp3`, duration: 0.19 };
export const CHIME_ALERT = { url: `${SOUNDS_BASE}/alert.mp3`, duration: 0.63 };
export const CHIME_ANNOUNCE_URL = `${SOUNDS_BASE}/announce.mp3`;

/** Cache of preloaded Audio elements keyed by URL */
const _audioCache = new Map();
/** URLs whose preload/load errored. Kept so runtime retries can report
 *  the original failure and we don't re-fire a toast per chime. */
const _failedUrls = new Set();

/**
 * Get or create a cached Audio element for the given URL.
 * The element is preloaded on first access.
 */
function getCachedAudio(url) {
  const fullUrl = buildMediaUrl(url);
  let audio = _audioCache.get(fullUrl);
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.src = fullUrl;
    _audioCache.set(fullUrl, audio);
  }
  return audio;
}

/**
 * Preload the most latency-sensitive chime sounds (wake + done) so the
 * first play has zero fetch delay. Other chimes (error, alert, announce)
 * are rare or preceded by network calls and load lazily on first use.
 *
 * Accepts the session so an individual chime fetch failure can be
 * surfaced via the toast manager. Wrapped in best-effort error handling
 * so a broken toast manager never breaks engine bootstrap.
 */
export function preloadChimes(session) {
  for (const chime of [CHIME_WAKE, CHIME_DONE]) {
    // Native host: warm the app-side cache too, so the first delegated
    // chime plays with zero fetch delay. The browser Audio elements below
    // still preload - they are the fallback path.
    if (supportsNativeSound()) {
      prefetchNativeSound(buildMediaUrl(chime.url));
    }
    const audio = getCachedAudio(chime.url);
    audio.addEventListener('error', () => {
      const fullUrl = buildMediaUrl(chime.url);
      if (_failedUrls.has(fullUrl)) return;
      _failedUrls.add(fullUrl);
      try {
        session?.toast?.show({
          id: 'audio.chime-preload-failed',
          severity: 'warn',
          category: 'Sounds',
          description: 'One or more chime sounds could not be loaded from the server. Interaction sounds may not play.',
        });
      } catch (_) { /* best-effort */ }
    }, { once: true });
  }
}

/**
 * Runtime-overridden durations keyed by filename (e.g. `wake.mp3`).
 * Populated by the client from a server-provided manifest probed in the
 * Python integration after it syncs user-supplied sound files into the
 * integration dir (see `_sync_custom_sounds()` in __init__.py).  Falls
 * back to the hardcoded `chime.duration` when no entry is present
 * (fresh install, manifest fetch failed, etc.).
 */
const _durationOverrides = new Map();

export function setChimeDurationOverrides(map) {
  _durationOverrides.clear();
  if (!map) return;
  for (const [filename, seconds] of Object.entries(map)) {
    if (Number.isFinite(seconds) && seconds > 0) {
      _durationOverrides.set(filename, seconds);
    }
  }
}

/**
 * Return the chime's duration in seconds.  Prefers the server-probed
 * override (accurate for user-supplied custom sound files); falls back
 * to the hardcoded declared value.
 *
 * @param {{ url: string, duration: number }} chime
 * @returns {number} duration in seconds
 */
export function getChimeDuration(chime) {
  if (!chime || !chime.url) return 0;
  const filename = chime.url.split('/').pop();
  const override = _durationOverrides.get(filename);
  if (override !== undefined) return override;
  return chime.duration ?? 0;
}

/**
 * Play a chime on a remote media player via media_player.play_media.
 * Fire-and-forget - errors are logged but don't block.
 */
function playChimeRemote(card, url, log, { announce = true } = {}) {
  const entityId = card.ttsTarget;
  if (!entityId || !card.hass) return;
  const fullUrl = buildMediaUrl(url);
  log?.log('chime', `Playing chime on remote: ${entityId} announce=${announce}`);
  card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: fullUrl,
    media_content_type: 'music',
    announce,
  }).catch((e) => {
    log?.error('chime', `Remote chime failed: ${e?.message || e}`);
  });
}

/**
 * Play a chime sound file. Routes to the remote media player when
 * TTS output is configured, with `announce` matching the remote TTS
 * mode (true for 'announcement', false for 'normal_playback'). For
 * 'normal_playback', TtsManager.playChime has already captured the
 * remote's pre-chime media state so the deferred restore can put it
 * back after the interaction.
 *
 * Reuses the cached Audio element directly (no cloneNode) to avoid
 * orphaned HTTP connections that exhaust the browser's connection pool.
 *
 * @param {object} card - Card/session instance
 * @param {object} chime - Chime definition with `url` and `duration`
 * @param {object} [log] - Logger instance
 */
export function playChime(card, chime, log) {
  try {
    if (card.ttsTarget) {
      const mode = getSelectState(
        card.hass,
        card.config?.satellite_entity,
        'tts_output_mode_remote',
        'announcement',
      );
      playChimeRemote(card, chime.url, log, { announce: mode !== 'normal_playback' });
      return;
    }
    const volume = card.mediaPlayer.volume;
    const playBrowser = () => {
      const audio = getCachedAudio(chime.url);
      audio.currentTime = 0;
      audio.volume = volume;
      audio.play().catch((e) => {
        log?.error('chime', `Chime play error: ${e}`);
      });
    };
    // Kiosk Satellite host: hand playback to the app, which honors the
    // user's speaker selection and has no autoplay gate. All timing stays
    // duration-based exactly as for browser audio, so nothing downstream
    // changes. A refusal (old app, fetch failure) falls back to the
    // browser element, which preloadChimes kept warm.
    if (supportsNativeSound()) {
      playNativeSound(buildMediaUrl(chime.url), volume, { cache: true })
        .then((ok) => { if (!ok) playBrowser(); })
        .catch(playBrowser);
      return;
    }
    playBrowser();
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
  }
}
