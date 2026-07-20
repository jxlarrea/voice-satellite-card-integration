/**
 * Satellite Event Subscription
 *
 * Single WS subscription for satellite-pushed events (announcement,
 * start_conversation, ask_question).  Replaces per-manager entity
 * state subscriptions for notification features.
 *
 * Module-level state. Normal socket reconnects are handled by
 * home-assistant-js-websocket, which replays active subscriptions onto the new
 * socket — so there is NO manual 'ready' re-subscribe here (that stacked a
 * second subscription on top of the replay, leaking one per reconnect). The
 * two recovery paths that haws replay does NOT cover are kept: the integration
 * 'reload' message (server tears the subscription down; see _scheduleRetry) and
 * a stale socket that dropped silently while the tab was hidden (see
 * refreshSatelliteSubscription).
 */

import { teardownVisibilityListener } from './satellite-notification.js';

let _unsubscribe = null;
let _subscribed = false;
let _card = null;
let _onEvent = null;
let _retryTimer = null;

const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000];
let _retryCount = 0;

/**
 * Subscribe to satellite events via voice_satellite/subscribe_events.
 * Idempotent - no-op if already subscribed.
 *
 * @param {object} card - Card instance
 * @param {(event: object) => void} onEvent - Called with {type, data}
 */
export function subscribeSatelliteEvents(card, onEvent) {
  const { config, connection } = card;
  if (!config.satellite_entity || !connection) return;
  if (_subscribed) return;

  _card = card;
  _onEvent = onEvent;
  _subscribed = true;
  _doSubscribe(card, connection, onEvent);
  // No 'ready' re-subscribe: haws replays this subscription on reconnect.
}

function _doSubscribe(card, connection, onEvent) {
  connection.subscribeMessage(
    (message) => {
      // Integration reload: entity is being torn down, re-subscribe after delay
      if (message.type === 'reload') {
        card.logger.log('satellite-sub', 'Integration reloading - will re-subscribe');
        _cleanup();
        _scheduleRetry(card, connection, onEvent);
        // Also restart the pipeline (its subscription is now dead too)
        if (card.pipeline) {
          card.pipeline.restart(RETRY_DELAYS[0]);
        }
        return;
      }
      onEvent(message);
    },
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
    try { _unsubscribe().catch(() => {}); } catch (_) { /* cleanup */ }
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
 * Permanently tear down the satellite subscription.
 * Called when the card is displaced by another browser.
 */
export function teardownSatelliteSubscription() {
  _cleanup();
  _card = null;
  _onEvent = null;
  teardownVisibilityListener();
}

