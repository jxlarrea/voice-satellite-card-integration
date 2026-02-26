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
    this._analyserBuffers = new WeakMap();

    this._rafId = null;
    this._barEl = null;
    this._visibilityHandler = null;
    this._lastLevel = -1;
    this._lastTick = 0;
    this._perfWindowStart = 0;
    this._perfTicks = 0;
    this._perfComputeMsSum = 0;
    this._perfComputeMsMax = 0;
    this._perfGapMsSum = 0;
    this._perfGapMsMax = 0;
    this._perfLateGaps = 0;
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
      this._setActiveAnalyser(this._micAnalyser);
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
      this._setActiveAnalyser(this._audioAnalyser);
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
      this._setActiveAnalyser(this._micAnalyser);
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
    this._perfWindowStart = 0;
    this._perfTicks = 0;
    this._perfComputeMsSum = 0;
    this._perfComputeMsMax = 0;
    this._perfGapMsSum = 0;
    this._perfGapMsMax = 0;
    this._perfLateGaps = 0;
  }

  // --- Private ---

  _createAnalyser(audioContext) {
    const analyser = audioContext.createAnalyser();
    // Reactive bar only needs coarse loudness, not detailed frequency bins.
    // Smaller windows reduce analysis work on low-spec tablets.
    analyser.fftSize = 128;
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
      this._setActiveAnalyser(this._micAnalyser);
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

    // Cap at ~20 fps — CSS transitions smooth the gaps and this saves CPU
    // significantly on low-end Android wall tablets.
    const now = performance.now();
    const targetIntervalMs = this._getUpdateIntervalMs();
    if (now - this._lastTick < targetIntervalMs) {
      this._rafId = requestAnimationFrame(() => this._tick());
      return;
    }
    const tickGapMs = this._lastTick ? (now - this._lastTick) : 0;
    this._lastTick = now;
    if (!this._perfWindowStart) this._perfWindowStart = now;
    const computeStart = performance.now();

    // Use time-domain waveform amplitude for a simple level meter. This is
    // cheaper than FFT/frequency analysis and visually sufficient here.
    this._activeAnalyser.getByteTimeDomainData(this._dataArray);

    // Compute mean absolute amplitude normalized to 0–1, then quantize to
    // skip redundant CSS updates when the level barely changes.
    let sum = 0;
    for (let i = 0; i < this._dataArray.length; i++) {
      sum += Math.abs(this._dataArray[i] - 128);
    }
    const meanAbs = (sum / this._dataArray.length) / 128;
    const level = Math.min(1, Math.round(Math.min(1, meanAbs * 3.5) * 20) / 20);

    if (level !== this._lastLevel) {
      this._lastLevel = level;
      this._barEl.style.setProperty('--vs-audio-level', level.toFixed(2));
    }

    const computeMs = performance.now() - computeStart;
    this._perfTicks += 1;
    this._perfComputeMsSum += computeMs;
    if (computeMs > this._perfComputeMsMax) this._perfComputeMsMax = computeMs;
    if (tickGapMs > 0) {
      this._perfGapMsSum += tickGapMs;
      if (tickGapMs > this._perfGapMsMax) this._perfGapMsMax = tickGapMs;
      // >75ms means we significantly missed the ~50ms target interval.
      if (tickGapMs > (targetIntervalMs * 1.5)) this._perfLateGaps += 1;
    }
    if (now - this._perfWindowStart >= 1000) {
      const avgMs = this._perfTicks ? (this._perfComputeMsSum / this._perfTicks) : 0;
      const gapSamples = Math.max(0, this._perfTicks - 1);
      const avgGapMs = gapSamples ? (this._perfGapMsSum / gapSamples) : 0;
      const effFps = avgGapMs > 0 ? (1000 / avgGapMs) : 0;
      this._log.log(
        'analyser',
        `perf 1s: int=${targetIntervalMs}ms effFps=${effFps.toFixed(1)} ticks=${this._perfTicks} avg=${avgMs.toFixed(2)}ms max=${this._perfComputeMsMax.toFixed(2)}ms gapAvg=${avgGapMs.toFixed(1)}ms gapMax=${this._perfGapMsMax.toFixed(1)}ms late=${this._perfLateGaps} analyser=${this._activeAnalyser === this._audioAnalyser ? 'audio' : 'mic'}`,
      );
      this._perfWindowStart = now;
      this._perfTicks = 0;
      this._perfComputeMsSum = 0;
      this._perfComputeMsMax = 0;
      this._perfGapMsSum = 0;
      this._perfGapMsMax = 0;
      this._perfLateGaps = 0;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _setActiveAnalyser(analyser) {
    this._activeAnalyser = analyser;
    if (!analyser) {
      this._dataArray = null;
      return;
    }
    let buf = this._analyserBuffers.get(analyser);
    if (!buf || buf.length !== analyser.fftSize) {
      buf = new Uint8Array(analyser.fftSize);
      this._analyserBuffers.set(analyser, buf);
    }
    this._dataArray = buf;
  }

  _getUpdateIntervalMs() {
    const raw = Number(this._card?.config?.reactive_bar_update_interval_ms);
    if (!Number.isFinite(raw)) return 33;
    // Cap at 60fps max (minimum interval ~16.67ms, rounded to 17ms).
    return Math.max(17, raw);
  }
}
