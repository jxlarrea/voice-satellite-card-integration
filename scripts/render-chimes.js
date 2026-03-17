#!/usr/bin/env node
/**
 * Render chime patterns from chime.js into WAV files.
 *
 * Usage:  node scripts/render-chimes.js
 * Output: scripts/chimes/*.wav
 *
 * These WAV files are faithful renditions of the Web Audio API oscillator
 * synthesis used in src/audio/chime.js, rendered at full volume (1.0).
 * Runtime volume is controlled by the card's volume setting.
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const OUT_DIR = path.join(__dirname, 'chimes');

// ── Chime definitions (mirrored from src/audio/chime.js) ────────────

const CHIME_WAKE = {
  type: 'single',
  wave: 'sine',
  notes: [
    { freq: 523, start: 0 },
    { freq: 659, start: 0.08 },
    { freq: 784, start: 0.16 },
  ],
  duration: 0.25,
};

const CHIME_ERROR = {
  type: 'single',
  wave: 'square',
  volumeScale: 0.3,
  notes: [
    { freq: 300, start: 0 },
    { freq: 200, start: 0.08 },
  ],
  duration: 0.15,
};

const CHIME_DONE = {
  type: 'single',
  wave: 'sine',
  notes: [
    { freq: 784, start: 0 },
    { freq: 659, start: 0.08 },
  ],
  duration: 0.25,
};

const CHIME_ALERT = {
  type: 'multi',
  wave: 'sine',
  notes: [
    { freq: 880, start: 0, end: 0.15 },
    { freq: 660, start: 0.18, end: 0.33 },
    { freq: 880, start: 0.36, end: 0.55 },
  ],
};

// ── Oscillator generators ───────────────────────────────────────────

function sineWave(phase) {
  return Math.sin(2 * Math.PI * phase);
}

function squareWave(phase) {
  return (phase % 1) < 0.5 ? 1 : -1;
}

function getWaveFn(type) {
  return type === 'square' ? squareWave : sineWave;
}

// ── Render "single" chime (wake, done, error) ───────────────────────
// One oscillator with frequency steps and an exponential gain ramp.

function renderSingle(pattern) {
  const volume = 1.0 * (pattern.volumeScale || 1);
  const totalSamples = Math.ceil(pattern.duration * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  const waveFn = getWaveFn(pattern.wave);

  // Build frequency timeline: at each sample, which freq?
  // Notes define set-at-time frequency changes (immediate).
  const sortedNotes = [...pattern.notes].sort((a, b) => a.start - b.start);

  function freqAt(t) {
    let f = sortedNotes[0].freq;
    for (const n of sortedNotes) {
      if (t >= n.start) f = n.freq;
    }
    return f;
  }

  // Exponential ramp from volume → 0.001 over duration
  // Web Audio exponentialRampToValueAtTime interpolates exponentially:
  //   v(t) = v0 * (v1/v0)^((t - t0) / (t1 - t0))
  const v0 = volume;
  const v1 = 0.001;
  const ratio = v1 / v0;

  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const frac = t / pattern.duration;
    const gain = v0 * Math.pow(ratio, frac);
    const freq = freqAt(t);
    phase += freq / SAMPLE_RATE;
    samples[i] = waveFn(phase) * gain;
  }

  return samples;
}

// ── Render "multi" chime (alert) ────────────────────────────────────
// Separate oscillators per note, each with attack/release envelope.

function renderMulti(pattern) {
  const volume = 1.0;
  const maxEnd = Math.max(...pattern.notes.map(n => n.end));
  const totalSamples = Math.ceil((maxEnd + 0.05) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  const waveFn = getWaveFn(pattern.wave);

  for (const note of pattern.notes) {
    const attackTime = 0.02; // linearRampToValueAtTime duration
    let phase = 0;
    const startSample = Math.floor(note.start * SAMPLE_RATE);
    const endSample = Math.ceil(note.end * SAMPLE_RATE);

    for (let i = startSample; i < endSample && i < totalSamples; i++) {
      const t = (i - startSample) / SAMPLE_RATE;
      const noteDuration = note.end - note.start;

      // Envelope: linear attack 0→volume in attackTime,
      // then exponential decay to 0.001 by note.end
      let gain;
      if (t < attackTime) {
        gain = (t / attackTime) * volume;
      } else {
        // Exponential from volume to 0.001 over remaining time
        const decayDuration = noteDuration - attackTime;
        const decayFrac = (t - attackTime) / decayDuration;
        gain = volume * Math.pow(0.001 / volume, Math.min(decayFrac, 1));
      }

      phase += note.freq / SAMPLE_RATE;
      samples[i] += waveFn(phase) * gain;
    }
  }

  // Clamp
  for (let i = 0; i < totalSamples; i++) {
    samples[i] = Math.max(-1, Math.min(1, samples[i]));
  }

  return samples;
}

// ── WAV writer ──────────────────────────────────────────────────────

function writeWav(filePath, samples) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const fileSize = 36 + dataSize;

  const buf = Buffer.alloc(44 + dataSize);
  let off = 0;

  // RIFF header
  buf.write('RIFF', off); off += 4;
  buf.writeUInt32LE(fileSize, off); off += 4;
  buf.write('WAVE', off); off += 4;

  // fmt chunk
  buf.write('fmt ', off); off += 4;
  buf.writeUInt32LE(16, off); off += 4;          // chunk size
  buf.writeUInt16LE(1, off); off += 2;           // PCM
  buf.writeUInt16LE(numChannels, off); off += 2;
  buf.writeUInt32LE(SAMPLE_RATE, off); off += 4;
  buf.writeUInt32LE(byteRate, off); off += 4;
  buf.writeUInt16LE(blockAlign, off); off += 2;
  buf.writeUInt16LE(bitsPerSample, off); off += 2;

  // data chunk
  buf.write('data', off); off += 4;
  buf.writeUInt32LE(dataSize, off); off += 4;

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buf.writeInt16LE(Math.round(val), off);
    off += 2;
  }

  fs.writeFileSync(filePath, buf);
}

// ── Main ────────────────────────────────────────────────────────────

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const chimes = [
  { name: 'wake', pattern: CHIME_WAKE },
  { name: 'done', pattern: CHIME_DONE },
  { name: 'error', pattern: CHIME_ERROR },
  { name: 'alert', pattern: CHIME_ALERT },
];

for (const { name, pattern } of chimes) {
  const samples = pattern.type === 'multi'
    ? renderMulti(pattern)
    : renderSingle(pattern);

  const outPath = path.join(OUT_DIR, `${name}.wav`);
  writeWav(outPath, samples);

  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  console.log(`  ${name}.wav  ${durationMs}ms  ${fs.statSync(outPath).size} bytes`);
}

console.log(`\nWAV files written to ${OUT_DIR}`);
