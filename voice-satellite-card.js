/**
 * Voice Satellite Card v2.3.0
 * Transform your browser into a voice satellite for Home Assistant Assist
 * 
 * A custom Lovelace card that enables wake word detection, speech-to-text,
 * intent processing, and text-to-speech playback directly in the browser.
 */

// ============================================================================
// State Constants
// ============================================================================

var State = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  LISTENING: 'LISTENING',
  PAUSED: 'PAUSED',
  WAKE_WORD_DETECTED: 'WAKE_WORD_DETECTED',
  STT: 'STT',
  INTENT: 'INTENT',
  TTS: 'TTS',
  ERROR: 'ERROR'
};

// ============================================================================
// Default Configuration
// ============================================================================

var DEFAULT_CONFIG = {
  // Behavior
  start_listening_on_load: true,
  wake_word_switch: '',
  pipeline_id: '',
  pipeline_timeout: 60,
  pipeline_idle_timeout: 300,
  chime_on_wake_word: true,
  chime_on_request_sent: true,
  chime_volume: 100,
  tts_volume: 100,
  tts_target: '',
  continue_conversation: true,
  double_tap_cancel: true,
  debug: false,

  // Microphone Processing
  noise_suppression: true,
  echo_cancellation: true,
  auto_gain_control: true,
  voice_isolation: false,

  // Rainbow Bar
  bar_position: 'bottom',
  bar_height: 16,
  bar_gradient: '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC',
  background_blur: true,
  background_blur_intensity: 5,

  // Transcription Bubble
  show_transcription: true,
  transcription_font_size: 20,
  transcription_font_family: 'inherit',
  transcription_font_color: '#444444',
  transcription_font_bold: true,
  transcription_font_italic: false,
  transcription_background: '#ffffff',
  transcription_border_color: 'rgba(0, 180, 255, 0.5)',
  transcription_padding: 16,
  transcription_rounded: true,

  // Response Bubble
  show_response: true,
  streaming_response: false,
  response_font_size: 20,
  response_font_family: 'inherit',
  response_font_color: '#444444',
  response_font_bold: true,
  response_font_italic: false,
  response_background: '#ffffff',
  response_border_color: 'rgba(100, 200, 150, 0.5)',
  response_padding: 16,
  response_rounded: true
};

// ============================================================================
// Expected error codes (no error UI, immediate restart)
// ============================================================================

var EXPECTED_ERRORS = [
  'timeout',
  'wake-word-timeout',
  'stt-no-text-recognized',
  'duplicate_wake_up_detected'
];

// ============================================================================
// VoiceSatelliteCard - Main Card
// ============================================================================

class VoiceSatelliteCard extends HTMLElement {

  constructor() {
    super();

    // State
    this._state = State.IDLE;
    this._config = Object.assign({}, DEFAULT_CONFIG);
    this._hass = null;
    this._connection = null;
    this._hasStarted = false;
    this._isStreaming = false;
    this._isPaused = false;

    // Pipeline
    this._unsubscribe = null;
    this._binaryHandlerId = null;
    this._retryCount = 0;
    this._serviceUnavailable = false;
    this._restartTimeout = null;
    this._isRestarting = false;
    this._idleTimeoutId = null;
    this._pendingRunEnd = false;
    this._recoveryTimeout = null;
    this._suppressTTS = false;
    this._intentErrorBarTimeout = null;
    this._continueConversationId = null;
    this._shouldContinue = false;
    this._continueMode = false;
    this._chatStreamEl = null;

    // Audio
    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._scriptProcessor = null;
    this._audioBuffer = [];
    this._sendInterval = null;
    this._actualSampleRate = 16000;
    this._currentAudio = null;
    this._ttsPlaying = false;
    this._ttsEndTimer = null;
    this._streamingTtsUrl = null;

    // UI
    this._globalUI = null;
    this._streamedResponse = '';
    this._lastTapTime = 0;
    this._doubleTapHandler = null;

    // Visibility
    this._visibilityDebounceTimer = null;
    this._disconnectTimeout = null;
    this._wasConnected = false;
    this._pendingStartButtonReason = undefined;

    // Bind methods
    this._handleVisibilityChange = this._handleVisibilityChangeFn.bind(this);
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  _log(category, msg, data) {
    if (!this._config.debug) return;
    if (data !== undefined) {
      console.log('[VS][' + category + '] ' + msg, data);
    } else {
      console.log('[VS][' + category + '] ' + msg);
    }
  }

  _logError(category, msg, data) {
    if (data !== undefined) {
      console.error('[VS][' + category + '] ' + msg, data);
    } else {
      console.error('[VS][' + category + '] ' + msg);
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._render();
    this._ensureGlobalUI();
    this._setupVisibilityHandler();

    if (!window._voiceSatelliteActive && this._hass && this._hass.connection) {
      this._startListening();
    }
  }

  disconnectedCallback() {
    var self = this;
    this._disconnectTimeout = setTimeout(function () {
      if (window._voiceSatelliteInstance === self) {
        // We're still the active instance but truly disconnected — keep running via global UI
      }
    }, 100);
  }

  setConfig(config) {
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    if (this._globalUI) {
      this._applyStyles();
    }

    // If a different instance is the active satellite, propagate config to it
    // so changes take effect immediately without a page reload.
    if (window._voiceSatelliteInstance && window._voiceSatelliteInstance !== this) {
      window._voiceSatelliteInstance._config = this._config;
      if (window._voiceSatelliteInstance._globalUI) {
        window._voiceSatelliteInstance._applyStyles();
      }
    }
  }

  set hass(hass) {
    this._hass = hass;

    if (this._hasStarted) return;
    if (!hass || !hass.connection) return;
    if (window._voiceSatelliteStarting) return;
    if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) return;

    this._connection = hass.connection;

    // Ensure global UI exists before we try to start or show the button.
    // The hass setter can fire before connectedCallback in some HA lifecycle paths.
    this._ensureGlobalUI();

    if (this._config.start_listening_on_load) {
      // Mark _hasStarted true so we only attempt auto-start once via the setter.
      // If auto-start fails (user gesture required), the start button click will retry.
      this._hasStarted = true;
      this._startListening();
    } else {
      // start_listening_on_load is false — show the button so user can manually start
      this._hasStarted = true;
      this._showStartButton();
    }
  }

  getCardSize() {
    return 0;
  }

  static getConfigElement() {
    return document.createElement('voice-satellite-card-editor');
  }

  static getStubConfig() {
    return { start_listening_on_load: true };
  }

  // --------------------------------------------------------------------------
  // Render & Global UI
  // --------------------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }
    this.shadowRoot.innerHTML = '<div id="voice-satellite-card" style="display:none;"></div>';
  }

  _ensureGlobalUI() {
    var alreadyExists = !!document.getElementById('voice-satellite-ui');
    
    if (alreadyExists) {
      this._globalUI = document.getElementById('voice-satellite-ui');
      this._flushPendingStartButton();
      return;
    }

    var ui = document.createElement('div');
    ui.id = 'voice-satellite-ui';
    ui.innerHTML =
      '<div class="vs-blur-overlay"></div>' +
      '<button class="vs-start-btn">' +
        '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>' +
      '</button>' +
      '<div class="vs-chat-container"></div>' +
      '<div class="vs-rainbow-bar"></div>';

    document.body.appendChild(ui);
    this._globalUI = ui;

    // Inject styles
    this._injectGlobalStyles();
    this._applyStyles();

    // Start button handler
    var self = this;
    ui.querySelector('.vs-start-btn').addEventListener('click', function () {
      self._handleStartClick();
    });

    // Double-tap to cancel: stop TTS and end interaction
    this._setupDoubleTapHandler();

    // Show the start button immediately. It acts as the user gesture fallback.
    // _hideStartButton() will be called if/when the mic starts successfully.
    // This ensures the button is always visible when needed, regardless of
    // race conditions between connectedCallback, hass setter, and async mic access.
    var btn = ui.querySelector('.vs-start-btn');
    btn.classList.add('visible');
    btn.title = 'Tap to start voice assistant';

    // Flush any pending start button show
    this._flushPendingStartButton();
  }

  _flushPendingStartButton() {
    if (this._pendingStartButtonReason !== undefined) {
      this._showStartButton(this._pendingStartButtonReason);
      this._pendingStartButtonReason = undefined;
    }
  }

  _injectGlobalStyles() {
    if (document.getElementById('voice-satellite-styles')) return;

    var style = document.createElement('style');
    style.id = 'voice-satellite-styles';
    style.textContent =
      '#voice-satellite-ui .vs-blur-overlay {' +
        'position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
        'backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);' +
        'background: rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s ease;' +
        'z-index: 9999; pointer-events: none;' +
      '}' +
      '#voice-satellite-ui .vs-blur-overlay.visible { opacity: 1; }' +

      '#voice-satellite-ui .vs-start-btn {' +
        'position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px;' +
        'border-radius: 50%; background: var(--primary-color, #03a9f4);' +
        'border: none; cursor: pointer; display: none; align-items: center;' +
        'justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.3);' +
        'z-index: 10001; transition: transform 0.2s, box-shadow 0.2s;' +
      '}' +
      '#voice-satellite-ui .vs-start-btn.visible { display: flex; animation: vs-btn-pulse 2s ease-in-out infinite; }' +
      '#voice-satellite-ui .vs-start-btn:hover {' +
        'transform: scale(1.1); box-shadow: 0 6px 16px rgba(0,0,0,0.4); animation: none;' +
      '}' +
      '#voice-satellite-ui .vs-start-btn svg { width: 28px; height: 28px; fill: white; }' +
      '@keyframes vs-btn-pulse {' +
        '0%, 100% { transform: scale(1); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }' +
        '50% { transform: scale(1.08); box-shadow: 0 6px 20px rgba(3,169,244,0.5); }' +
      '}' +

      '#voice-satellite-ui .vs-rainbow-bar {' +
        'position: fixed; left: 0; right: 0;' +
        'background-size: 200% 100%; opacity: 0; transition: opacity 0.3s ease;' +
        'z-index: 10000; pointer-events: none;' +
      '}' +

      '#voice-satellite-ui .vs-chat-container {' +
        'position: fixed; left: 50%; transform: translateX(-50%);' +
        'display: flex; flex-direction: column; align-items: center; gap: 8px;' +
        'max-width: 80%; width: 80%; z-index: 10001;' +
        'pointer-events: none; overflow: visible;' +
      '}' +
      '#voice-satellite-ui .vs-chat-container.visible { pointer-events: auto; }' +
      '#voice-satellite-ui .vs-chat-msg {' +
        'max-width: 85%; padding: 12px; opacity: 0; text-align: center;' +
        'box-shadow: 0 4px 12px rgba(0,0,0,0.15);' +
        'animation: vs-chat-fade-in 0.3s ease forwards;' +
        'word-wrap: break-word;' +
      '}' +
      '@keyframes vs-chat-fade-in {' +
        '0% { opacity: 0; transform: translateY(8px); }' +
        '100% { opacity: 1; transform: translateY(0); }' +
      '}' +
      '#voice-satellite-ui .vs-rainbow-bar.visible { opacity: 1; }' +
      '#voice-satellite-ui .vs-rainbow-bar.connecting {' +
        'animation: vs-bar-breathe 1.5s ease-in-out infinite;' +
      '}' +
      '#voice-satellite-ui .vs-rainbow-bar.listening {' +
        'animation: vs-gradient-flow 3s linear infinite;' +
      '}' +
      '#voice-satellite-ui .vs-rainbow-bar.processing {' +
        'animation: vs-gradient-flow 0.5s linear infinite;' +
      '}' +
      '#voice-satellite-ui .vs-rainbow-bar.speaking {' +
        'animation: vs-gradient-flow 2s linear infinite;' +
      '}' +
      '#voice-satellite-ui .vs-rainbow-bar.error-mode {' +
        'animation: vs-gradient-flow 2s linear infinite; opacity: 1;' +
      '}' +
      '@keyframes vs-gradient-flow {' +
        '0% { background-position: 0% 50%; }' +
        '100% { background-position: 200% 50%; }' +
      '}' +
      '@keyframes vs-bar-breathe {' +
        '0%, 100% { opacity: 0.3; }' +
        '50% { opacity: 0.7; }' +
      '}';

    document.head.appendChild(style);
  }

  _applyStyles() {
    if (!this._globalUI) return;
    var cfg = this._config;

    // Rainbow bar
    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.style.height = cfg.bar_height + 'px';
    bar.style[cfg.bar_position === 'top' ? 'top' : 'bottom'] = '0';
    bar.style[cfg.bar_position === 'top' ? 'bottom' : 'top'] = 'auto';
    bar.style.background = 'linear-gradient(90deg, ' + cfg.bar_gradient + ')';
    bar.style.backgroundSize = '200% 100%';

    // Blur overlay
    var blur = this._globalUI.querySelector('.vs-blur-overlay');
    if (cfg.background_blur) {
      blur.style.backdropFilter = 'blur(' + cfg.background_blur_intensity + 'px)';
      blur.style.webkitBackdropFilter = 'blur(' + cfg.background_blur_intensity + 'px)';
    } else {
      blur.style.backdropFilter = 'none';
      blur.style.webkitBackdropFilter = 'none';
    }

    // Chat container positioning
    var bubbleGap = 12;
    var barH = cfg.bar_height || 6;
    var chat = this._globalUI.querySelector('.vs-chat-container');
    if (cfg.bar_position === 'bottom') {
      chat.style.bottom = (barH + bubbleGap) + 'px';
      chat.style.top = 'auto';
    } else {
      chat.style.bottom = bubbleGap + 'px';
      chat.style.top = 'auto';
    }
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  _setState(newState) {
    var oldState = this._state;
    this._state = newState;
    this._log('state', oldState + ' → ' + newState)
    this._updateUI();
  }

  _updateUI() {
    if (!this._globalUI) return;

    var states = {
      IDLE:               { barVisible: false },
      CONNECTING:         { barVisible: false },
      LISTENING:          { barVisible: false },
      PAUSED:             { barVisible: false },
      WAKE_WORD_DETECTED: { barVisible: true, animation: 'listening' },
      STT:                { barVisible: true, animation: 'listening' },
      INTENT:             { barVisible: true, animation: 'processing' },
      TTS:                { barVisible: true, animation: 'speaking' },
      ERROR:              { barVisible: false }
    };

    var config = states[this._state];
    if (!config) return;

    // If service unavailable (error state), keep red bar visible
    if (this._serviceUnavailable && !config.barVisible) {
      return;
    }

    // If TTS audio is still playing, keep the bar visible in speaking mode
    // even if the pipeline has restarted and state moved to LISTENING/IDLE
    if (this._ttsPlaying && !config.barVisible) {
      return;
    }

    var bar = this._globalUI.querySelector('.vs-rainbow-bar');

    if (config.barVisible) {
      // Transitioning to an active state — restore rainbow gradient if needed
      if (bar.classList.contains('error-mode')) {
        this._clearErrorBar();
      }
      bar.classList.add('visible');
      bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
      if (config.animation) {
        bar.classList.add(config.animation);
      }
    } else {
      if (bar.classList.contains('error-mode')) {
        this._clearErrorBar();
      }
      bar.classList.remove('visible', 'connecting', 'listening', 'processing', 'speaking');
    }
  }

  // --------------------------------------------------------------------------
  // Start / Stop Listening
  // --------------------------------------------------------------------------

  async _startListening() {
    if (window._voiceSatelliteActive && window._voiceSatelliteInstance !== this) {
      this._log('lifecycle', 'Another instance is active, skipping')
      return;
    }
    if (window._voiceSatelliteStarting) {
      this._log('lifecycle', 'Pipeline already starting globally, skipping')
      return;
    }

    window._voiceSatelliteStarting = true;

    try {
      this._setState(State.CONNECTING);
      await this._startMicrophone();
      await this._startPipeline();

      window._voiceSatelliteActive = true;
      window._voiceSatelliteInstance = this;
      this._hideStartButton();
    } catch (e) {
      this._logError('pipeline', 'Failed to start: ' + e);

      // Determine what went wrong and show an appropriate start button
      var reason = 'error';
      if (e.name === 'NotAllowedError') {
        // Could be either: user denied permission, OR no user gesture yet.
        // Browsers throw NotAllowedError for both cases.
        // Show mic button so user can tap to provide the gesture / re-prompt.
        reason = 'not-allowed';
        this._log('mic', 'Access denied — browser requires user gesture');
      } else if (e.name === 'NotFoundError') {
        reason = 'not-found';
        this._logError('mic', 'No microphone found');
      } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
        reason = 'not-readable';
        this._logError('mic', 'Microphone in use or not readable');
      }

      this._showStartButton(reason);
      this._setState(State.IDLE);
    } finally {
      window._voiceSatelliteStarting = false;
    }
  }

  // --------------------------------------------------------------------------
  // Microphone
  // --------------------------------------------------------------------------

  async _startMicrophone() {
    await this._ensureAudioContextRunning();

    this._log('mic', 'AudioContext state=' + this._audioContext.state +
                  ' sampleRate=' + this._audioContext.sampleRate)

    var audioConstraints = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: this._config.echo_cancellation,
      noiseSuppression: this._config.noise_suppression,
      autoGainControl: this._config.auto_gain_control
    };

    // voiceIsolation is Chrome-only; use advanced so unsupported browsers ignore it
    if (this._config.voice_isolation) {
      audioConstraints.advanced = [{ voiceIsolation: true }];
    }

    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });

    if (this._config.debug) {
      var tracks = this._mediaStream.getAudioTracks();
      this._log('mic', 'Got media stream with ' + tracks.length + ' audio track(s)');
      if (tracks.length > 0) {
        var settings = tracks[0].getSettings();
        this._log('mic', 'Track settings: ' + JSON.stringify(settings));
      }
    }

    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._actualSampleRate = this._audioContext.sampleRate;

    this._log('mic', 'Actual sample rate: ' + this._actualSampleRate)

    // Try AudioWorklet, fall back to ScriptProcessor
    try {
      await this._setupAudioWorklet(this._sourceNode);
      this._log('mic', 'Audio capture via AudioWorklet')
    } catch (e) {
      this._log('mic', 'AudioWorklet unavailable (' + e.message + '), using ScriptProcessor');
      this._setupScriptProcessor(this._sourceNode);
      this._log('mic', 'Audio capture via ScriptProcessor')
    }
  }

  _stopMicrophone() {
    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._scriptProcessor) {
      this._scriptProcessor.disconnect();
      this._scriptProcessor = null;
    }
    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(function (track) { track.stop(); });
      this._mediaStream = null;
    }
    this._audioBuffer = [];
  }

  async _ensureAudioContextRunning() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
    }
    if (this._audioContext.state === 'suspended') {
      this._log('mic', 'Resuming suspended AudioContext')
      await this._audioContext.resume();
    }
    if (this._audioContext.state !== 'running') {
      throw new Error('AudioContext failed to start: ' + this._audioContext.state);
    }
  }

  async _setupAudioWorklet(sourceNode) {
    var workletCode =
      'class VoiceSatelliteProcessor extends AudioWorkletProcessor {' +
        'constructor() { super(); this.buffer = []; }' +
        'process(inputs, outputs, parameters) {' +
          'var input = inputs[0];' +
          'if (input && input[0]) {' +
            'var channelData = new Float32Array(input[0]);' +
            'this.port.postMessage(channelData);' +
          '}' +
          'return true;' +
        '}' +
      '}' +
      'registerProcessor("voice-satellite-processor", VoiceSatelliteProcessor);';

    var blob = new Blob([workletCode], { type: 'application/javascript' });
    var workletUrl = URL.createObjectURL(blob);
    await this._audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this._workletNode = new AudioWorkletNode(this._audioContext, 'voice-satellite-processor');
    var self = this;
    this._workletNode.port.onmessage = function (e) {
      self._audioBuffer.push(new Float32Array(e.data));
    };
    sourceNode.connect(this._workletNode);
    this._workletNode.connect(this._audioContext.destination);
  }

  _setupScriptProcessor(sourceNode) {
    this._scriptProcessor = this._audioContext.createScriptProcessor(2048, 1, 1);
    var self = this;
    this._scriptProcessor.onaudioprocess = function (e) {
      var inputData = e.inputBuffer.getChannelData(0);
      self._audioBuffer.push(new Float32Array(inputData));
    };
    sourceNode.connect(this._scriptProcessor);
    this._scriptProcessor.connect(this._audioContext.destination);
  }

  // --------------------------------------------------------------------------
  // Audio Processing
  // --------------------------------------------------------------------------

  _sendAudioBuffer() {
    if (this._binaryHandlerId === null || this._binaryHandlerId === undefined) return;
    if (this._audioBuffer.length === 0) return;

    // Combine all chunks
    var totalLength = 0;
    for (var i = 0; i < this._audioBuffer.length; i++) {
      totalLength += this._audioBuffer[i].length;
    }
    var combined = new Float32Array(totalLength);
    var offset = 0;
    for (var i = 0; i < this._audioBuffer.length; i++) {
      combined.set(this._audioBuffer[i], offset);
      offset += this._audioBuffer[i].length;
    }
    this._audioBuffer = [];

    // Resample if needed
    if (this._actualSampleRate !== 16000) {
      combined = this._resample(combined, this._actualSampleRate, 16000);
    }

    // Convert and send
    var pcmData = this._floatTo16BitPCM(combined);
    this._sendBinaryAudio(pcmData);


  }

  _resample(inputSamples, fromSampleRate, toSampleRate) {
    if (fromSampleRate === toSampleRate) return inputSamples;

    var ratio = fromSampleRate / toSampleRate;
    var outputLength = Math.round(inputSamples.length / ratio);
    var output = new Float32Array(outputLength);

    for (var i = 0; i < outputLength; i++) {
      var srcIndex = i * ratio;
      var low = Math.floor(srcIndex);
      var high = Math.min(low + 1, inputSamples.length - 1);
      var frac = srcIndex - low;
      output[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
    }
    return output;
  }

  _floatTo16BitPCM(float32Array) {
    var pcmData = new Int16Array(float32Array.length);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcmData;
  }

  _sendBinaryAudio(pcmData) {
    if (this._binaryHandlerId === null || this._binaryHandlerId === undefined) return;
    if (!this._connection || !this._connection.socket) return;

    // Don't send if WebSocket is closing or closed
    if (this._connection.socket.readyState !== WebSocket.OPEN) return;

    var message = new Uint8Array(1 + pcmData.byteLength);
    message[0] = this._binaryHandlerId;
    message.set(new Uint8Array(pcmData.buffer), 1);
    this._connection.socket.send(message.buffer);
  }

  // --------------------------------------------------------------------------
  // Pipeline
  // --------------------------------------------------------------------------

  async _startPipeline(options) {
    var self = this;
    var opts = options || {};

    if (!this._connection) {
      if (this._hass && this._hass.connection) {
        this._connection = this._hass.connection;
      } else {
        throw new Error('No Home Assistant connection available');
      }
    }

    // Get available pipelines
    var pipelines = await this._connection.sendMessagePromise({
      type: 'assist_pipeline/pipeline/list'
    });

    this._log('pipeline', 'Available: ' + pipelines.pipelines.map(function(p) {
        return p.name + ' (' + p.id + ')' + (p.preferred ? ' [preferred]' : '');
      }).join(', '));

    // Select pipeline
    var pipelineId = this._config.pipeline_id;
    if (!pipelineId) {
      var preferred = pipelines.pipelines.find(function (p) { return p.preferred; });
      pipelineId = preferred ? preferred.id : pipelines.pipelines[0].id;
    }

    this._log('pipeline', 'Starting pipeline: ' + pipelineId);

    // Subscribe to pipeline events
    var startStage = opts.start_stage || 'wake_word';
    var runConfig = {
      type: 'assist_pipeline/run',
      start_stage: startStage,
      end_stage: 'tts',
      input: {
        sample_rate: 16000,
        timeout: startStage === 'wake_word' ? 0 : undefined  // Only needed for wake_word stage
      },
      pipeline: pipelineId,
      timeout: this._config.pipeline_timeout
    };

    // Pass conversation_id for continue conversation
    if (opts.conversation_id) {
      runConfig.conversation_id = opts.conversation_id;
    }

    // Remove undefined values (input.timeout for STT mode)
    if (runConfig.input.timeout === undefined) {
      delete runConfig.input.timeout;
    }

    this._log('pipeline', 'Run config: ' + JSON.stringify(runConfig));

    this._unsubscribe = await this._connection.subscribeMessage(
      function (message) {
        self._handlePipelineMessage(message);
      },
      runConfig
    );

    this._log('pipeline', 'Subscribed, waiting for run-start...');

    // Start sending audio
    this._sendInterval = setInterval(function () {
      self._sendAudioBuffer();
    }, 100);

    this._isStreaming = true;
    this._startIdleTimeout();
  }

  async _stopPipeline() {
    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
    this._binaryHandlerId = null;
    this._isStreaming = false;

    if (this._unsubscribe) {
      try {
        await this._unsubscribe();
      } catch (e) {
        // Ignore unsubscribe errors
      }
      this._unsubscribe = null;
    }

    this._clearIdleTimeout();
  }

  _restartPipeline(delay) {
    var self = this;

    // Prevent concurrent restarts — if one is already in flight, skip
    if (this._isRestarting) {
      this._log('pipeline', 'Restart already in progress — skipping');
      return;
    }
    this._isRestarting = true;

    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }

    // Clear idle timeout to prevent it from triggering during restart
    this._clearIdleTimeout();

    // _stopPipeline is async (awaits unsubscribe). We must wait for it
    // to complete before scheduling the new pipeline to avoid stale
    // subscriptions piling up.
    var stopPromise = this._stopPipeline();
    stopPromise.then(function () {
      self._restartTimeout = setTimeout(function () {
        self._restartTimeout = null;
        self._isRestarting = false;
        self._startPipeline().catch(function (e) {
          self._logError('pipeline', 'Restart failed: ' + e);

          // Show error bar on connection/startup failures too
          if (!self._serviceUnavailable) {
            self._showErrorBar();
            self._serviceUnavailable = true;
          }

          self._restartPipeline(self._calculateRetryDelay());
        });
      }, delay || 0);
    });
  }

  _restartPipelineContinue(conversationId) {
    var self = this;

    if (this._isRestarting) {
      this._log('pipeline', 'Restart already in progress — skipping continue');
      return;
    }
    this._isRestarting = true;
    this._clearIdleTimeout();

    var stopPromise = this._stopPipeline();
    stopPromise.then(function () {
      self._isRestarting = false;
      self._continueMode = true;
      self._startPipeline({
        start_stage: 'stt',
        conversation_id: conversationId
      }).catch(function (e) {
        self._logError('pipeline', 'Continue conversation failed: ' + e);
        // Fall back to normal wake word mode
        self._chatClear();
        self._hideBlurOverlay();
        self._restartPipeline(0);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Pipeline Message Handling
  // --------------------------------------------------------------------------

  _handlePipelineMessage(message) {
    // Ignore pipeline events while paused — the server may still send events
    // (stt-end, intent-end, tts-end) after we've cleaned up the UI on tab hide.
    if (this._isPaused) {
      this._log('event', 'Ignoring event while paused: ' + message.type);
      return;
    }

    // HA's assist_pipeline/run subscribeMessage delivers events directly as:
    //   { type: "run-start", data: {...}, timestamp: "..." }
    //   { type: "wake_word-end", data: {...}, timestamp: "..." }
    // NOT wrapped in { type: "event", event: {...} }

    var eventType = message.type;
    var eventData = message.data || {};

    if (this._config.debug) {
      var timestamp = message.timestamp ? message.timestamp.split('T')[1].split('.')[0] : '';
      this._log('event', timestamp + ' ' + eventType + ' ' + JSON.stringify(eventData).substring(0, 500));
    }

    switch (eventType) {
      case 'run-start':
        this._handleRunStart(eventData);
        break;
      case 'wake_word-start':
        this._handleWakeWordStart();
        break;
      case 'wake_word-end':
        this._handleWakeWordEnd(eventData);
        break;
      case 'stt-start':
        this._setState(State.STT);
        break;
      case 'stt-vad-start':
        this._log('event', 'VAD: speech started');
        break;
      case 'stt-vad-end':
        this._log('event', 'VAD: speech ended');
        break;
      case 'stt-end':
        this._handleSttEnd(eventData);
        break;
      case 'intent-start':
        this._setState(State.INTENT);
        break;
      case 'intent-progress':
        if (this._config.streaming_response) {
          this._handleIntentProgress(eventData);
        }
        break;
      case 'intent-end':
        this._handleIntentEnd(eventData);
        break;
      case 'tts-start':
        this._setState(State.TTS);
        break;
      case 'tts-end':
        this._handleTtsEnd(eventData);
        break;
      case 'run-end':
        this._handleRunEnd();
        break;
      case 'error':
        this._handlePipelineError(eventData);
        break;
    }
  }

  _handleRunStart(eventData) {
    this._binaryHandlerId = eventData.runner_data.stt_binary_handler_id;
    this._resetIdleTimeout();

    // Store streaming TTS URL if provided upfront by HA
    this._streamingTtsUrl = null;
    if (eventData.tts_output && eventData.tts_output.url && eventData.tts_output.stream_response) {
      var url = eventData.tts_output.url;
      this._streamingTtsUrl = url.startsWith('http') ? url : window.location.origin + url;
      this._log('tts', 'Streaming TTS URL available: ' + this._streamingTtsUrl);
    }

    // In continue conversation mode, go straight to STT state
    // to keep the bar visible (user is expected to speak immediately)
    if (this._continueMode) {
      this._continueMode = false;
      this._setState(State.STT);
      this._log('pipeline', 'Running (continue conversation) — binary handler ID: ' + this._binaryHandlerId);
      this._log('pipeline', 'Listening for speech...');
      return;
    }

    this._setState(State.LISTENING);
    this._log('pipeline', 'Running — binary handler ID: ' + this._binaryHandlerId);
    this._log('pipeline', 'Listening for wake word...');
  }

  _handleWakeWordStart() {
    // When the wake word service is down, wake_word-start is immediately
    // followed by wake_word-end with empty output (within milliseconds).
    // If 2 seconds pass without that, the service is healthy — clear error state.
    if (this._serviceUnavailable) {
      var self = this;
      if (this._recoveryTimeout) clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = setTimeout(function () {
        if (self._serviceUnavailable) {
          self._log('recovery', 'Wake word service recovered');
          self._serviceUnavailable = false;
          self._retryCount = 0;
          self._clearErrorBar();
          self._globalUI.querySelector('.vs-rainbow-bar').classList.remove('visible');
        }
      }, 2000);
    }
  }

  _handleWakeWordEnd(eventData) {
    // If wake_word_output is empty, the wake word service is unavailable.
    var wakeOutput = eventData.wake_word_output;
    if (!wakeOutput || Object.keys(wakeOutput).length === 0) {
      this._logError('error', 'Wake word service unavailable (empty wake_word_output)');

      // Cancel any pending recovery — service is still down
      if (this._recoveryTimeout) {
        clearTimeout(this._recoveryTimeout);
        this._recoveryTimeout = null;
      }

      this._binaryHandlerId = null;

      this._showErrorBar();
      this._serviceUnavailable = true;
      this._restartPipeline(this._calculateRetryDelay());
      return;
    }

    // Valid wake word detected — service is healthy, reset error state
    if (this._recoveryTimeout) {
      clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = null;
    }
    this._serviceUnavailable = false;
    this._retryCount = 0;
    this._clearErrorBar();

    // If TTS is still playing from a previous interaction, stop it
    if (this._ttsPlaying) {
      this._stopTTS();
      this._pendingRunEnd = false;
    }
    // Cancel any pending intent error bar timeout
    if (this._intentErrorBarTimeout) {
      clearTimeout(this._intentErrorBarTimeout);
      this._intentErrorBarTimeout = null;
    }
    // Clear any leftover UI from previous interaction
    this._chatClear();
    this._hideTranscription();
    this._hideResponse();

    // Clear continue conversation state — new wake word starts fresh
    this._shouldContinue = false;
    this._continueConversationId = null;

    this._setState(State.WAKE_WORD_DETECTED);
    this._resetIdleTimeout();

    if (this._config.chime_on_wake_word) {
      this._playChime('wake');
    }
    this._turnOffWakeWordSwitch();
    this._showBlurOverlay();
  }

  _handleSttEnd(eventData) {
    var text = eventData.stt_output ? eventData.stt_output.text : '';
    if (text) {
      this._showTranscription(text);
    }
  }

  _handleIntentEnd(eventData) {
    // Check if the intent response is an error (e.g. LLM service down)
    var responseType = null;
    try {
      responseType = eventData.intent_output.response.response_type;
    } catch (e) { /* ignore */ }

    if (responseType === 'error') {
      var errorText = this._extractResponseText(eventData) || 'An error occurred';
      this._logError('error', 'Intent error: ' + errorText);

      // Show the red error bar and play error chime
      this._showErrorBar();
      if (this._config.chime_on_wake_word) {
        this._playChime('error');
      }

      // Suppress TTS for this interaction
      this._suppressTTS = true;

      // Auto-hide error bar after 3 seconds
      var self = this;
      if (this._intentErrorBarTimeout) clearTimeout(this._intentErrorBarTimeout);
      this._intentErrorBarTimeout = setTimeout(function () {
        self._intentErrorBarTimeout = null;
        self._clearErrorBar();
        if (self._globalUI) {
          self._globalUI.querySelector('.vs-rainbow-bar').classList.remove('visible');
        }
      }, 3000);

      // Clear streaming accumulator
      this._streamedResponse = '';
      return;
    }

    var responseText = this._extractResponseText(eventData);
    if (responseText) {
      this._showResponse(responseText);
    }

    // Check if the conversation agent wants to continue the conversation
    this._shouldContinue = false;
    this._continueConversationId = null;
    if (this._config.continue_conversation) {
      try {
        if (eventData.intent_output.continue_conversation === true) {
          this._shouldContinue = true;
          this._continueConversationId = eventData.intent_output.conversation_id || null;
          this._log('pipeline', 'Continue conversation requested — id: ' + this._continueConversationId);
        }
      } catch (e) { /* ignore */ }
    }

    // Clear streaming accumulator
    this._streamedResponse = '';
    this._chatStreamEl = null;
  }

  _handleIntentProgress(eventData) {
    // HA signals that TTS has started generating audio from partial text.
    // Start playing the streaming TTS URL immediately — don't wait for tts-end.
    // NOTE: We do NOT restart the pipeline here for barge-in because text chunks
    // (intent-progress) keep arriving after tts_start_streaming. Restarting would
    // unsubscribe and lose those remaining chunks. The pipeline restart happens
    // later in _handleTtsEnd (which skips duplicate playback if already streaming).
    if (eventData.tts_start_streaming && this._streamingTtsUrl && !this._ttsPlaying) {
      this._log('tts', 'Streaming TTS started — playing early');
      this._setState(State.TTS);
      this._playTTS(this._streamingTtsUrl);
      this._streamingTtsUrl = null;  // consumed
    }

    // HA sends streaming chunks as: { chat_log_delta: { content: " word" } }
    // The first chunk may be { chat_log_delta: { role: "assistant" } } with no content.
    if (!eventData.chat_log_delta) return;

    var chunk = eventData.chat_log_delta.content;
    if (typeof chunk !== 'string') return;

    this._streamedResponse = (this._streamedResponse || '') + chunk;
    this._updateResponse(this._streamedResponse);
  }

  _handleTtsEnd(eventData) {
    // If intent returned an error, suppress TTS playback
    if (this._suppressTTS) {
      this._suppressTTS = false;
      this._log('tts', 'TTS suppressed (intent error)');
      this._restartPipeline(0);
      return;
    }

    // If streaming TTS is already playing (started early via tts_start_streaming),
    // don't start playback again — just restart the pipeline for barge-in.
    if (this._ttsPlaying) {
      this._log('tts', 'Streaming TTS already playing — skipping duplicate playback');
      this._restartPipeline(0);
      return;
    }

    var url = eventData.tts_output ? (eventData.tts_output.url || eventData.tts_output.url_path) : null;
    if (url) {
      this._playTTS(url);
    }

    // Restart the pipeline immediately so it listens for the wake word
    // while TTS is playing. This allows the user to interrupt TTS by
    // saying the wake word — the new wake_word-end will stop playback.
    this._restartPipeline(0);
  }

  _handleRunEnd() {
    this._log('pipeline', 'Run ended')

    this._binaryHandlerId = null;

    // If a restart is already in progress (e.g. idle timeout fired), skip
    if (this._isRestarting) {
      this._log('pipeline', 'Restart already in progress — skipping run-end restart');
      return;
    }

    // If error recovery is already handling the restart, don't interfere
    if (this._serviceUnavailable) {
      this._log('ui', 'Error recovery handling restart')
      this._hideBlurOverlay();
      this._hideTranscription();
      this._hideResponse();
      return;
    }

    // If TTS is still playing, defer UI cleanup and pipeline restart
    // until playback completes. HA sends run-end as soon as the TTS URL
    // is dispatched, but the browser still needs time to play the audio.
    if (this._ttsPlaying) {
      this._log('ui', 'TTS playing — deferring cleanup')
      this._pendingRunEnd = true;
      return;
    }

    this._finishRunEnd();
  }

  _finishRunEnd() {
    this._pendingRunEnd = false;
    this._chatClear();
    this._hideBlurOverlay();
    this._hideTranscription();
    this._hideResponse();
    this._setState(State.IDLE);

    // Don't restart if we're already in error recovery with backoff
    if (this._serviceUnavailable) {
      this._log('ui', 'Retry already scheduled — skipping restart')
      return;
    }

    // Restart pipeline immediately
    this._restartPipeline(0);
  }

  _handlePipelineError(errorData) {
    var errorCode = errorData.code || '';
    var errorMessage = errorData.message || '';

    this._log('error', errorCode + ' — ' + errorMessage)

    // Expected errors — immediate restart, no error UI
    if (EXPECTED_ERRORS.indexOf(errorCode) !== -1) {
      this._log('pipeline', 'Expected error: ' + errorCode + ' — restarting');

      // stt-no-text-recognized happens after wake word detection, so the
      // blur overlay and bubbles are still visible. Clean them up and play
      // the done chime so the user knows the interaction ended.
      var interactingStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (interactingStates.indexOf(this._state) !== -1) {
        this._log('ui', 'Cleaning up interaction UI after expected error');
        this._setState(State.IDLE);
        this._chatClear();
        this._hideBlurOverlay();
        this._hideTranscription();
        this._hideResponse();
        // Clear continue conversation state — fall back to wake word mode
        this._shouldContinue = false;
        this._continueConversationId = null;
        var isRemote = this._config.tts_target && this._config.tts_target !== 'browser';
        if (this._config.chime_on_request_sent && !isRemote) {
          this._playChime('done');
        }
      }

      this._restartPipeline(0);
      return;
    }

    // Unexpected errors — full error handling
    this._logError('error', 'Unexpected: ' + errorCode + ' — ' + errorMessage);

    // Only play error chime if user was actively interacting
    // (after wake word detection, during STT, intent processing, or TTS)
    var interactingStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
    var wasInteracting = interactingStates.indexOf(this._state) !== -1;

    this._binaryHandlerId = null;

    if (wasInteracting && this._config.chime_on_wake_word) {
      this._playChime('error');
    }
    this._showErrorBar();
    this._serviceUnavailable = true;
    this._chatClear();
    this._hideBlurOverlay();

    this._restartPipeline(this._calculateRetryDelay());
  }

  _extractResponseText(eventData) {
    // Primary path
    try {
      var text = eventData.intent_output.response.speech.plain.speech;
      if (text) return text;
    } catch (e) { /* ignore */ }

    // Fallbacks
    try { if (eventData.intent_output.response.speech.speech) return eventData.intent_output.response.speech.speech; } catch (e) { /* ignore */ }
    try { if (eventData.intent_output.response.plain) return eventData.intent_output.response.plain; } catch (e) { /* ignore */ }
    try { if (typeof eventData.intent_output.response === 'string') return eventData.intent_output.response; } catch (e) { /* ignore */ }

    this._log('error', 'Could not extract response text')
    return null;
  }

  // --------------------------------------------------------------------------
  // Error Recovery
  // --------------------------------------------------------------------------

  _calculateRetryDelay() {
    // Linear backoff: 5s, 10s, 15s, 20s, 25s, 30s (capped)
    this._retryCount++;
    var delay = Math.min(5000 * this._retryCount, 30000);
    this._log('pipeline', 'Retry in ' + delay + 'ms (attempt #' + this._retryCount + ')');
    return delay;
  }

  // --------------------------------------------------------------------------
  // Idle Timeout (TTS Token Refresh)
  // --------------------------------------------------------------------------

  _startIdleTimeout() {
    var self = this;
    this._clearIdleTimeout();

    if (this._config.pipeline_idle_timeout <= 0) return;

    this._idleTimeoutId = setTimeout(function () {
      // Don't restart if user is mid-interaction
      var activeStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (activeStates.indexOf(self._state) !== -1) {
        self._log('pipeline', 'Idle timeout fired but interaction in progress — deferring');
        self._resetIdleTimeout();
        return;
      }
      // Don't restart if TTS is still playing (pipeline may have restarted for barge-in)
      if (self._ttsPlaying) {
        self._log('pipeline', 'Idle timeout fired but TTS playing — deferring');
        self._resetIdleTimeout();
        return;
      }

      self._log('pipeline', 'Idle timeout — restarting');
      self._restartPipeline(0);
    }, this._config.pipeline_idle_timeout * 1000);
  }

  _clearIdleTimeout() {
    if (this._idleTimeoutId) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  _resetIdleTimeout() {
    this._startIdleTimeout();
  }

  // --------------------------------------------------------------------------
  // UI Methods
  // --------------------------------------------------------------------------

  _showStartButton(reason) {
    if (!this._globalUI) {
      // Global UI not ready yet — defer until it is
      var self = this;
      this._pendingStartButtonReason = reason;
      return;
    }
    var btn = this._globalUI.querySelector('.vs-start-btn');
    btn.classList.add('visible');

    // Set tooltip based on failure reason
    if (reason === 'not-allowed') {
      btn.title = 'Tap to enable microphone';
    } else if (reason === 'not-found') {
      btn.title = 'No microphone found';
    } else if (reason === 'not-readable') {
      btn.title = 'Microphone unavailable - tap to retry';
    } else {
      btn.title = 'Tap to start voice assistant';
    }
  }

  _hideStartButton() {
    if (!this._globalUI) return;
    this._globalUI.querySelector('.vs-start-btn').classList.remove('visible');
  }

  _showBlurOverlay() {
    if (!this._globalUI || !this._config.background_blur) return;
    this._globalUI.querySelector('.vs-blur-overlay').classList.add('visible');
  }

  _hideBlurOverlay() {
    if (!this._globalUI) return;
    this._globalUI.querySelector('.vs-blur-overlay').classList.remove('visible');
  }

  // --------------------------------------------------------------------------
  // Chat Container
  // --------------------------------------------------------------------------

  // Legacy API wrappers — route to chat container
  _showTranscription(text) {
    if (!this._config.show_transcription) return;
    this._chatAddUser(text);
  }

  _hideTranscription() {
    // No-op: chat messages persist until _chatClear
  }

  _showResponse(text) {
    if (!this._config.show_response) return;
    // If streaming already created a bubble, set final text (no fade)
    if (this._chatStreamEl) {
      this._chatStreamEl.textContent = text;
    } else {
      this._chatAddAssistant(text);
    }
  }

  _updateResponse(text) {
    if (!this._config.show_response) return;
    if (!this._chatStreamEl) {
      this._chatAddAssistant(text);
    } else {
      this._chatUpdateAssistant(text);
    }
  }

  _hideResponse() {
    // No-op: chat messages persist until _chatClear
  }

  _chatAddUser(text) {
    if (!this._globalUI) return;
    var cfg = this._config;
    var container = this._globalUI.querySelector('.vs-chat-container');
    container.classList.add('visible');

    var msg = document.createElement('div');
    msg.className = 'vs-chat-msg user';
    msg.textContent = text;
    msg.style.fontSize = cfg.transcription_font_size + 'px';
    msg.style.fontFamily = cfg.transcription_font_family;
    msg.style.color = cfg.transcription_font_color;
    msg.style.fontWeight = cfg.transcription_font_bold ? 'bold' : 'normal';
    msg.style.fontStyle = cfg.transcription_font_italic ? 'italic' : 'normal';
    msg.style.background = cfg.transcription_background;
    msg.style.border = '3px solid ' + cfg.transcription_border_color;
    msg.style.padding = cfg.transcription_padding + 'px';
    msg.style.borderRadius = cfg.transcription_rounded ? '12px' : '0';
    container.appendChild(msg);
  }

  _chatAddAssistant(text) {
    if (!this._globalUI) return;
    var cfg = this._config;
    var container = this._globalUI.querySelector('.vs-chat-container');
    container.classList.add('visible');

    var msg = document.createElement('div');
    msg.className = 'vs-chat-msg assistant';
    msg.textContent = text;
    msg.style.fontSize = cfg.response_font_size + 'px';
    msg.style.fontFamily = cfg.response_font_family;
    msg.style.color = cfg.response_font_color;
    msg.style.fontWeight = cfg.response_font_bold ? 'bold' : 'normal';
    msg.style.fontStyle = cfg.response_font_italic ? 'italic' : 'normal';
    msg.style.background = cfg.response_background;
    msg.style.border = '3px solid ' + cfg.response_border_color;
    msg.style.padding = cfg.response_padding + 'px';
    msg.style.borderRadius = cfg.response_rounded ? '12px' : '0';
    container.appendChild(msg);

    this._chatStreamEl = msg;
  }

  _chatUpdateAssistant(text) {
    if (!this._chatStreamEl) return;

    // Apply a trailing character fade: the last FADE_LEN characters get
    // decreasing opacity so new text appears to flow in smoothly.
    var FADE_LEN = 24;
    if (text.length <= FADE_LEN) {
      this._chatStreamEl.textContent = text;
      return;
    }

    var solid = text.slice(0, text.length - FADE_LEN);
    var tail = text.slice(text.length - FADE_LEN);

    // Build HTML: solid text + faded tail spans
    var html = this._escapeHtml(solid);
    for (var i = 0; i < tail.length; i++) {
      var opacity = ((FADE_LEN - i) / FADE_LEN).toFixed(2);
      html += '<span style="opacity:' + opacity + '">' + this._escapeHtml(tail[i]) + '</span>';
    }
    this._chatStreamEl.innerHTML = html;
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _chatClear() {
    if (!this._globalUI) return;
    var container = this._globalUI.querySelector('.vs-chat-container');
    container.innerHTML = '';
    container.classList.remove('visible');
    this._chatStreamEl = null;
  }

  _showErrorBar() {
    if (!this._globalUI) return;
    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
    bar.classList.add('visible', 'error-mode');
    // Override the inline background set by _applyStyles
    bar.style.background = 'linear-gradient(90deg, #ff4444, #ff6666, #cc2222, #ff4444, #ff6666, #cc2222)';
    bar.style.backgroundSize = '200% 100%';
  }

  _clearErrorBar() {
    if (!this._globalUI) return;
    var bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('error-mode');
    // Restore the rainbow gradient from config
    bar.style.background = 'linear-gradient(90deg, ' + this._config.bar_gradient + ')';
    bar.style.backgroundSize = '200% 100%';
  }

  // --------------------------------------------------------------------------
  // Chimes (Web Audio API)
  // --------------------------------------------------------------------------

  _playChime(type) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      var volume = (this._config.chime_volume / 100) * 0.5;

      if (type === 'wake') {
        osc.type = 'sine';
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.16);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'error') {
        osc.type = 'square';
        gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.setValueAtTime(200, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else {
        // done chime
        osc.type = 'sine';
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.frequency.setValueAtTime(784, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }

      // Clean up context after chime
      setTimeout(function () { ctx.close(); }, 500);
    } catch (e) {
      this._logError('tts', 'Chime error: ' + e);
    }
  }

  // --------------------------------------------------------------------------
  // TTS Playback
  // --------------------------------------------------------------------------

  _playTTS(urlPath) {
    var self = this;
    var url = this._buildTtsUrl(urlPath);
    this._ttsPlaying = true;

    // Remote media player target
    if (this._config.tts_target && this._config.tts_target !== 'browser') {
      this._playTTSRemote(url);
      return;
    }

    // Browser playback (default)
    var audio = new Audio();
    audio.volume = this._config.tts_volume / 100;

    audio.onended = function () {
      self._log('tts', 'Playback complete');
      self._onTTSComplete();
    };

    audio.onerror = function (e) {
      self._logError('tts', 'Playback error: ' + e);
      self._logError('tts', 'URL: ' + url);
      self._onTTSComplete();
    };

    audio.src = url;
    audio.play().catch(function (e) {
      self._logError('tts', 'play() failed: ' + e);
      self._onTTSComplete();
    });

    this._currentAudio = audio;
  }

  _playTTSRemote(url) {
    var self = this;
    var entityId = this._config.tts_target;

    this._log('tts', 'Playing on remote: ' + entityId + ' URL: ' + url);

    this._hass.callService('media_player', 'play_media', {
      entity_id: entityId,
      media_content_id: url,
      media_content_type: 'music'
    }).catch(function (e) {
      self._logError('tts', 'Remote play failed: ' + e);
    });

    // For remote playback, we don't know when TTS finishes.
    // Hide UI after a short delay so the user can read the response bubble,
    // then clean up. Done chime is skipped for remote playback.
    this._ttsEndTimer = setTimeout(function () {
      self._ttsEndTimer = null;
      self._onTTSComplete();
    }, 2000);
  }

  _onTTSComplete() {
    this._log('tts', 'Complete — cleaning up UI');
    this._currentAudio = null;
    this._ttsPlaying = false;

    if (this._ttsEndTimer) {
      clearTimeout(this._ttsEndTimer);
      this._ttsEndTimer = null;
    }

    // If a new interaction is already in progress (user said wake word
    // during TTS), don't touch the UI — it belongs to the new interaction.
    var activeInteraction = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
    if (activeInteraction.indexOf(this._state) !== -1) {
      this._log('tts', 'New interaction in progress — skipping cleanup');
      return;
    }

    // Continue conversation: skip wake word, go straight to STT
    if (this._shouldContinue && this._continueConversationId) {
      this._log('pipeline', 'Continuing conversation — skipping wake word');
      this._shouldContinue = false;
      var conversationId = this._continueConversationId;
      this._continueConversationId = null;
      this._chatStreamEl = null;

      // Keep blur, bar, and chat messages visible — user is still in conversation
      this._restartPipelineContinue(conversationId);
      return;
    }

    // Normal completion — play done chime and clean up
    var isRemote = this._config.tts_target && this._config.tts_target !== 'browser';
    if (this._config.chime_on_request_sent && !isRemote) {
      this._playChime('done');
    }

    this._chatClear();
    this._hideBlurOverlay();
    // Re-evaluate bar visibility now that TTS is done
    this._updateUI();
  }

  _stopTTS() {
    this._ttsPlaying = false;

    // Clear remote playback timer
    if (this._ttsEndTimer) {
      clearTimeout(this._ttsEndTimer);
      this._ttsEndTimer = null;
    }

    // Stop browser audio
    if (this._currentAudio) {
      this._currentAudio.onended = null;
      this._currentAudio.onerror = null;
      this._currentAudio.pause();
      this._currentAudio.src = '';
      this._currentAudio = null;
    }

    // Stop remote media player
    if (this._config.tts_target && this._config.tts_target !== 'browser' && this._hass) {
      var self = this;
      this._hass.callService('media_player', 'media_stop', {
        entity_id: this._config.tts_target
      }).catch(function (e) {
        self._logError('tts', 'Remote stop failed: ' + e);
      });
    }
  }

  _buildTtsUrl(urlPath) {
    if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
      return urlPath;
    }
    // Use window.location.origin as the reliable base URL.
    // hass.hassUrl may be a URL object, undefined, or other non-string types.
    var baseUrl = window.location.origin;
    if (!urlPath.startsWith('/')) {
      urlPath = '/' + urlPath;
    }
    return baseUrl + urlPath;
  }

  // --------------------------------------------------------------------------
  // Home Assistant Service Calls
  // --------------------------------------------------------------------------

  _turnOffWakeWordSwitch() {
    if (!this._config.wake_word_switch || !this._hass) return;
    var self = this;

    var entityId = this._config.wake_word_switch;
    if (!entityId.includes('.')) {
      this._log('switch', 'Invalid entity: ' + entityId);
      return;
    }

    this._log('switch', 'Turning off: ' + entityId);

    this._hass.callService('homeassistant', 'turn_off', {
      entity_id: entityId
    }).catch(function (err) {
      self._logError('switch', 'Failed to turn off: ' + err);
    });
  }

  // --------------------------------------------------------------------------
  // Double-Tap to Cancel
  // --------------------------------------------------------------------------

  _setupDoubleTapHandler() {
    var self = this;
    this._lastTapTime = 0;

    this._doubleTapHandler = function (e) {
      // Check if feature is enabled
      if (!self._config.double_tap_cancel) return;

      // Only act during active interactions
      var activeStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (activeStates.indexOf(self._state) === -1 && !self._ttsPlaying) return;

      var now = Date.now();
      var timeSinceLastTap = now - self._lastTapTime;
      self._lastTapTime = now;

      if (timeSinceLastTap < 400 && timeSinceLastTap > 0) {
        // Double-tap detected — cancel interaction
        self._log('ui', 'Double-tap detected — cancelling interaction');
        e.preventDefault();

        // Stop TTS if playing
        if (self._ttsPlaying) {
          self._stopTTS();
        }

        // Clear continue conversation state
        self._shouldContinue = false;
        self._continueConversationId = null;

        // Clean up all UI
        self._chatClear();
        self._hideBlurOverlay();

        // Play done chime to acknowledge cancellation
        var isRemote = self._config.tts_target && self._config.tts_target !== 'browser';
        if (self._config.chime_on_request_sent && !isRemote) {
          self._playChime('done');
        }

        // Restart pipeline fresh in wake word mode
        self._restartPipeline(0);
      }
    };

    document.addEventListener('touchstart', this._doubleTapHandler, { passive: false });
    document.addEventListener('click', this._doubleTapHandler);
  }

  // --------------------------------------------------------------------------
  // Tab Visibility
  // --------------------------------------------------------------------------

  _setupVisibilityHandler() {
    document.addEventListener('visibilitychange', this._handleVisibilityChange);
  }

  _handleVisibilityChangeFn() {
    var self = this;

    if (this._visibilityDebounceTimer) {
      clearTimeout(this._visibilityDebounceTimer);
    }

    if (document.hidden) {
      // Set paused immediately to block pipeline events from re-showing UI
      // during the debounce window. The actual mic pause happens after 500ms.
      this._isPaused = true;

      // If mid-interaction, clean up UI immediately
      var interactingStates = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];
      if (interactingStates.indexOf(this._state) !== -1) {
        this._log('visibility', 'Tab hidden during interaction — cleaning up UI');
        this._chatClear();
        this._hideBlurOverlay();
        this._hideTranscription();
        this._hideResponse();
        this._shouldContinue = false;
        this._continueConversationId = null;
        if (this._ttsPlaying) {
          this._stopTTS();
        }
      }

      this._visibilityDebounceTimer = setTimeout(function () {
        self._log('visibility', 'Tab hidden — pausing mic');
        self._pauseMicrophone();
      }, 500);
    } else {
      self._log('visibility', 'Tab visible — resuming');
      self._resumeMicrophone();
    }
  }

  _pauseMicrophone() {
    this._isPaused = true;
    this._setState(State.PAUSED);

    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }

    if (this._mediaStream) {
      this._mediaStream.getAudioTracks().forEach(function (track) {
        track.enabled = false;
      });
    }
  }

  _resumeMicrophone() {
    if (!this._isPaused) return;
    this._isPaused = false;

    if (this._mediaStream) {
      this._mediaStream.getAudioTracks().forEach(function (track) {
        track.enabled = true;
      });
    }

    var self = this;
    if (!this._sendInterval && this._isStreaming) {
      this._sendInterval = setInterval(function () {
        self._sendAudioBuffer();
      }, 100);
    }

    // Always restart the pipeline fresh on resume. While paused, pipeline
    // events were dropped (_isPaused check in _handlePipelineMessage), so the
    // server-side pipeline likely completed or errored without us processing
    // the run-end. The old subscription is stale — restart in wake word mode.
    // Reset restart guards that may have been left set by an in-flight restart
    // (e.g. _restartPipelineContinue) that was interrupted by the tab switch.
    this._isRestarting = false;
    this._continueMode = false;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
    this._log('visibility', 'Resuming — restarting pipeline');
    this._restartPipeline(0);
  }

  // --------------------------------------------------------------------------
  // Start Button Handler
  // --------------------------------------------------------------------------

  async _handleStartClick() {
    // CRITICAL: This click IS the user gesture that browsers require.
    // We must initiate AudioContext resume and getUserMedia from within
    // this synchronous click handler context. Browsers track the "user
    // activation" state and it can expire if we defer too long.

    // Step 1: Create or resume AudioContext synchronously within the click.
    // This consumes the user gesture for audio policy.
    try {
      if (!this._audioContext) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000
        });
      }
      if (this._audioContext.state === 'suspended') {
        // .resume() must be called in the same event handler as the user gesture
        await this._audioContext.resume();
      }
    } catch (e) {
      this._logError('mic', 'Failed to resume AudioContext on click: ' + e);
    }

    // Step 2: Now start the full listening flow. getUserMedia will succeed
    // because we're still within the user-activation window from the click.
    await this._startListening();
  }
}


// ============================================================================
// VoiceSatelliteCardEditor - Visual Configuration Editor
// ============================================================================

class VoiceSatelliteCardEditor extends HTMLElement {

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
        type: 'assist_pipeline/pipeline/list'
      });
      this._pipelines = result.pipelines || [];
      this._render();
    } catch (e) {
      console.error('[VS][editor] Failed to load pipelines:', e);
    }
  }

  _render() {
    var cfg = this._config;

    // Pipeline options
    var pipelineOptions = '<option value="">Default Pipeline</option>';
    for (var i = 0; i < this._pipelines.length; i++) {
      var p = this._pipelines[i];
      var sel = p.id === cfg.pipeline_id ? ' selected' : '';
      pipelineOptions += '<option value="' + p.id + '"' + sel + '>' + (p.name || p.id) + '</option>';
    }

    // Media player options for TTS target
    var mediaPlayerOptions = '<option value=""' + (!cfg.tts_target ? ' selected' : '') + '>Browser (default)</option>';
    if (this._hass) {
      var states = this._hass.states || {};
      var entityIds = Object.keys(states).filter(function(id) {
        return id.startsWith('media_player.');
      }).sort();
      for (var m = 0; m < entityIds.length; m++) {
        var eid = entityIds[m];
        var friendly = states[eid].attributes.friendly_name || eid;
        var mSel = eid === cfg.tts_target ? ' selected' : '';
        mediaPlayerOptions += '<option value="' + eid + '"' + mSel + '>' + friendly + '</option>';
      }
    }

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

        // --- Behavior ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Behavior</div>' +
          this._selectRow('Pipeline', 'pipeline_id', pipelineOptions) +
          this._checkboxRow('Start listening on load', 'start_listening_on_load') +
          this._textRow('Wake word switch entity', 'wake_word_switch', 'switch.screensaver') +
          this._checkboxRow('Continue conversation mode', 'continue_conversation') +
          this._checkboxRow('Double-tap screen to cancel interaction', 'double_tap_cancel') +
          this._checkboxRow('Debug logging', 'debug') +
        '</div>' +

        // --- Microphone ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Microphone Processing</div>' +
          this._checkboxRow('Noise suppression', 'noise_suppression') +
          this._checkboxRow('Echo cancellation', 'echo_cancellation') +
          this._checkboxRow('Auto gain control', 'auto_gain_control') +
          this._checkboxRow('Voice isolation (Chrome only)', 'voice_isolation') +
        '</div>' +

        // --- Timeouts ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Timeouts</div>' +
          this._numberRow('Server-side pipeline timeout (s)', 'pipeline_timeout', 0, 300) +
          this._numberRow('Client-side idle restart (s)', 'pipeline_idle_timeout', 0, 3600) +
        '</div>' +

        // --- Volume ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Volume & Chimes</div>' +
          this._selectRow('TTS output device (Experimental)', 'tts_target', mediaPlayerOptions) +
          this._sliderRow('Chime volume', 'chime_volume', 0, 100) +
          this._sliderRow('TTS volume', 'tts_volume', 0, 100) +
          this._checkboxRow('Chime on wake word', 'chime_on_wake_word') +
          this._checkboxRow('Chime on request sent', 'chime_on_request_sent') +
        '</div>' +

        // --- Rainbow Bar ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Rainbow Bar</div>' +
          this._selectRowRaw('Position', 'bar_position',
            '<option value="bottom"' + (cfg.bar_position === 'bottom' ? ' selected' : '') + '>Bottom</option>' +
            '<option value="top"' + (cfg.bar_position === 'top' ? ' selected' : '') + '>Top</option>'
          ) +
          this._sliderRow('Height (px)', 'bar_height', 2, 40) +
          this._textRow('Gradient colors', 'bar_gradient', '#FF7777, #FF9977, ...') +
        '</div>' +

        // --- Transcription Bubble ---
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

        // --- Response Bubble ---
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

        // --- Background ---
        '<div class="vs-section">' +
          '<div class="vs-section-title">Background</div>' +
          this._checkboxRow('Background blur', 'background_blur') +
          this._sliderRow('Blur intensity', 'background_blur_intensity', 0, 20) +
        '</div>' +

      '</div>';

    // Attach event listeners
    this._attachListeners();
  }

  // --- Row helpers ---

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

  _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Event handling ---

  _attachListeners() {
    var self = this;

    // Checkboxes
    this.querySelectorAll('input[type="checkbox"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.checked);
      });
    });

    // Text inputs
    this.querySelectorAll('input[type="text"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });

    // Number inputs
    this.querySelectorAll('input[type="number"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, parseInt(el.value, 10) || 0);
      });
    });

    // Range inputs
    this.querySelectorAll('input[type="range"]').forEach(function (el) {
      el.addEventListener('input', function () {
        var span = self.querySelector('[data-range-for="' + el.dataset.key + '"]');
        if (span) span.textContent = el.value;
      });
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, parseInt(el.value, 10));
      });
    });

    // Color inputs
    this.querySelectorAll('input[type="color"]').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });

    // Selects
    this.querySelectorAll('select').forEach(function (el) {
      el.addEventListener('change', function () {
        self._updateConfig(el.dataset.key, el.value);
      });
    });
  }

  _updateConfig(key, value) {
    this._config = Object.assign({}, this._config);
    this._config[key] = value;

    // Fire config-changed event
    var event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);
  }
}


// ============================================================================
// Registration
// ============================================================================

customElements.define('voice-satellite-card', VoiceSatelliteCard);
customElements.define('voice-satellite-card-editor', VoiceSatelliteCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Transform your browser into a voice satellite for Home Assistant Assist',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card'
});

console.info(
  '%c VOICE-SATELLITE-CARD %c v2.3.0 ',
  'color: white; background: #03a9f4; font-weight: bold;',
  'color: #03a9f4; background: white; font-weight: bold;'
);
