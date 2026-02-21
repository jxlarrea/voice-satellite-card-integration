/**
 * Voice Satellite Card — Satellite State Helpers
 *
 * Read satellite entity attributes and sibling switch states
 * from the HA frontend cache. These are pure lookups with no
 * side-effects, shared across all managers.
 */

/**
 * Read an attribute from the satellite entity's HA state.
 * @param {object} hass - HA frontend object
 * @param {string} entityId - Satellite entity ID
 * @param {string} name - Attribute name
 * @returns {*} Attribute value, or undefined if unavailable
 */
export function getSatelliteAttr(hass, entityId, name) {
  if (!hass || !entityId) return undefined;
  const state = hass.states[entityId];
  return state?.attributes?.[name];
}

/**
 * Read a switch entity's on/off state directly from the entity registry
 * and state cache, bypassing satellite extra_state_attributes (which can
 * be stale if the state-change listener wasn't set up in time).
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Switch translation_key ('mute' | 'wake_sound')
 * @returns {boolean|undefined} true if switch is on, false if off, undefined if not found
 */
export function getSwitchState(hass, satelliteId, translationKey) {
  if (!hass || !satelliteId) return undefined;

  // Find the switch via the frontend entity registry cache (hass.entities)
  if (hass.entities) {
    const satellite = hass.entities[satelliteId];
    if (satellite?.device_id) {
      for (const [eid, entry] of Object.entries(hass.entities)) {
        if (entry.device_id === satellite.device_id &&
            entry.platform === 'voice_satellite' &&
            entry.translation_key === translationKey) {
          return hass.states[eid]?.state === 'on';
        }
      }
    }
  }

  // Fallback: satellite extra_state_attributes (may be stale)
  const attrName = translationKey === 'mute' ? 'muted' : translationKey;
  const val = getSatelliteAttr(hass, satelliteId, attrName);
  return val !== undefined ? val === true : undefined;
}
