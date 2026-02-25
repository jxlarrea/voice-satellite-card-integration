/**
 * Voice Satellite Card — AnalyserManager
 *
 * Provides real-time audio level analysis for reactive bar animations.
 * Uses two separate AnalyserNodes — one for microphone input, one for
 * audio output (TTS / notifications) — so the mic can never be routed
 * to the speakers through the analyser graph.
 *
 * The mic analyser is never connected to AudioContext.destination;
 * the audio analyser routes through to destination for playback.
 * _activeAnalyser points to whichever node _tick() should read from.
 *
 * Skins opt in via `reactiveBar: true` in their definition.
 */

export class AnalyserManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    // Mic path: sourceNode → _micAnalyser (no destination)
    this._micAnalyser = null;
    this._micSourceNode = null;

    // Audio path: mediaElementSource → _audioAnalyser → destination
    this._audioAnalyser = null;
    this._mediaSourceNode = null;

    // Which analyser _tick() reads from
    this._activeAnalyser = null;
    this._dataArray = null;

    this._rafId = null;
    this._barEl = null;
    this._visibilityHandler = null;
    this._lastLevel = -1;
    this._lastTick = 0;
  }

  /**
   * Connect analyser as a parallel tap on the mic source node.
   * The mic analyser is never connected to destination — it only
   * provides FFT data for the reactive bar.
   */
  attachMic(sourceNode, audioContext) {
    this._micSourceNode = sourceNode;
    if (!this._micAnalyser) {
      this._micAnalyser = this._createAnalyser(audioContext);
    }
    try {
      sourceNode.connect(this._micAnalyser);
      this._log.log('analyser', 'Mic → micAnalyser connected');
    } catch (e) {
      this._log.log('analyser', `Failed to attach mic: ${e.message}`);
    }
    // Default to mic analyser when no audio is playing
    if (!this._activeAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (initial)');
    }
  }

  /**
   * Disconnect mic tap.
   */
  detachMic(sourceNode) {
    this._micSourceNode = null;
    if (!this._micAnalyser) return;
    try {
      sourceNode.disconnect(this._micAnalyser);
      this._log.log('analyser', 'Mic → micAnalyser disconnected');
    } catch {
      // Already disconnected
    }
    if (this._activeAnalyser === this._micAnalyser) {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active → none (mic detached)');
    }
  }

  /**
   * Route an HTML Audio element through the audio analyser for output
   * analysis. createMediaElementSource reroutes audio through the Web
   * Audio graph, so we connect through to destination for audibility.
   *
   * Uses a separate analyser from the mic — the mic analyser has no
   * path to destination, so feedback is structurally impossible.
   */
  attachAudio(audioEl, audioContext) {
    if (!audioEl || !audioContext) return;
    this._detachAudio();

    try {
      if (!this._audioAnalyser) {
        this._audioAnalyser = this._createAnalyser(audioContext);
      }
      this._mediaSourceNode = audioContext.createMediaElementSource(audioEl);
      this._mediaSourceNode.connect(this._audioAnalyser);
      this._audioAnalyser.connect(audioContext.destination);

      // Switch reactive bar to read from audio analyser during playback
      this._activeAnalyser = this._audioAnalyser;
      this._dataArray = new Uint8Array(this._audioAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Audio → audioAnalyser → destination connected, active → audioAnalyser');
    } catch (e) {
      this._log.log('analyser', `Failed to attach audio: ${e.message}`);
      this._mediaSourceNode = null;
    }
  }

  /**
   * Disconnect audio element routing.
   */
  detachAudio() {
    this._detachAudio();
  }

  /**
   * Switch the reactive bar back to reading from the mic analyser.
   * The mic source stays connected to its analyser at all times —
   * this just changes which analyser _tick() reads FFT data from.
   *
   * No-op while audio is routed through the audio analyser — callers
   * like updateForState fire for all bar-visible states (including TTS),
   * and switching away from the audio analyser mid-playback would make
   * the bar show mic levels instead of TTS levels.
   */
  reconnectMic() {
    if (this._mediaSourceNode) {
      this._log.log('analyser', 'reconnectMic skipped — audio still attached');
      return;
    }
    if (this._micAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (reconnectMic)');
    }
  }

  /**
   * Start the animation frame loop that updates --vs-audio-level.
   */
  start(barEl) {
    this._barEl = barEl;
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.hidden) {
          if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
          }
        } else if (this._barEl && !this._rafId) {
          this._tick();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
    if (this._rafId) return; // Already running
    this._tick();
  }

  /**
   * Stop the animation frame loop and reset the CSS variable.
   */
  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._barEl) {
      this._barEl.style.setProperty('--vs-audio-level', '0');
      this._barEl = null;
      this._log.log('analyser', 'Tick loop stopped');
    }
  }

  // --- Private ---

  _createAnalyser(audioContext) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    return analyser;
  }

  _detachAudio() {
    if (this._mediaSourceNode) {
      try { this._mediaSourceNode.disconnect(); } catch {}
      this._mediaSourceNode = null;
      this._log.log('analyser', 'Audio → audioAnalyser disconnected');
    }
    if (this._audioAnalyser) {
      try { this._audioAnalyser.disconnect(); } catch {}
      this._log.log('analyser', 'audioAnalyser → destination disconnected');
    }
    // Revert to mic analyser if available
    if (this._micAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (audio detached)');
    } else {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active → none (audio detached, no mic)');
    }
  }

  _tick() {
    if (!this._barEl || !this._activeAnalyser) {
      this._rafId = null;
      return;
    }

    // Cap at ~30 fps — CSS transitions (50ms) smooth the gaps
    const now = performance.now();
    if (now - this._lastTick < 32) {
      this._rafId = requestAnimationFrame(() => this._tick());
      return;
    }
    this._lastTick = now;

    this._activeAnalyser.getByteFrequencyData(this._dataArray);

    // Compute RMS volume normalized to 0–1, quantized to 20 steps
    // to skip redundant CSS updates when the level barely changes.
    let sum = 0;
    for (let i = 0; i < this._dataArray.length; i++) {
      const v = this._dataArray[i] / 255;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._dataArray.length);
    const level = Math.min(1, Math.round(Math.min(1, rms * 2) * 20) / 20);

    if (level !== this._lastLevel) {
      this._lastLevel = level;
      this._barEl.style.setProperty('--vs-audio-level', level.toFixed(2));
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }
}
