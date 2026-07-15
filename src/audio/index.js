/**
 * AudioManager
 *
 * Handles microphone acquisition, AudioContext management,
 * and audio stream send control.
 */

import { setupAudioWorklet, setupPushAudioSource, sendAudioBuffer } from './processing.js';
import { resolveDspForMode } from './dsp-config.js';
import { describeAudioInputDevices, describeSelectedAudioTrack } from './devices.js';
import * as kiosk from '../kiosk/index.js';

const TARGET_SAMPLE_RATE = 16000;

/**
 * Stands in for a MediaStream when Kiosk Satellite is the audio source.
 * There is no real getUserMedia stream in that mode, but callers treat
 * `_mediaStream` as "the mic is up" and may iterate its tracks, so duck-typing
 * an empty track list keeps all of them working without special cases.
 */
const KIOSK_MEDIA_STREAM = Object.freeze({
  kioskSatellite: true,
  getTracks: () => [],
  getAudioTracks: () => [],
});

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
    this._actualSampleRate = TARGET_SAMPLE_RATE;
    this._sendSessionCount = 0;
    this._silentGainNode = null;
    this._captureBuffering = false;
    // Authoritative mute flag — separate from any specific MediaStreamTrack
    // so a stream swap (switchMicMode) can re-apply it to the new tracks
    // without racing the wake-word handler's synchronous mute call.
    this._micTracksMuted = false;
  }

  /** Read-only — true while all mic tracks should be silent. */
  get micTracksMuted() { return this._micTracksMuted; }

  /**
   * Mute / unmute all audio tracks on the current MediaStream.  Records
   * the desired state so subsequent stream rebuilds (switchMicMode) can
   * reproduce it.  Replaces the wake-word handler's direct
   * `track.enabled = ...` poking, which had no way to survive a stream
   * swap mid-mute.
   */
  setMicTracksMuted(muted) {
    this._micTracksMuted = !!muted;
    // The Kiosk Satellite source has no MediaStreamTracks to disable (the app
    // owns the capture), so muting is enforced where its chunks arrive - see
    // _startKioskMicrophone. Without that, this would silently do nothing and
    // the wake chime would land in the STT recording.
    if (this._mediaStream) {
      this._mediaStream.getAudioTracks().forEach((t) => { t.enabled = !this._micTracksMuted; });
    }
  }
  get card() { return this._card; }
  get log() { return this._log; }
  get audioContext() { return this._audioContext; }
  get sourceNode() { return this._sourceNode; }
  get workletNode() { return this._workletNode; }
  set workletNode(val) { this._workletNode = val; }
  get audioBuffer() { return this._audioBuffer; }
  set audioBuffer(val) { this._audioBuffer = val; }
  get actualSampleRate() { return this._actualSampleRate; }
  get currentMicMode() { return this._currentMicMode || 'wake_word'; }
  /**
   * Acquire the mic.  `mode` selects which DSP config group applies — the
   * panel exposes separate toggles for wake-word listening vs. STT
   * streaming, and the engine restarts the mic on the state transition so
   * each phase gets the signal shape it was tuned for.
   *
   * @param {'wake_word' | 'stt'} [mode='wake_word']
   */
  async startMicrophone(mode = 'wake_word') {
    await this._ensureAudioContextRunning();

    // Kiosk Satellite owns the mic (it is already capturing for native
    // wake-word detection).  Stream its audio instead of opening a second
    // capture: getUserMedia costs ~600 ms here, which is dead air right after
    // the wake word, exactly where the user's command starts.
    if (this._card._nativeWakeActive && kiosk.supportsAudioStream()) {
      await this._startKioskMicrophone(mode);
      return;
    }

    const { config } = this._card;
    this._currentMicMode = mode;
    this._log.log('mic', `AudioContext state=${this._audioContext.state} sampleRate=${this._audioContext.sampleRate} mode=${mode}`);

    const dsp = resolveDspForMode(config, mode);
    const audioConstraints = {
      sampleRate: TARGET_SAMPLE_RATE,
      channelCount: 1,
      echoCancellation: dsp.echoCancellation,
      noiseSuppression: dsp.noiseSuppression,
      autoGainControl: dsp.autoGainControl,
    };

    if (dsp.voiceIsolation) {
      audioConstraints.advanced = [{ voiceIsolation: true }];
    }

    this._mediaStream = await this._getUserMediaWithDeviceFallback(audioConstraints, mode);

    if (config.debug) {
      const tracks = this._mediaStream.getAudioTracks();
      this._log.log('mic', `Got media stream with ${tracks.length} audio track(s)`);
      if (tracks.length > 0) {
        this._log.log('mic', `Track settings: ${JSON.stringify(tracks[0].getSettings())}`);
      }
    }
    await this._logMicDevices('initial');

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

  /**
   * Acquire audio from Kiosk Satellite rather than getUserMedia.
   *
   * The app hands us 16 kHz mono PCM16 that it is already capturing, opening
   * with a short pre-roll of audio from just before this call, so the stream
   * effectively starts *before* the user began speaking their command, and
   * nothing is clipped.  Chunks are pushed into the same `_audioBuffer` the
   * AudioWorklet would fill, so everything downstream (`sendAudioBuffer`, the
   * 100 ms send loop, the pipeline) is unchanged.  `_actualSampleRate` is
   * already 16 kHz, so the resampler is skipped entirely.
   *
   * @param {'wake_word' | 'stt'} mode
   */
  async _startKioskMicrophone(mode) {
    this._currentMicMode = mode;
    this._actualSampleRate = TARGET_SAMPLE_RATE;

    // Republish the delegated audio as a real AudioNode so the reactive bar's
    // analyser can tap it exactly like a mic source (see setupPushAudioSource).
    this._sourceNode = await setupPushAudioSource(this);
    if (this._card.isReactiveBarEnabled) {
      this._card.analyser.attachMic(this._sourceNode, this._audioContext);
    }

    kiosk.bindAudioStream((samples, _rate, preRoll) => {
      // Muted: drop the audio on the floor rather than buffer it. This is what
      // disabling the MediaStream's tracks does for a getUserMedia source, and
      // it is what keeps the deferred wake chime out of the STT recording
      // during the cross-tablet dedupe window.
      if (this._micTracksMuted) return;
      // Mirror the AudioWorklet handler: only buffer while we're streaming to
      // the pipeline (or during the brief pre-handler capture window).
      if (this._sendInterval || this._captureBuffering) {
        this._audioBuffer.push(samples);
      }
      // The pre-roll is audio from *before* the stream opened. The pipeline
      // needs it, the reactive bar must not see it: this graph runs at 16 kHz
      // and is fed 16 kHz, so it drains exactly as fast as it fills and any
      // head start becomes permanent latency (the bar would trail live speech
      // by the whole pre-roll for the rest of the turn).
      if (preRoll) return;
      // Drive the reactive bar. Copy: the worklet transfers/retains the
      // buffer, and the same samples are already queued for the pipeline.
      const node = this._sourceNode;
      if (node) node.port.postMessage(samples.slice());
    });

    const res = await kiosk.startAudioStream();
    if (!res) {
      kiosk.unbindAudioStream();
      this._log.error('mic', 'Kiosk Satellite audio stream failed to start');
      throw new Error('kiosk audio stream unavailable');
    }
    this._mediaStream = KIOSK_MEDIA_STREAM;
    this._log.log(
      'mic',
      `Audio capture via Kiosk Satellite (native mic, ${res.sampleRate}Hz, no getUserMedia)`,
    );
  }

  /**
   * Swap the MediaStream to a new DSP mode without tearing down the
   * AudioContext or AudioWorklet.  Re-acquires getUserMedia with the
   * target-mode constraints, reconnects the new source to the existing
   * worklet, and leaves the send loop running.  Typical dropout: ~20–50 ms
   * (getUserMedia latency), far less than a full startMicrophone+context
   * teardown.
   *
   * Called on pipeline state transitions so the wake-word and STT phases
   * each see the signal shape they were tuned for.
   *
   * @param {'wake_word' | 'stt'} mode
   */
  async switchMicMode(mode) {
    // Kiosk Satellite source: DSP is the app's business (it applies its own
    // capture config), and there is no MediaStream to re-acquire, so a mode
    // swap is a no-op beyond recording the intent.
    if (this._mediaStream === KIOSK_MEDIA_STREAM) {
      this._currentMicMode = mode;
      return;
    }
    if (!this._audioContext || !this._workletNode) return;
    if (this._currentMicMode === mode) return;
    const { config } = this._card;
    const dsp = resolveDspForMode(config, mode);
    this._log.log('mic', `switchMicMode → ${mode}`);

    const audioConstraints = {
      sampleRate: TARGET_SAMPLE_RATE,
      channelCount: 1,
      echoCancellation: dsp.echoCancellation,
      noiseSuppression: dsp.noiseSuppression,
      autoGainControl: dsp.autoGainControl,
    };
    if (dsp.voiceIsolation) audioConstraints.advanced = [{ voiceIsolation: true }];
    this._applyConfiguredDevice(audioConstraints);

    // Acquire the new stream BEFORE tearing the old one down so the old
    // sourceNode keeps feeding the analyser (reactive bar) and the worklet
    // throughout the getUserMedia round-trip.  Otherwise the UI shows a
    // 50-200 ms dead patch between wake-word detection and STT start that
    // looks like a UI stagger.  Cutover is a single synchronous disconnect +
    // connect, well under one audio render quantum.
    let nextStream;
    try {
      nextStream = await this._getUserMediaWithDeviceFallback(audioConstraints, mode);
    } catch (e) {
      this._log.error('mic', `switchMicMode getUserMedia failed: ${e.message || e}`);
      return;
    }

    // If the session was torn down while we were awaiting getUserMedia,
    // clean up the stream we just got and bail.
    if (!this._audioContext || !this._workletNode) {
      nextStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      return;
    }

    const oldSource = this._sourceNode;
    const oldStream = this._mediaStream;

    // Carry mute state across the swap.  The wake-word handler mutes the
    // mic via setMicTracksMuted() between `setState(WAKE_WORD_DETECTED)`
    // (which triggers this swap) and the chime playing — if we left the
    // new stream's tracks live while getUserMedia was in flight, the
    // chime would bleed into the mic for 100-200 ms once the new tracks
    // came up, showing as a clearly-audio-reactive bar during the chime.
    // Reading from `_micTracksMuted` (authoritative flag) instead of
    // sampling `oldStream`'s track.enabled state avoids races with the
    // synchronous mute call that runs while we're awaiting getUserMedia.
    if (this._micTracksMuted) {
      nextStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    }

    // Build the new graph first: attach the new source to the analyser and
    // worklet while the old source is still connected to both.  During the
    // overlap (a handful of audio ticks) both sources feed into the mic
    // analyser — harmless; they carry the same room audio with a sub-ms
    // skew so the reactive-bar spectrum stays coherent.  This is the key
    // trick that eliminates the "wake word fires, UI pops up, bar freezes,
    // chime plays, bar unfreezes" stagger.
    const nextSource = this._audioContext.createMediaStreamSource(nextStream);
    if (this._card.isReactiveBarEnabled) {
      this._card.analyser.attachMic(nextSource, this._audioContext);
    }
    nextSource.connect(this._workletNode);

    // ...then drop the old source.  IMPORTANT: call sourceNode.disconnect()
    // directly instead of analyser.detachMic().  detachMic() clears the
    // analyser's `_activeAnalyser` to null as a side-effect, which stops the
    // reactive bar even though `nextSource` is still feeding the same
    // underlying AnalyserNode.  A plain disconnect() unhooks the old source
    // from every destination (including the analyser) without touching the
    // analyser's active-source bookkeeping.
    if (oldSource) {
      try { oldSource.disconnect(); } catch (_) {}
    }
    if (oldStream) {
      oldStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    }

    this._mediaStream = nextStream;
    this._sourceNode = nextSource;
    this._currentMicMode = mode;
    await this._logMicDevices(`switch:${mode}`);
  }

  stopMicrophone() {
    const hadWorklet = !!this._workletNode;
    const hadStream = !!this._mediaStream;
    this.stopSending();
    // Kiosk Satellite source: hand the mic back to the app so it can re-arm
    // native wake-word detection. There is no worklet/stream to tear down.
    if (this._mediaStream === KIOSK_MEDIA_STREAM) {
      kiosk.unbindAudioStream();
      kiosk.stopAudioStream();
      if (this._sourceNode) {
        this._card.analyser.detachMic(this._sourceNode);
        try { this._sourceNode.disconnect(); } catch (_) { /* ignore */ }
        this._sourceNode = null;
      }
      if (this._pushSilentGain) {
        try { this._pushSilentGain.disconnect(); } catch (_) { /* ignore */ }
        this._pushSilentGain = null;
      }
      this._mediaStream = null;
      this._captureBuffering = false;
      this._audioBuffer = [];
      this._log.log('mic', 'stopMicrophone: released Kiosk Satellite audio stream');
      return;
    }
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._silentGainNode) {
      try { this._silentGainNode.disconnect(); } catch (_) {}
      this._silentGainNode = null;
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
    // Deliberately leave this._audioContext open.  `createMediaElementSource`
    // permanently binds the TTS <audio> element to whatever AudioContext
    // first wraps it (per Web Audio spec — one MediaElementSource per
    // element, forever).  If we close the context here, the next
    // startMicrophone() creates a fresh one, subsequent attachAudio()
    // throws "HTMLMediaElement already connected previously to a
    // different MediaElementSourceNode", AND the old binding sinks TTS
    // audio into the dead graph so playback is silent.  The context is
    // cheap to keep alive; real teardown happens in destroy().
    this._captureBuffering = false;
    this._audioBuffer = [];
    if (hadWorklet || hadStream) {
      this._log.log('mic', `stopMicrophone: worklet=${hadWorklet} stream=${hadStream} (ctx kept)`);
    }
  }

  /**
   * Final teardown — call only on card destroy, not on a normal
   * start/stop cycle.  Closes the AudioContext, which invalidates every
   * MediaElementSource bound to it (TTS, notification audio).  The card
   * controller is responsible for dropping references to those <audio>
   * elements afterward so a restart rebuilds them fresh.
   */
  destroyContext() {
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
      this._log.log('mic', 'AudioContext closed (destroyContext)');
    }
  }

  /**
   * @param {() => number|null} binaryHandlerIdGetter
   */
  startSending(binaryHandlerIdGetter) {
    this.stopSending();
    this._captureBuffering = false;
    this._sendSessionCount += 1;
    const sendSession = this._sendSessionCount;
    let firstSendLogged = false;
    this._sendInterval = setInterval(() => {
      const handlerId = binaryHandlerIdGetter();
      if (!firstSendLogged && this._audioBuffer.length > 0) {
        firstSendLogged = true;
        const phase = sendSession === 1 ? 'First audio send' : 'Audio send resumed';
        this._log.log('mic', `${phase} - handlerId=${handlerId} bufferChunks=${this._audioBuffer.length}`);
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

  startBuffering({ reset = false } = {}) {
    if (reset) this._audioBuffer = [];
    this._captureBuffering = true;
  }

  stopBuffering({ clear = false } = {}) {
    this._captureBuffering = false;
    if (clear) this._audioBuffer = [];
  }

  async _logMicDevices(reason) {
    const track = this._mediaStream?.getAudioTracks?.()[0] || null;
    this._log.log('mic', `${describeSelectedAudioTrack(track)} reason=${reason}`);
    this._log.log('mic', await describeAudioInputDevices(track));
  }

  async _getUserMediaWithDeviceFallback(audioConstraints, mode) {
    this._applyConfiguredDevice(audioConstraints);
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      if (!audioConstraints.deviceId) throw err;
      const requested = this._card.config?.microphone_device_id;
      this._log.log('mic', `Selected microphone unavailable (${requested}) for ${mode}: ${err?.message || err}; falling back to browser default`);
      const fallbackConstraints = Object.assign({}, audioConstraints);
      delete fallbackConstraints.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio: fallbackConstraints });
    }
  }

  _applyConfiguredDevice(audioConstraints) {
    const deviceId = this._card.config?.microphone_device_id;
    if (deviceId && deviceId !== 'default') {
      audioConstraints.deviceId = { exact: deviceId };
    }
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
      await this._audioContext.resume();
    }
  }

  async ensureAudioContextForGesture() {
    try {
      if (!this._audioContext) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: TARGET_SAMPLE_RATE,
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
    // A closed context can't be reused — treat it like null so we build
    // a fresh one on the next start.  (stopMicrophone no longer closes,
    // but a prior destroyContext() or browser-initiated close can leave
    // the reference behind.)
    if (this._audioContext && this._audioContext.state === 'closed') {
      this._audioContext = null;
    }
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: TARGET_SAMPLE_RATE,
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
