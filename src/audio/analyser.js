/**
 * Voice Satellite Card — AnalyserManager
 *
 * Provides real-time audio level analysis for reactive bar animations.
 * Taps into microphone input and TTS/notification audio output,
 * computing volume levels on each animation frame and exposing them
 * as a CSS custom property (--vs-audio-level) on the bar element.
 *
 * Skins opt in via `reactiveBar: true` in their definition.
 */

export class AnalyserManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._analyser = null;
    this._dataArray = null;
    this._rafId = null;
    this._barEl = null;
    this._mediaSourceNode = null;
    this._micSourceNode = null;
    this._connectedToDestination = false;
  }

  /**
   * Connect analyser as a parallel tap on the mic source node.
   * Does not interrupt the existing source → worklet/processor chain.
   */
  attachMic(sourceNode, audioContext) {
    this._ensureAnalyser(audioContext);
    this._micSourceNode = sourceNode;
    try {
      sourceNode.connect(this._analyser);
    } catch (e) {
      this._log.log('analyser', `Failed to attach mic: ${e.message}`);
    }
  }

  /**
   * Disconnect mic tap.
   */
  detachMic(sourceNode) {
    this._micSourceNode = null;
    if (!this._analyser) return;
    try {
      sourceNode.disconnect(this._analyser);
    } catch {
      // Already disconnected
    }
  }

  /**
   * Route an HTML Audio element through the analyser for output analysis.
   * createMediaElementSource reroutes audio through the Web Audio graph,
   * so we must connect through to destination to keep audio audible.
   */
  attachAudio(audioEl, audioContext) {
    if (!audioEl || !audioContext) return;
    this._ensureAnalyser(audioContext);
    this._detachAudio();

    // Disconnect mic from the analyser while audio is routed through it —
    // attachAudio connects analyser → destination for playback, and if the
    // mic is still connected to the analyser, mic audio would flow through
    // analyser → destination → speakers, causing a feedback loop.
    if (this._micSourceNode) {
      try { this._micSourceNode.disconnect(this._analyser); } catch {}
    }

    try {
      this._mediaSourceNode = audioContext.createMediaElementSource(audioEl);
      this._mediaSourceNode.connect(this._analyser);
      if (!this._connectedToDestination) {
        this._analyser.connect(audioContext.destination);
        this._connectedToDestination = true;
      }
    } catch (e) {
      // CORS or already-connected errors — fall back to CSS animations.
      // Reconnect mic since audio attachment failed.
      if (this._micSourceNode) {
        try { this._micSourceNode.connect(this._analyser); } catch {}
      }
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
   * Start the animation frame loop that updates --vs-audio-level.
   */
  start(barEl) {
    this._barEl = barEl;
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
    if (this._barEl) {
      this._barEl.style.setProperty('--vs-audio-level', '0');
      this._barEl = null;
    }
  }

  // --- Private ---

  _ensureAnalyser(audioContext) {
    if (this._analyser) return;
    this._analyser = audioContext.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.6;
    this._dataArray = new Uint8Array(this._analyser.frequencyBinCount);
  }

  /**
   * Reconnect the mic source to the analyser (if previously attached).
   * Call after detachAudio when mic-level reactivity should resume.
   */
  reconnectMic() {
    if (this._micSourceNode && this._analyser) {
      try { this._micSourceNode.connect(this._analyser); } catch {}
    }
  }

  _detachAudio() {
    if (this._mediaSourceNode) {
      try { this._mediaSourceNode.disconnect(); } catch {}
      this._mediaSourceNode = null;
    }
    if (this._connectedToDestination && this._analyser) {
      try { this._analyser.disconnect(); } catch {}
      this._connectedToDestination = false;
    }
  }

  _tick() {
    if (!this._barEl || !this._analyser) {
      this._rafId = null;
      return;
    }

    this._analyser.getByteFrequencyData(this._dataArray);

    // Compute RMS volume normalized to 0–1
    let sum = 0;
    for (let i = 0; i < this._dataArray.length; i++) {
      const v = this._dataArray[i] / 255;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._dataArray.length);

    // Clamp and apply slight boost for visual responsiveness
    const level = Math.min(1, rms * 2);
    this._barEl.style.setProperty('--vs-audio-level', level.toFixed(3));

    this._rafId = requestAnimationFrame(() => this._tick());
  }
}
