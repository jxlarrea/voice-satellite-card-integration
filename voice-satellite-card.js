/**
 * Voice Satellite Card for Home Assistant
 * 
 * Turns your browser into a voice satellite by streaming audio to
 * Home Assistant's Assist Pipeline, which handles:
 * - Wake word detection (via openWakeWord add-on)
 * - Speech-to-text
 * - Intent processing  
 * - Text-to-speech response
 * 
 * @version 1.10.0
 * 
 * Features:
 * - AudioWorklet for efficient audio processing (falls back to ScriptProcessor)
 * - Visibility API to pause when tab/screen is hidden (saves battery)
 * - Automatic reconnection on WebSocket disconnect
 * - Reusable buffers to reduce memory allocations
 * - Auto-start with fallback button for browsers requiring user gesture
 * - Pastel rainbow gradient bar indicator
 * - Invisible card - only shows floating button when needed
 */

var SAMPLE_RATE = 16000;
var BUFFER_SIZE = 2048;
var AUDIO_CHUNK_MS = 100;
var RECONNECT_DELAY_MS = 3000;
var MAX_RECONNECT_ATTEMPTS = 5;

var State = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  WAKE_WORD_DETECTED: 'wake_word_detected',
  STT: 'stt',
  INTENT: 'intent',
  TTS: 'tts',
  PAUSED: 'paused',
  ERROR: 'error'
};

// AudioWorklet processor code as a string (will be loaded as blob URL)
var WORKLET_CODE = '\
class AudioProcessor extends AudioWorkletProcessor {\
  constructor() {\
    super();\
    this.bufferSize = 2048;\
    this.buffer = new Float32Array(this.bufferSize);\
    this.bufferIndex = 0;\
  }\
  process(inputs) {\
    var input = inputs[0];\
    if (!input || !input[0]) return true;\
    var channelData = input[0];\
    for (var i = 0; i < channelData.length; i++) {\
      this.buffer[this.bufferIndex++] = channelData[i];\
      if (this.bufferIndex >= this.bufferSize) {\
        this.port.postMessage({ audio: this.buffer.slice() });\
        this.bufferIndex = 0;\
      }\
    }\
    return true;\
  }\
}\
registerProcessor("audio-processor", AudioProcessor);';

// Global flag to track if connection listeners are registered
var _vsConnectionListenersRegistered = false;

// Global mutex to prevent multiple pipelines starting
var _vsPipelineStarting = false;

class VoiceSatelliteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    this._config = {};
    this._hass = null;
    this._state = State.IDLE;
    
    this._audioContext = null;
    this._mediaStream = null;
    this._workletNode = null;
    this._workletRegistered = false;
    this._processor = null; // Fallback ScriptProcessor
    this._useWorklet = false;
    
    // Reusable buffers to reduce allocations
    this._audioChunks = [];
    this._reusablePcmBuffer = null;
    this._reusableMessageBuffer = null;
    
    this._binaryHandlerId = null;
    this._unsub = null;
    this._sendInterval = null;
    this._sourceNode = null;
    
    this._isStreaming = false;
    this._isPaused = false;
    this._isConnected = false;
    this._isSpeaking = false;
    this._isRestarting = false;
    this._reconnectAttempts = 0;
    this._reconnectTimeout = null;
    this._pipelineTimeoutId = null;
    this._errorHandlingRestart = false;
    this._streamingResponse = '';
    this._serviceUnavailable = false;
    this._resumeDebounceTimer = null;
    this._serviceRecoveryTimer = null;
    this._pipelineRefreshTimer = null;
    this._pipelineStartTime = null;
    
    // Bind visibility handler
    this._boundVisibilityHandler = this._handleVisibilityChange.bind(this);
    this._globalUI = null;
  }

  static getConfigElement() {
    return document.createElement('voice-satellite-card-editor');
  }

  static getStubConfig() {
    return {
      bar_position: 'bottom',
      bar_height: 4,
      bar_gradient: '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC',
      start_listening_on_load: true,
      noise_suppression: true,
      auto_gain_control: true,
      echo_cancellation: true,
      chime_on_wake_word: true,
      chime_on_request_sent: true,
      wake_word_switch: '',
      show_transcription: true,
      transcription_font_size: 30,
      transcription_font_family: 'inherit',
      transcription_font_color: '#444444',
      transcription_background: 'rgba(255, 255, 255, 0.85)',
      transcription_padding: 16,
      transcription_rounded: true
    };
  }

  setConfig(config) {
    this._config = {
      pipeline_id: config.pipeline_id || '',
      bar_position: config.bar_position || 'bottom',
      bar_height: config.bar_height !== undefined ? config.bar_height : 16,
      bar_gradient: config.bar_gradient || '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC',
      start_listening_on_load: config.start_listening_on_load !== false,
      chime_on_wake_word: config.chime_on_wake_word !== false,
      chime_on_request_sent: config.chime_on_request_sent !== false,
      chime_volume: config.chime_volume !== undefined ? config.chime_volume : 100,
      tts_volume: config.tts_volume !== undefined ? config.tts_volume : 100,
      wake_word_switch: config.wake_word_switch || '',
      debug: config.debug || false,
      // Audio processing options (still used internally)
      wake_word_timeout: config.wake_word_timeout !== undefined ? config.wake_word_timeout : 0,
      stt_timeout: config.stt_timeout !== undefined ? config.stt_timeout : 0,
      // Pipeline timeout (seconds) - 0 means no timeout
      pipeline_timeout: config.pipeline_timeout !== undefined ? config.pipeline_timeout : 60,
      // Microphone processing options
      noise_suppression: config.noise_suppression !== false,
      auto_gain_control: config.auto_gain_control !== false,
      echo_cancellation: config.echo_cancellation !== false,
      // Transcription bubble options (user speech)
      show_transcription: config.show_transcription !== false,
      transcription_font_size: config.transcription_font_size !== undefined ? config.transcription_font_size : 20,
      transcription_font_family: config.transcription_font_family || 'inherit',
      transcription_font_color: config.transcription_font_color || '#444444',
      transcription_font_bold: config.transcription_font_bold !== false,
      transcription_font_italic: config.transcription_font_italic || false,
      transcription_background: config.transcription_background || '#ffffff',
      transcription_padding: config.transcription_padding !== undefined ? config.transcription_padding : 16,
      transcription_rounded: config.transcription_rounded !== false,
      transcription_border_color: config.transcription_border_color || 'rgba(0, 180, 255, 0.5)',
      // Response bubble options (assistant speech)
      show_response: config.show_response !== false,
      streaming_response: config.streaming_response || false,
      response_font_size: config.response_font_size !== undefined ? config.response_font_size : 20,
      response_font_family: config.response_font_family || 'inherit',
      response_font_color: config.response_font_color || '#444444',
      response_font_bold: config.response_font_bold !== false,
      response_font_italic: config.response_font_italic || false,
      response_background: config.response_background || '#ffffff',
      response_padding: config.response_padding !== undefined ? config.response_padding : 16,
      response_rounded: config.response_rounded !== false,
      response_border_color: config.response_border_color || 'rgba(100, 200, 150, 0.5)',
      // Background blur
      background_blur: config.background_blur !== false,
      background_blur_intensity: config.background_blur_intensity !== undefined ? config.background_blur_intensity : 5,
      // Pipeline refresh interval (minutes) - restart pipeline periodically to keep TTS tokens fresh
      // Default 30 minutes, 0 to disable
      pipeline_refresh_interval: config.pipeline_refresh_interval !== undefined ? config.pipeline_refresh_interval : 30
    };
    
    this._render();
  }

  set hass(hass) {
    var firstSet = !this._hass;
    var self = this;
    this._hass = hass;
    
    // Monitor connection state changes (only register once globally)
    if (firstSet && hass && hass.connection && !_vsConnectionListenersRegistered) {
      // Try to subscribe to connection state changes
      try {
        // Home Assistant connection uses addEventListener
        if (typeof hass.connection.addEventListener === 'function') {
          // Track if we've had an initial connection
          var hadInitialConnection = false;
          
          hass.connection.addEventListener('ready', function() {
            console.log('[VoiceSatellite] Connection ready event, hadInitialConnection:', hadInitialConnection);
            
            // Skip the first ready event (initial page load)
            if (!hadInitialConnection) {
              hadInitialConnection = true;
              console.log('[VoiceSatellite] Initial connection, skipping restart');
              return;
            }
            
            // This is a reconnect - clear stale handler ID
            if (self._binaryHandlerId) {
              console.log('[VoiceSatellite] Clearing stale binary handler after reconnect');
              self._binaryHandlerId = null;
            }
            // Restart pipeline if we were streaming
            if (self._isStreaming) {
              console.log('[VoiceSatellite] Restarting pipeline after reconnect');
              self._restartPipeline();
            }
          });
          
          hass.connection.addEventListener('disconnected', function() {
            console.log('[VoiceSatellite] Connection disconnected event');
            // Mark that we've had a connection (so next ready is a reconnect)
            hadInitialConnection = true;
            // Immediately invalidate the handler to stop sending
            self._binaryHandlerId = null;
            // Unsubscribe from pipeline to clean up server-side tasks
            if (self._unsub) {
              console.log('[VoiceSatellite] Unsubscribing pipeline on disconnect');
              try { 
                self._unsub(); 
              } catch(e) {
                // Connection is already closed, this is expected
              }
              self._unsub = null;
            }
          });
          
          _vsConnectionListenersRegistered = true;
          console.log('[VoiceSatellite] Connection event listeners registered');
        } else {
          console.log('[VoiceSatellite] Connection addEventListener not available');
        }
      } catch (e) {
        console.error('[VoiceSatellite] Error registering connection listeners:', e);
      }
    }
    
    if (firstSet && hass && this._config.start_listening_on_load) {
      setTimeout(function() { self._tryAutoStart(); }, 1000);
    }
  }

  async _tryAutoStart() {
    // If already streaming, nothing to do
    if (this._isStreaming) {
      console.log('[VoiceSatellite] Already streaming, skipping auto-start');
      this._hideStartButton();
      return;
    }
    
    try {
      await this._startPipeline('_tryAutoStart');
      this._hideStartButton();
    } catch (error) {
      console.log('[VoiceSatellite] Auto-start failed:', error.message);
      this._showStartButton();
      this._stopPipeline();
    }
  }

  _showStartButton() {
    var btn = this._globalUI ? this._globalUI.querySelector('.vs-start-btn') : null;
    if (btn) {
      btn.classList.add('visible');
      console.log('[VoiceSatellite] Showing start button');
    }
  }

  _hideStartButton() {
    var btn = this._globalUI ? this._globalUI.querySelector('.vs-start-btn') : null;
    if (btn) {
      btn.classList.remove('visible');
    }
  }

  async _handleStartClick() {
    this._hideStartButton();
    try {
      await this._startPipeline('_handleStartClick');
    } catch (error) {
      console.error('[VoiceSatellite] Start failed:', error);
      this._showStartButton();
    }
  }

  async _startPipeline(caller) {
    // Log who's calling
    console.log('[VoiceSatellite] _startPipeline called by:', caller || 'unknown');
    
    // Check global mutex first
    if (_vsPipelineStarting) {
      console.log('[VoiceSatellite] Pipeline already starting globally, skipping');
      return;
    }
    
    if (this._isStreaming) {
      console.log('[VoiceSatellite] Already streaming, skipping _startPipeline');
      return;
    }
    var self = this;
    
    // Set both flags immediately to prevent race conditions
    _vsPipelineStarting = true;
    this._isStreaming = true;
    
    // Clear any pending reconnect timeout
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    
    this._setState(State.CONNECTING);
    this._reconnectAttempts = 0;
    
    try {
      // Start microphone first (needs user gesture context)
      await this._startMicrophone();
      
      // Add visibility listener
      document.addEventListener('visibilitychange', this._boundVisibilityHandler);
      
      var pipelinesResult = await this._hass.connection.sendMessagePromise({
        type: 'assist_pipeline/pipeline/list'
      });
      
      if (this._config.debug) {
        console.log('[VoiceSatellite] Available pipelines:', pipelinesResult);
      }
      
      var pipelineId = this._config.pipeline_id;
      if (!pipelineId && pipelinesResult && pipelinesResult.pipelines) {
        pipelineId = pipelinesResult.preferred_pipeline || 
                     (pipelinesResult.pipelines[0] ? pipelinesResult.pipelines[0].id : null);
      }
      
      if (!pipelineId) {
        throw new Error('No pipeline available');
      }
      
      console.log('[VoiceSatellite] Using pipeline:', pipelineId);
      
      this._pipelineId = pipelineId;
      
      await this._subscribeToPipeline(pipelineId);
    } catch (e) {
      // If startup fails, reset the flag
      this._isStreaming = false;
      throw e;
    } finally {
      _vsPipelineStarting = false;
    }
  }

  async _subscribeToPipeline(pipelineId) {
    var self = this;
    
    // Always unsubscribe from existing pipeline first to prevent leaks
    if (this._unsub) {
      console.log('[VoiceSatellite] Unsubscribing from previous pipeline');
      try { 
        this._unsub(); 
        console.log('[VoiceSatellite] Successfully unsubscribed from previous pipeline');
      } catch(e) {
        console.log('[VoiceSatellite] Error unsubscribing from previous pipeline:', e);
      }
      this._unsub = null;
    }
    
    var pipelineOptions = {
      type: 'assist_pipeline/run',
      start_stage: 'wake_word',
      end_stage: 'tts',
      input: {
        sample_rate: SAMPLE_RATE,
        timeout: this._config.wake_word_timeout
      },
      pipeline: pipelineId,
      // Set overall pipeline timeout very high (24 hours) to prevent idle expiration
      // The default is 300 seconds (5 minutes) which causes timeout errors during idle listening
      timeout: 86400
    };
    
    this._unsub = await this._hass.connection.subscribeMessage(
      function(event) { 
        self._handlePipelineEvent(event); 
      },
      pipelineOptions
    );
  }

  async _startMicrophone() {
    var self = this;
    
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE
    });
    
    console.log('[VoiceSatellite] Audio context initial state:', this._audioContext.state);
    
    if (this._audioContext.state === 'suspended') {
      console.log('[VoiceSatellite] Attempting to resume audio context...');
      
      var resumePromise = this._audioContext.resume();
      var timeoutPromise = new Promise(function(resolve) { 
        setTimeout(function() { resolve('timeout'); }, 200); 
      });
      
      await Promise.race([resumePromise, timeoutPromise]);
      
      console.log('[VoiceSatellite] Audio context state after resume attempt:', this._audioContext.state);
      
      if (this._audioContext.state === 'suspended') {
        console.log('[VoiceSatellite] Audio context still suspended, need user gesture');
        this._audioContext.close();
        this._audioContext = null;
        throw new Error('Audio context suspended - user gesture required');
      }
    }
    
    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: this._config.echo_cancellation,
        noiseSuppression: this._config.noise_suppression,
        autoGainControl: this._config.auto_gain_control
      }
    });
    
    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
    
    // Try to use AudioWorklet (more efficient), fall back to ScriptProcessor
    try {
      await this._setupAudioWorklet(this._sourceNode);
      this._useWorklet = true;
      console.log('[VoiceSatellite] Using AudioWorklet for audio processing');
    } catch (e) {
      console.log('[VoiceSatellite] AudioWorklet not available, using ScriptProcessor:', e.message);
      this._setupScriptProcessor(this._sourceNode);
      this._useWorklet = false;
    }
    
    // Start send interval
    this._sendInterval = setInterval(function() {
      self._sendAudioBuffer();
    }, AUDIO_CHUNK_MS);
    
    console.log('[VoiceSatellite] Microphone started successfully');
  }

  async _setupAudioWorklet(source) {
    var self = this;
    
    // Only register the worklet if not already registered
    if (!this._workletRegistered) {
      try {
        // Create blob URL from worklet code
        var blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        var workletUrl = URL.createObjectURL(blob);
        
        await this._audioContext.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);
        
        this._workletRegistered = true;
      } catch (e) {
        // Already registered or other error - that's okay, continue
        if (e.message && e.message.indexOf('already registered') !== -1) {
          this._workletRegistered = true;
        } else {
          throw e;
        }
      }
    }
    
    this._workletNode = new AudioWorkletNode(this._audioContext, 'audio-processor');
    
    this._workletNode.port.onmessage = function(event) {
      if (!self._isStreaming || !self._binaryHandlerId || self._isPaused) return;
      
      var audioData = event.data.audio;
      var pcm = self._convertToPcm(audioData);
      self._audioChunks.push(pcm);
    };
    
    source.connect(this._workletNode);
    this._workletNode.connect(this._audioContext.destination);
  }

  _setupScriptProcessor(source) {
    var self = this;
    
    this._processor = this._audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    
    this._processor.onaudioprocess = function(e) {
      if (!self._isStreaming || !self._binaryHandlerId || self._isPaused) return;
      
      var inputData = e.inputBuffer.getChannelData(0);
      var pcm = self._convertToPcm(inputData);
      self._audioChunks.push(pcm);
    };
    
    source.connect(this._processor);
    this._processor.connect(this._audioContext.destination);
  }

  _convertToPcm(floatData) {
    // Reuse buffer if same size, otherwise create new one
    var length = floatData.length;
    if (!this._reusablePcmBuffer || this._reusablePcmBuffer.length !== length) {
      this._reusablePcmBuffer = new Int16Array(length);
    }
    
    var pcm = new Int16Array(length); // Need new array for storage
    for (var i = 0; i < length; i++) {
      var s = floatData[i];
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm;
  }

  _sendAudioBuffer() {
    if (!this._binaryHandlerId || this._audioChunks.length === 0 || this._isPaused) return;
    
    // Check if connection is still valid
    if (!this._hass || !this._hass.connection || !this._hass.connection.connected) {
      // Connection lost - clear handler and stop sending
      this._binaryHandlerId = null;
      return;
    }
    
    // Calculate total length
    var totalLength = 0;
    for (var i = 0; i < this._audioChunks.length; i++) {
      totalLength += this._audioChunks[i].length;
    }
    
    // Combine chunks
    var combined = new Int16Array(totalLength);
    var offset = 0;
    for (var i = 0; i < this._audioChunks.length; i++) {
      combined.set(this._audioChunks[i], offset);
      offset += this._audioChunks[i].length;
    }
    this._audioChunks.length = 0; // Clear array without reallocating
    
    // Create message with handler ID prefix
    var audioBytes = new Uint8Array(combined.buffer);
    var messageLength = 1 + audioBytes.length;
    
    // Reuse message buffer if possible
    if (!this._reusableMessageBuffer || this._reusableMessageBuffer.length !== messageLength) {
      this._reusableMessageBuffer = new Uint8Array(messageLength);
    }
    
    this._reusableMessageBuffer[0] = this._binaryHandlerId;
    this._reusableMessageBuffer.set(audioBytes, 1);
    
    try {
      var socket = this._hass.connection.socket;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(this._reusableMessageBuffer.buffer);
      } else {
        // Socket not ready - clear handler
        this._binaryHandlerId = null;
      }
    } catch (e) {
      console.error('[VoiceSatellite] Error sending audio:', e);
      this._binaryHandlerId = null;
    }
  }

  _handlePipelineEvent(event) {
    var self = this;
    var eventType = event.type;
    var eventData = event.data || {};
    
    if (this._config.debug) {
      console.log('[VoiceSatellite] Event:', eventType, JSON.stringify(eventData));
    }
    
    // Don't reset reconnect attempts here - only reset on successful wake word detection
    // This allows the counter to accumulate when service is unavailable
    
    switch (eventType) {
      case 'run-start':
        if (eventData.runner_data && eventData.runner_data.stt_binary_handler_id !== undefined) {
          this._binaryHandlerId = eventData.runner_data.stt_binary_handler_id;
        }
        // Track when pipeline started for refresh timer
        this._pipelineStartTime = Date.now();
        this._startPipelineRefreshTimer();
        // Don't clear _serviceUnavailable here - we need to wait for wake_word-end
        // to confirm the service is actually working (non-empty wake_word_output)
        this._setState(State.LISTENING);
        console.log('[VoiceSatellite] Pipeline started, binary_handler_id:', this._binaryHandlerId);
        break;
        
      case 'wake_word-start':
        this._setState(State.LISTENING);
        // If service was unavailable, set a timer to clear the error bar
        // If we don't get an empty wake_word-end within 2 seconds, service is working
        if (this._serviceUnavailable) {
          var self = this;
          this._serviceRecoveryTimer = setTimeout(function() {
            if (self._serviceUnavailable) {
              console.log('[VoiceSatellite] Service appears recovered (no immediate error)');
              self._serviceUnavailable = false;
              self._reconnectAttempts = 0;
              self._hideErrorBar();
            }
          }, 2000);
        }
        break;
        
      case 'wake_word-end':
        // Clear the service recovery timer if it's running
        if (this._serviceRecoveryTimer) {
          clearTimeout(this._serviceRecoveryTimer);
          this._serviceRecoveryTimer = null;
        }
        // Only trigger if wake_word_output contains actual data (wake_word_id)
        // An empty object {} means no wake word was detected (e.g., service unavailable)
        if (eventData.wake_word_output && Object.keys(eventData.wake_word_output).length > 0) {
          // Service is working - clear error state and reset attempts
          this._reconnectAttempts = 0;
          if (this._serviceUnavailable) {
            this._serviceUnavailable = false;
            this._hideErrorBar();
            console.log('[VoiceSatellite] Service recovered, cleared error state');
          }
          console.log('[VoiceSatellite] Wake word detected:', JSON.stringify(eventData.wake_word_output));
          
          // Force hide transcription and response from previous run
          this._hideTranscription();
          this._hideResponse();
          
          // Force state update
          this._state = State.WAKE_WORD_DETECTED;
          
          // Start pipeline timeout if configured
          this._startPipelineTimeout();
          
          // Multiple attempts to show UI for slower devices
          var self = this;
          self._forceUIUpdate();
          setTimeout(function() { self._forceUIUpdate(); }, 50);
          setTimeout(function() { self._forceUIUpdate(); }, 150);
          setTimeout(function() { self._forceUIUpdate(); }, 300);
          
          if (this._config.chime_on_wake_word) {
            this._playChime('wake');
          }
          // Turn off configured switch (e.g., to exit screensaver)
          if (this._config.wake_word_switch) {
            this._hass.callService('switch', 'turn_off', {
              entity_id: this._config.wake_word_switch
            });
          }
        } else {
          console.log('[VoiceSatellite] wake_word-end received with empty output (service may be unavailable)');
          // Mark service as unavailable and show error bar immediately
          this._serviceUnavailable = true;
          this._showErrorBar();
          // Only play chime on first detection
          if (this._reconnectAttempts === 0) {
            this._playChime('error');
          }
          // Set flag so run-end doesn't also restart
          this._errorHandlingRestart = true;
          // Use service unavailable reconnect (keeps trying indefinitely)
          this._handleServiceUnavailable();
        }
        break;
        
      case 'stt-start':
        this._setState(State.STT);
        break;
        
      case 'stt-end':
        if (eventData.stt_output && eventData.stt_output.text) {
          var sttText = eventData.stt_output.text.trim();
          console.log('[VoiceSatellite] STT:', sttText);
          this._showTranscription(sttText);
        }
        break;
        
      case 'intent-start':
        this._setState(State.INTENT);
        // Reset streaming response buffer
        this._streamingResponse = '';
        break;
      
      case 'intent-progress':
        // Stream response text in real-time (requires cloud models)
        if (this._config.streaming_response && eventData.chat_log_delta && eventData.chat_log_delta.content) {
          this._streamingResponse = (this._streamingResponse || '') + eventData.chat_log_delta.content;
          this._showResponse(this._streamingResponse);
        }
        break;
        
      case 'intent-end':
        if (eventData.intent_output && eventData.intent_output.response) {
          var response = eventData.intent_output.response;
          if (response.speech && response.speech.plain) {
            var responseText = response.speech.plain.speech;
            console.log('[VoiceSatellite] Response:', responseText);
            // Show final response (in case streaming missed anything)
            this._showResponse(responseText);
          }
        }
        // Clear streaming buffer
        this._streamingResponse = '';
        break;
        
      case 'tts-start':
        this._setState(State.TTS);
        this._forceUIUpdate();
        // Clear pipeline timeout - TTS has arrived, no longer stuck
        this._clearPipelineTimeout();
        break;
        
      case 'tts-end':
        if (eventData.tts_output && eventData.tts_output.url) {
          this._playResponse(eventData.tts_output.url);
          // Keep TTS state active - will be reset when audio finishes in _playResponse
        }
        break;
        
      case 'run-end':
        console.log('[VoiceSatellite] Pipeline run ended');
        this._binaryHandlerId = null;
        
        // Note: Don't clear pipeline timeout here - it should only clear when TTS starts
        // This handles cases where the pipeline ends without reaching TTS
        
        // Only reset state if not playing TTS audio
        if (this._state !== State.TTS || !this._isSpeaking) {
          // If error handler is already restarting, don't restart again
          if (this._errorHandlingRestart) {
            this._errorHandlingRestart = false;
            break;
          }
          
          // If we never reached TTS and timeout is still running, let it handle the restart
          // Otherwise proceed normally
          if (!this._pipelineTimeoutId) {
            if (this._config.chime_on_request_sent && this._state !== State.LISTENING) {
              this._playChime('done');
            }
            
            // Force state to IDLE first, then restart
            this._state = State.IDLE;
            this._updateUI();
            
            setTimeout(function() {
              if (self._isStreaming && !self._isPaused) {
                self._restartPipeline();
              }
            }, 500);
          }
        }
        break;
        
      case 'error':
        console.error('[VoiceSatellite] Pipeline error:', eventData.code, '-', eventData.message);
        // Clear pipeline timeout - error is being handled, don't trigger timeout later
        this._clearPipelineTimeout();
        // Set flag so run-end doesn't also restart
        this._errorHandlingRestart = true;
        // Hide bubbles
        this._hideTranscription();
        this._hideResponse();
        
        // Determine if we should show error feedback
        // Only show error chime/flash if user was actively interacting (not just idle listening)
        var isActiveInteraction = this._state !== State.IDLE && 
                                   this._state !== State.LISTENING && 
                                   this._state !== State.CONNECTING;
        
        // Some errors are expected and should restart immediately without counting as failures
        var isExpectedError = eventData.code === 'stt-no-text-recognized' || 
                              eventData.code === 'duplicate_wake_up_detected' ||
                              eventData.code === 'timeout';
        
        if (isExpectedError || !isActiveInteraction) {
          // Silent handling - just hide UI quietly
          this._state = State.IDLE;
          this._updateUI();
        } else {
          // Active interaction error - show error feedback
          this._playChime('error');
          this._flashError();
        }
        
        if (isExpectedError) {
          // Expected errors - restart immediately, no delay, don't increment counter
          console.log('[VoiceSatellite] Expected error, restarting immediately');
          this._restartPipeline();
        } else {
          // Unexpected errors - use normal error handling with delay and counter
          this._handlePipelineError();
        }
        break;
    }
  }

  _handlePipelineError() {
    var self = this;
    
    this._reconnectAttempts++;
    
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[VoiceSatellite] Max reconnect attempts reached');
      this._setState(State.ERROR);
      this._showStartButton();
      return;
    }
    
    console.log('[VoiceSatellite] Reconnecting in', RECONNECT_DELAY_MS, 'ms (attempt', this._reconnectAttempts, ')');
    
    this._reconnectTimeout = setTimeout(function() {
      if (self._isStreaming && !self._isPaused) {
        self._restartPipeline();
      }
    }, RECONNECT_DELAY_MS);
  }

  _handleServiceUnavailable() {
    var self = this;
    
    this._reconnectAttempts++;
    
    // Use exponential backoff: 5s, 10s, 15s, max 30s
    var delay = Math.min(5000 + (this._reconnectAttempts - 1) * 5000, 30000);
    
    console.log('[VoiceSatellite] Service unavailable, retrying in', delay, 'ms (attempt', this._reconnectAttempts, ')');
    
    this._reconnectTimeout = setTimeout(async function() {
      if (self._isStreaming && !self._isPaused) {
        // Full microphone reset for service recovery
        await self._fullMicrophoneReset();
        self._restartPipeline();
      }
    }, delay);
  }

  async _restartPipeline() {
    var self = this;
    
    // Prevent concurrent restarts
    if (this._isRestarting) {
      console.log('[VoiceSatellite] Already restarting, skipping');
      return;
    }
    
    // Clear any pending reconnect timeout to prevent double restarts
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    
    this._isRestarting = true;
    console.log('[VoiceSatellite] Restarting pipeline...');
    this._binaryHandlerId = null;
    
    try {
      await this._subscribeToPipeline(this._pipelineId);
    } catch (error) {
      console.error('[VoiceSatellite] Failed to restart pipeline:', error);
      this._handlePipelineError();
    } finally {
      this._isRestarting = false;
    }
  }

  _handleVisibilityChange() {
    if (document.hidden) {
      this._pauseListening();
    } else {
      this._resumeListening();
    }
  }

  _pauseListening() {
    if (!this._isStreaming || this._isPaused) return;
    
    console.log('[VoiceSatellite] Pausing (tab hidden)');
    this._isPaused = true;
    this._setState(State.PAUSED);
    
    // Clear audio buffer
    this._audioChunks.length = 0;
    
    // Suspend audio context to save resources
    if (this._audioContext && this._audioContext.state === 'running') {
      this._audioContext.suspend();
    }
  }

  async _resumeListening() {
    if (!this._isStreaming || !this._isPaused) return;
    
    // Debounce rapid tab switches - wait 500ms before actually resuming
    if (this._resumeDebounceTimer) {
      clearTimeout(this._resumeDebounceTimer);
    }
    
    var self = this;
    this._resumeDebounceTimer = setTimeout(async function() {
      self._resumeDebounceTimer = null;
      
      if (!self._isStreaming || !self._isPaused) return;
      
      console.log('[VoiceSatellite] Resuming (tab visible)');
      
      // Clear the paused flag
      self._isPaused = false;
      
      // The audio nodes may have stopped working after suspend
      // Safest approach is to recreate the microphone connection
      await self._reconnectMicrophone();
      
      // Restart pipeline to get fresh handler ID
      await self._restartPipeline();
    }, 500);
  }

  async _reconnectMicrophone() {
    console.log('[VoiceSatellite] Reconnecting microphone...');
    
    // Stop existing audio processing
    if (this._sourceNode) {
      try {
        this._sourceNode.disconnect();
      } catch (e) {
        // Ignore - might already be disconnected
      }
      this._sourceNode = null;
    }
    
    if (this._workletNode) {
      try {
        this._workletNode.disconnect();
      } catch (e) {
        // Ignore
      }
      this._workletNode = null;
    }
    
    if (this._processor) {
      try {
        this._processor.disconnect();
      } catch (e) {
        // Ignore
      }
      this._processor = null;
    }
    
    // Resume audio context if needed
    if (this._audioContext && this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
      console.log('[VoiceSatellite] Audio context resumed, state:', this._audioContext.state);
    }
    
    // Recreate the source and processor nodes
    if (this._mediaStream && this._audioContext) {
      this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
      
      // Try to use AudioWorklet, fall back to ScriptProcessor
      if (this._useWorklet) {
        try {
          await this._setupAudioWorklet(this._sourceNode);
          console.log('[VoiceSatellite] AudioWorklet reconnected');
        } catch (e) {
          console.log('[VoiceSatellite] AudioWorklet reconnect failed, using ScriptProcessor');
          this._setupScriptProcessor(this._sourceNode);
          this._useWorklet = false;
        }
      } else {
        this._setupScriptProcessor(this._sourceNode);
        console.log('[VoiceSatellite] ScriptProcessor reconnected');
      }
    }
  }

  async _fullMicrophoneReset() {
    console.log('[VoiceSatellite] Full microphone reset for service recovery');
    
    // Stop existing audio processing
    if (this._sourceNode) {
      try {
        this._sourceNode.disconnect();
      } catch (e) {
        // Ignore
      }
      this._sourceNode = null;
    }
    
    if (this._workletNode) {
      try {
        this._workletNode.disconnect();
      } catch (e) {
        // Ignore
      }
      this._workletNode = null;
    }
    
    if (this._processor) {
      try {
        this._processor.disconnect();
      } catch (e) {
        // Ignore
      }
      this._processor = null;
    }
    
    // Stop old stream
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(function(track) { track.stop(); });
      this._mediaStream = null;
    }
    
    // Close old audio context
    if (this._audioContext) {
      try {
        await this._audioContext.close();
      } catch (e) {
        console.log('[VoiceSatellite] Error closing audio context:', e);
      }
      this._audioContext = null;
    }
    
    // Reset worklet registration since we're creating a new audio context
    this._workletRegistered = false;
    
    // Get fresh microphone
    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
      
      if (this._useWorklet) {
        try {
          await this._setupAudioWorklet(this._sourceNode);
          console.log('[VoiceSatellite] AudioWorklet fully recreated');
        } catch (e) {
          console.log('[VoiceSatellite] AudioWorklet failed, using ScriptProcessor');
          this._setupScriptProcessor(this._sourceNode);
          this._useWorklet = false;
        }
      } else {
        this._setupScriptProcessor(this._sourceNode);
        console.log('[VoiceSatellite] ScriptProcessor recreated');
      }
    } catch (e) {
      console.error('[VoiceSatellite] Failed to get fresh microphone:', e);
    }
  }

  _stopPipeline() {
    this._isStreaming = false;
    this._isPaused = false;
    
    // Remove visibility listener
    document.removeEventListener('visibilitychange', this._boundVisibilityHandler);
    
    // Clear reconnect timeout
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    
    // Clear pipeline timeout
    this._clearPipelineTimeout();
    
    // Clear pipeline refresh timer
    this._clearPipelineRefreshTimer();
    
    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
    
    if (this._unsub) {
      try { this._unsub(); } catch(e) {}
      this._unsub = null;
    }
    
    this._binaryHandlerId = null;
    
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(function(t) { t.stop(); });
      this._mediaStream = null;
    }
    
    if (this._audioContext && this._audioContext.state !== 'closed') {
      this._audioContext.close();
      this._audioContext = null;
    }
    
    this._audioChunks.length = 0;
    this._setState(State.IDLE);
    
    console.log('[VoiceSatellite] Pipeline stopped');
  }

  _startPipelineTimeout() {
    var self = this;
    
    // Clear any existing timeout
    this._clearPipelineTimeout();
    
    // Only set timeout if configured (> 0)
    if (this._config.pipeline_timeout > 0) {
      console.log('[VoiceSatellite] Starting pipeline timeout:', this._config.pipeline_timeout, 'seconds');
      
      this._pipelineTimeoutId = setTimeout(function() {
        console.warn('[VoiceSatellite] Pipeline timeout! Restarting...');
        
        // Play error chime
        self._playChime('error');
        
        // Flash red on the bar
        self._flashError();
        
        // Hide any visible bubbles
        self._hideTranscription();
        self._hideResponse();
        
        // Force restart the pipeline after a brief delay for visual feedback
        setTimeout(function() {
          self._restartPipeline();
        }, 1000);
      }, this._config.pipeline_timeout * 1000);
    }
  }

  _startPipelineRefreshTimer() {
    var self = this;
    
    // Clear any existing refresh timer
    this._clearPipelineRefreshTimer();
    
    // If refresh interval is 0 or not set, don't start timer
    if (!this._config.pipeline_refresh_interval) return;
    
    var refreshMs = this._config.pipeline_refresh_interval * 60 * 1000;
    
    console.log('[VoiceSatellite] Pipeline refresh timer started:', this._config.pipeline_refresh_interval, 'minutes');
    
    this._pipelineRefreshTimer = setTimeout(function() {
      // Only refresh if we're in idle listening state (not actively processing)
      if (self._isStreaming && !self._isPaused && 
          (self._state === State.LISTENING || self._state === State.IDLE)) {
        console.log('[VoiceSatellite] Pipeline refresh - restarting to get fresh TTS token');
        self._restartPipeline();
      } else {
        // Not in idle state, try again in 1 minute
        console.log('[VoiceSatellite] Pipeline refresh deferred - not in idle state');
        self._pipelineRefreshTimer = setTimeout(function() {
          self._startPipelineRefreshTimer();
        }, 60000);
      }
    }, refreshMs);
  }

  _clearPipelineRefreshTimer() {
    if (this._pipelineRefreshTimer) {
      clearTimeout(this._pipelineRefreshTimer);
      this._pipelineRefreshTimer = null;
    }
  }

  _flashError() {
    var bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
    if (!bar) return;
    
    // Store original background
    var originalBg = bar.style.background;
    
    // Flash red
    bar.style.background = '#ff4444';
    bar.classList.add('visible');
    bar.style.opacity = '1';
    
    // Flash 3 times
    var self = this;
    var flashCount = 0;
    var flashInterval = setInterval(function() {
      flashCount++;
      if (flashCount % 2 === 0) {
        bar.style.background = '#ff4444';
        bar.style.opacity = '1';
      } else {
        bar.style.opacity = '0.3';
      }
      
      if (flashCount >= 6) {
        clearInterval(flashInterval);
        bar.style.background = originalBg;
        bar.style.opacity = '';
        bar.classList.remove('visible');
      }
    }, 150);
  }

  _showErrorBar() {
    var bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
    if (!bar) {
      // Try to ensure UI exists first
      if (!this._globalUI || !document.body.contains(this._globalUI)) {
        this._ensureGlobalUI();
        bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
      }
      if (!bar) return;
    }
    
    // Show red gradient bar with flowing animation
    bar.style.background = 'linear-gradient(90deg, #ff2222, #ff6666, #ff4444, #ff8888, #ff4444, #ff6666, #ff2222)';
    bar.style.backgroundSize = '200% 100%';
    bar.classList.add('visible');
    bar.classList.add('error-mode');
    bar.style.opacity = '1';
  }

  _hideErrorBar() {
    var bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
    if (!bar) return;
    
    // Restore gradient background
    bar.style.background = '';
    bar.style.backgroundSize = '';
    bar.style.opacity = '';
    bar.classList.remove('visible');
    bar.classList.remove('error-mode');
  }

  _clearPipelineTimeout() {
    if (this._pipelineTimeoutId) {
      clearTimeout(this._pipelineTimeoutId);
      this._pipelineTimeoutId = null;
    }
  }

  async _playResponse(url) {
    var self = this;
    try {
      this._isSpeaking = true;
      
      // Ensure audio context is running (may be suspended after tab visibility changes)
      if (this._audioContext && this._audioContext.state === 'suspended') {
        await this._audioContext.resume();
      }
      
      // Convert relative URL to absolute URL using Home Assistant connection
      var fullUrl = url;
      if (url.startsWith('/') && this._hass && this._hass.auth && this._hass.auth.data) {
        // Get the base URL from HA connection
        var hassUrl = this._hass.auth.data.hassUrl || '';
        if (hassUrl) {
          fullUrl = hassUrl + url;
        }
      }
      
      console.log('[VoiceSatellite] Playing TTS:', fullUrl);
      
      var audio = new Audio(fullUrl);
      // Browser audio maxes out at 1.0 (100%)
      audio.volume = Math.min(this._config.tts_volume / 100, 1.0);
      
      audio.onended = function() {
        self._isSpeaking = false;
        
        // Clear pipeline timeout - TTS completed successfully
        self._clearPipelineTimeout();
        
        if (self._config.chime_on_request_sent) {
          self._playChime('done');
        }
        
        // Now reset state and restart pipeline
        self._state = State.IDLE;
        self._updateUI();
        
        setTimeout(function() {
          if (self._isStreaming && !self._isPaused) {
            self._restartPipeline();
          }
        }, 500);
      };
      
      audio.onerror = function(e) {
        // Get more details about the error
        var errorDetails = '';
        if (audio.error) {
          errorDetails = 'code=' + audio.error.code + ' message=' + (audio.error.message || 'unknown');
        }
        console.error('[VoiceSatellite] Audio element error:', errorDetails, 'url:', fullUrl);
        console.error('[VoiceSatellite] Audio networkState:', audio.networkState, 'readyState:', audio.readyState);
        
        self._isSpeaking = false;
        self._state = State.IDLE;
        self._updateUI();
        
        // Still restart pipeline after audio error
        setTimeout(function() {
          if (self._isStreaming && !self._isPaused) {
            self._restartPipeline();
          }
        }, 500);
      };
      
      // Add canplaythrough event to ensure audio is ready
      audio.oncanplaythrough = function() {
        console.log('[VoiceSatellite] Audio ready to play');
      };
      
      await audio.play();
    } catch (error) {
      console.error('[VoiceSatellite] Playback error:', error.name, error.message);
      console.error('[VoiceSatellite] URL was:', url);
      this._isSpeaking = false;
      
      // Still restart pipeline after playback error
      var self = this;
      this._state = State.IDLE;
      this._updateUI();
      setTimeout(function() {
        if (self._isStreaming && !self._isPaused) {
          self._restartPipeline();
        }
      }, 500);
    }
  }

  _playChime(type) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = 'sine';
      var volume = (this._config.chime_volume / 100) * 0.5; // Scale to max 0.5 to avoid clipping
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      
      if (type === 'wake') {
        // Rising tone: C5 -> E5 -> G5
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.16);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else if (type === 'error') {
        // Error tone: Short low buzz
        osc.type = 'square';
        gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.setValueAtTime(200, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else {
        // Done tone: G5 -> E5
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.frequency.setValueAtTime(784, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch (e) {}
  }

  _setState(state) {
    if (this._state !== state) {
      if (this._config.debug) {
        console.log('[VoiceSatellite] State:', this._state, '->', state);
      }
      this._state = state;
      
      // Hide transcription and response when going back to listening
      if (state === State.LISTENING) {
        this._hideTranscription();
        this._hideResponse();
      }
      
      // Use requestAnimationFrame for smoother UI updates
      var self = this;
      requestAnimationFrame(function() {
        self._updateUI();
      });
    }
  }

  _showTranscription(text) {
    if (!this._config.show_transcription) return;
    
    var el = this._globalUI ? this._globalUI.querySelector('.vs-transcription') : null;
    var responseEl = this._globalUI ? this._globalUI.querySelector('.vs-response') : null;
    if (!el) return;
    
    var pos = this._config.bar_position;
    var barHeight = this._config.bar_height;
    
    // Calculate position - transcription appears ABOVE response (further from bar)
    var baseOffset = barHeight + 12;
    var responseHeight = 0;
    
    if (responseEl) {
      responseEl.offsetHeight; // Force layout
      if (responseEl.classList.contains('visible') || responseEl.textContent) {
        responseHeight = responseEl.offsetHeight + 12; // 12px gap
      }
    }
    
    var transcriptionOffset = baseOffset + responseHeight;
    
    // Set position
    if (pos === 'top') {
      el.style.top = transcriptionOffset + 'px';
      el.style.bottom = '';
    } else {
      el.style.bottom = transcriptionOffset + 'px';
      el.style.top = '';
    }
    
    // Force hide first, then show with new text
    el.classList.remove('visible');
    el.offsetHeight; // Force repaint
    el.textContent = text;
    el.classList.add('visible');
    
    // Show blur overlay if enabled
    if (this._config.background_blur) {
      this._showBlur();
    }
  }

  _hideTranscription() {
    var el = this._globalUI ? this._globalUI.querySelector('.vs-transcription') : null;
    if (el) {
      el.classList.remove('visible');
    }
    
    // Hide blur when transcription hides (only if response is also hidden)
    var responseEl = this._globalUI ? this._globalUI.querySelector('.vs-response') : null;
    if (!responseEl || !responseEl.classList.contains('visible')) {
      this._hideBlur();
    }
  }

  _showBlur() {
    var el = this._globalUI ? this._globalUI.querySelector('.vs-blur-overlay') : null;
    if (el) {
      el.classList.add('visible');
    }
  }

  _hideBlur() {
    var el = this._globalUI ? this._globalUI.querySelector('.vs-blur-overlay') : null;
    if (el) {
      el.classList.remove('visible');
    }
  }

  _showResponse(text) {
    if (!this._config.show_response) return;
    
    var el = this._globalUI ? this._globalUI.querySelector('.vs-response') : null;
    var transcriptionEl = this._globalUI ? this._globalUI.querySelector('.vs-transcription') : null;
    if (!el) return;
    
    var pos = this._config.bar_position;
    var barHeight = this._config.bar_height;
    
    // Reset to default width first
    el.style.width = '';
    el.style.maxWidth = '85%';
    el.classList.remove('visible');
    el.textContent = text;
    
    // Force layout calculation
    el.offsetHeight;
    
    // Check if content overflows and needs more width
    var viewportHeight = window.innerHeight;
    var viewportWidth = window.innerWidth;
    var maxAllowedHeight = viewportHeight * 0.5; // Max 50% of viewport height
    
    // If too tall, progressively increase width
    if (el.scrollHeight > maxAllowedHeight) {
      var widthPercents = [90, 92, 94, 96];
      for (var i = 0; i < widthPercents.length; i++) {
        var newWidth = Math.floor(viewportWidth * widthPercents[i] / 100);
        el.style.width = newWidth + 'px';
        el.style.maxWidth = newWidth + 'px';
        el.offsetHeight; // Force recalc
        if (el.scrollHeight <= maxAllowedHeight) break;
      }
    }
    
    el.classList.add('visible');
    
    // Reposition transcription bubble above response
    if (transcriptionEl && transcriptionEl.classList.contains('visible')) {
      var baseOffset = barHeight + 12;
      var responseHeight = el.offsetHeight + 12; // 12px gap
      var transcriptionOffset = baseOffset + responseHeight;
      
      if (pos === 'top') {
        transcriptionEl.style.top = transcriptionOffset + 'px';
        transcriptionEl.style.bottom = '';
      } else {
        transcriptionEl.style.bottom = transcriptionOffset + 'px';
        transcriptionEl.style.top = '';
      }
    }
  }

  _hideResponse() {
    var el = this._globalUI ? this._globalUI.querySelector('.vs-response') : null;
    if (el) {
      el.classList.remove('visible');
    }
    
    // Hide blur when response hides (only if transcription is also hidden)
    var transcriptionEl = this._globalUI ? this._globalUI.querySelector('.vs-transcription') : null;
    if (!transcriptionEl || !transcriptionEl.classList.contains('visible')) {
      this._hideBlur();
    }
  }

  _updateUI() {
    var bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
    
    if (!bar) return;
    
    var states = {};
    states[State.IDLE] = { active: false };
    states[State.CONNECTING] = { active: false };
    states[State.LISTENING] = { active: false };
    states[State.PAUSED] = { active: false };
    states[State.WAKE_WORD_DETECTED] = { active: true, anim: 'listening' };
    states[State.STT] = { active: true, anim: 'listening' };
    states[State.INTENT] = { active: true, anim: 'processing' };
    states[State.TTS] = { active: true, anim: 'speaking' };
    states[State.ERROR] = { active: false };
    
    var s = states[this._state] || states[State.IDLE];
    
    // If service is unavailable and we're going to IDLE/LISTENING, keep error bar visible
    if (this._serviceUnavailable && !s.active) {
      return;
    }
    
    // Clear any inline styles that might override CSS
    bar.style.opacity = '';
    bar.style.transition = '';
    bar.style.background = '';
    bar.style.backgroundSize = '';
    
    // Force remove all classes first
    bar.classList.remove('visible', 'listening', 'processing', 'speaking', 'error-mode');
    
    // Force a repaint by reading offsetHeight
    bar.offsetHeight;
    
    if (s.active) {
      bar.classList.add('visible');
      if (s.anim) bar.classList.add(s.anim);
    }
  }

  _forceUIUpdate() {
    var self = this;
    
    // Ensure global UI exists
    if (!this._globalUI || !document.body.contains(this._globalUI)) {
      this._ensureGlobalUI();
    }
    
    var bar = this._globalUI ? this._globalUI.querySelector('.vs-rainbow-bar') : null;
    if (!bar) return;
    
    // Check if we should be visible
    var shouldBeVisible = (
      this._state === State.WAKE_WORD_DETECTED ||
      this._state === State.STT ||
      this._state === State.INTENT ||
      this._state === State.TTS
    );
    
    if (shouldBeVisible) {
      // Remove all animation classes first (including error-mode)
      bar.classList.remove('listening', 'processing', 'speaking', 'error-mode');
      // Clear any inline styles from error bar
      bar.style.background = '';
      bar.style.backgroundSize = '';
      
      bar.classList.add('visible');
      
      // Clear inline opacity so CSS animations can control it
      bar.style.opacity = '';
      
      // Add correct animation class based on state
      if (this._state === State.INTENT) {
        bar.classList.add('processing');
      } else if (this._state === State.TTS) {
        bar.classList.add('speaking');
      } else {
        bar.classList.add('listening');
      }
    }
  }

  _buildGradient(colors) {
    var colorList = colors.split(',').map(function(c) { return c.trim(); });
    var stops = [];
    for (var i = 0; i < colorList.length; i++) {
      var percent = Math.round((i / (colorList.length - 1)) * 100);
      stops.push(colorList[i] + ' ' + percent + '%');
    }
    return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  }

  _render() {
    var self = this;
    
    // Render minimal content in shadow DOM
    this.shadowRoot.innerHTML = 
      '<style>:host { display: none; }</style>';
    
    // Remove existing global UI to recreate with new config
    this._removeGlobalUI();
    
    // Create global UI elements in document body
    this._ensureGlobalUI();
  }

  _ensureGlobalUI() {
    var self = this;
    
    var pos = this._config.bar_position;
    var height = this._config.bar_height;
    var posStyle = pos === 'top' ? 'top: 0;' : 'bottom: 0;';
    var gradient = this._buildGradient(this._config.bar_gradient);
    
    // Create container
    var container = document.createElement('div');
    container.id = 'voice-satellite-ui';
    container.innerHTML = 
      '<style>' +
        '#voice-satellite-ui .vs-start-btn {' +
          'display: none;' +
          'position: fixed;' +
          'bottom: 20px;' +
          'right: 20px;' +
          'width: 56px;' +
          'height: 56px;' +
          'border-radius: 50%;' +
          'background: var(--primary-color, #03a9f4);' +
          'color: white;' +
          'border: none;' +
          'cursor: pointer;' +
          'box-shadow: 0 4px 12px rgba(0,0,0,0.3);' +
          'z-index: 10001;' +
          'align-items: center;' +
          'justify-content: center;' +
          'transition: transform 0.2s, box-shadow 0.2s;' +
        '}' +
        '#voice-satellite-ui .vs-start-btn.visible {' +
          'display: flex;' +
        '}' +
        '#voice-satellite-ui .vs-start-btn:hover {' +
          'transform: scale(1.1);' +
          'box-shadow: 0 6px 16px rgba(0,0,0,0.4);' +
        '}' +
        '#voice-satellite-ui .vs-start-btn:active {' +
          'transform: scale(0.95);' +
        '}' +
        '#voice-satellite-ui .vs-start-btn svg {' +
          'width: 28px;' +
          'height: 28px;' +
          'fill: white;' +
        '}' +
        '#voice-satellite-ui .vs-transcription {' +
          'position: fixed;' +
          'left: 50%;' +
          'transform: translateX(-50%);' +
          'background: ' + this._config.transcription_background + ';' +
          'color: ' + this._config.transcription_font_color + ';' +
          'padding: ' + this._config.transcription_padding + 'px ' + (this._config.transcription_padding * 2) + 'px;' +
          'border-radius: ' + (this._config.transcription_rounded ? '20px' : '0') + ';' +
          'font-size: ' + this._config.transcription_font_size + 'px;' +
          'font-family: ' + this._config.transcription_font_family + ';' +
          'font-weight: ' + (this._config.transcription_font_bold ? '700' : '400') + ';' +
          'font-style: ' + (this._config.transcription_font_italic ? 'italic' : 'normal') + ';' +
          'max-width: 80%;' +
          'text-align: center;' +
          'opacity: 0;' +
          'transition: opacity 0.3s ease;' +
          'z-index: 10002;' +
          'pointer-events: none;' +
          'border: 2px solid ' + this._config.transcription_border_color + ';' +
        '}' +
        '#voice-satellite-ui .vs-transcription.visible {' +
          'opacity: 1;' +
        '}' +
        '#voice-satellite-ui .vs-response {' +
          'position: fixed;' +
          'left: 50%;' +
          'transform: translateX(-50%);' +
          (pos === 'top' ? 'top: ' + (height + 12) + 'px;' : 'bottom: ' + (height + 12) + 'px;') +
          'background: ' + this._config.response_background + ';' +
          'color: ' + this._config.response_font_color + ';' +
          'padding: ' + this._config.response_padding + 'px ' + (this._config.response_padding * 2) + 'px;' +
          'border-radius: ' + (this._config.response_rounded ? '20px' : '0') + ';' +
          'font-size: ' + this._config.response_font_size + 'px;' +
          'font-family: ' + this._config.response_font_family + ';' +
          'font-weight: ' + (this._config.response_font_bold ? '700' : '400') + ';' +
          'font-style: ' + (this._config.response_font_italic ? 'italic' : 'normal') + ';' +
          'max-width: 85%;' +
          'max-height: 70vh;' +
          'overflow-y: auto;' +
          'text-align: center;' +
          'opacity: 0;' +
          'transition: opacity 0.3s ease;' +
          'z-index: 10001;' +
          'pointer-events: none;' +
          'border: 2px solid ' + this._config.response_border_color + ';' +
        '}' +
        '#voice-satellite-ui .vs-response.visible {' +
          'opacity: 1;' +
        '}' +
        '#voice-satellite-ui .vs-rainbow-bar {' +
          'position: fixed;' +
          'left: 0;' +
          'right: 0;' +
          posStyle +
          'height: ' + height + 'px;' +
          'background: ' + gradient + ';' +
          'background-size: 200% 100%;' +
          'opacity: 0;' +
          'transition: opacity 0.3s ease, height 0.2s ease;' +
          'z-index: 10000;' +
          'pointer-events: none;' +
        '}' +
        '#voice-satellite-ui .vs-rainbow-bar.visible { opacity: 1; }' +
        '#voice-satellite-ui .vs-rainbow-bar.listening {' +
          'animation: vs-flow 1.5s linear infinite;' +
          'height: ' + (height + 2) + 'px;' +
        '}' +
        '#voice-satellite-ui .vs-rainbow-bar.processing {' +
          'animation: vs-flow 0.4s linear infinite;' +
          'height: ' + (height + 4) + 'px;' +
        '}' +
        '#voice-satellite-ui .vs-rainbow-bar.speaking {' +
          'animation: vs-flow 1.5s linear infinite;' +
          'height: ' + (height + 2) + 'px;' +
        '}' +
        '#voice-satellite-ui .vs-rainbow-bar.error-mode {' +
          'animation: vs-flow 2s linear infinite;' +
          'height: ' + (height + 2) + 'px;' +
        '}' +
        '@keyframes vs-flow {' +
          '0% { background-position: 0% 50%; }' +
          '100% { background-position: 200% 50%; }' +
        '}' +
        '#voice-satellite-ui .vs-blur-overlay {' +
          'position: fixed;' +
          'top: 0;' +
          'left: 0;' +
          'right: 0;' +
          'bottom: 0;' +
          'backdrop-filter: blur(' + this._config.background_blur_intensity + 'px);' +
          '-webkit-backdrop-filter: blur(' + this._config.background_blur_intensity + 'px);' +
          'background: rgba(0, 0, 0, 0.2);' +
          'opacity: 0;' +
          'pointer-events: none;' +
          'transition: opacity 0.3s ease;' +
          'z-index: 10000;' +
        '}' +
        '#voice-satellite-ui .vs-blur-overlay.visible {' +
          'opacity: 1;' +
        '}' +
      '</style>' +
      '<div class="vs-blur-overlay"></div>' +
      '<button class="vs-start-btn"><svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg></button>' +
      '<div class="vs-transcription"></div>' +
      '<div class="vs-response"></div>' +
      '<div class="vs-rainbow-bar"></div>';
    
    document.body.appendChild(container);
    this._globalUI = container;
    
    // Add click handler
    container.querySelector('.vs-start-btn').addEventListener('click', function() { 
      self._handleStartClick(); 
    });
  }

  _removeGlobalUI() {
    var ui = document.getElementById('voice-satellite-ui');
    if (ui) {
      ui.remove();
    }
    this._globalUI = null;
  }

  connectedCallback() {
    this._render();
    this._isConnected = true;
    
    // Update UI to reflect current state
    if (this._isStreaming) {
      this._updateUI();
    }
  }

  disconnectedCallback() {
    this._isConnected = false;
    // Don't stop the pipeline - keep it running in the background
    // The audio will continue streaming even when on a different view
    console.log('[VoiceSatellite] Disconnected from DOM, but keeping pipeline alive');
  }

  getCardSize() {
    return 0;
  }
}

class VoiceSatelliteCardEditor extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._rendered = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && !this._rendered) {
      this._render();
    }
  }

  setConfig(config) {
    this._config = config;
    if (this._hass) {
      this._render();
    }
  }

  _render() {
    if (this._rendered) return;
    this._rendered = true;
    
    var self = this;
    
    this.innerHTML = 
      '<style>' +
        '.card-config .row { margin-bottom: 16px; }' +
        '.card-config .row > label { display: block; font-weight: 500; margin-bottom: 4px; }' +
        '.card-config .row > input:not([type="checkbox"]):not([type="range"]), .card-config .row > select { width: 100%; padding: 8px; border: 1px solid var(--divider-color, #e0e0e0); border-radius: 4px; box-sizing: border-box; background: var(--card-background-color, #fff); color: var(--primary-text-color, #000); }' +
        '.card-config .help { font-size: 12px; color: var(--secondary-text-color, #666); margin-top: 4px; }' +
        '.card-config .checkbox-row { display: flex; align-items: center; gap: 8px; }' +
        '.card-config .checkbox-row input { width: auto; }' +
        '.card-config .section { font-weight: 600; margin: 20px 0 12px 0; padding-bottom: 4px; border-bottom: 1px solid var(--divider-color, #e0e0e0); }' +
      '</style>' +
      '<div class="card-config">' +
      
      '<div class="section">Behavior</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="start_listening_on_load"' + (this._config.start_listening_on_load !== false ? ' checked' : '') + '>' +
        '<label for="start_listening_on_load">Start listening automatically</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Wake Word Switch (optional)</label>' +
        '<input type="text" id="wake_word_switch" value="' + (this._config.wake_word_switch || '') + '" placeholder="switch.tablet_screensaver">' +
        '<div class="help">Switch to turn OFF when wake word detected (e.g., Fully Kiosk screensaver)</div>' +
      '</div>' +
      '<div class="row">' +
        '<label>Pipeline Timeout (seconds)</label>' +
        '<input type="number" id="pipeline_timeout" value="' + (this._config.pipeline_timeout !== undefined ? this._config.pipeline_timeout : 60) + '" min="0" max="300">' +
        '<div class="help">Max time to wait for pipeline to complete after wake word. 0 = no timeout.</div>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="chime_on_wake_word"' + (this._config.chime_on_wake_word !== false ? ' checked' : '') + '>' +
        '<label for="chime_on_wake_word">Play chime on wake word detected</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="chime_on_request_sent"' + (this._config.chime_on_request_sent !== false ? ' checked' : '') + '>' +
        '<label for="chime_on_request_sent">Play chime after request sent</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="debug"' + (this._config.debug ? ' checked' : '') + '>' +
        '<label for="debug">Show debug info in console</label>' +
      '</div>' +
      
      '<div class="section">Microphone Processing</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="noise_suppression"' + (this._config.noise_suppression !== false ? ' checked' : '') + '>' +
        '<label for="noise_suppression">Noise Suppression</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="echo_cancellation"' + (this._config.echo_cancellation !== false ? ' checked' : '') + '>' +
        '<label for="echo_cancellation">Echo Cancellation</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="auto_gain_control"' + (this._config.auto_gain_control !== false ? ' checked' : '') + '>' +
        '<label for="auto_gain_control">Auto Gain Control</label>' +
      '</div>' +
      
      '<div class="section">Appearance - Bar</div>' +
      '<div class="row">' +
        '<label>Bar Height (px)</label>' +
        '<input type="number" id="bar_height" value="' + (this._config.bar_height || 16) + '" min="2" max="40">' +
      '</div>' +
      '<div class="row">' +
        '<label>Bar Position</label>' +
        '<select id="bar_position">' +
          '<option value="bottom"' + (this._config.bar_position === 'bottom' ? ' selected' : '') + '>Bottom</option>' +
          '<option value="top"' + (this._config.bar_position === 'top' ? ' selected' : '') + '>Top</option>' +
        '</select>' +
      '</div>' +
      '<div class="row">' +
        '<label>Bar Gradient Colors</label>' +
        '<input type="text" id="bar_gradient" value="' + (this._config.bar_gradient || '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC') + '">' +
        '<div class="help">Comma-separated list of colors (e.g., #FF0000, #00FF00, #0000FF)</div>' +
      '</div>' +
      
      '<div class="section">Transcription Bubble (User Speech)</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="show_transcription"' + (this._config.show_transcription !== false ? ' checked' : '') + '>' +
        '<label for="show_transcription">Show transcription bubble (user speech)</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Font Size (px)</label>' +
        '<input type="number" id="transcription_font_size" value="' + (this._config.transcription_font_size || 20) + '" min="10" max="60">' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Font Family</label>' +
        '<input type="text" id="transcription_font_family" value="' + (this._config.transcription_font_family || 'inherit') + '" placeholder="inherit">' +
        '<div class="help">CSS font family (e.g., inherit, Roboto, system-ui, monospace)</div>' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Font Color</label>' +
        '<input type="text" id="transcription_font_color" value="' + (this._config.transcription_font_color || '#444444') + '" placeholder="#444444">' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="transcription_font_bold"' + (this._config.transcription_font_bold !== false ? ' checked' : '') + '>' +
        '<label for="transcription_font_bold">Bold</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="transcription_font_italic"' + (this._config.transcription_font_italic ? ' checked' : '') + '>' +
        '<label for="transcription_font_italic">Italic</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Background Color</label>' +
        '<input type="text" id="transcription_background" value="' + (this._config.transcription_background || '#ffffff') + '" placeholder="#ffffff">' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Border Color</label>' +
        '<input type="text" id="transcription_border_color" value="' + (this._config.transcription_border_color || 'rgba(0, 180, 255, 0.5)') + '" placeholder="rgba(0, 180, 255, 0.5)">' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Padding (px)</label>' +
        '<input type="number" id="transcription_padding" value="' + (this._config.transcription_padding !== undefined ? this._config.transcription_padding : 16) + '" min="0" max="32">' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="transcription_rounded"' + (this._config.transcription_rounded !== false ? ' checked' : '') + '>' +
        '<label for="transcription_rounded">Rounded corners on transcription bubble</label>' +
      '</div>' +
      
      '<div class="section">Response Bubble (Assistant Speech)</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="show_response"' + (this._config.show_response !== false ? ' checked' : '') + '>' +
        '<label for="show_response">Show response bubble (assistant speech)</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="streaming_response"' + (this._config.streaming_response ? ' checked' : '') + '>' +
        '<label for="streaming_response">Stream text response in real-time</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Font Size (px)</label>' +
        '<input type="number" id="response_font_size" value="' + (this._config.response_font_size || 20) + '" min="10" max="60">' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Font Family</label>' +
        '<input type="text" id="response_font_family" value="' + (this._config.response_font_family || 'inherit') + '" placeholder="inherit">' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Font Color</label>' +
        '<input type="text" id="response_font_color" value="' + (this._config.response_font_color || '#444444') + '" placeholder="#444444">' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="response_font_bold"' + (this._config.response_font_bold !== false ? ' checked' : '') + '>' +
        '<label for="response_font_bold">Bold</label>' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="response_font_italic"' + (this._config.response_font_italic ? ' checked' : '') + '>' +
        '<label for="response_font_italic">Italic</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Background Color</label>' +
        '<input type="text" id="response_background" value="' + (this._config.response_background || '#ffffff') + '" placeholder="#ffffff">' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Padding (px)</label>' +
        '<input type="number" id="response_padding" value="' + (this._config.response_padding !== undefined ? this._config.response_padding : 16) + '" min="0" max="32">' +
      '</div>' +
      '<div class="row">' +
        '<label>Response Border Color</label>' +
        '<input type="text" id="response_border_color" value="' + (this._config.response_border_color || 'rgba(100, 200, 150, 0.5)') + '" placeholder="rgba(100, 200, 150, 0.5)">' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="response_rounded"' + (this._config.response_rounded !== false ? ' checked' : '') + '>' +
        '<label for="response_rounded">Rounded corners on response bubble</label>' +
      '</div>' +
      
      '<div class="section">Background Blur</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="background_blur"' + (this._config.background_blur !== false ? ' checked' : '') + '>' +
        '<label for="background_blur">Blur background when bubbles are visible</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Blur Intensity (px)</label>' +
        '<input type="number" id="background_blur_intensity" value="' + (this._config.background_blur_intensity !== undefined ? this._config.background_blur_intensity : 5) + '" min="1" max="30">' +
      '</div>' +
      
      '</div>';
    
    // Set up fields
    var fields = ['bar_height', 'bar_position', 'bar_gradient', 'start_listening_on_load', 
                  'wake_word_switch', 'pipeline_timeout', 'chime_on_wake_word', 'chime_on_request_sent', 'debug',
                  'noise_suppression', 'echo_cancellation', 'auto_gain_control',
                  'show_transcription', 'transcription_font_size', 'transcription_font_family', 'transcription_font_color', 
                  'transcription_font_bold', 'transcription_font_italic',
                  'transcription_background', 'transcription_border_color', 'transcription_padding', 'transcription_rounded',
                  'show_response', 'streaming_response', 'response_font_size', 'response_font_family', 'response_font_color',
                  'response_font_bold', 'response_font_italic',
                  'response_background', 'response_border_color', 'response_padding', 'response_rounded',
                  'background_blur', 'background_blur_intensity'];
    
    fields.forEach(function(id) {
      var el = self.querySelector('#' + id);
      if (el) {
        el.addEventListener('change', function(e) { self._changed(e); });
        if (el.type === 'range') {
          el.addEventListener('input', function(e) { self._changed(e); });
        }
      }
    });
  }

  _valueChanged(key, value) {
    var newConfig = Object.assign({}, this._config);
    newConfig[key] = value;
    
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: newConfig },
      bubbles: true,
      composed: true
    }));
  }

  _changed(e) {
    var t = e.target;
    var value;
    
    if (t.type === 'checkbox') {
      value = t.checked;
    } else if (t.type === 'number' || t.type === 'range') {
      value = parseFloat(t.value);
    } else {
      value = t.value;
    }
    
    this._valueChanged(t.id, value);
  }
}

customElements.define('voice-satellite-card', VoiceSatelliteCard);
customElements.define('voice-satellite-card-editor', VoiceSatelliteCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Turn your browser into a voice satellite with server-side wake word detection',
  preview: true
});

console.info(
  '%c VOICE-SATELLITE-CARD %c v1.7.0 ',
  'color: white; background: #4CAF50; font-weight: bold; padding: 2px 6px; border-radius: 4px 0 0 4px;',
  'color: #4CAF50; background: white; font-weight: bold; padding: 2px 6px; border-radius: 0 4px 4px 0; border: 1px solid #4CAF50;'
);
