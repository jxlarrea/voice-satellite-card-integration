/**
 * Voice Satellite Card  -  Card Comms
 *
 * WebSocket state sync from the card.
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * Sync pipeline state to the integration entity.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {string} state
 */
export function syncSatelliteState(card, state) {
  const entityId = card.config.satellite_entity;
  if (!entityId || !card.hass?.connection) return;

  if (state === card.lastSyncedSatelliteState) return;
  card.lastSyncedSatelliteState = state;

  card.hass.connection.sendMessagePromise({
    type: 'voice_satellite/update_state',
    entity_id: entityId,
    state,
  }).catch(() => { /* fire-and-forget */ });
}
