/**
 * Timer Events
 *
 * Processes satellite entity state changes to detect timer additions,
 * removals, and finished alerts.
 */

let _lastTimerJson = '';

/**
 * Reset the dedup state (called on destroy/reconnect).
 */
export function resetTimerDedup() {
  _lastTimerJson = '';
}

/**
 * @param {import('./index.js').TimerManager} mgr
 * @param {object} attrs - Entity attributes from state_changed event
 */
export function processStateChange(mgr, attrs) {
  let rawTimers = attrs.active_timers;
  const lastEvent = attrs.last_timer_event;

  if (!rawTimers || !Array.isArray(rawTimers)) {
    rawTimers = [];
  }

  const rawJson = JSON.stringify(rawTimers);
  if (rawJson === _lastTimerJson) return;

  mgr.log.log('timer', `State changed: timers=${rawJson} last_event=${lastEvent}`);
  _lastTimerJson = rawJson;

  // Detect which timers were removed
  const newIds = rawTimers.map((t) => t.id);
  const removedIds = mgr.knownTimerIds.filter((id) => !newIds.includes(id));

  // If timers were removed and the last event was "finished", show alert
  if (removedIds.length > 0 && lastEvent === 'finished') {
    mgr.log.log('timer', `Timer(s) finished: ${removedIds.join(', ')}`);
    if (!mgr.alertActive) {
      mgr.showAlert();
    }
  }

  // Remove pills for removed timers
  for (const id of removedIds) {
    mgr.removePill(id);
  }

  mgr.knownTimerIds = newIds;

  // Sync remaining/new timers
  mgr.syncTimers(rawTimers);
}
