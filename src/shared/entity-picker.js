/** Satellite entity persistence (localStorage, per-browser). */

const STORAGE_KEY = 'vs-satellite-entity';
const CONFIG_KEY = 'vs-panel-config';
const CLEARED_KEY = 'vs-entity-cleared';

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
    localStorage.removeItem(CLEARED_KEY);
  } catch (_) { /* private browsing */ }
}

export function clearStoredEntity() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(CLEARED_KEY, '1');
  } catch (_) { /* private browsing */ }
}

function wasExplicitlyCleared() {
  try {
    return localStorage.getItem(CLEARED_KEY) === '1';
  } catch (_) {
    return false;
  }
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
 * Auto-selects if only one satellite entity is available.
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

  // Don't auto-select if the user explicitly cleared the entity
  if (wasExplicitlyCleared()) return null;

  // Auto-select if only one satellite entity
  const entities = discoverSatelliteEntities(hass);
  if (entities.length === 1) {
    setStoredEntity(entities[0].entity_id);
    return entities[0].entity_id;
  }

  return null;
}
