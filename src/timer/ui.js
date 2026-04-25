/** Timer UI bridge: pills, ticking, and finished-alert lifecycle. */

import { playChime, CHIME_ALERT } from '../audio/chime.js';

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

  mgr.card.wakeWord?.disableStopModel();

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
  playChime(mgr.card, CHIME_ALERT, mgr.log);
  mgr.log.log('timer', 'Alert chime played');
}
