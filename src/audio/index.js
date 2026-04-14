/**
 * AudioManager
 *
 * Handles microphone acquisition, AudioContext management,
 * and audio stream send control.
 */

import { setupAudioWorklet, sendAudioBuffer } from './processing.js';
import { resolveDspForMode } from './dsp-config.js';

const TARGET_SAMPLE_RATE = 16000;

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

    // Acquire the new stream BEFORE tearing the old one down so the old
    // sourceNode keeps feeding the analyser (reactive bar) and the worklet
    // throughout the getUserMedia round-trip.  Otherwise the UI shows a
    // 50-200 ms dead patch between wake-word detection and STT start that
    // looks like a UI stagger.  Cutover is a single synchronous disconnect +
    // connect, well under one audio render quantum.
    let nextStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
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
  }

  stopMicrophone() {
    const hadWorklet = !!this._workletNode;
    const hadStream = !!this._mediaStream;
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
    // Deliberately leave this._audioContext open.  `createMediaElementSource`
    // permanently binds the TTS <audio> element to whatever AudioContext
    // first wraps it (per Web Audio spec — one MediaElementSource per
    // element, forever).  If we close the context here, the next
    // startMicrophone() creates a fresh one, subsequent attachAudio()
    // throws "HTMLMediaElement already connected previously to a
    // different MediaElementSourceNode", AND the old binding sinks TTS
    // audio into the dead graph so playback is silent.  The context is
    // cheap to keep alive; real teardown happens in destroy().
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
