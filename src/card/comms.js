/**
 * Voice Satellite Card — Card Comms
 *
 * WebSocket state sync and service calls from the card.
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

/**
 * Update the interaction state entity (input_text).
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {string} interactionState - 'ACTIVE' or 'IDLE'
 */
export function updateInteractionState(card, interactionState) {
  const entityId = card.config.state_entity;
  if (!entityId || !card.hass) return;

  card.logger.log('state_entity', `${entityId} → ${interactionState}`);
  card.hass.callService('input_text', 'set_value', {
    entity_id: entityId,
    value: interactionState,
  }).catch((e) => {
    card.logger.error('state_entity', `Failed to update ${entityId}: ${e}`);
  });
}

/**
 * Turn off the wake word switch (e.g., Fully Kiosk screensaver).
 * @param {import('./index.js').VoiceSatelliteCard} card
 */
export function turnOffWakeWordSwitch(card) {
  if (!card.config.wake_word_switch || !card.hass) return;

  const entityId = card.config.wake_word_switch;
  if (!entityId.includes('.')) {
    card.logger.log('switch', `Invalid entity: ${entityId}`);
    return;
  }

  card.logger.log('switch', `Turning off: ${entityId}`);

  card.hass.callService('homeassistant', 'turn_off', {
    entity_id: entityId,
  }).catch((err) => {
    card.logger.error('switch', `Failed to turn off: ${err}`);
  });
}
