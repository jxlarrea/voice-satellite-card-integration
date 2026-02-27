/**
 * AudioManager
 *
 * Handles microphone acquisition, AudioContext management,
 * and audio stream send control.
 */

import { setupAudioWorklet, sendAudioBuffer } from './processing.js';

export class AudioManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._audioBuffer = [];
    this._sendInterval = null;
    this._actualSampleRate = 16000;
  }
  get card() { return this._card; }
  get log() { return this._log; }
  get audioContext() { return this._audioContext; }
  get workletNode() { return this._workletNode; }
  set workletNode(val) { this._workletNode = val; }
  get audioBuffer() { return this._audioBuffer; }
  set audioBuffer(val) { this._audioBuffer = val; }
  get actualSampleRate() { return this._actualSampleRate; }
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

    // Tap mic into analyser for reactive bar (parallel connection - doesn't disrupt pipeline)
    if (this._card.isReactiveBarEnabled) {
      this._card.analyser.attachMic(this._sourceNode, this._audioContext);
    }

    await setupAudioWorklet(this, this._sourceNode);
    this._log.log('mic', 'Audio capture via AudioWorklet');
  }

  stopMicrophone() {
    this.stopSending();
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._sourceNode) {
      this._card.analyser.detachMic(this._sourceNode);
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
    let firstSendLogged = false;
    this._sendInterval = setInterval(() => {
      const handlerId = binaryHandlerIdGetter();
      if (!firstSendLogged && this._audioBuffer.length > 0) {
        firstSendLogged = true;
        this._log.log('mic', `First audio send - handlerId=${handlerId} bufferChunks=${this._audioBuffer.length}`);
      }
      sendAudioBuffer(this, handlerId);
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

  async resume() {
    // Discard stale audio accumulated during the hidden period - the worklet
    // may have kept running (producing silence) while the tab was in the
    // background.  Sending this to the server would clog the wake word engine.
    this._audioBuffer = [];

    this._mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    // Browser suspends AudioContext when tab is in background  - 
    // worklet/processor stops producing audio until we resume it.
    if (this._audioContext?.state === 'suspended') {
      this._log.log('mic', 'Resuming suspended AudioContext');
      await this._audioContext.resume();
    }
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
  async _ensureAudioContextRunning() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
    }
    if (this._audioContext.state === 'suspended') {
      this._log.log('mic', 'Resuming suspended AudioContext');
      // Chrome may keep resume() pending (no reject) until a user gesture.
      // Timeout so startup can fall back to the explicit start button UI.
      await this._resumeAudioContextWithTimeout();
    }
    if (this._audioContext.state !== 'running') {
      throw new Error(`AudioContext failed to start: ${this._audioContext.state}`);
    }
  }

  async _resumeAudioContextWithTimeout() {
    const ctx = this._audioContext;
    if (!ctx || ctx.state !== 'suspended') return;

    let timeoutId = null;
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const err = new Error('AudioContext resume timed out waiting for user gesture');
            err.name = 'NotAllowedError';
            reject(err);
          }, 800);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
