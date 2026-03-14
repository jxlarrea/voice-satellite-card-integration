/**
 * Voice Satellite Panel
 *
 * Sidebar panel that replaces the card editor for configuring the
 * voice satellite engine. Provides all settings (entity, appearance,
 * microphone, debug) plus a live preview of the selected skin.
 *
 * Config is stored in localStorage so each browser/device can have
 * its own settings. The running session picks up changes immediately.
 *
 * Uses light DOM (no shadow root) because ha-panel-custom renders
 * panels in light DOM and HA components like ha-form break inside
 * nested shadow roots. Preview uses its own shadow root for isolation.
 */

import {
  getStoredEntity,
  setStoredEntity,
  clearStoredEntity,
} from '../shared/entity-picker.js';
import { DEFAULT_CONFIG, State, VERSION } from '../constants.js';
import { renderPreview } from '../editor/preview.js';
import {
  behaviorSchema, entitySchema, autoStartSchema, microphoneSchema, debugSchema,
  behaviorLabels, behaviorHelpers,
} from '../editor/behavior.js';
import { skinSchema, skinLabels, skinHelpers } from '../editor/skin.js';

const P = 'vsp';
const CONFIG_KEY = 'vs-panel-config';

/* ── Combined schema & labels (mirrors full card editor) ── */

const panelSchema = [
  ...behaviorSchema,
  ...autoStartSchema,
  ...skinSchema,
  ...microphoneSchema,
  ...debugSchema,
];

const allLabels = Object.assign({}, behaviorLabels, skinLabels);
const allHelpers = Object.assign({}, behaviorHelpers, skinHelpers);

/* ── Engine status display ── */

const STATE_LABELS = {
  [State.IDLE]: 'Idle',
  [State.CONNECTING]: 'Connecting...',
  [State.LISTENING]: 'Listening for wake word',
  [State.WAKE_WORD_DETECTED]: 'Wake word detected',
  [State.STT]: 'Listening to speech',
  [State.INTENT]: 'Processing...',
  [State.TTS]: 'Speaking',
  [State.ERROR]: 'Error',
};

const STATE_COLORS = {
  [State.IDLE]: '#9e9e9e',
  [State.CONNECTING]: '#ff9800',
  [State.LISTENING]: '#4caf50',
  [State.WAKE_WORD_DETECTED]: '#2196f3',
  [State.STT]: '#2196f3',
  [State.INTENT]: '#9c27b0',
  [State.TTS]: '#e91e63',
  [State.ERROR]: '#f44336',
};

/* ── Config persistence (localStorage, per-browser) ── */

function getStoredConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function setStoredConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (_) { /* private browsing */ }
}

/* ── HA component loading ── */

let _componentsReady = null;
function ensureHaComponents() {
  if (_componentsReady) return _componentsReady;
  _componentsReady = Promise.race([
    _loadComponents(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
  ]);
  return _componentsReady;
}

async function _loadComponents() {
  if (customElements.get('ha-form')) return;

  // Step 1: ensure loadCardHelpers is available
  if (!window.loadCardHelpers) {
    await customElements.whenDefined('partial-panel-resolver');
    const ppr = document.createElement('partial-panel-resolver');
    const routes = ppr._getRoutes?.([
      { component_name: 'lovelace', url_path: 'a' },
    ]);
    await routes?.routes?.a?.load?.();
  }

  // Step 2: call loadCardHelpers and trigger a card editor load.
  // ha-form and ha-entity-picker are lazy-loaded via card editor imports.
  if (window.loadCardHelpers) {
    const helpers = await window.loadCardHelpers();

    if (!customElements.get('ha-form') && helpers) {
      const cardTypes = ['entities', 'entity', 'light', 'button'];
      for (const type of cardTypes) {
        if (customElements.get('ha-form')) break;
        try {
          const CardClass = customElements.get(`hui-${type}-card`);
          if (CardClass?.getConfigElement) {
            await CardClass.getConfigElement();
          }
        } catch (_) { /* ignore — just need the import side-effect */ }
      }
    }
  }
}

/* ── Panel element ── */

class VoiceSatellitePanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._statusInterval = null;
    this._rendered = false;
    this._formLoaded = false;
    this._config = Object.assign({}, DEFAULT_CONFIG, getStoredConfig());
    // Sync entity from dedicated storage into config
    const storedEntity = getStoredEntity();
    if (storedEntity) this._config.satellite_entity = storedEntity;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._buildDom();
    }
    this._updateForm();
    this._updateStatus();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    const menuBtn = this.querySelector(`.${P}-menu-btn`);
    if (menuBtn) menuBtn.narrow = narrow;
  }
  set route(route) { /* unused */ }
  set panel(panel) { /* unused */ }

  connectedCallback() {
    if (!this._rendered && this._hass) {
      this._buildDom();
    }
    this._statusInterval = setInterval(() => this._updateStatus(), 1000);
  }

  disconnectedCallback() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }

  _getSession() {
    return window.__vsSession || null;
  }

  _updateForm() {
    if (!this._hass) return;
    const menuBtn = this.querySelector(`.${P}-menu-btn`);
    if (menuBtn) menuBtn.hass = this._hass;
    const entityForm = this.querySelector(`.${P}-entity-container ha-form`);
    if (entityForm) entityForm.hass = this._hass;
    const form = this.querySelector(`.${P}-form-container ha-form`);
    if (form) form.hass = this._hass;
  }

  _updateStatus() {
    const session = this._getSession();

    const dot = this.querySelector(`.${P}-status-dot`);
    const label = this.querySelector(`.${P}-status-label`);
    if (!dot || !label) return;

    const state = session?.isStarted ? (session.currentState || State.IDLE) : State.IDLE;
    dot.style.background = STATE_COLORS[state] || '#9e9e9e';
    label.textContent = STATE_LABELS[state] || state;

    const running = this.querySelector(`.${P}-engine-running`);
    if (running) {
      running.textContent = session?.isStarted ? 'Engine running' : 'Engine dormant';
      running.style.color = session?.isStarted ? '#4caf50' : '#ff9800';
    }

    const isStarted = session?.isStarted || false;
    const startBtn = this.querySelector(`.${P}-engine-start`);
    if (startBtn) {
      startBtn.style.display = !isStarted && this._config.satellite_entity ? '' : 'none';
    }
    const stopBtn = this.querySelector(`.${P}-engine-stop`);
    if (stopBtn) {
      stopBtn.style.display = isStarted ? '' : 'none';
    }
  }

  _onEntityChange(newData) {
    this._config = Object.assign({}, this._config, newData);
    setStoredConfig(this._config);

    if (this._config.satellite_entity) {
      setStoredEntity(this._config.satellite_entity);
    } else {
      clearStoredEntity();
    }

    const session = this._getSession();
    if (session) {
      session.updateConfig(Object.assign({}, this._config), { fromPanel: true });
      if (this._hass) session.updateHass(this._hass);
      if (this._config.satellite_entity && this._config.auto_start !== false && !session.isStarted) {
        // Ensure an engine card exists for UI rendering
        if (session._cards.size === 0) {
          const card = document.createElement('voice-satellite-card');
          card._engineOwned = true;
          card.setConfig(Object.assign({}, this._config));
          card.style.display = 'none';
          document.body.appendChild(card);
          card.hass = this._hass;
        }
        requestAnimationFrame(() => {
          if (!session.isStarted) {
            session._userStopped = false;
            session._startAttempted = false;
            session.start();
          }
        });
      }
      if (!this._config.satellite_entity && session.isStarted) {
        session.teardown();
        this._updateStatus();
      }
    }

    // Sync entity form
    const entityForm = this.querySelector(`.${P}-entity-container ha-form`);
    if (entityForm) entityForm.data = Object.assign({}, this._config);
    this._updateStatus();
    this._updatePreview();
  }

  _onSettingsChange(newData) {
    Object.assign(this._config, newData);
    setStoredConfig(this._config);

    // Propagate to running session (debug, mic constraints, reactive bar, etc.)
    const session = this._getSession();
    if (session) {
      session.updateConfig(Object.assign({}, this._config), { fromPanel: true });
    }

    // Sync settings form
    const settingsForm = this.querySelector(`.${P}-form-container ha-form`);
    if (settingsForm) settingsForm.data = Object.assign({}, this._config);
    this._updateStatus();
    this._updatePreview();
  }

  _updatePreview() {
    const host = this.querySelector(`.${P}-preview-host`);
    if (!host?.shadowRoot) return;
    host._hass = this._hass;
    renderPreview(host.shadowRoot, this._config);
  }

  _buildDom() {
    if (!this._hass) return;
    this._rendered = true;

    const session = this._getSession();
    const state = session?.currentState || State.IDLE;
    const isStarted = session?.isStarted || false;

    this.innerHTML = `
      <style>
        voice-satellite-panel {
          display: block;
          font-family: var(--ha-font-family, Roboto, sans-serif);
          color: var(--primary-text-color, #fff);
        }
        .${P}-toolbar {
          display: flex;
          align-items: center;
          height: var(--header-height, 56px);
          padding: 0 12px;
          background: var(--app-header-background-color, var(--primary-background-color, #111));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
          font-size: 20px;
          border-bottom: 1px solid var(--divider-color, #333);
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .${P}-toolbar ha-menu-button {
          flex-shrink: 0;
        }
        .${P}-toolbar-title {
          flex: 1;
          min-width: 0;
          font-weight: 400;
          margin-left: 4px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .${P}-toolbar-icon {
          width: 24px;
          height: 24px;
          flex-shrink: 0;
        }
        .${P}-toolbar-right {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }
        .${P}-toolbar-version {
          font-size: 14px;
          opacity: 0.7;
        }
        .${P}-toolbar-help {
          color: inherit;
          opacity: 0.7;
          cursor: pointer;
          display: flex;
          align-items: center;
          --mdc-icon-size: 24px;
          padding: 8px;
          border-radius: 50%;
        }
        .${P}-toolbar-help:hover {
          opacity: 1;
          background: rgba(255, 255, 255, 0.08);
        }
        .${P}-content {
          padding: 24px;
          max-width: 600px;
          margin: 0 auto;
        }
        .${P}-card {
          background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid var(--divider-color, #333);
        }
        .${P}-card-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 16px;
        }
        .${P}-card-subtitle {
          font-size: 13px;
          color: var(--secondary-text-color, #999);
          margin-bottom: 16px;
          line-height: 1.5;
        }
        .${P}-status-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .${P}-status-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .${P}-status-label {
          font-size: 15px;
        }
        .${P}-engine-layout {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .${P}-engine-info {
          flex: 1;
          min-width: 0;
        }
        .${P}-engine-running {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 4px;
        }
        .${P}-engine-action {
          flex-shrink: 0;
          width: 80px;
          display: flex;
          justify-content: flex-end;
        }
        .${P}-engine-start {
          background: var(--primary-color, #03a9f4);
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
        }
        .${P}-engine-start:hover,
        .${P}-engine-stop:hover {
          opacity: 0.85;
        }
        .${P}-engine-stop {
          background: var(--error-color, #f44336);
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
        }
        .${P}-entity-container {
          /* ha-form renders inside */
        }
        .${P}-entity-hint {
          font-size: 13px;
          color: var(--secondary-text-color, #999);
          margin-top: 8px;
          line-height: 1.5;
        }
        .${P}-preview-host {
          display: block;
          border-radius: var(--ha-card-border-radius, 12px);
          overflow: hidden;
        }
        .${P}-form-loading {
          font-size: 14px;
          color: var(--secondary-text-color, #999);
          padding: 12px 0;
        }
        .${P}-hint {
          font-size: 13px;
          color: var(--secondary-text-color, #999);
          margin-top: 8px;
          line-height: 1.5;
        }
      </style>

      <div class="${P}-toolbar">
        <ha-menu-button class="${P}-menu-btn"></ha-menu-button>
        <div class="${P}-toolbar-title">
          <img class="${P}-toolbar-icon" src="/voice_satellite/brand/icon.png" alt="">
          Voice Satellite
        </div>
        <div class="${P}-toolbar-right">
          <span class="${P}-toolbar-version">v${VERSION}</span>
          <a class="${P}-toolbar-help" href="https://github.com/jxlarrea/voice-satellite-card-integration/blob/main/README.md" target="_blank" rel="noopener noreferrer">
            <ha-icon icon="mdi:help-circle-outline"></ha-icon>
          </a>
        </div>
      </div>

      <div class="${P}-content">
      <div class="${P}-card">
        <div class="${P}-engine-layout">
          <div class="${P}-engine-info">
            <div class="${P}-engine-running" style="color: ${isStarted ? '#4caf50' : '#ff9800'}">
              ${isStarted ? 'Engine running' : 'Engine dormant'}
            </div>
            <div class="${P}-status-row">
              <div class="${P}-status-dot" style="background: ${STATE_COLORS[state] || '#9e9e9e'}"></div>
              <div class="${P}-status-label">${STATE_LABELS[state] || state}</div>
            </div>
          </div>
          <div class="${P}-engine-action">
            <button class="${P}-engine-start" style="display: ${!isStarted && this._config.satellite_entity ? '' : 'none'}">Start</button>
            <button class="${P}-engine-stop" style="display: ${isStarted ? '' : 'none'}">Stop</button>
          </div>
        </div>
      </div>

      <div class="${P}-card">
        <div class="${P}-card-title">Satellite entity</div>
        <div class="${P}-card-subtitle">Assign the Voice Satellite device that this browser will use.</div>
        <div class="${P}-entity-container">
          <div class="${P}-form-loading">Loading...</div>
        </div>
        <div class="${P}-entity-hint">Add a satellite device first via Settings → Devices &amp; Services → Voice Satellite.</div>
      </div>

      <div class="${P}-card">
        <div class="${P}-card-title">Preview</div>
        <div class="${P}-preview-host"></div>
      </div>

      <div class="${P}-card">
        <div class="${P}-card-title">Settings</div>
        <div class="${P}-form-container">
          <div class="${P}-form-loading">Loading settings...</div>
        </div>
        <div class="${P}-hint">
          Settings are stored per-browser and persist across sessions.
        </div>
      </div>
      </div>
    `;

    // Set up menu button (HA built-in, handles sidebar toggle)
    const menuBtn = this.querySelector(`.${P}-menu-btn`);
    if (menuBtn) {
      menuBtn.hass = this._hass;
      menuBtn.narrow = this._narrow;
    }

    // Set up preview (shadow DOM for style isolation)
    const previewHost = this.querySelector(`.${P}-preview-host`);
    previewHost._hass = this._hass;
    previewHost.attachShadow({ mode: 'open' });
    renderPreview(previewHost.shadowRoot, this._config);

    // Start / Stop buttons
    const startBtn = this.querySelector(`.${P}-engine-start`);
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const session = this._getSession();
        if (session && !session.isStarted && this._config.satellite_entity) {
          // Ensure an engine card exists for UI rendering
          if (session._cards.size === 0) {
            const card = document.createElement('voice-satellite-card');
            card._engineOwned = true;
            card.setConfig(Object.assign({}, this._config));
            card.style.display = 'none';
            document.body.appendChild(card);
            card.hass = this._hass;
          }
          session._userStopped = false;
          session._startAttempted = false;
          requestAnimationFrame(() => {
            if (!session.isStarted) session.start();
          });
        }
      });
    }
    const stopBtn = this.querySelector(`.${P}-engine-stop`);
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        const session = this._getSession();
        if (session?.isStarted) {
          session._userStopped = true;
          session.teardown();
          this._updateStatus();
        }
      });
    }

    // Load ha-form async
    this._loadForm();
  }

  async _loadForm() {
    if (this._formLoaded) return;
    try {
      await ensureHaComponents();
    } catch (e) {
      const container = this.querySelector(`.${P}-form-container`);
      if (container) container.innerHTML = `<div class="${P}-form-loading">Settings unavailable</div>`;
      return;
    }
    this._formLoaded = true;

    // Entity picker
    const entityContainer = this.querySelector(`.${P}-entity-container`);
    if (entityContainer) {
      entityContainer.innerHTML = '';
      const entityForm = document.createElement('ha-form');
      entityForm.hass = this._hass;
      entityForm.data = Object.assign({}, this._config);
      entityForm.schema = entitySchema;
      entityForm.computeLabel = () => '';
      entityForm.computeHelper = () => '';
      entityForm.addEventListener('value-changed', (e) => {
        this._onEntityChange(e.detail.value);
      });
      entityContainer.appendChild(entityForm);
    }

    // Settings form
    const container = this.querySelector(`.${P}-form-container`);
    if (!container) return;
    container.innerHTML = '';

    const form = document.createElement('ha-form');
    form.hass = this._hass;
    form.data = Object.assign({}, this._config);
    form.schema = panelSchema;
    form.computeLabel = (schema) => allLabels[schema.name] || '';
    form.computeHelper = (schema) => allHelpers[schema.name] || '';
    form.addEventListener('value-changed', (e) => {
      this._onSettingsChange(e.detail.value);
    });

    container.appendChild(form);
  }
}

if (!customElements.get('voice-satellite-panel')) {
  customElements.define('voice-satellite-panel', VoiceSatellitePanel);
}
