/** Satellite entity persistence (localStorage, per-browser). */

const STORAGE_KEY = 'vs-satellite-entity';
const CONFIG_KEY = 'vs-panel-config';

export function getStoredEntity() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

export function setStoredEntity(entityId) {
  try {
    localStorage.setItem(STORAGE_KEY, entityId);
  } catch (_) { /* private browsing */ }
}

export function clearStoredEntity() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) { /* private browsing */ }
}

export function discoverSatelliteEntities(hass) {
  if (!hass?.entities) return [];
  const results = [];
  for (const [entityId, entry] of Object.entries(hass.entities)) {
    if (entry.platform === 'voice_satellite' && entityId.startsWith('assist_satellite.')) {
      const state = hass.states?.[entityId];
      const name = state?.attributes?.friendly_name || entityId;
      results.push({ entity_id: entityId, friendly_name: name });
    }
  }
  results.sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
  return results;
}

/**
 * Resolve entity from localStorage. Validates it still exists in HA.
 * Returns entity_id string or null.
 */
export function resolveEntity(hass) {
  // Check dedicated entity storage first, then fall back to panel config
  let stored = getStoredEntity();
  if (!stored) {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const panelConfig = JSON.parse(raw);
        if (panelConfig.satellite_entity) {
          stored = panelConfig.satellite_entity;
        }
      }
    } catch (_) { /* ignore */ }
  }

  if (stored) {
    // Entity registry may not be loaded yet — wait rather than clearing
    if (!hass.entities) return null;
    if (hass.entities[stored]) {
      // Sync back to dedicated storage if it was missing
      setStoredEntity(stored);
      return stored;
    }
    // Entity no longer exists in HA — clear stale storage
    clearStoredEntity();
  }

  return null;
}
