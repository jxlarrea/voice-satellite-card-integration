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

export const CHIME_ANNOUNCE_URI = 'data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAAWGluZwAAAA8AAABHAAAJ2wAsNDo6PEJCREdPT1FXV1lfZGRmaWlucXR0dnl5fH6BgYSGhomLi46Rk5OWmZmbnqGho6amqKuurrCzs7a4u7u+wMDDxcXIy83N0NPT1djb293g4OLl6Ojq7e3w8vX1+Pr6/f8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJAJ2AAAAAAAACduXdSMzAAAAAAAAAAAAAAAAAP/zkMQABKACtA1AAAAhIf//////WD7//////+UDBQEFAG8QAAwAA////////4tHrTBwb1nAKAQwAWv4GNQjv/gALnV////////lgLfymat/9gaiyIf/0wgGjEYcAf////////rqE9AlozJOsr////////////Uk5Mol0UiKDADgf/0EwbiN//////////////uLQ4epCADgf/2iAIJ7/////////////1DUUXUCgAcD/+GAlf//////1B6B//dgWCav////////////rTTMQFhiYyognA/2UxiYERBp4DRkFFE2mt////////////1oooFIRghgYkdAKn4ExhoMptbiMZpfCf/zMMTlDsL+0B+AoCQ0KggA4H/9SQDSP//////////////ckC7kabUCgAcD/+JQhb/////////////4gmVMQU0Cgf/zoG0Xgf/UuAxx8P/zIMTrCIKuvAfAkAEd6nQQ///////////+1MwYzXWYJUcJoa0aW/eeGJ2nyIkWlSC8D/r/8xDE8AXyusQWBBeQ1KWbBkEDXKjZ2//////zIMTlBaK2wBYAW4D///////9S0HU0UQCBvOWduMNageQ2nIkcAf/1koCfV///////////8xDE9QN5XtAeAFeA///0E94FTyoMAOB//P/zEMT0BhK2wAYDTZGWE2f///////////////MwxOgM8s6cDgT3kdxwlj0IAOB//dAA5Pf////////////+gHBl1QwA4H/9JATz//////////////MmA4H/8UMKDD/+dBtMQU1FqqoC//MQxPUGOrbUFgNxkIH/8rEFTEFNRVVVVQj/8yDE6QUisuAeAFWAP/5wGKpMQU1FqqqqA4H/8EHVTEFNRVVVVQOB//cJVUxBTUVV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';

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

    const volume = card.mediaPlayer.volume * 0.5;
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
    const volume = card.mediaPlayer.volume * 0.25;

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
