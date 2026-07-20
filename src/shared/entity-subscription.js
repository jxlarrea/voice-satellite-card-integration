/**
 * Entity Subscription Utility
 *
 * Watches a single HA entity's attributes via an entity-scoped
 * `subscribe_entities` subscription — server-side filtered to just that one
 * entity. This replaces an earlier `subscribeEvents(..., 'state_changed')`,
 * which received EVERY entity's state change (the whole-instance firehose,
 * with full old+new state objects) and filtered client-side. On low-powered
 * tablets that firehose is a real cost, and it delivered nothing the consumer
 * (TimerManager) uses beyond the watched entity's attributes.
 *
 * Reconnects are handled by home-assistant-js-websocket, which replays active
 * subscriptions onto the new socket — the same way every other subscription in
 * this project relies on. So there is deliberately NO manual 'ready'
 * re-subscribe here: the previous one stacked a second subscription on top of
 * that replay on every reconnect, leaking another full subscription each time
 * (measured: +1 per reconnect, unbounded).
 *
 * `subscribe_entities` uses HA's compressed format, so this keeps a small
 * shadow of the entity's attributes and applies the add/change/remove deltas
 * before handing the current attributes to the consumer. The consumer contract
 * is unchanged: `onAttrs(currentAttributes)` on the initial state and on every
 * subsequent change.
 *
 * @param {object} manager - Manager instance (holds _subscribed/_unsubscribe/_entityId)
 * @param {object} connection - HA WebSocket connection
 * @param {string} entityId - Entity to watch
 * @param {(attrs: object) => void} onAttrs - Callback receiving the entity's current attributes
 * @param {string} logTag - Log category label
 */
export function subscribeToEntity(manager, connection, entityId, onAttrs, logTag) {
  manager._subscribed = true;
  manager._entityId = entityId;
  manager._attrs = {};

  const apply = (msg) => {
    if (!msg) return;
    // Compressed subscribe_entities payload:
    //   a = added   (full state; sent on subscribe and on reconnect replay)
    //   c = changed (per-entity delta: '+' sets/merges attrs, '-' removes keys)
    //   r = removed (entity ids)
    if (msg.a && msg.a[entityId]) {
      manager._attrs = { ...(msg.a[entityId].a || {}) };
      onAttrs(manager._attrs);
      return;
    }
    if (msg.c && msg.c[entityId]) {
      const delta = msg.c[entityId];
      const cur = manager._attrs || (manager._attrs = {});
      if (delta['+'] && delta['+'].a) {
        const added = delta['+'].a;
        for (const key in added) cur[key] = added[key];
      }
      if (delta['-'] && delta['-'].a) {
        const removed = delta['-'].a;
        (Array.isArray(removed) ? removed : Object.keys(removed))
          .forEach((key) => { delete cur[key]; });
      }
      onAttrs(cur);
      return;
    }
    if (msg.r && msg.r.includes(entityId)) {
      manager._attrs = {};
      onAttrs(manager._attrs);
    }
  };

  connection.subscribeMessage(apply, {
    type: 'subscribe_entities',
    entity_ids: [entityId],
  }).then((unsub) => {
    manager._unsubscribe = unsub;
    manager.log.log(logTag, `Subscribed to ${entityId} (entity-scoped)`);
  }).catch((err) => {
    manager.log.error(logTag, `Failed to subscribe: ${err}`);
    manager._subscribed = false;
  });
}

/**
 * Clean up the subscription.
 */
export function unsubscribeEntity(manager) {
  if (manager._unsubscribe) {
    try { manager._unsubscribe().catch(() => {}); } catch (_) { /* cleanup */ }
    manager._unsubscribe = null;
  }
  manager._subscribed = false;
}
