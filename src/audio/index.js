/**
 * Voice Satellite Card — AudioManager
 *
 * Handles microphone acquisition, AudioContext management,
 * and audio stream send control.
 */

import { setupAudioWorklet, setupScriptProcessor, sendAudioBuffer } from './processing.js';

export class AudioManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._scriptProcessor = null;
    this._audioBuffer = [];
    this._sendInterval = null;
    this._actualSampleRate = 16000;
  }

  // --- Public accessors ---

  get card() { return this._card; }
  get log() { return this._log; }
  get audioContext() { return this._audioContext; }
  get isStreaming() { return !!this._sendInterval; }
  get workletNode() { return this._workletNode; }
  set workletNode(val) { this._workletNode = val; }
  get scriptProcessor() { return this._scriptProcessor; }
  set scriptProcessor(val) { this._scriptProcessor = val; }
  get audioBuffer() { return this._audioBuffer; }
  set audioBuffer(val) { this._audioBuffer = val; }
  get actualSampleRate() { return this._actualSampleRate; }

  // --- Public API ---

  async startMicrophone() {
    await this._ensureAudioContextRunning();

    const { config } = this._card;
    this._log.log('mic', `AudioContext state=${this._audioContext.state} sampleRate=${this._audioContext.sampleRate}`);

    const audioConstraints = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: config.echo_cancellation,
      noiseSuppression: config.noise_suppression,
      autoGainControl: config.auto_gain_control,
    };

    if (config.voice_isolation) {
      audioConstraints.advanced = [{ voiceIsolation: true }];
    }

    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    if (config.debug) {
      const tracks = this._mediaStream.getAudioTracks();
      this._log.log('mic', `Got media stream with ${tracks.length} audio track(s)`);
      if (tracks.length > 0) {
        this._log.log('mic', `Track settings: ${JSON.stringify(tracks[0].getSettings())}`);
      }
    }

    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._actualSampleRate = this._audioContext.sampleRate;
    this._log.log('mic', `Actual sample rate: ${this._actualSampleRate}`);

    try {
      await setupAudioWorklet(this, this._sourceNode);
      this._log.log('mic', 'Audio capture via AudioWorklet');
    } catch (e) {
      this._log.log('mic', `AudioWorklet unavailable (${e.message}), using ScriptProcessor`);
      setupScriptProcessor(this, this._sourceNode);
      this._log.log('mic', 'Audio capture via ScriptProcessor');
    }
  }

  stopMicrophone() {
    this.stopSending();
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
      this._mediaStream.getTracks().forEach((track) => track.stop());
      this._mediaStream = null;
    }
    this._audioBuffer = [];
  }

  /**
   * @param {() => number|null} binaryHandlerIdGetter
   */
  startSending(binaryHandlerIdGetter) {
    this.stopSending();
    this._sendInterval = setInterval(() => {
      sendAudioBuffer(this, binaryHandlerIdGetter());
    }, 100);
  }

  stopSending() {
    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
  }

  pause() {
    this.stopSending();
    this._mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
  }

  resume() {
    this._mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
  }

  async ensureAudioContextForGesture() {
    try {
      if (!this._audioContext) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000,
        });
      }
      if (this._audioContext.state === 'suspended') {
        await this._audioContext.resume();
      }
    } catch (e) {
      this._log.error('mic', `Failed to resume AudioContext on click: ${e}`);
    }
  }

  // --- Private ---

  async _ensureAudioContextRunning() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
    }
    if (this._audioContext.state === 'suspended') {
      this._log.log('mic', 'Resuming suspended AudioContext');
      await this._audioContext.resume();
    }
    if (this._audioContext.state !== 'running') {
      throw new Error(`AudioContext failed to start: ${this._audioContext.state}`);
    }
  }
}
