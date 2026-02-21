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
    card.logger.log('satellite-sub', `Subscribed to satellite events for ${card.config.satellite_entity}`);
  }).catch((err) => {
    card.logger.error('satellite-sub', `Failed to subscribe: ${err}`);
    _subscribed = false;
  });
}

function _cleanup() {
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

