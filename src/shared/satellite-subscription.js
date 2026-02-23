/**
 * Voice Satellite Card — Satellite Event Subscription
 *
 * Single WS subscription for satellite-pushed events (announcement,
 * start_conversation, ask_question).  Replaces per-manager entity
 * state subscriptions for notification features.
 *
 * Pattern follows entity-subscription.js: module-level state,
 * reconnect via the connection 'ready' event.
 */

import { isOwner } from './singleton.js';

let _unsubscribe = null;
let _subscribed = false;
let _reconnectListener = null;
let _card = null;
let _onEvent = null;
let _retryTimer = null;

const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000];
let _retryCount = 0;

/**
 * Subscribe to satellite events via voice_satellite/subscribe_events.
 * Idempotent — no-op if already subscribed.
 *
 * @param {object} card - Card instance
 * @param {(event: object) => void} onEvent - Called with {type, data}
 */
export function subscribeSatelliteEvents(card, onEvent) {
  const { config, connection } = card;
  if (!config.satellite_entity || !connection) return;
  if (!isOwner(card)) return;
  if (_subscribed) return;

  _card = card;
  _onEvent = onEvent;
  _subscribed = true;
  _doSubscribe(card, connection, onEvent);

  // Re-subscribe on HA reconnect
  if (!_reconnectListener) {
    _reconnectListener = () => {
      card.logger.log('satellite-sub', 'Connection reconnected — re-subscribing');
      _cleanup();
      const conn = card.connection;
      if (conn) {
        _subscribed = true;
        _doSubscribe(card, conn, onEvent);
      }
    };
    connection.addEventListener('ready', _reconnectListener);
  }
}

function _doSubscribe(card, connection, onEvent) {
  connection.subscribeMessage(
    (message) => onEvent(message),
    {
      type: 'voice_satellite/subscribe_events',
      entity_id: card.config.satellite_entity,
    },
  ).then((unsub) => {
    _unsubscribe = unsub;
    _retryCount = 0;
    card.logger.log('satellite-sub', `Subscribed to satellite events for ${card.config.satellite_entity}`);
  }).catch((err) => {
    card.logger.error('satellite-sub', `Failed to subscribe: ${err}`);
    _subscribed = false;
    _scheduleRetry(card, connection, onEvent);
  });
}

function _scheduleRetry(card, connection, onEvent) {
  if (_retryTimer) return;
  const delay = RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)];
  _retryCount++;
  card.logger.log('satellite-sub', `Retrying in ${delay / 1000}s (attempt ${_retryCount})`);
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (_subscribed) return; // subscribed while waiting
    const conn = card.connection;
    if (!conn) return;
    _subscribed = true;
    _doSubscribe(card, conn, onEvent);
  }, delay);
}

function _cleanup() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _retryCount = 0;
  if (_unsubscribe) {
    try { _unsubscribe(); } catch (_) { /* cleanup */ }
    _unsubscribe = null;
  }
  _subscribed = false;
}

/**
 * Tear down and re-establish the satellite subscription.
 * Called on tab visibility resume to recover from connections that went
 * stale while the tab was hidden (WebSocket may silently drop/reconnect).
 */
export function refreshSatelliteSubscription() {
  if (!_card || !_onEvent) return;
  _cleanup();
  subscribeSatelliteEvents(_card, _onEvent);
}

/**
 * Permanently tear down the satellite subscription and reconnect listener.
 * Called when the card is displaced by another browser.
 */
export function teardownSatelliteSubscription() {
  _cleanup();
  if (_reconnectListener && _card?.connection) {
    _card.connection.removeEventListener('ready', _reconnectListener);
    _reconnectListener = null;
  }
  _card = null;
  _onEvent = null;
}

