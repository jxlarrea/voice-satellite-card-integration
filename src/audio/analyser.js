/**
 * AnalyserManager
 *
 * Provides real-time audio level analysis for reactive bar animations.
 * Uses two separate AnalyserNodes - one for microphone input, one for
 * audio output (TTS / notifications) - so the mic can never be routed
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

    // Mic path: sourceNode -> _micAnalyser (no destination)
    this._micAnalyser = null;
    this._micSourceNode = null;

    // Audio path: mediaElementSource -> _audioAnalyser -> destination
    this._audioAnalyser = null;
    this._mediaSourceNode = null;
    this._mediaSourceEl = null;
    this._mediaSourceCache = new WeakMap();

    // Which analyser _tick() reads from
    this._activeAnalyser = null;
    this._dataArray = null;
    this._analyserBuffers = new WeakMap();

    this._rafId = null;
    this._barEl = null;
    this._visibilityHandler = null;
    this._lastLevel = -1;
    this._lastTick = 0;

    // Bound tick for RAF to avoid creating a new closure per frame
    this._boundTick = () => this._tick();
  }

  /**
   * Connect analyser as a parallel tap on the mic source node.
   * The mic analyser is never connected to destination - it only
   * provides FFT data for the reactive bar.
   */
  attachMic(sourceNode, audioContext) {
    this._micSourceNode = sourceNode;
    if (this._micAnalyser && this._micAnalyser.context !== audioContext) {
      this._micAnalyser = null;
    }
    if (!this._micAnalyser) {
      this._micAnalyser = this._createAnalyser(audioContext);
    }
    try {
      sourceNode.connect(this._micAnalyser);
      this._log.log('analyser', 'Mic -> micAnalyser connected');
    } catch (e) {
      this._log.log('analyser', `Failed to attach mic: ${e.message}`);
    }
    // Default to mic analyser when no audio is playing
    if (!this._activeAnalyser) {
      this._setActiveAnalyser(this._micAnalyser);
      this._log.log('analyser', 'Active -> micAnalyser (initial)');
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
      this._log.log('analyser', 'Mic -> micAnalyser disconnected');
    } catch {
      // Already disconnected
    }
    if (this._activeAnalyser === this._micAnalyser) {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active -> none (mic detached)');
    }
  }

  /**
   * Route an HTML Audio element through the audio analyser for output
   * analysis. createMediaElementSource reroutes audio through the Web
   * Audio graph, so we connect through to destination for audibility.
   *
   * Uses a separate analyser from the mic - the mic analyser has no
   * path to destination, so feedback is structurally impossible.
   */
  attachAudio(audioEl, audioContext) {
    if (!audioEl || !audioContext) return;
    this._detachAudio();

    try {
      if (this._audioAnalyser && this._audioAnalyser.context !== audioContext) {
        this._audioAnalyser = null;
        this._mediaSourceNode = null;
        this._mediaSourceEl = null;
        this._mediaSourceCache = new WeakMap();
      }
      if (!this._audioAnalyser) {
        this._audioAnalyser = this._createAnalyser(audioContext);
      }
      // createMediaElementSource can only be called once per element for
      // the life of the document. Cache per-element source nodes so TTS,
      // notifications, and later reattachments all reuse the original node.
      if (this._mediaSourceEl !== audioEl) {
        const cached = this._mediaSourceCache.get(audioEl);
        if (cached) {
          if (cached.context !== audioContext) {
            this._log.log('analyser', 'Skipping audio analyser attach - media element is bound to an old AudioContext');
            return;
          }
          this._mediaSourceNode = cached.node;
        } else {
          this._mediaSourceNode = audioContext.createMediaElementSource(audioEl);
          this._mediaSourceCache.set(audioEl, {
            node: this._mediaSourceNode,
            context: audioContext,
          });
        }
        this._mediaSourceEl = audioEl;
      }
      this._mediaSourceNode.connect(this._audioAnalyser);
      this._audioAnalyser.connect(audioContext.destination);

      // Switch reactive bar to read from audio analyser during playback
      this._setActiveAnalyser(this._audioAnalyser);
      this._log.log('analyser', 'Audio -> audioAnalyser -> destination connected, active -> audioAnalyser');

      // Auto-start tick loop if a bar element is waiting (deferred start
      // from onNotificationStart — bar was prepared but loop deferred
      // until audio was attached).
      if (this._barEl && !this._rafId) {
        this._log.log('analyser', 'Auto-starting tick loop (deferred bar ready)');
        this._tick();
      }
    } catch (e) {
      this._log.log('analyser', `Failed to attach audio: ${e.message}`);
      if (this._mediaSourceEl === audioEl) {
        this._mediaSourceNode = null;
        this._mediaSourceEl = null;
      }
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
   * The mic source stays connected to its analyser at all times  - 
   * this just changes which analyser _tick() reads FFT data from.
   *
   * No-op while audio is routed through the audio analyser - callers
   * like updateForState fire for all bar-visible states (including TTS),
   * and switching away from the audio analyser mid-playback would make
   * the bar show mic levels instead of TTS levels.
   */
  reconnectMic() {
    if (this._activeAnalyser === this._audioAnalyser) {
      this._log.log('analyser', 'reconnectMic skipped - audio still attached');
      return;
    }
    if (this._micAnalyser) {
      this._setActiveAnalyser(this._micAnalyser);
      this._log.log('analyser', 'Active -> micAnalyser (reconnectMic)');
    }
  }

  /**
   * Start the animation frame loop that updates --vs-audio-level.
   * @param {HTMLElement} barEl - The bar element to update
   * @param {object} [opts]
   * @param {boolean} [opts.deferred] - Store bar element but don't start
   *   the tick loop yet.  Used by notification playback: the bar enters
   *   reactive/speaking mode immediately, but the tick loop should only
   *   run once attachAudio() switches to the audio analyser — otherwise
   *   the bar would react to mic input during the pre-announce chime.
   */
  start(barEl, { deferred } = {}) {
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
    if (!deferred) this._tick();
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
      // Don't null _mediaSourceNode - it's reusable for the same element
      this._log.log('analyser', 'Audio -> audioAnalyser disconnected');
    }
    if (this._audioAnalyser) {
      try { this._audioAnalyser.disconnect(); } catch {}
      this._log.log('analyser', 'audioAnalyser -> destination disconnected');
    }
    // Clear active analyser — the tick loop will stop on the next frame.
    // Don't revert to mic: callers like playMediaFor detach audio when
    // notification media ends, and the bar would react to mic input
    // during the cleanup/linger period.  reconnectMic() restores mic
    // explicitly when the pipeline needs it (e.g. updateForState).
    this._setActiveAnalyser(null);
    if (this._barEl) {
      this._lastLevel = 0;
      this._barEl.style.setProperty('--vs-audio-level', '0');
    }
    this._log.log('analyser', 'Active -> none (audio detached)');
  }

  _tick() {
    if (!this._barEl || !this._activeAnalyser) {
      this._rafId = null;
      return;
    }

    // Cap at ~20 fps - CSS transitions smooth the gaps and this saves CPU
    // significantly on low-end Android wall tablets.
    const now = performance.now();
    const targetIntervalMs = this._getUpdateIntervalMs();
    if (now - this._lastTick < targetIntervalMs) {
      this._rafId = requestAnimationFrame(this._boundTick);
      return;
    }

    this._lastTick = now;

    // Use time-domain waveform amplitude for a simple level meter. This is
    // cheaper than FFT/frequency analysis and visually sufficient here.
    this._activeAnalyser.getByteTimeDomainData(this._dataArray);

    // Compute mean absolute amplitude normalized to 0-1, then quantize to
    // skip redundant CSS updates when the level barely changes.
    let sum = 0;
    for (let i = 0; i < this._dataArray.length; i++) {
      sum += Math.abs(this._dataArray[i] - 128);
    }
    const meanAbs = (sum / this._dataArray.length) / 128;
    const isMic = this._activeAnalyser === this._micAnalyser;
    const level = Math.min(1, Math.round(this._mapVisualLevel(meanAbs, isMic) * 20) / 20);

    if (level !== this._lastLevel) {
      this._lastLevel = level;
      this._barEl.style.setProperty('--vs-audio-level', level.toFixed(2));
    }

    this._rafId = requestAnimationFrame(this._boundTick);
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

  _mapVisualLevel(meanAbs, isMic) {
    // This is visual-only remapping for reactive skins. It does not affect
    // wake word, VAD, or any uploaded audio — only the shared CSS level.
    //
    // Mic input tends to sit much lower than local/remote playback, so give
    // it a slightly stronger lift plus a small visible floor once real input
    // is present. The nonlinear curve keeps quiet speech readable without
    // flattening louder speech into a constant maxed-out bar.
    const gain = isMic ? 7.5 : 5;
    const scaled = Math.min(1, meanAbs * gain);
    const curved = Math.pow(scaled, isMic ? 0.6 : 0.8);

    if (isMic) {
      if (curved <= 0.015) return 0;
      const floored = 0.12 + curved * 0.88;
      return Math.min(1, floored);
    }

    return curved;
  }
}
