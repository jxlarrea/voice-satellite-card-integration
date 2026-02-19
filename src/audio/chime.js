/**
 * Voice Satellite Card — Chime Utility
 *
 * Shared Web Audio API chime synthesis. Supports reusing the card's
 * existing AudioContext (unlocked by user gesture) with automatic
 * fallback to a new context.
 */

/** Predefined chime note patterns */
export const CHIME_WAKE = {
  type: 'single',
  wave: 'sine',
  notes: [
    { freq: 523, start: 0 },
    { freq: 659, start: 0.08 },
    { freq: 784, start: 0.16 },
  ],
  duration: 0.25,
};

export const CHIME_ERROR = {
  type: 'single',
  wave: 'square',
  volumeScale: 0.3,
  notes: [
    { freq: 300, start: 0 },
    { freq: 200, start: 0.08 },
  ],
  duration: 0.15,
};

export const CHIME_DONE = {
  type: 'single',
  wave: 'sine',
  notes: [
    { freq: 784, start: 0 },
    { freq: 659, start: 0.08 },
  ],
  duration: 0.25,
};

export const CHIME_ANNOUNCE = {
  type: 'multi',
  wave: 'sine',
  notes: [
    { freq: 784, start: 0, end: 0.15 },
    { freq: 587, start: 0.18, end: 0.4 },
  ],
  totalMs: 500,
};

export const CHIME_ALERT = {
  type: 'multi',
  wave: 'sine',
  notes: [
    { freq: 880, start: 0, end: 0.15 },
    { freq: 660, start: 0.18, end: 0.33 },
    { freq: 880, start: 0.36, end: 0.55 },
  ],
};

/**
 * Get or create an AudioContext, preferring the card's existing one.
 * @param {object} card - Card instance (uses card.audio.audioContext)
 * @returns {{ ctx: AudioContext, owned: boolean }}
 */
export function getOrCreateContext(card) {
  const existing = card.audio?.audioContext;

  if (existing && existing.state !== 'closed') {
    if (existing.state === 'suspended') existing.resume();
    return { ctx: existing, owned: false };
  }

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  return { ctx, owned: true };
}

/**
 * Play a "single oscillator" chime (wake, error, done).
 * Uses one oscillator with frequency steps.
 *
 * @param {object} card - Card instance
 * @param {object} pattern - Chime pattern object
 * @param {object} [log] - Logger instance
 */
export function playChime(card, pattern, log) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const volume = (card.config.chime_volume / 100) * 0.5;
    const vol = volume * (pattern.volumeScale || 1);

    osc.type = pattern.wave;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + pattern.duration);

    for (const note of pattern.notes) {
      osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.start);
    }

    osc.start();
    osc.stop(ctx.currentTime + pattern.duration);

    setTimeout(() => ctx.close(), 500);
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
  }
}

/**
 * Play a "multi-note" chime with separate oscillators per note (announce, alert).
 * Each note has its own envelope with attack/release.
 *
 * @param {object} card - Card instance
 * @param {object} pattern - Chime pattern with individual note envelopes
 * @param {object} [options]
 * @param {Function} [options.onDone] - Callback after chime completes
 * @param {object} [options.log] - Logger instance
 * @returns {void}
 */
export function playMultiNoteChime(card, pattern, options = {}) {
  const { onDone, log } = options;

  try {
    const { ctx, owned } = getOrCreateContext(card);
    const volume = (card.config.chime_volume / 100) * 0.5;

    for (const note of pattern.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = pattern.wave;
      osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.start);
      gain.gain.setValueAtTime(0, ctx.currentTime + note.start);
      gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + note.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.end);
      osc.start(ctx.currentTime + note.start);
      osc.stop(ctx.currentTime + note.end);
    }

    if (pattern.totalMs || onDone) {
      setTimeout(() => {
        if (owned) ctx.close();
        onDone?.();
      }, pattern.totalMs || 600);
    } else if (owned) {
      setTimeout(() => ctx.close(), 1000);
    }
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
    onDone?.();
  }
}
