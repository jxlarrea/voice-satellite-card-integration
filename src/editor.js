/**
 * Voice Satellite Card — Editor
 *
 * Visual configuration editor for the HA Lovelace UI.
 */

import { DEFAULT_CONFIG } from './constants.js';

export class VoiceSatelliteCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._pipelines = [];
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && hass.connection && this._pipelines.length === 0) {
      this._loadPipelines();
    }
  }

  setConfig(config) {
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._render();
  }

  async _loadPipelines() {
    try {
      var result = await this._hass.connection.sendMessagePromise({
        type: 'assist_pipeline/pipeline/list',
      });
      this._pipelines = result.pipelines || [];
      this._render();
    } catch (e) {
      console.error('[VS][editor] Failed to load pipelines:', e);
    }
  }

  _render() {
    var cfg = this._config;

    var pipelineOptions = '<option value="">Default Pipeline</option>';
    for (var i = 0; i < this._pipelines.length; i++) {
      var p = this._pipelines[i];
      var sel = p.id === cfg.pipeline_id ? ' selected' : '';
      pipelineOptions += '<option value="' + p.id + '"' + sel + '>' + (p.name || p.id) + '</option>';
    }

    var mediaPlayerOptions = '<option value=""' + (!cfg.tts_target ? ' selected' : '') + '>Browser (default)</option>';
    if (this._hass) {
      var states = this._hass.states || {};
      var entityIds = Object.keys(states).filter(function (id) {
        return id.startsWith('media_player.');
      }).sort();
      for (var m = 0; m < entityIds.length; m++) {
        var eid = entityIds[m];
        var friendly = states[eid].attributes.friendly_name || eid;
        var mSel = eid === cfg.tts_target ? ' selected' : '';
        mediaPlayerOptions += '<option value="' + eid + '"' + mSel + '>' + friendly + '</option>';
      }
    }

    var wakeWordSwitchOptions = this._entityOptions(cfg.wake_word_switch, ['switch.', 'input_boolean.']);
    var stateEntityOptions = this._entityOptions(cfg.state_entity, ['input_text.']);

    this.innerHTML =
      '<style>' +
      '.vs-editor { padding: 16px; }' +
      '.vs-section { margin-bottom: 16px; padding: 12px; background: var(--card-background-color, #fff); border-radius: 8px; border: 1px solid var(--divider-color, #e0e0e0); }' +
      '.vs-section-title { font-weight: bold; font-size: 14px; margin-bottom: 12px; color: var(--primary-color, #03a9f4); }' +
      '.vs-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; min-height: 36px; }' +
      '.vs-row label { flex: 1; font-size: 14px; }' +
      '.vs-row input[type="checkbox"] { width: 20px; height: 20px; }' +
      '.vs-row input[type="number"], .vs-row input[type="text"], .vs-row input[type="color"], .vs-row select { width: 160px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color, #333); }' +
      '.vs-row input[type="range"] { width: 120px; }' +
      '.vs-row .range-val { width: 32px; text-align: right; font-size: 13px; }' +
      '</style>' +
      '<div class="vs-editor">' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Behavior</div>' +
      this._selectRow('Pipeline', 'pipeline_id', pipelineOptions) +
      this._checkboxRow('Start listening on load', 'start_listening_on_load') +
      this._selectRow('Wake word switch entity', 'wake_word_switch', wakeWordSwitchOptions) +
      this._selectRow('State tracking entity', 'state_entity', stateEntityOptions) +
      this._checkboxRow('Continue conversation mode', 'continue_conversation') +
      this._checkboxRow('Double-tap screen to cancel interaction', 'double_tap_cancel') +
      this._checkboxRow('Debug logging', 'debug') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Microphone Processing</div>' +
      this._checkboxRow('Noise suppression', 'noise_suppression') +
      this._checkboxRow('Echo cancellation', 'echo_cancellation') +
      this._checkboxRow('Auto gain control', 'auto_gain_control') +
      this._checkboxRow('Voice isolation (Chrome only)', 'voice_isolation') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Timeouts</div>' +
      this._numberRow('Server-side pipeline timeout (s)', 'pipeline_timeout', 0, 300) +
      this._numberRow('Client-side idle restart (s)', 'pipeline_idle_timeout', 0, 3600) +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Volume & Chimes</div>' +
      this._selectRow('TTS output device (Experimental)', 'tts_target', mediaPlayerOptions) +
      this._sliderRow('Chime volume', 'chime_volume', 0, 100) +
      this._sliderRow('TTS volume', 'tts_volume', 0, 100) +
      this._checkboxRow('Chime on wake word', 'chime_on_wake_word') +
      this._checkboxRow('Chime on request sent', 'chime_on_request_sent') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Rainbow Bar</div>' +
      this._selectRowRaw('Position', 'bar_position',
        '<option value="bottom"' + (cfg.bar_position === 'bottom' ? ' selected' : '') + '>Bottom</option>' +
        '<option value="top"' + (cfg.bar_position === 'top' ? ' selected' : '') + '>Top</option>'
      ) +
      this._sliderRow('Height (px)', 'bar_height', 2, 40) +
      this._textRow('Gradient colors', 'bar_gradient', '#FF7777, #FF9977, ...') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Transcription Bubble</div>' +
      this._checkboxRow('Show transcription', 'show_transcription') +
      this._sliderRow('Font size', 'transcription_font_size', 10, 48) +
      this._textRow('Font family', 'transcription_font_family', 'inherit') +
      this._colorRow('Font color', 'transcription_font_color') +
      this._checkboxRow('Bold', 'transcription_font_bold') +
      this._checkboxRow('Italic', 'transcription_font_italic') +
      this._colorRow('Background', 'transcription_background') +
      this._textRow('Border color', 'transcription_border_color', 'rgba(0,180,255,0.5)') +
      this._sliderRow('Padding', 'transcription_padding', 0, 32) +
      this._checkboxRow('Rounded corners', 'transcription_rounded') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Response Bubble</div>' +
      this._checkboxRow('Show response', 'show_response') +
      this._checkboxRow('Streaming response', 'streaming_response') +
      this._sliderRow('Font size', 'response_font_size', 10, 48) +
      this._textRow('Font family', 'response_font_family', 'inherit') +
      this._colorRow('Font color', 'response_font_color') +
      this._checkboxRow('Bold', 'response_font_bold') +
      this._checkboxRow('Italic', 'response_font_italic') +
      this._colorRow('Background', 'response_background') +
      this._textRow('Border color', 'response_border_color', 'rgba(100,200,150,0.5)') +
      this._sliderRow('Padding', 'response_padding', 0, 32) +
      this._checkboxRow('Rounded corners', 'response_rounded') +
      '</div>' +

      '<div class="vs-section">' +
      '<div class="vs-section-title">Background</div>' +
      this._checkboxRow('Background blur', 'background_blur') +
      this._sliderRow('Blur intensity', 'background_blur_intensity', 0, 20) +
      '</div>' +

      '</div>';

    this._attachListeners();
  }

  _checkboxRow(label, key) {
    var checked = this._config[key] ? ' checked' : '';
    return '<div class="vs-row"><label>' + label + '</label><input type="checkbox" data-key="' + key + '"' + checked + '></div>';
  }

  _textRow(label, key, placeholder) {
    var val = this._config[key] || '';
    return '<div class="vs-row"><label>' + label + '</label><input type="text" data-key="' + key + '" value="' + this._escAttr(val) + '" placeholder="' + (placeholder || '') + '"></div>';
  }

  _numberRow(label, key, min, max) {
    var val = this._config[key] !== undefined ? this._config[key] : '';
    return '<div class="vs-row"><label>' + label + '</label><input type="number" data-key="' + key + '" value="' + val + '" min="' + min + '" max="' + max + '"></div>';
  }

  _sliderRow(label, key, min, max) {
    var val = this._config[key] !== undefined ? this._config[key] : min;
    return '<div class="vs-row"><label>' + label + '</label><input type="range" data-key="' + key + '" min="' + min + '" max="' + max + '" value="' + val + '"><span class="range-val" data-range-for="' + key + '">' + val + '</span></div>';
  }

  _colorRow(label, key) {
    var val = this._config[key] || '#000000';
    return '<div class="vs-row"><label>' + label + '</label><input type="color" data-key="' + key + '" value="' + val + '"></div>';
  }

  _selectRow(label, key, options) {
    return '<div class="vs-row"><label>' + label + '</label><select data-key="' + key + '">' + options + '</select></div>';
  }

  _selectRowRaw(label, key, options) {
    return '<div class="vs-row"><label>' + label + '</label><select data-key="' + key + '">' + options + '</select></div>';
  }

  _entityOptions(currentValue, prefixes) {
    var options = '<option value=""' + (!currentValue ? ' selected' : '') + '>None</option>';
    if (!this._hass) return options;

    var states = this._hass.states || {};
    var entityIds = Object.keys(states).filter(function (id) {
      for (var i = 0; i < prefixes.length; i++) {
        if (id.startsWith(prefixes[i])) return true;
      }
      return false;
    }).sort();

    for (var i = 0; i < entityIds.length; i++) {
      var eid = entityIds[i];
      var friendly = states[eid].attributes.friendly_name || eid;
      var sel = eid === currentValue ? ' selected' : '';
      options += '<option value="' + eid + '"' + sel + '>' + friendly + '</option>';
    }
    return options;
  }

  _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _attachListeners() {
    var self = this;

    this.querySelectorAll('input[type="checkbox"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.checked);
      });
    });

    this.querySelectorAll('input[type="text"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });

    this.querySelectorAll('input[type="number"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, parseInt(el.value, 10) || 0);
      });
    });

    this.querySelectorAll('input[type="range"]').forEach(function (el) {
      el.addEventListener('input', function () {
        var span = self.querySelector('[data-range-for="' + el.dataset.key + '"]');
        if (span) span.textContent = el.value;
      });
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, parseInt(el.value, 10));
      });
    });

    this.querySelectorAll('input[type="color"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });

    this.querySelectorAll('select').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });
  }

  _updateConfig(key, value) {
    this._config = Object.assign({}, this._config);
    this._config[key] = value;

    var event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}