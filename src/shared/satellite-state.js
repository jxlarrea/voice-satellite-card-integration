/**
 * Satellite State Helpers
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
 * Read a select entity's resolved entity_id attribute from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key (e.g. 'tts_output')
 * @returns {string|undefined} The entity_id attribute value, or undefined if not found
 */
export function getSelectEntityId(hass, satelliteId, translationKey) {
  if (!hass?.entities || !satelliteId) return undefined;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return undefined;
  for (const [eid, entry] of Object.entries(hass.entities)) {
    if (entry.device_id === satellite.device_id &&
        entry.platform === 'voice_satellite' &&
        entry.translation_key === translationKey) {
      return hass.states[eid]?.attributes?.entity_id || '';
    }
  }
  return undefined;
}

/**
 * Read a number entity's numeric value from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Number translation_key
 * @param {number} defaultValue - Fallback if not found
 * @returns {number} The numeric value, or defaultValue if not found
 */
export function getNumberState(hass, satelliteId, translationKey, defaultValue) {
  if (!hass?.entities || !satelliteId) return defaultValue;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return defaultValue;
  for (const [eid, entry] of Object.entries(hass.entities)) {
    if (entry.device_id === satellite.device_id &&
        entry.platform === 'voice_satellite' &&
        entry.translation_key === translationKey) {
      const val = parseFloat(hass.states[eid]?.state);
      if (!isNaN(val)) return val;
      break;
    }
  }

  // Fallback to the satellite entity attribute exposed by the integration.
  // This is more resilient on HA versions/frontends where hass.entities
  // metadata (translation_key/device cache) may not be ready yet.
  const attrVal = parseFloat(getSatelliteAttr(hass, satelliteId, translationKey));
  return isNaN(attrVal) ? defaultValue : attrVal;
}

/**
 * Read a select entity's state value directly from the entity registry.
 * Unlike getSelectEntityId (which reads the entity_id attribute), this
 * returns the select entity's display state (e.g. "Home Assistant", "ok_nabu").
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key
 * @param {string} [defaultValue] - Fallback if not found
 * @returns {string|undefined} The select state value, or defaultValue
 */
export function getSelectState(hass, satelliteId, translationKey, defaultValue) {
  if (!hass?.entities || !satelliteId) return defaultValue;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return defaultValue;
  for (const [eid, entry] of Object.entries(hass.entities)) {
    if (entry.device_id === satellite.device_id &&
        entry.platform === 'voice_satellite' &&
        entry.translation_key === translationKey) {
      const val = hass.states[eid]?.state;
      if (val && val !== 'unknown' && val !== 'unavailable') return val;
      break;
    }
  }

  // Fallback to satellite extra_state_attributes
  const attrVal = getSatelliteAttr(hass, satelliteId, translationKey);
  return attrVal !== undefined ? attrVal : defaultValue;
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
