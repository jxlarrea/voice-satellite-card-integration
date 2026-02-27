/** Browser-override satellite entity persistence and picker overlay. */

const STORAGE_KEY = 'vs-satellite-entity';
export const DISABLED_VALUE = '__disabled__';

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

export function isDeviceDisabled() {
  return getStoredEntity() === DISABLED_VALUE;
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
  const stored = getStoredEntity();
  if (stored) {
    // Device explicitly disabled - return as-is
    if (stored === DISABLED_VALUE) return DISABLED_VALUE;
    // Validate entity still exists
    if (hass.entities?.[stored]) {
      return stored;
    }
    // Stale - clear it
    clearStoredEntity();
  }

  // Auto-select if only one satellite entity
  const entities = discoverSatelliteEntities(hass);
  if (entities.length === 1) {
    setStoredEntity(entities[0].entity_id);
    return entities[0].entity_id;
  }

  return null;
}

function isHADialogBlocking() {
  try {
    const ha = document.querySelector('home-assistant');
    if (!ha?.shadowRoot) return false;
    const main = ha.shadowRoot.querySelector('home-assistant-main');
    return main?.hasAttribute('inert') || false;
  } catch (_) {
    return false;
  }
}

function waitForDialogClose(callback) {
  try {
    const ha = document.querySelector('home-assistant');
    const main = ha?.shadowRoot?.querySelector('home-assistant-main');
    if (!main) { callback(); return null; }

    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      observer.disconnect();
      clearTimeout(safetyTimeout);
      callback();
    };

    const observer = new MutationObserver(() => {
      if (!main.hasAttribute('inert')) fire();
    });
    observer.observe(main, { attributes: true, attributeFilter: ['inert'] });

    // Safety timeout - don't wait forever if the dialog gets stuck
    const safetyTimeout = setTimeout(fire, 10000);

    return observer;
  } catch (_) {
    callback();
    return null;
  }
}

const PICKER_CSS = `
.vs-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  pointer-events: auto;
  font-family: var(--ha-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
}
.vs-picker-overlay * { pointer-events: auto; }
.vs-picker-card {
  background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
  border-radius: var(--ha-card-border-radius, 16px);
  padding: 28px 24px;
  max-width: 380px;
  width: 90%;
  box-shadow: var(--ha-card-box-shadow, 0 8px 32px rgba(0, 0, 0, 0.5));
}
.vs-picker-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--primary-text-color, #fff);
  margin-bottom: 6px;
  text-align: center;
}
.vs-picker-subtitle {
  font-size: 13px;
  color: var(--secondary-text-color, #999);
  text-align: center;
  margin-bottom: 20px;
  line-height: 1.4;
}
.vs-picker-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.vs-picker-item {
  display: block;
  width: 100%;
  padding: 14px 16px;
  background: var(--secondary-background-color, #2c2c2e);
  border: 1px solid var(--divider-color, #3a3a3c);
  border-radius: 10px;
  color: var(--primary-text-color, #fff);
  font-size: 15px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.vs-picker-item:hover {
  background: var(--divider-color, #3a3a3c);
}
.vs-picker-item:active {
  background: var(--divider-color, #48484a);
  border-color: var(--primary-color, #48484a);
}
.vs-picker-empty {
  color: var(--secondary-text-color, #999);
  font-size: 14px;
  text-align: center;
  padding: 16px 0;
  line-height: 1.5;
}
.vs-picker-disable {
  display: block;
  width: 100%;
  padding: 14px 16px;
  margin-top: 8px;
  background: rgba(255, 59, 48, 0.15);
  border: 1px solid rgba(255, 59, 48, 0.3);
  border-radius: 10px;
  color: #ff3b30;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  text-align: center;
  transition: background 0.15s, border-color 0.15s;
}
.vs-picker-disable:hover {
  background: rgba(255, 59, 48, 0.25);
}
.vs-picker-disable:active {
  background: rgba(255, 59, 48, 0.35);
  border-color: rgba(255, 59, 48, 0.5);
}
`;

let pickerStyleEl = null;

function ensurePickerStyles() {
  if (pickerStyleEl && document.head.contains(pickerStyleEl)) return;
  pickerStyleEl = document.createElement('style');
  pickerStyleEl.textContent = PICKER_CSS;
  document.head.appendChild(pickerStyleEl);
}

/**
 * Show a fullscreen entity picker overlay appended to document.body.
 * If HA's editor dialog is open (modal blocks all interaction), defers
 * until the dialog closes via MutationObserver on the inert attribute.
 * @param {object} hass - Home Assistant instance
 * @param {function} onSelect - callback(entityId)
 * @returns {function} teardown function to remove the overlay / cancel pending
 */
export function showPicker(hass, onSelect) {
  if (isHADialogBlocking()) {
    let cancelled = false;
    let innerTeardown = null;
    const observer = waitForDialogClose(() => {
      if (!cancelled) {
        innerTeardown = doShowPicker(hass, onSelect);
      }
    });
    return () => {
      cancelled = true;
      if (observer) observer.disconnect();
      if (innerTeardown) innerTeardown();
    };
  }
  return doShowPicker(hass, onSelect);
}

function doShowPicker(hass, onSelect) {
  ensurePickerStyles();

  const overlay = document.createElement('div');
  overlay.className = 'vs-picker-overlay';

  const entities = discoverSatelliteEntities(hass);
  const card = document.createElement('div');
  card.className = 'vs-picker-card';

  const title = document.createElement('div');
  title.className = 'vs-picker-title';
  title.textContent = 'Voice Satellite Card';
  card.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'vs-picker-subtitle';
  subtitle.textContent = 'Per-device satellite override is enabled. Select the satellite to use on this device.';
  card.appendChild(subtitle);

  const list = document.createElement('div');
  list.className = 'vs-picker-list';

  if (entities.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'vs-picker-empty';
    empty.append('No voice satellites found.');
    empty.appendChild(document.createElement('br'));
    empty.append('Set up the Voice Satellite Card integration first.');
    list.appendChild(empty);
  } else {
    for (const entity of entities) {
      const button = document.createElement('button');
      button.className = 'vs-picker-item';
      button.dataset.entity = entity.entity_id;
      button.textContent = entity.friendly_name;
      list.appendChild(button);
    }
  }
  card.appendChild(list);

  const disable = document.createElement('button');
  disable.className = 'vs-picker-disable';
  disable.dataset.entity = DISABLED_VALUE;
  disable.textContent = 'Disable on this device';
  card.appendChild(disable);

  overlay.appendChild(card);

  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('.vs-picker-item') || e.target.closest('.vs-picker-disable');
    if (!btn) return;
    const entityId = btn.dataset.entity;
    setStoredEntity(entityId);
    teardown();
    onSelect(entityId);
  });

  document.body.appendChild(overlay);

  function teardown() {
    if (overlay.parentNode) overlay.remove();
  }

  return teardown;
}
