/** Timer UI bridge: pills, ticking, and finished-alert lifecycle. */

import { playChime, CHIME_ALERT } from '../audio/chime.js';

let _chimeInterval = null;
// Screensaver keepalive: while the alert is on screen we ping the
// in-app idle timer (notifyActivity) AND Fully Kiosk's native screensaver
// every 4 s so neither covers the alert UI before the user sees it.
// Same cadence the media-player overlays use for video/image playback.
let _screensaverKeepaliveTimer = null;
const SCREENSAVER_KEEPALIVE_MS = 4000;
import { BlurReason, Timing } from '../constants.js';

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

  // Play chime immediately then loop
  playAlertChime(mgr);
  if (_chimeInterval) clearInterval(_chimeInterval);
  _chimeInterval = setInterval(() => playAlertChime(mgr), Timing.TIMER_CHIME_INTERVAL);
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

  // Stop chime loop
  if (_chimeInterval) {
    clearInterval(_chimeInterval);
    _chimeInterval = null;
  }

  mgr.card.ui.clearTimerAlert();
  mgr.card.ui.hideBlurOverlay(BlurReason.TIMER);

  // Only tear down pills/container if no timers remain active
  if (mgr.timers.length === 0) {
    mgr.stopTick();
    removeContainer(mgr);
  }

  mgr.log.log('timer', 'Alert dismissed');
}

/** @param {import('./index.js').TimerManager} mgr */
function playAlertChime(mgr) {
  playChime(mgr.card, CHIME_ALERT, mgr.log);
  mgr.log.log('timer', 'Alert chime played');
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
  }
}

/** @param {import('./index.js').TimerManager} mgr */
function pingScreensaver(mgr) {
  mgr.card.screensaver?.notifyActivity?.();
  if (typeof window !== 'undefined' && window.fully
      && typeof window.fully.stopScreensaver === 'function') {
    try { window.fully.stopScreensaver(); } catch (_e) { /* best-effort */ }
  }
}
