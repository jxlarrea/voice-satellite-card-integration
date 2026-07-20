/**
 * Satellite Event Subscription
 *
 * Single WS subscription for satellite-pushed events (announcement,
 * start_conversation, ask_question).  Replaces per-manager entity
 * state subscriptions for notification features.
 *
 * Module-level state. Reconnects are handled MANUALLY here, with the
 * subscription opted OUT of home-assistant-js-websocket's automatic replay
 * ({resubscribe: false}). Both mechanisms at once is the historical leak (each
 * reconnect stacked the replayed copy plus a manual one, +1 per reconnect,
 * unbounded); replay alone is not safe for a CUSTOM command: haws re-issues it
 * with no error handling, and after a Home Assistant restart the frontend can
 * reconnect before the integration has registered voice_satellite/
 * subscribe_events — the replay then fails once and the subscription is dead
 * with no retry. The manual 'ready' path funnels through _doSubscribe's
 * failure handling, which retries with backoff until the integration is up.
 * (entity-subscription.js, by contrast, rides a CORE command that always
 * exists at auth time, so it safely uses haws replay.)
 *
 * Also kept: the integration 'reload' message (server tears the subscription
 * down; see _scheduleRetry) and a stale socket that dropped silently while the
 * tab was hidden (see refreshSatelliteSubscription).
 */

import {
  resetNotificationDedup,
  teardownVisibilityListener,
} from './satellite-notification.js';

let _unsubscribe = null;
let _subscribed = false;
let _reconnectListener = null;
let _reconnectConnection = null;
let _card = null;
let _onEvent = null;
let _retryTimer = null;

const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000];
let _retryCount = 0;

// Liveness verification. A confirmed subscribe is NOT proof the server still
// has us: reconnect storms + haws's per-socket command-id reuse mean a stale
// unsubscribe (including haws's own "unknown subscription" defense) can land
// on OUR fresh id and silently unregister it server-side. Nothing notifies
// the client. So after subscribing we periodically ask the backend
// (voice_satellite/subscription_check) and re-subscribe if it says no.
const VERIFY_FIRST_MS = 5000;
const VERIFY_EVERY_MS = 30000;
let _verifyTimeout = null;
let _verifyInterval = null;

function _stopVerify() {
  if (_verifyTimeout) { clearTimeout(_verifyTimeout); _verifyTimeout = null; }
  if (_verifyInterval) { clearInterval(_verifyInterval); _verifyInterval = null; }
}

function _startVerify(card) {
  _stopVerify();
  _verifyTimeout = setTimeout(() => {
    _verifyNow(card);
    _verifyInterval = setInterval(() => _verifyNow(card), VERIFY_EVERY_MS);
  }, VERIFY_FIRST_MS);
}

function _verifyNow(card) {
  if (!_subscribed || !_unsubscribe) return;
  const conn = card.connection;
  if (!conn) return;
  conn.sendMessagePromise({
    type: 'voice_satellite/subscription_check',
    entity_id: card.config.satellite_entity,
  }).then((res) => {
    if (!res || res.subscribed !== false) return;
    card.logger.log('satellite-sub', 'Subscription lost server-side - re-subscribing');
    // Dead server-side: drop the handle (nothing to unsubscribe, and a stale
    // unsubscribe is exactly the id-collision hazard), then re-establish.
    _unsubscribe = null;
    _subscribed = false;
    _stopVerify();
    const c = card.connection;
    if (c) {
      _subscribed = true;
      _doSubscribe(card, c, _onEvent);
    }
  }).catch(() => {
    // Transient (mid-reconnect) or the integration is reloading; the
    // reconnect/reload/retry paths own recovery for those.
  });
}

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

  // The ONLY re-subscribe path on reconnect (the subscription itself opts out
  // of haws replay) — so a failure lands in _doSubscribe's retry/backoff, and
  // exactly one subscription ever exists per connection.
  if (!_reconnectListener) {
    _reconnectListener = () => {
      card.logger.log('satellite-sub', 'Connection reconnected - re-subscribing');
      // The previous subscription died with its socket, so there is nothing
      // to unsubscribe server-side. Critically, do NOT send its unsubscribe
      // on the new socket: haws resets command ids on every reconnect
      // (connection.ts _handleClose), and the frontend's boot sequence is
      // deterministic enough that the stale id routinely EQUALS the id of a
      // freshly-created subscription — the server then tears down the wrong,
      // live subscription. (Observed: the replacement satellite subscription
      // was unregistered 3ms after registering; announcements went nowhere
      // while the card believed it was subscribed.) Just drop the handle.
      _unsubscribe = null;
      _stopVerify();
      if (_retryTimer) {
        clearTimeout(_retryTimer);
        _retryTimer = null;
      }
      _retryCount = 0;
      _subscribed = false;
      const conn = card.connection;
      if (conn) {
        _subscribed = true;
        _doSubscribe(card, conn, onEvent);
      }
    };
    connection.addEventListener('ready', _reconnectListener);
    _reconnectConnection = connection;
  }
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
    // No haws auto-replay: the 'ready' listener above re-subscribes with
    // retry/backoff instead (see the header comment for why).
    { resubscribe: false },
  ).then((unsub) => {
    _unsubscribe = unsub;
    _retryCount = 0;
    // New subscription session = new server id-space (HA may have restarted
    // and reset its announce counter) — start the notification dedup over.
    resetNotificationDedup();
    card.logger.log('satellite-sub', `Subscribed to satellite events for ${card.config.satellite_entity}`);
    // Trust, but verify: reconnect races can unregister this server-side
    // moments from now without telling us (see the verification block above).
    _startVerify(card);
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
  _stopVerify();
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
 * Permanently tear down the satellite subscription and reconnect listener.
 * Called when the card is displaced by another browser.
 */
export function teardownSatelliteSubscription() {
  _cleanup();
  if (_reconnectListener && _reconnectConnection) {
    _reconnectConnection.removeEventListener('ready', _reconnectListener);
    _reconnectListener = null;
    _reconnectConnection = null;
  }
  _card = null;
  _onEvent = null;
  teardownVisibilityListener();
}

