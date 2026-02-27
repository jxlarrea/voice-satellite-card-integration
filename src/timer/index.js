/**
 * Voice Satellite Card  -  TimerManager
 *
 * Watches the satellite entity's active_timers attribute and renders
 * countdown pill overlays.
 *
 * Timer lifecycle:
 * 1. HA state_changed -> active_timers gets new entry -> pill appears
 * 2. Local 1s tick counts down -> pill updates in-place
 * 3. HA state_changed -> active_timers entry removed + last_timer_event
 *    - "finished" -> show alert (blur + chime + 0:00 display)
 *    - "cancelled" -> silently remove pill
 * 4. Alert dismissed by double-tap or auto-dismiss timeout
 */

import { subscribeToEntity, unsubscribeEntity } from '../shared/entity-subscription.js';
import { processStateChange, resetTimerDedup } from './events.js';
import { sendCancelTimer } from './comms.js';
import {
  removeContainer,
  removePill, syncDOM, tick, showAlert, clearAlert,
} from './ui.js';

export class TimerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    /** @type {Array<object>} Active timer objects */
    this._timers = [];
    this._tickInterval = null;
    this._container = null;
    this._unsubscribe = null;
    this._subscribed = false;
    this._reconnectListener = null;

    /** @type {string[]} Track timer IDs to detect removals */
    this._knownTimerIds = [];

    // Alert state
    this._alertActive = false;
    this._alertEl = null;
  }

  // --- Public API ---

  update() {
    if (this._subscribed) return;

    const { config, connection } = this._card;
    if (!config.satellite_entity || !connection) return;

    subscribeToEntity(
      this, connection, config.satellite_entity,
      (attrs) => this.processStateChange(attrs),
      'timer',
    );
  }

  get card() { return this._card; }
  get log() { return this._log; }
  get timers() { return this._timers; }
  set timers(val) { this._timers = val; }
  get knownTimerIds() { return this._knownTimerIds; }
  set knownTimerIds(val) { this._knownTimerIds = val; }
  get alertActive() { return this._alertActive; }
  set alertActive(val) { this._alertActive = val; }

  dismissAlert() {
    this._card.tts.playChime('done');
    this.clearAlert();
  }

  destroy() {
    this.stopTick();
    removeContainer(this);
    this.clearAlert();
    this._timers = [];
    this._knownTimerIds = [];
    resetTimerDedup();
    unsubscribeEntity(this);
  }

  // --- State Processing (delegated) ---

  processStateChange(attrs) {
    processStateChange(this, attrs);
  }

  // --- Timer Sync ---

  /**
   * @param {Array<object>} rawTimers - active_timers array from entity attributes
   */
  syncTimers(rawTimers) {
    if (rawTimers.length === 0) {
      this._timers = [];
      this.stopTick();
      removeContainer(this);
      return;
    }

    const now = Date.now();
    const newTimers = [];

    for (const raw of rawTimers) {
      const existing = this._timers.find((t) => t.id === raw.id);

      // Use server-side started_at (epoch seconds) to compute correct start
      const serverStartedAt = raw.started_at ? raw.started_at * 1000 : now;

      if (existing) {
        if (existing.totalSeconds !== raw.total_seconds) {
          existing.totalSeconds = raw.total_seconds;
          existing.startedAt = serverStartedAt;
          const elapsed = Math.max(0, Math.floor((now - serverStartedAt) / 1000));
          existing.secondsLeft = Math.max(0, raw.total_seconds - elapsed);
          existing.startHours = raw.start_hours || 0;
          existing.startMinutes = raw.start_minutes || 0;
          existing.startSeconds = raw.start_seconds || 0;
        }
        newTimers.push(existing);
      } else {
        const elapsed = Math.max(0, Math.floor((now - serverStartedAt) / 1000));
        newTimers.push({
          id: raw.id,
          name: raw.name || '',
          totalSeconds: raw.total_seconds,
          secondsLeft: Math.max(0, raw.total_seconds - elapsed),
          startedAt: serverStartedAt,
          startHours: raw.start_hours || 0,
          startMinutes: raw.start_minutes || 0,
          startSeconds: raw.start_seconds || 0,
          el: null,
        });
      }
    }

    this._timers = newTimers;
    this.startTick();
    syncDOM(this);
  }

  // --- Tick Control ---

  startTick() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => tick(this), 1000);
  }

  stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  // --- UI Delegation ---

  showAlert() { showAlert(this); }
  clearAlert() { clearAlert(this); }
  removePill(timerId) { removePill(this, timerId); }

  // --- Cancel Timer ---

  cancelTimer(timerId) {
    this._log.log('timer', `Cancelling timer: ${timerId}`);

    sendCancelTimer(this._card, timerId);
    this._card.tts.playChime('done');

    // Remove pill with animation immediately for responsive UI
    removePill(this, timerId);

    // Remove from tracked timers
    const timerIdx = this._timers.findIndex((t) => t.id === timerId);
    if (timerIdx !== -1) this._timers.splice(timerIdx, 1);

    // Remove from known IDs so we don't trigger alert on next state change
    const knownIdx = this._knownTimerIds.indexOf(timerId);
    if (knownIdx !== -1) this._knownTimerIds.splice(knownIdx, 1);

    // Update raw JSON cache to match
    resetTimerDedup();

    if (this._timers.length === 0) {
      this.stopTick();
      setTimeout(() => {
        if (this._timers.length === 0) removeContainer(this);
      }, 500);
    }
  }
}
