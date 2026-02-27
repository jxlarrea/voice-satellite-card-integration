/**
 * Entity Subscription Utility
 *
 * Shared subscription pattern for watching HA entity state changes.
 * Used by TimerManager and AnnouncementManager.
 *
 * @param {object} manager - Manager instance (must have _log, _card, _unsubscribe, _entityId)
 * @param {object} connection - HA WebSocket connection
 * @param {string} entityId - Entity to watch
 * @param {(attrs: object) => void} onAttrs - Callback receiving new_state.attributes
 * @param {string} logTag - Log category label
 */
export function subscribeToEntity(manager, connection, entityId, onAttrs, logTag) {
  manager._subscribed = true;
  manager._entityId = entityId;

  doSubscribe(manager, connection, entityId, onAttrs, logTag);

  // Re-subscribe on HA reconnect (e.g. after restart)
  if (!manager._reconnectListener) {
    manager._reconnectListener = () => {
      if (!manager.card.isOwner) return;

      manager.log.log(logTag, 'Connection reconnected - re-subscribing');
      if (manager._unsubscribe) {
        try { manager._unsubscribe(); } catch (_) { /* cleanup */ }
        manager._unsubscribe = null;
      }
      const conn = manager.card.connection;
      if (conn) {
        doSubscribe(manager, conn, manager._entityId, onAttrs, logTag);
      }
    };
    connection.addEventListener('ready', manager._reconnectListener);
  }
}

/**
 * Perform the actual event subscription and immediate state check.
 */
function doSubscribe(manager, connection, entityId, onAttrs, logTag) {
  connection.subscribeEvents((event) => {
    const { data } = event;
    if (!data || !data.new_state) return;
    if (data.entity_id !== entityId) return;
    onAttrs(data.new_state.attributes || {});
  }, 'state_changed').then((unsub) => {
    manager._unsubscribe = unsub;
    manager.log.log(logTag, `Subscribed to state changes for ${entityId}`);

    // Immediate check for current state
    const hass = manager.card.hass;
    if (hass?.states?.[entityId]) {
      onAttrs(hass.states[entityId].attributes || {});
    }
  }).catch((err) => {
    manager.log.error(logTag, `Failed to subscribe: ${err}`);
    manager._subscribed = false;
  });
}

/**
 * Clean up subscription and reconnect listener.
 */
export function unsubscribeEntity(manager) {
  if (manager._unsubscribe) {
    manager._unsubscribe();
    manager._unsubscribe = null;
  }
  if (manager._reconnectListener && manager.card.connection) {
    manager.card.connection.removeEventListener('ready', manager._reconnectListener);
    manager._reconnectListener = null;
  }
  manager._subscribed = false;
}
