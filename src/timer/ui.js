/** Timer UI bridge: pills, ticking, and finished-alert lifecycle. */

import { playMultiNoteChime, CHIME_ALERT } from '../audio/chime.js';

let _chimeInterval = null;
let _dismissTimeout = null;
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

    mgr.card.ui.updateTimerPill(t.el, left, t.totalSeconds);
  }
}

/** @param {import('./index.js').TimerManager} mgr */
export function showAlert(mgr) {
  if (mgr.alertActive) {
    mgr.log.log('timer', 'Alert already active, skipping duplicate');
    return;
  }

  mgr.alertActive = true;
  mgr.log.log('timer', 'Showing finished alert');

  mgr.card.ui.showBlurOverlay(BlurReason.TIMER);

  mgr.card.ui.showTimerAlert(() => mgr.clearAlert());

  // Play chime immediately then loop
  playAlertChime(mgr);
  if (_chimeInterval) clearInterval(_chimeInterval);
  _chimeInterval = setInterval(() => playAlertChime(mgr), Timing.TIMER_CHIME_INTERVAL);

  // Auto-dismiss after 60 seconds
  const duration = 60;
  if (duration > 0) {
    if (_dismissTimeout) clearTimeout(_dismissTimeout);
    _dismissTimeout = setTimeout(() => mgr.clearAlert(), duration * 1000);
  }
}

/** @param {import('./index.js').TimerManager} mgr */
export function clearAlert(mgr) {
  if (!mgr.alertActive) return;
  mgr.alertActive = false;

  // Stop chime loop
  if (_chimeInterval) {
    clearInterval(_chimeInterval);
    _chimeInterval = null;
  }

  // Cancel auto-dismiss
  if (_dismissTimeout) {
    clearTimeout(_dismissTimeout);
    _dismissTimeout = null;
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
  playMultiNoteChime(mgr.card, CHIME_ALERT, { log: mgr.log });
  mgr.log.log('timer', 'Alert chime played');
}
