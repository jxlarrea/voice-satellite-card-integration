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
import { WakeWordTestSession } from '../wake-word/wake-word-test-session.js';
import { resolveDspForMode } from '../audio/dsp-config.js';
import { getMicroModelParams } from '../wake-word/micro-models.js';
import { getSelectOptions } from '../shared/satellite-state.js';

const P = 'vsp';
const CONFIG_KEY = 'vs-panel-config';
const SENSITIVITY_MARGIN_FACTORS = {
  'Slightly sensitive': 0.5,
  'Moderately sensitive': 1.0,
  'Very sensitive': 2.0,
};
const STOP_SENSITIVITY_FACTORS = {
  'Slightly sensitive': 0.8,
  'Moderately sensitive': 1.0,
  'Very sensitive': 1.2,
};


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
    // Migrate legacy unified DSP keys into the STT group.
    const LEGACY_DSP_KEYS = ['noise_suppression', 'echo_cancellation', 'auto_gain_control', 'voice_isolation'];
    for (const key of LEGACY_DSP_KEYS) {
      const legacy = this._config[key];
      if (legacy !== true && legacy !== false) continue;
      const stt = `stt_${key}`;
      if (this._config[stt] === undefined) this._config[stt] = legacy;
    }
    // v6.10.x shipped wake-word DSP defaulting to off — fix persisted
    // false values back to true (matching Voice PE hardware behavior).
    if (!(this._config._dsp_version >= 2)) {
      this._config.wake_word_noise_suppression = true;
      this._config.wake_word_echo_cancellation = true;
      this._config.wake_word_auto_gain_control = true;
      this._config._dsp_version = 2;
      setStoredConfig(this._config);
    }
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
    this._stopTesterMonitor();
    if (this._testerPopulateInterval) {
      clearInterval(this._testerPopulateInterval);
      this._testerPopulateInterval = null;
    }
    // Tear down the standalone tester session if active so the mic is
    // released when the user navigates away from the panel. If we paused
    // the main engine for the test, restart it.
    if (this._testerSession) {
      const cs = this._testerSession;
      const wasRunning = this._testerEngineWasRunning;
      this._testerSession = null;
      cs.stop().then(() => {
        if (wasRunning) this._resumeEngineAfterTester();
      }).catch(() => {
        if (wasRunning) this._resumeEngineAfterTester();
      });
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

    // If a tester session is running and the user just toggled a Mic
    // Processing setting, the session has stale browser DSP constraints.
    // Stop it so the user can restart with the new settings applied.
    if (this._testerSession?.running) {
      this._stopTesterSession().catch(() => { /* ignore */ });
    }
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
          height: 100%;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          font-family: var(--ha-font-family, Roboto, sans-serif);
          color: var(--primary-text-color, #fff);
        }
        .${P}-toolbar {
          position: sticky;
          top: 0;
          height: var(--header-height, 56px);
          display: flex;
          align-items: center;
          padding: 0 12px;
          background: var(--app-header-background-color, var(--primary-background-color, #111));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
          font-size: 20px;
          border-bottom: 1px solid var(--divider-color, #333);
          z-index: 10;
          box-sizing: border-box;
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
        .${P}-tester-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        .${P}-tester-label {
          font-size: 14px;
          color: var(--primary-text-color, #fff);
          flex-shrink: 0;
          width: 130px;
        }
        .${P}-tester-model {
          flex: 1;
          background: var(--secondary-background-color, #2c2c2e);
          color: var(--primary-text-color, #fff);
          border: 1px solid var(--divider-color, #444);
          border-radius: 6px;
          padding: 8px 10px;
          font-size: 14px;
          font-family: inherit;
        }
        .${P}-tester-meter-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 14px;
        }
        .${P}-tester-meter-label {
          font-size: 13px;
          color: var(--secondary-text-color, #999);
          width: 130px;
          flex-shrink: 0;
        }
        .${P}-tester-meter {
          flex: 1;
          height: 12px;
          background: var(--secondary-background-color, #2c2c2e);
          border-radius: 6px;
          overflow: hidden;
          position: relative;
        }
        .${P}-tester-meter-fill {
          height: 100%;
          width: 0%;
          background: linear-gradient(90deg, #4caf50 0%, #ffc107 70%, #f44336 100%);
          transition: width 60ms linear;
        }
        .${P}-tester-meter-value {
          font-size: 12px;
          color: var(--secondary-text-color, #999);
          width: 56px;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .${P}-tester-graph-row {
          margin-bottom: 14px;
        }
        .${P}-tester-graph-row .${P}-tester-meter-label {
          width: auto;
          display: block;
        }
        .${P}-tester-graph-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .${P}-tester-graph-readout {
          font-size: 12px;
          color: var(--secondary-text-color, #999);
          font-variant-numeric: tabular-nums;
        }
        .${P}-tester-latest,
        .${P}-tester-peak,
        .${P}-tester-threshold-val {
          color: var(--primary-text-color, #fff);
          font-weight: 500;
        }
        .${P}-tester-graph {
          width: 100%;
          height: 120px;
          display: block;
          background: var(--secondary-background-color, #2c2c2e);
          border-radius: 6px;
        }
        .${P}-tester-axis-note {
          margin-top: 6px;
          font-size: 12px;
          color: var(--secondary-text-color, #999);
          display: flex;
          justify-content: space-between;
          font-variant-numeric: tabular-nums;
        }
        .${P}-tester-actions {
          display: flex;
          gap: 8px;
          margin-top: 16px;
        }
        .${P}-tester-actions button {
          flex: 1;
          padding: 10px 16px;
          border-radius: 8px;
          border: none;
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
        }
        .${P}-tester-toggle {
          background: #4caf50;
          color: #fff;
        }
        .${P}-tester-toggle.is-running {
          background: var(--error-color, #f44336);
        }
        .${P}-tester-actions button:hover {
          opacity: 0.85;
        }
        .${P}-tester-card.is-idle .${P}-tester-meter,
        .${P}-tester-card.is-idle .${P}-tester-graph {
          opacity: 0.4;
        }
        .${P}-tester-log-row {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .${P}-tester-log-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        .${P}-tester-log-clear {
          background: transparent;
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .${P}-tester-log-clear:hover {
          background: var(--secondary-background-color);
        }
        .${P}-tester-log {
          width: 100%;
          height: 180px;
          overflow-y: auto;
          background: var(--code-editor-background-color, #1e1e1e);
          color: var(--primary-text-color, #eee);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 11px;
          line-height: 1.45;
          padding: 6px 8px;
          box-sizing: border-box;
          white-space: pre;
        }
        .${P}-tester-log-entry {
          display: block;
          padding: 1px 0;
        }
        .${P}-tester-log-entry.is-trigger {
          color: #4caf50;
          font-weight: 600;
        }
        .${P}-tester-log-entry.is-warn {
          color: #ff9800;
        }
        .${P}-tester-log-entry.is-info {
          color: #64b5f6;
        }
        .${P}-tester-log-entry.is-diag {
          color: #b0bec5;
        }
        /* Wake-word DSP warning — the actual warning element gets
           inline-styled because it's injected into ha-form-expandable's
           shadow root, which light-DOM CSS can't penetrate. */
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

      <div class="${P}-card ${P}-tester-card">
        <div class="${P}-card-title">Wake Word Tester</div>
        <div class="${P}-card-subtitle">
          Visualize wake word activation in real time. Use this to confirm
          a model is being detected reliably from your usual distance, or
          to compare how different models behave on this specific device.
          The tester runs with the same Microphone Processing settings the
          engine uses.
        </div>

        <div class="${P}-tester-row">
          <label class="${P}-tester-label" for="${P}-tester-model">Model</label>
          <select class="${P}-tester-model" id="${P}-tester-model"></select>
        </div>

        <div class="${P}-tester-row">
          <label class="${P}-tester-label" for="${P}-tester-sensitivity">Sensitivity</label>
          <select class="${P}-tester-model" id="${P}-tester-sensitivity">
            <option value="Slightly sensitive">Slightly sensitive</option>
            <option value="Moderately sensitive" selected>Moderately sensitive</option>
            <option value="Very sensitive">Very sensitive</option>
          </select>
        </div>

        <div class="${P}-tester-meter-row">
          <div class="${P}-tester-meter-label">Mic level</div>
          <div class="${P}-tester-meter">
            <div class="${P}-tester-meter-fill"></div>
          </div>
          <div class="${P}-tester-meter-value">0.000</div>
        </div>

        <div class="${P}-tester-graph-row">
          <div class="${P}-tester-graph-header">
            <div class="${P}-tester-meter-label">Detection probability (smoothed)</div>
            <div class="${P}-tester-graph-readout">
              latest <span class="${P}-tester-latest">0.000</span>
              &nbsp;·&nbsp; peak <span class="${P}-tester-peak">0.000</span>
              &nbsp;·&nbsp; threshold <span class="${P}-tester-threshold-val">0.00</span>
            </div>
          </div>
          <canvas class="${P}-tester-graph" width="600" height="120"></canvas>
          <div class="${P}-tester-axis-note">
            <span>Y: probability</span>
            <span>X: time → newest</span>
          </div>
        </div>

        <div class="${P}-tester-actions">
          <button class="${P}-tester-toggle">Start</button>
        </div>

        <div class="${P}-tester-log-row">
          <div class="${P}-tester-log-header">
            <span>Live log — probabilities, warnings, and triggers</span>
            <button type="button" class="${P}-tester-log-clear">Clear</button>
          </div>
          <div class="${P}-tester-log" role="log" aria-live="polite"></div>
        </div>

        <div class="${P}-hint">
          Click <strong>Start</strong> to grant mic access and begin
          monitoring. Stand at your usual distance and say the wake word.
          The probability curve should cross the dashed threshold line —
          when it does, the engine would have triggered a detection.
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

    // Wire up the wake word tester card
    this._initTesterCard();
  }

  // ─── Wake Word Tester ──────────────────────────────────────────────

  _initTesterCard() {
    const card = this.querySelector(`.${P}-tester-card`);
    if (!card) return;

    card.classList.add('is-idle');

    const modelSelect = card.querySelector(`#${P}-tester-model`);
    const sensitivitySelect = card.querySelector(`#${P}-tester-sensitivity`);
    const toggleBtn = card.querySelector(`.${P}-tester-toggle`);
    const thresholdValEl = card.querySelector(`.${P}-tester-threshold-val`);

    // Probability ring buffer (~6s @ 30Hz = 180 samples) — drives the
    // scrolling chart only. Peak is tracked separately as a session-max
    // value that persists across the chart's rolling window so the user
    // can compare attempts that happened more than 6s apart. The peak
    // resets on each Start (no separate Reset button — keep the UI minimal).
    this._testerProbBuf = new Float32Array(180);
    this._testerProbHead = 0;
    this._testerProbCount = 0;
    this._testerPeakSmoothed = 0;

    // Cached threshold for the currently selected model. Used to draw
    // the dashed line on the graph and rendered next to the readouts.
    this._testerThreshold = 0.85;

    // Standalone tester session (lazy — created on first Start click)
    this._testerSession = null;

    // Populate model dropdown from the HA entity's options list (which
    // includes built-in + any custom .tflite files discovered at startup).
    const populate = () => {
      const entityOptions = getSelectOptions(
        this._hass, this._config.satellite_entity, 'wake_word_model',
      );
      const fallback = ['ok_nabu', 'hey_jarvis', 'hey_mycroft', 'alexa',
        'hey_home_assistant', 'hey_luna', 'okay_computer'];
      const session = this._getSession();
      const ww = session?.wakeWord;
      const active = ww ? ww.getActiveModels() : [];
      const all = Array.from(new Set([...active, ...(entityOptions.length ? entityOptions : fallback)]))
        .filter((m) => m && m !== 'No wake word' && m !== 'stop');
      const current = modelSelect.value;
      modelSelect.innerHTML = '';
      for (const name of all) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        modelSelect.appendChild(opt);
      }
      const initial = current || active[0] || all[0];
      if (initial) modelSelect.value = initial;
    };

    populate();
    this._testerSelectedModel = modelSelect.value;
    this._testerSensitivity = sensitivitySelect?.value || 'Moderately sensitive';

    const updateThresholdForModel = () => {
      const name = modelSelect.value;
      const sensitivity = sensitivitySelect?.value || 'Moderately sensitive';
      this._testerSelectedModel = name;
      this._testerSensitivity = sensitivity;
      const params = getMicroModelParams(name);
      const baseCutoff = params?.cutoff ?? 0.85;
      const factors = name === 'stop' ? STOP_SENSITIVITY_FACTORS : SENSITIVITY_MARGIN_FACTORS;
      const factor = factors[sensitivity] ?? 1.0;
      this._testerThreshold = Math.max(0.1, Math.min(1 - (1 - baseCutoff) * factor, 0.99));
      if (thresholdValEl) thresholdValEl.textContent = this._testerThreshold.toFixed(2);
      // Reset chart + peak for the new model
      this._testerProbCount = 0;
      this._testerProbHead = 0;
      this._testerProbBuf.fill(0);
      this._testerPeakSmoothed = 0;
      // Draw the idle frame so the user sees the grid + the dashed
      // threshold line at the new model's cutoff before they click Start.
      this._renderTesterIdleChart();
    };

    updateThresholdForModel();

    modelSelect.addEventListener('change', async () => {
      updateThresholdForModel();
      // If a tester session is running, switch models on the fly so the
      // user doesn't have to Stop and Start to compare two models.
      if (this._testerSession?.running) {
        try {
          await this._testerSession.switchModel(this._testerSelectedModel, {
            threshold: this._testerThreshold,
          });
        } catch (e) {
          // Best effort — failure here just means the next sample is stale.
        }
      }
    });

    sensitivitySelect?.addEventListener('change', () => {
      updateThresholdForModel();
      if (this._testerSession?.running) {
        this._testerSession.setThreshold(this._testerThreshold);
      }
    });

    toggleBtn.addEventListener('click', async () => {
      if (this._testerSession?.running) {
        await this._stopTesterSession();
      } else {
        await this._startTesterSession();
      }
    });

    const clearBtn = card.querySelector(`.${P}-tester-log-clear`);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this._clearTesterLog());
    }

    // Refresh dropdown labels periodically so the active-model list
    // reflects integration changes (e.g. user picked a new wake word
    // in the satellite settings).
    this._testerPopulateInterval = setInterval(() => {
      const current = modelSelect.value;
      populate();
      if (current && Array.from(modelSelect.options).some((o) => o.value === current)) {
        modelSelect.value = current;
      }
    }, 4000);
  }

  async _startTesterSession() {
    const card = this.querySelector(`.${P}-tester-card`);
    const toggleBtn = card?.querySelector(`.${P}-tester-toggle`);

    if (!card || !toggleBtn) return;
    toggleBtn.disabled = true;
    toggleBtn.textContent = 'Starting...';

    // Pause the main engine so a wake word said during the test doesn't
    // pop the pipeline UI overlay. Remember whether it was running so we
    // can restart it after the test ends.
    const session = this._getSession();
    this._testerEngineWasRunning = !!session?.isStarted;
    if (this._testerEngineWasRunning) {
      try {
        session._userStopped = true;
        session.teardown();
        this._updateStatus();
      } catch (_) { /* best-effort */ }
    }

    try {
      this._testerSession = new WakeWordTestSession();
      // Route the tester through the *wake-word* DSP settings so it mirrors
      // the audio path the main engine uses during wake-word listening.
      const dsp = resolveDspForMode(this._config, 'wake_word');

      // Subscribe to the session's log BEFORE calling start() — the DSP
      // requested/applied diagnostic emits during _acquireMic(), which runs
      // inside start().  If we subscribed afterwards we'd miss those lines.
      this._clearTesterLog();
      this._unsubscribeTesterLog = this._testerSession.onLogMessage(
        (cat, msg, ts) => this._appendTesterLog(cat, msg, ts),
      );

      await this._testerSession.start(this._testerSelectedModel, {
        threshold: this._testerThreshold,
        constraints: {
          echoCancellation: dsp.echoCancellation === true,
          noiseSuppression: dsp.noiseSuppression === true,
          autoGainControl: dsp.autoGainControl === true,
          voiceIsolation: dsp.voiceIsolation === true,
        },
      });

      // Reset peak on each fresh start so the user can compare a new
      // session against itself, not against whatever they did 5 minutes ago.
      this._testerPeakSmoothed = 0;
      this._testerProbCount = 0;
      this._testerProbHead = 0;
      this._testerProbBuf.fill(0);
      this._appendTesterLog('info', `started "${this._testerSelectedModel}" — listening`);

      card.classList.remove('is-idle');
      toggleBtn.classList.add('is-running');
      toggleBtn.textContent = 'Stop';
      toggleBtn.disabled = false;
      this._startTesterMonitor();
    } catch (e) {
      this._appendTesterLog('warn', `Failed to start: ${e.message || e}`);
      this._testerSession = null;
      toggleBtn.disabled = false;
      toggleBtn.textContent = 'Start';
      toggleBtn.classList.remove('is-running');
      // Restart the engine if we paused it but the test failed to start.
      if (this._testerEngineWasRunning) {
        this._resumeEngineAfterTester();
      }
    }
  }

  async _stopTesterSession() {
    const card = this.querySelector(`.${P}-tester-card`);
    const toggleBtn = card?.querySelector(`.${P}-tester-toggle`);

    this._stopTesterMonitor();

    // Detach log subscriber before we drop the session reference.
    if (this._unsubscribeTesterLog) {
      try { this._unsubscribeTesterLog(); } catch (_) { /* ignore */ }
      this._unsubscribeTesterLog = null;
    }
    this._appendTesterLog('info', 'stopped');

    if (this._testerSession) {
      try { await this._testerSession.stop(); } catch (_) { /* ignore */ }
      this._testerSession = null;
    }

    if (card) card.classList.add('is-idle');
    if (toggleBtn) {
      toggleBtn.classList.remove('is-running');
      toggleBtn.textContent = 'Start';
    }

    // Restart the main engine if we paused it for the test.
    if (this._testerEngineWasRunning) {
      this._resumeEngineAfterTester();
    }
  }

  _resumeEngineAfterTester() {
    this._testerEngineWasRunning = false;
    const session = this._getSession();
    if (!session || !this._config.satellite_entity) return;

    // Mirror the Start button: clear stop guard and kick off after a frame
    // so any in-flight teardown / mic release settles first.
    session._userStopped = false;
    session._startAttempted = false;
    if (session._cards.size === 0) {
      const card = document.createElement('voice-satellite-card');
      card._engineOwned = true;
      card.setConfig(Object.assign({}, this._config));
      card.style.display = 'none';
      document.body.appendChild(card);
      card.hass = this._hass;
    }
    requestAnimationFrame(() => {
      if (!session.isStarted) session.start();
      this._updateStatus();
    });
  }

  _startTesterMonitor() {
    if (this._testerRafActive) return;
    this._testerRafActive = true;

    const card = this.querySelector(`.${P}-tester-card`);
    const fillEl = card?.querySelector(`.${P}-tester-meter-fill`);
    const valueEl = card?.querySelector(`.${P}-tester-meter-value`);
    const canvas = card?.querySelector(`.${P}-tester-graph`);
    const ctx = canvas?.getContext('2d');
    const latestEl = card?.querySelector(`.${P}-tester-latest`);
    const peakEl = card?.querySelector(`.${P}-tester-peak`);
    let lastDetectionSeq = 0;

    let lastSampleTs = 0;
    const SAMPLE_INTERVAL = 33; // ~30Hz

    const tick = (ts) => {
      if (!this._testerRafActive) return;
      this._testerRafFrame = requestAnimationFrame(tick);

      const cs = this._testerSession;

      if (ts - lastSampleTs >= SAMPLE_INTERVAL) {
        lastSampleTs = ts;

        // Clamp display values at 0. The sliding-window mean inside the
        // inference engine can drift to tiny negative numbers (-1e-15)
        // from floating-point subtract-then-add, which toFixed renders
        // as "-0.000". Math.max(0, x) also normalizes negative zero to
        // positive zero so the readouts don't flicker a minus sign.
        const rms = cs ? Math.max(0, cs.latestRms) : 0;
        // Map RMS to 0..1 visual range. Most speech sits around 0.05-0.3.
        // Cap at 0.5 so the bar doesn't pin to the right on loud bursts.
        const rmsPct = Math.min(1, rms / 0.5);
        if (fillEl) fillEl.style.width = `${(rmsPct * 100).toFixed(1)}%`;
        if (valueEl) valueEl.textContent = rms.toFixed(3);

        // Smoothed (sliding-window mean) probability — what the engine
        // actually compares against the cutoff for detection.
        const prob = cs ? Math.max(0, cs.getLatestSmoothedProbability()) : 0;
        const buf = this._testerProbBuf;
        buf[this._testerProbHead] = prob;
        this._testerProbHead = (this._testerProbHead + 1) % buf.length;
        if (this._testerProbCount < buf.length) this._testerProbCount++;
        if (latestEl) latestEl.textContent = prob.toFixed(3);
        if (prob > this._testerPeakSmoothed) this._testerPeakSmoothed = prob;
        if (peakEl) peakEl.textContent = this._testerPeakSmoothed.toFixed(3);

        const detectionSeq = cs?.detectionSeq || 0;
        if (detectionSeq !== lastDetectionSeq) {
          lastDetectionSeq = detectionSeq;
        }
      }

      // Repaint graph every frame for smooth scrolling
      if (ctx && canvas) {
        const flashActive = !!(cs && cs.detectionSeq > 0 && (cs.lastDetectionAt ? (ts - cs.lastDetectionAt) < 220 : false));
        this._drawTesterGraph(canvas, ctx, flashActive);
      }
    };

    this._testerRafFrame = requestAnimationFrame(tick);
  }

  /**
   * Draw the static parts of the chart (grid + dashed threshold line)
   * once, without the live waveform. Called from init and on model
   * change so the chart is never blank — the user always sees where
   * the detection threshold lives even before they click Start.
   */
  _renderTesterIdleChart() {
    const canvas = this.querySelector(`.${P}-tester-graph`);
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) this._drawTesterGraph(canvas, ctx, false);
  }

  _drawTesterGraph(canvas, ctx, flashActive = false) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const padLeft = 38;
    const padRight = 8;
    const padTop = 8;
    const padBottom = 18;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    const plotX0 = padLeft;
    const plotY0 = padTop;

    ctx.fillStyle = flashActive
      ? 'rgba(76, 175, 80, 0.22)'
      : 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, w, h);

    // Background grid lines (0, 0.25, 0.5, 0.75, 1.0)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = plotY0 + (i / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotX0, y);
      ctx.lineTo(plotX0 + plotW, y);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = ['1.00', '0.75', '0.50', '0.25', '0.00'];
    for (let i = 0; i < yTicks.length; i++) {
      const y = plotY0 + (i / 4) * plotH;
      ctx.fillText(yTicks[i], plotX0 - 6, y);
    }

    // Threshold line at the model's natural cutoff
    const threshold = this._testerThreshold;
    const threshY = plotY0 + plotH - threshold * plotH;
    ctx.strokeStyle = 'rgba(255, 152, 0, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(plotX0, threshY);
    ctx.lineTo(plotX0 + plotW, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = ['-6s', '-4s', '-2s', 'now'];
    for (let i = 0; i < xTicks.length; i++) {
      const x = plotX0 + (i / 3) * plotW;
      ctx.fillText(xTicks[i], x, plotY0 + plotH + 4);
    }

    // Probability waveform — newest sample at the right edge.
    // Below-threshold segments stay blue; the portion above the threshold
    // is highlighted in red with exact threshold-crossing splits so the
    // preceding segment does not get tinted accidentally.
    const buf = this._testerProbBuf;
    const count = this._testerProbCount;
    if (count < 2) return;

    const stepX = plotW / (buf.length - 1);
    // Walk oldest → newest. The newest sample lives at (head - 1).
    const start = (this._testerProbHead - count + buf.length) % buf.length;
    const points = [];
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % buf.length;
      const v = buf[idx];
      const x = plotX0 + i * stepX + (buf.length - count) * stepX;
      const y = plotY0 + plotH - v * plotH;
      points.push({ x, y, v });
    }

    const drawSegment = (strokeStyle, a, b) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const aAbove = a.v >= threshold;
      const bAbove = b.v >= threshold;

      if (aAbove === bAbove) {
        drawSegment(aAbove ? '#f44336' : '#03a9f4', a, b);
        continue;
      }

      const denom = (b.v - a.v);
      const t = denom === 0 ? 0 : (threshold - a.v) / denom;
      const cross = {
        x: a.x + (b.x - a.x) * t,
        y: threshY,
        v: threshold,
      };

      drawSegment(aAbove ? '#f44336' : '#03a9f4', a, cross);
      drawSegment(bAbove ? '#f44336' : '#03a9f4', cross, b);
    }
  }

  _stopTesterMonitor() {
    this._testerRafActive = false;
    if (this._testerRafFrame) {
      cancelAnimationFrame(this._testerRafFrame);
      this._testerRafFrame = null;
    }
  }

  // ─── Tester log pane ───────────────────────────────────────────────
  // These render inline in the panel instead of the browser console so the
  // user can see probability diag frames, clip-guard warnings, and
  // detections without opening DevTools.
  _appendTesterLog(cat, msg, ts) {
    const pane = this.querySelector(`.${P}-tester-log`);
    if (!pane) return;
    const when = new Date(ts ?? Date.now());
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp =
      `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}`;
    const entry = document.createElement('span');
    entry.className = `${P}-tester-log-entry is-${cat}`;
    entry.textContent = `${stamp}  [${cat}]  ${msg}`;
    pane.appendChild(entry);
    // Bound the log so it doesn't grow unbounded over a long session.
    const MAX_ENTRIES = 400;
    while (pane.childNodes.length > MAX_ENTRIES) pane.removeChild(pane.firstChild);
    // Auto-scroll unless the user has scrolled up to read older entries.
    const nearBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    if (nearBottom) pane.scrollTop = pane.scrollHeight;
  }

  _clearTesterLog() {
    const pane = this.querySelector(`.${P}-tester-log`);
    if (pane) pane.innerHTML = '';
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

    // Single ha-form, unchanged rendering — one call, nothing custom.
    const form = document.createElement('ha-form');
    form.hass = this._hass;
    form.data = Object.assign({}, this._config);
    form.schema = panelSchema;
    form.computeLabel = (s) => allLabels[s.name] || '';
    form.computeHelper = (s) => allHelpers[s.name] || '';
    form.addEventListener('value-changed', (e) => this._onSettingsChange(e.detail.value));
    container.appendChild(form);

    // The Wake-Word DSP warning has to sit INSIDE the Wake Word expandable
    // so users see it right where the toggles are.  ha-form-expandable
    // renders an `<ha-expansion-panel>` in its own shadow root with the
    // inner ha-form as its light-DOM child — that panel slot-projects
    // any light-DOM children into the expanded content area.  So we
    // walk ha-form's shadow tree, find the Wake Word expandable by its
    // header text, and append our warning as a second light-DOM child
    // of the ha-expansion-panel.  No new custom elements — we're just
    // placing a plain <div> into an existing expansion panel's default
    // slot exactly the way ha-form itself places the inner ha-form.
  }
}

if (!customElements.get('voice-satellite-panel')) {
  customElements.define('voice-satellite-panel', VoiceSatellitePanel);
}
