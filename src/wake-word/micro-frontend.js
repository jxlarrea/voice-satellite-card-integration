/**
 * microWakeWord Audio Feature Extraction (micro_frontend)
 *
 * Pure-JS implementation of the TensorFlow Lite Micro frontend used by
 * microWakeWord / ESPHome for audio preprocessing. Converts raw 16kHz
 * PCM audio into int8 feature vectors suitable for TFLite wake word models.
 *
 * Pipeline: Hann window → 512-point FFT → 40-channel mel filterbank
 *           → sqrt → noise reduction → PCAN gain control → log₂ scale → int8
 *
 * Browser adaptation: Browser mic + WebRTC AGC produces audio at ~10×
 * the amplitude of ESP32's I2S ADC. Rather than tweaking NR/PCAN parameters
 * (which always leads to clipped or flat features), we scale the audio
 * amplitude down to match ESP32 levels (AUDIO_SCALE ≈ 4000 vs 32767),
 * inject a noise floor matching ESP32's analog noise (~1000 sqrt_mel),
 * then run the standard C code pipeline with original parameters.
 *
 * Parameters match ESPHome's micro_wake_word component:
 *   - Window: 30ms (480 samples), hop: 10ms (160 samples)
 *   - FFT: 512 points (zero-padded from 480)
 *   - Mel filterbank: 40 channels, 125–7500 Hz
 *   - FilterbankSqrt: square root of mel energies (reduces dynamic range)
 *   - Noise reduction: asymmetric smoothing (slow up / fast down)
 *   - PCAN: gain control with PcanShrink (offset=80, strength=0.95)
 *   - Log scale: log₂(1 + energy) × 64 (scale_shift = 6)
 *   - Quantization: int8 via (val * 256 / 666) - 128
 */

// ─── Configuration ──────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 480;    // 30ms
const HOP_SIZE = 160;       // 10ms (must match reference: step_size_ms=10)
const FFT_SIZE = 512;
const NUM_BINS = FFT_SIZE / 2 + 1; // 257
const NUM_CHANNELS = 40;
const LOWER_FREQ = 125.0;
const UPPER_FREQ = 7500.0;

// Audio amplitude scaling. Browser mic + WebRTC AGC at 32767 produces
// sqrt_mel ~44000 for loud speech channels. ESP32 I2S ADC produces ~10000-16000.
// At 2500, loud onset sqrt_mel is ~22K → PCAN onset features ~+81 (no clipping
// for most channels; very loudest frames may clip to 127 which is acceptable).
const AUDIO_SCALE = 2500;

// Noise reduction parameters — asymmetric smoothing.
// Upward tracking 40× slower than C default so features persist for the full
// ~0.5s duration of a normal-speed wake word (onset +81, 0.5s +62, 1s +46).
// Downward tracking 2× faster for quick recovery between attempts.
const NR_EVEN_SMOOTHING = 0.025;
const NR_ODD_SMOOTHING = 0.06;
const NR_MIN_SIGNAL = 0.05;
const NR_UP_MULT = 0.025;  // 40× slower upward tracking
const NR_DOWN_MULT = 2.0;  // 2× faster downward recovery

// Noise floor injected after FilterbankSqrt to simulate ESP32's ADC/analog noise.
// Browser mic + noise suppression produces near-digital-silence (~1 sqrt mel at
// AUDIO_SCALE=4000), but ESP32 has ~500-1000 sqrt_mel from ADC/preamp noise.
const NOISE_FLOOR = 1000.0;

// PCAN gain control parameters (match C code: offset=80, strength=0.95)
const PCAN_STRENGTH = 0.95;
const PCAN_OFFSET = 80.0;

// Log scale
const LOG_SCALE_SHIFT = 6; // output = log2(1 + energy) * (1 << 6)

// Int8 quantization: maps the uint16-range log output [0, ~670] to int8
const QUANT_DIVISOR = 666.0;

// ─── Helpers ────────────────────────────────────────────────────────────

/** Convert frequency to mel scale. */
function hzToMel(hz) {
  return 2595.0 * Math.log10(1.0 + hz / 700.0);
}

/** Convert mel scale to frequency. */
function melToHz(mel) {
  return 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
}

/**
 * Build a periodic Hann window of length N.
 * Matches numpy.hanning(N) / the TF micro_frontend Hann window.
 */
function buildHannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / n));
  }
  return w;
}

/**
 * Build a 40-channel triangular mel filterbank.
 * Returns an array of 40 arrays, each containing {bin, weight} pairs
 * for the non-zero filter taps in the frequency domain.
 */
function buildMelFilterbank() {
  const lowMel = hzToMel(LOWER_FREQ);
  const highMel = hzToMel(UPPER_FREQ);
  const numEdges = NUM_CHANNELS + 2; // 42 edges for 40 filters
  const melEdges = new Float64Array(numEdges);
  for (let i = 0; i < numEdges; i++) {
    melEdges[i] = lowMel + (highMel - lowMel) * i / (numEdges - 1);
  }

  // Convert mel edges to FFT bin indices (floating point)
  const binFreqs = new Float64Array(numEdges);
  for (let i = 0; i < numEdges; i++) {
    binFreqs[i] = melToHz(melEdges[i]) * FFT_SIZE / SAMPLE_RATE;
  }

  const filterbank = [];
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const left = binFreqs[ch];
    const center = binFreqs[ch + 1];
    const right = binFreqs[ch + 2];
    const taps = [];

    const startBin = Math.max(0, Math.floor(left));
    const endBin = Math.min(NUM_BINS - 1, Math.ceil(right));

    for (let bin = startBin; bin <= endBin; bin++) {
      let weight = 0;
      if (bin >= left && bin <= center && center > left) {
        weight = (bin - left) / (center - left);
      } else if (bin > center && bin <= right && right > center) {
        weight = (right - bin) / (right - center);
      }
      if (weight > 0) {
        taps.push({ bin, weight });
      }
    }
    filterbank.push(taps);
  }
  return filterbank;
}

/**
 * PcanShrink compression function (matches pcan_gain_control.c).
 * Two-regime compressor: quadratic for small values, linear for large.
 */
function pcanShrink(value) {
  if (value < 8192) {
    return (value * value) / (value + 8192);
  }
  return value - 4096;
}

// ─── In-place radix-2 FFT ───────────────────────────────────────────────

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * Operates on separate real/imag arrays of length N (must be power of 2).
 */
function fft(real, imag, n) {
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      let tmp = real[i]; real[i] = real[j]; real[j] = tmp;
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const step = -2.0 * Math.PI / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < halfSize; k++) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const idx1 = i + k;
        const idx2 = i + k + halfSize;
        const tr = wr * real[idx2] - wi * imag[idx2];
        const ti = wr * imag[idx2] + wi * real[idx2];
        real[idx2] = real[idx1] - tr;
        imag[idx2] = imag[idx1] - ti;
        real[idx1] += tr;
        imag[idx1] += ti;
      }
    }
  }
}

// ─── MicroFrontend class ────────────────────────────────────────────────

export class MicroFrontend {
  constructor() {
    // Precomputed constants
    this._hannWindow = buildHannWindow(WINDOW_SIZE);
    this._melFilterbank = buildMelFilterbank();

    // FFT scratch buffers
    this._fftReal = new Float64Array(FFT_SIZE);
    this._fftImag = new Float64Array(FFT_SIZE);

    // Audio sample accumulator (handles partial windows across chunks)
    this._audioBuffer = new Float32Array(0);

    // Noise reduction state (per-channel noise floor estimate)
    this._noiseEstimate = new Float64Array(NUM_CHANNELS);
    this._noiseInitialized = false;

  }

  /**
   * Feed new audio samples and return feature vectors.
   * Call repeatedly with consecutive chunks of 16kHz float32 audio [-1, 1].
   *
   * @param {Float32Array} samples - raw audio samples (any length)
   * @returns {Int8Array[]} array of int8 feature vectors (40 channels each),
   *   one per feature frame produced (may be 0 if not enough samples yet)
   */
  feed(samples) {
    // Append to internal buffer
    const combined = new Float32Array(this._audioBuffer.length + samples.length);
    combined.set(this._audioBuffer);
    combined.set(samples, this._audioBuffer.length);
    this._audioBuffer = combined;

    const features = [];
    while (this._audioBuffer.length >= WINDOW_SIZE) {
      features.push(this._processWindow(this._audioBuffer.subarray(0, WINDOW_SIZE)));
      // Advance by hop size — keep overlap for next window
      this._audioBuffer = this._audioBuffer.slice(HOP_SIZE);
    }
    return features;
  }

  /**
   * Process a single 480-sample window → one 40-channel int8 feature vector.
   */
  _processWindow(samples) {
    // 1. Apply Hann window and zero-pad to 512
    const real = this._fftReal;
    const imag = this._fftImag;
    real.fill(0);
    imag.fill(0);
    for (let i = 0; i < WINDOW_SIZE; i++) {
      // Scale to ESP32-equivalent amplitude (not full int16 range)
      real[i] = samples[i] * AUDIO_SCALE * this._hannWindow[i];
    }

    // 2. FFT (in-place, result in real/imag arrays)
    fft(real, imag, FFT_SIZE);

    // 3. Power spectrum: |FFT[k]|² for k = 0..256
    const power = new Float64Array(NUM_BINS);
    for (let i = 0; i < NUM_BINS; i++) {
      power[i] = real[i] * real[i] + imag[i] * imag[i];
    }

    // 4. Mel filterbank: weighted sum of power spectrum → 40 channels
    const melEnergies = new Float64Array(NUM_CHANNELS);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      let sum = 0;
      for (const tap of this._melFilterbank[ch]) {
        sum += power[tap.bin] * tap.weight;
      }
      melEnergies[ch] = Math.max(sum, 1.0); // floor to avoid sqrt(0)
    }

    // 5. FilterbankSqrt: reduce dynamic range (matches FilterbankSqrt in C code)
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      melEnergies[ch] = Math.sqrt(melEnergies[ch]);
    }

    // 5b. Inject noise floor — browser mic silence is ~10-100 (vs ESP32 ~1000).
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      melEnergies[ch] += NOISE_FLOOR;
    }

    // 6. Noise reduction
    this._noiseReduction(melEnergies);

    // 7. PCAN gain control
    this._pcanGainControl(melEnergies);

    // 8. Log₂ scale: log₂(1 + energy) × (1 << scale_shift)
    const logFeatures = new Float64Array(NUM_CHANNELS);
    for (let i = 0; i < NUM_CHANNELS; i++) {
      logFeatures[i] = Math.max(0, Math.log2(1.0 + melEnergies[i]) * (1 << LOG_SCALE_SHIFT));
    }

    // 9. Quantize to int8
    const int8Features = new Int8Array(NUM_CHANNELS);
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const val = Math.round(logFeatures[i] * 256.0 / QUANT_DIVISOR) - 128;
      int8Features[i] = Math.max(-128, Math.min(127, val));
    }

    return int8Features;
  }

  /**
   * Per-channel noise reduction with asymmetric exponential smoothing.
   *
   * Upward tracking is 20× slower than C code default so features persist
   * for the full 0.5-0.7s duration of a normal-speed wake word. Downward
   * tracking is 2× faster for quick recovery between attempts.
   */
  _noiseReduction(energies) {
    if (!this._noiseInitialized) {
      for (let i = 0; i < NUM_CHANNELS; i++) {
        this._noiseEstimate[i] = energies[i];
      }
      this._noiseInitialized = true;
    }

    for (let i = 0; i < NUM_CHANNELS; i++) {
      const base = (i % 2 === 0) ? NR_EVEN_SMOOTHING : NR_ODD_SMOOTHING;
      const smoothing = (energies[i] > this._noiseEstimate[i])
        ? base * NR_UP_MULT    // Slow upward — features persist longer
        : base * NR_DOWN_MULT; // Fast downward — quick recovery

      this._noiseEstimate[i] = (1.0 - smoothing) * this._noiseEstimate[i]
        + smoothing * energies[i];

      // Subtract noise, keep at least min_signal fraction
      const signal = energies[i] - this._noiseEstimate[i];
      const minSignal = NR_MIN_SIGNAL * this._noiseEstimate[i];
      energies[i] = Math.max(signal, minSignal);
    }
  }

  /**
   * PCAN gain control (matches pcan_gain_control.c).
   * Gain is computed from the noise estimate: gain = (offset/noise)^strength.
   */
  _pcanGainControl(energies) {
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const noise = Math.max(this._noiseEstimate[i], 1.0);
      const gain = Math.pow(PCAN_OFFSET / noise, PCAN_STRENGTH);
      energies[i] = pcanShrink(energies[i] * gain);
    }
  }

  /**
   * Reset all internal state (for restarting detection).
   */
  reset() {
    this._audioBuffer = new Float32Array(0);
    this._noiseEstimate.fill(0);
    this._noiseInitialized = false;
  }
}
