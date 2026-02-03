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
 * @version 1.1.0
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
    
    this._isStreaming = false;
    this._isPaused = false;
    this._isConnected = false;
    this._isSpeaking = false;
    this._reconnectAttempts = 0;
    this._reconnectTimeout = null;
    
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
      bar_height: config.bar_height !== undefined ? config.bar_height : 4,
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
      // Microphone processing options
      noise_suppression: config.noise_suppression !== false,
      auto_gain_control: config.auto_gain_control !== false,
      echo_cancellation: config.echo_cancellation !== false,
      // Transcription options
      show_transcription: config.show_transcription !== false,
      transcription_font_size: config.transcription_font_size !== undefined ? config.transcription_font_size : 30,
      transcription_font_family: config.transcription_font_family || 'inherit',
      transcription_font_color: config.transcription_font_color || '#444444',
      transcription_background: config.transcription_background || 'rgba(255, 255, 255, 0.85)',
      transcription_padding: config.transcription_padding !== undefined ? config.transcription_padding : 16,
      transcription_rounded: config.transcription_rounded !== false
    };
    
    this._render();
  }

  set hass(hass) {
    var firstSet = !this._hass;
    this._hass = hass;
    
    if (firstSet && hass && this._config.start_listening_on_load) {
      var self = this;
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
      await this._startPipeline();
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
      await this._startPipeline();
    } catch (error) {
      console.error('[VoiceSatellite] Start failed:', error);
      this._showStartButton();
    }
  }

  async _startPipeline() {
    if (this._isStreaming) return;
    var self = this;
    
    this._setState(State.CONNECTING);
    this._reconnectAttempts = 0;
    
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
    
    this._isStreaming = true;
    this._pipelineId = pipelineId;
    
    await this._subscribeToPipeline(pipelineId);
  }

  async _subscribeToPipeline(pipelineId) {
    var self = this;
    
    var pipelineOptions = {
      type: 'assist_pipeline/run',
      start_stage: 'wake_word',
      end_stage: 'tts',
      input: {
        sample_rate: SAMPLE_RATE,
        timeout: this._config.wake_word_timeout
      },
      pipeline: pipelineId
    };
    
    // Add STT timeout if specified
    if (this._config.stt_timeout > 0) {
      pipelineOptions.timeout = this._config.stt_timeout;
    }
    
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
    
    var source = this._audioContext.createMediaStreamSource(this._mediaStream);
    
    // Try to use AudioWorklet (more efficient), fall back to ScriptProcessor
    try {
      await this._setupAudioWorklet(source);
      this._useWorklet = true;
      console.log('[VoiceSatellite] Using AudioWorklet for audio processing');
    } catch (e) {
      console.log('[VoiceSatellite] AudioWorklet not available, using ScriptProcessor:', e.message);
      this._setupScriptProcessor(source);
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
      }
    } catch (e) {
      console.error('[VoiceSatellite] Error sending audio:', e);
    }
  }

  _handlePipelineEvent(event) {
    var self = this;
    var eventType = event.type;
    var eventData = event.data || {};
    
    if (this._config.debug) {
      console.log('[VoiceSatellite] Event:', eventType, eventData);
    }
    
    // Reset reconnect attempts on successful event
    this._reconnectAttempts = 0;
    
    switch (eventType) {
      case 'run-start':
        if (eventData.runner_data && eventData.runner_data.stt_binary_handler_id !== undefined) {
          this._binaryHandlerId = eventData.runner_data.stt_binary_handler_id;
        }
        this._setState(State.LISTENING);
        console.log('[VoiceSatellite] Pipeline started, binary_handler_id:', this._binaryHandlerId);
        break;
        
      case 'wake_word-start':
        this._setState(State.LISTENING);
        break;
        
      case 'wake_word-end':
        if (eventData.wake_word_output) {
          console.log('[VoiceSatellite] Wake word detected!');
          
          // Force hide transcription from previous run
          this._hideTranscription();
          
          // Force state update
          this._state = State.WAKE_WORD_DETECTED;
          
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
        break;
        
      case 'intent-end':
        if (eventData.intent_output && eventData.intent_output.response) {
          var response = eventData.intent_output.response;
          if (response.speech && response.speech.plain) {
            console.log('[VoiceSatellite] Response:', response.speech.plain.speech);
          }
        }
        break;
        
      case 'tts-start':
        this._setState(State.TTS);
        this._forceUIUpdate();
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
        
        // Only reset state if not playing TTS audio
        if (this._state !== State.TTS || !this._isSpeaking) {
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
        break;
        
      case 'error':
        console.error('[VoiceSatellite] Pipeline error:', eventData);
        this._handlePipelineError();
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

  async _restartPipeline() {
    var self = this;
    
    console.log('[VoiceSatellite] Restarting pipeline...');
    this._binaryHandlerId = null;
    
    try {
      if (this._unsub) {
        try { this._unsub(); } catch(e) {}
      }
      
      await this._subscribeToPipeline(this._pipelineId);
      
    } catch (error) {
      console.error('[VoiceSatellite] Failed to restart pipeline:', error);
      this._handlePipelineError();
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
    
    console.log('[VoiceSatellite] Resuming (tab visible)');
    
    // Clear the paused flag
    this._isPaused = false;
    
    // The audio nodes may have stopped working after suspend
    // Safest approach is to recreate the microphone connection
    await this._reconnectMicrophone();
    
    // Restart pipeline to get fresh handler ID
    await this._restartPipeline();
  }

  async _reconnectMicrophone() {
    console.log('[VoiceSatellite] Reconnecting microphone...');
    
    // Stop existing audio processing but keep the stream
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    
    // Resume audio context if needed
    if (this._audioContext && this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
      console.log('[VoiceSatellite] Audio context resumed, state:', this._audioContext.state);
    }
    
    // Recreate the source and processor nodes
    if (this._mediaStream && this._audioContext) {
      var source = this._audioContext.createMediaStreamSource(this._mediaStream);
      
      // Try to use AudioWorklet, fall back to ScriptProcessor
      if (this._useWorklet) {
        try {
          await this._setupAudioWorklet(source);
          console.log('[VoiceSatellite] AudioWorklet reconnected');
        } catch (e) {
          console.log('[VoiceSatellite] AudioWorklet reconnect failed, using ScriptProcessor');
          this._setupScriptProcessor(source);
          this._useWorklet = false;
        }
      } else {
        this._setupScriptProcessor(source);
        console.log('[VoiceSatellite] ScriptProcessor reconnected');
      }
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

  async _playResponse(url) {
    var self = this;
    try {
      this._isSpeaking = true;
      var audio = new Audio(url);
      // Browser audio maxes out at 1.0 (100%)
      audio.volume = Math.min(this._config.tts_volume / 100, 1.0);
      
      audio.onended = function() {
        self._isSpeaking = false;
        
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
      
      audio.onerror = function() {
        self._isSpeaking = false;
        self._state = State.IDLE;
        self._updateUI();
      };
      
      await audio.play();
    } catch (error) {
      console.error('[VoiceSatellite] Playback error:', error);
      this._isSpeaking = false;
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
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      
      if (type === 'wake') {
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.16);
      } else {
        osc.frequency.setValueAtTime(784, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08);
      }
      
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }

  _setState(state) {
    if (this._state !== state) {
      if (this._config.debug) {
        console.log('[VoiceSatellite] State:', this._state, '->', state);
      }
      this._state = state;
      
      // Hide transcription when going back to listening
      if (state === State.LISTENING) {
        this._hideTranscription();
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
    if (el) {
      // Force hide first, then show with new text
      el.classList.remove('visible');
      el.offsetHeight; // Force repaint
      el.textContent = text;
      el.classList.add('visible');
    }
  }

  _hideTranscription() {
    var el = this._globalUI ? this._globalUI.querySelector('.vs-transcription') : null;
    if (el) {
      el.classList.remove('visible');
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
    
    // Clear any inline styles that might override CSS
    bar.style.opacity = '';
    bar.style.transition = '';
    
    // Force remove all classes first
    bar.classList.remove('visible', 'listening', 'processing', 'speaking');
    
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
      // Remove all animation classes first
      bar.classList.remove('listening', 'processing', 'speaking');
      bar.classList.add('visible');
      
      // Add correct animation class based on state
      if (this._state === State.INTENT) {
        bar.style.opacity = '1';
        bar.classList.add('processing');
      } else if (this._state === State.TTS) {
        // Clear inline opacity so CSS pulse animation can control it
        bar.style.opacity = '';
        bar.classList.add('speaking');
      } else {
        bar.style.opacity = '1';
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
          (pos === 'top' ? 'top: ' + (height + 12) + 'px;' : 'bottom: ' + (height + 12) + 'px;') +
          'background: ' + this._config.transcription_background + ';' +
          'color: ' + this._config.transcription_font_color + ';' +
          'padding: ' + this._config.transcription_padding + 'px ' + (this._config.transcription_padding * 2) + 'px;' +
          'border-radius: ' + (this._config.transcription_rounded ? '20px' : '0') + ';' +
          'font-size: ' + this._config.transcription_font_size + 'px;' +
          'font-family: ' + this._config.transcription_font_family + ';' +
          'font-weight: 500;' +
          'max-width: 80%;' +
          'text-align: center;' +
          'opacity: 0;' +
          'transition: opacity 0.3s ease;' +
          'z-index: 10001;' +
          'pointer-events: none;' +
          'box-shadow: 0 2px 6px rgba(0,0,0,0.15);' +
        '}' +
        '#voice-satellite-ui .vs-transcription.visible {' +
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
        '@keyframes vs-flow {' +
          '0% { background-position: 0% 50%; }' +
          '100% { background-position: 200% 50%; }' +
        '}' +
      '</style>' +
      '<button class="vs-start-btn"><svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg></button>' +
      '<div class="vs-transcription"></div>' +
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
      
      '<div class="section">Appearance</div>' +
      '<div class="row">' +
        '<label>Bar Height (px)</label>' +
        '<input type="number" id="bar_height" value="' + (this._config.bar_height || 4) + '" min="2" max="20">' +
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
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="show_transcription"' + (this._config.show_transcription !== false ? ' checked' : '') + '>' +
        '<label for="show_transcription">Show transcription bubble</label>' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Font Size (px)</label>' +
        '<input type="number" id="transcription_font_size" value="' + (this._config.transcription_font_size || 30) + '" min="10" max="60">' +
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
      '<div class="row">' +
        '<label>Transcription Background Color</label>' +
        '<input type="text" id="transcription_background" value="' + (this._config.transcription_background || 'rgba(255, 255, 255, 0.85)') + '" placeholder="rgba(255, 255, 255, 0.85)">' +
      '</div>' +
      '<div class="row">' +
        '<label>Transcription Padding (px)</label>' +
        '<input type="number" id="transcription_padding" value="' + (this._config.transcription_padding !== undefined ? this._config.transcription_padding : 16) + '" min="0" max="32">' +
      '</div>' +
      '<div class="row checkbox-row">' +
        '<input type="checkbox" id="transcription_rounded"' + (this._config.transcription_rounded !== false ? ' checked' : '') + '>' +
        '<label for="transcription_rounded">Rounded corners on transcription bubble</label>' +
      '</div>' +
      
      '</div>';
    
    // Set up fields
    var fields = ['bar_height', 'bar_position', 'bar_gradient', 'start_listening_on_load', 
                  'wake_word_switch', 'chime_on_wake_word', 'chime_on_request_sent', 'debug',
                  'noise_suppression', 'echo_cancellation', 'auto_gain_control',
                  'show_transcription', 'transcription_font_size', 'transcription_font_family', 'transcription_font_color', 
                  'transcription_background', 'transcription_padding', 'transcription_rounded'];
    
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
  '%c VOICE-SATELLITE-CARD %c v1.1.0 ',
  'color: white; background: #4CAF50; font-weight: bold; padding: 2px 6px; border-radius: 4px 0 0 4px;',
  'color: #4CAF50; background: white; font-weight: bold; padding: 2px 6px; border-radius: 0 4px 4px 0; border: 1px solid #4CAF50;'
);
