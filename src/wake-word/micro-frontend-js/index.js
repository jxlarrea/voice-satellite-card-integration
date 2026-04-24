const SAMPLE_RATE = 16000;
const WINDOW_SIZE_MS = 30;
const STEP_SIZE_MS = 10;
const FEATURE_SIZE = 40;
const FILTERBANK_LOW_HZ = 125.0;
const FILTERBANK_HIGH_HZ = 7500.0;
const NOISE_REDUCTION_BITS = 14;
const NOISE_REDUCTION_SMOOTHING_BITS = 10;
// C uses direct float-to-int cast (truncation), NOT round-to-nearest.
// 0.025 * 16384 = 409.6 → C stores 409; using Math.round gives 410 (off by 1).
const NOISE_REDUCTION_EVEN_SMOOTHING = Math.trunc(0.025 * (1 << NOISE_REDUCTION_BITS));
const NOISE_REDUCTION_ODD_SMOOTHING = Math.trunc(0.06 * (1 << NOISE_REDUCTION_BITS));
const NOISE_REDUCTION_MIN_SIGNAL = Math.trunc(0.05 * (1 << NOISE_REDUCTION_BITS));
const PCAN_SNR_BITS = 12;
const PCAN_OUTPUT_BITS = 6;
const PCAN_GAIN_BITS = 21;
const PCAN_STRENGTH = 0.95;
const PCAN_OFFSET = 80.0;
const WIDE_DYNAMIC_BITS = 32;
const LOG_SEGMENTS_LOG2 = 7;
const LOG_SCALE_LOG2 = 16;
const LOG_SCALE = 65536;
const LOG_COEFF = 45426;
const FLOAT32_SCALE = 0.0390625;
const FRONTEND_WINDOW_BITS = 12;

const WINDOW_SIZE = Math.floor((WINDOW_SIZE_MS * SAMPLE_RATE) / 1000);
const STEP_SIZE = Math.floor((STEP_SIZE_MS * SAMPLE_RATE) / 1000);
const FFT_SIZE = 1 << Math.ceil(Math.log2(WINDOW_SIZE));
const SPECTRUM_SIZE = FFT_SIZE / 2 + 1;
const INPUT_CORRECTION_BITS = mostSignificantBit32(FFT_SIZE) - 1 - (FRONTEND_WINDOW_BITS / 2);
const SNR_SHIFT = PCAN_GAIN_BITS - INPUT_CORRECTION_BITS - PCAN_SNR_BITS;
const LOG_LUT = new Uint16Array([
  0, 224, 442, 654, 861, 1063, 1259, 1450, 1636, 1817, 1992, 2163, 2329, 2490,
  2646, 2797, 2944, 3087, 3224, 3358, 3487, 3611, 3732, 3848, 3960, 4068, 4172,
  4272, 4368, 4460, 4549, 4633, 4714, 4791, 4864, 4934, 5001, 5063, 5123, 5178,
  5231, 5280, 5326, 5368, 5408, 5444, 5477, 5507, 5533, 5557, 5578, 5595, 5610,
  5622, 5631, 5637, 5640, 5641, 5638, 5633, 5626, 5615, 5602, 5586, 5568, 5547,
  5524, 5498, 5470, 5439, 5406, 5370, 5332, 5291, 5249, 5203, 5156, 5106, 5054,
  5000, 4944, 4885, 4825, 4762, 4697, 4630, 4561, 4490, 4416, 4341, 4264, 4184,
  4103, 4020, 3935, 3848, 3759, 3668, 3575, 3481, 3384, 3286, 3186, 3084, 2981,
  2875, 2768, 2659, 2549, 2437, 2323, 2207, 2090, 1971, 1851, 1729, 1605, 1480,
  1353, 1224, 1094, 963, 830, 695, 559, 421, 282, 142, 0, 0,
]);

let sharedState = null;

export async function createJsMicroFrontend() {
  return new JsMicroFrontend(getSharedState());
}

class JsMicroFrontend {
  constructor(shared) {
    this._shared = shared;
    // Pre-quantization float feature frames (length = FEATURE_SIZE).
    // Quantization is now done per-keyword inside the inference engine so
    // two wake word models with different (scale, zero_point) params can
    // share one feature stream. See micro-inference.js _runModelRunner.
    this._featurePool = [];
    this._featurePoolMax = 32;

    this._input = new Int16Array(WINDOW_SIZE);
    this._inputUsed = 0;
    this._windowed = new Int16Array(WINDOW_SIZE);
    // kiss_fftr packs real samples into N/2 complex slots, then post-processes
    // with super-twiddles.  fftTime holds the scaled real input (int16, zero
    // padded to FFT_SIZE).  fftOutR/fftOutI hold the N/2+1 complex bins.
    this._fftTime = new Int16Array(FFT_SIZE);
    this._fftOutR = new Int16Array(SPECTRUM_SIZE);
    this._fftOutI = new Int16Array(SPECTRUM_SIZE);
    // C: work is uint64[]. JS: use BigInt64Array? No — weights are int16 and
    // magnitudes fit in uint32, so we can use regular Number accumulation as
    // long as the sum stays below 2^53.  Worst case: 40 channels * 16 bins *
    // 32767 * 2^32 ≈ 2^47. Safe.
    this._filterbankWork = new Float64Array(FEATURE_SIZE + 1);
    this._noiseEstimate = new Uint32Array(FEATURE_SIZE);
  }

  /**
   * Deprecated no-op. Quantization is now per-keyword inside the inference
   * engine. Kept so old callers do not throw during the transition.
   */
  setQuantization(_scale, _zeroPoint) { /* moved to inference engine */ }

  feed(samples) {
    if (!samples?.length) return [];

    const results = [];
    let offset = 0;

    while (offset < samples.length) {
      const writable = Math.min(samples.length - offset, WINDOW_SIZE - this._inputUsed);
      for (let i = 0; i < writable; i++) {
        this._input[this._inputUsed + i] = floatToInt16(samples[offset + i]);
      }
      this._inputUsed += writable;
      offset += writable;

      if (this._inputUsed < WINDOW_SIZE) continue;

      results.push(this._processWindow());
      this._input.copyWithin(0, STEP_SIZE, WINDOW_SIZE);
      this._inputUsed -= STEP_SIZE;
    }

    return results;
  }

  recycleFeature(buf) {
    if (!buf) return;
    if (this._featurePool.length >= this._featurePoolMax) return;
    if (!this._featurePool.includes(buf)) this._featurePool.push(buf);
  }

  reset() {
    this._input.fill(0);
    this._windowed.fill(0);
    this._fftTime.fill(0);
    this._fftOutR.fill(0);
    this._fftOutI.fill(0);
    this._filterbankWork.fill(0);
    this._noiseEstimate.fill(0);
    this._inputUsed = 0;
  }

  destroy() {
    this._featurePool.length = 0;
    this._shared = null;
  }

  _processWindow() {
    const { windowCoefficients, filterbank, fftPlan, gainLut } = this._shared;

    let maxAbs = 0;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const value = (this._input[i] * windowCoefficients[i]) >> FRONTEND_WINDOW_BITS;
      this._windowed[i] = value;
      const absValue = value < 0 ? -value : value;
      if (absValue > maxAbs) maxAbs = absValue;
    }

    const inputShift = 15 - mostSignificantBit32(maxAbs >>> 0);

    // Pre-FFT scaling: C does
    //   fft_input[i] = (int16_t)((uint16_t)input[i] << input_scale_shift);
    // Zero-extend to uint16 first, then shift, then truncate to int16 (wrap).
    // Int16Array assignment handles the final int16 wrap automatically.
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const uVal = this._windowed[i] & 0xFFFF;
      this._fftTime[i] = (uVal << inputShift) & 0xFFFF;
    }
    for (let i = WINDOW_SIZE; i < FFT_SIZE; i++) {
      this._fftTime[i] = 0;
    }

    // kiss_fftr: N/2-point complex FFT + real-FFT post-processing.  Output
    // is N/2+1 complex bins (int16), matching pymicro_features bit-exactly.
    kissFftr(this._fftTime, this._fftOutR, this._fftOutI, fftPlan);

    let weightAccumulator = 0;
    let unweightAccumulator = 0;

    for (let channel = 0; channel <= FEATURE_SIZE; channel++) {
      const freqStart = filterbank.channelFrequencyStarts[channel];
      const weightStart = filterbank.channelWeightStarts[channel];
      const width = filterbank.channelWidths[channel];

      for (let j = 0; j < width; j++) {
        const bin = freqStart + j;
        const real = this._fftOutR[bin];
        const imag = this._fftOutI[bin];
        // C: uint32_t mag_squared = (real*real) + (imag*imag)
        // Both operands are int16 widened to int32.  Product max ≈ 2^30,
        // sum ≈ 2^31 — fits in uint32 (wraps on overflow, matching C).
        const magnitude = (real * real + imag * imag) >>> 0;
        weightAccumulator += filterbank.weights[weightStart + j] * magnitude;
        unweightAccumulator += filterbank.unweights[weightStart + j] * magnitude;
      }

      this._filterbankWork[channel] = weightAccumulator;
      weightAccumulator = unweightAccumulator;
      unweightAccumulator = 0;
    }

    const signal = new Float64Array(FEATURE_SIZE);
    for (let i = 0; i < FEATURE_SIZE; i++) {
      // C uses a custom integer Sqrt64 with rounding; Math.sqrt rounded to
      // the nearest int matches it for all practical inputs (sum of
      // weighted energies stays well under 2^53).
      const sqrtValue = Math.round(Math.sqrt(this._filterbankWork[i + 1]));
      signal[i] = sqrtValue >>> inputShift;
    }

    this._applyNoiseReduction(signal);
    this._applyPcan(signal, gainLut);

    // Emit pre-quantization float features. Each downstream keyword
    // applies its own (scale, zero_point) on the way into the model input
    // tensor (see micro-inference.js _quantizeFeatureTo). This lets two
    // models with different quantization params share one feature stream.
    const feature = this._featurePool.pop() || new Float32Array(FEATURE_SIZE);
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const corrected = signal[i] * (1 << INPUT_CORRECTION_BITS);
      const logged = corrected > 1 ? logScale(corrected) : 0;
      const clamped = logged < 0xFFFF ? logged : 0xFFFF;
      feature[i] = Math.fround(clamped * FLOAT32_SCALE);
    }

    return feature;
  }

  _applyNoiseReduction(signal) {
    const NR_BITS_POW = 1 << NOISE_REDUCTION_BITS;        // 2^14
    const SM_BITS_POW = 1 << NOISE_REDUCTION_SMOOTHING_BITS; // 2^10
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const smoothing = (i & 1) === 0
        ? NOISE_REDUCTION_EVEN_SMOOTHING
        : NOISE_REDUCTION_ODD_SMOOTHING;
      const oneMinus = NR_BITS_POW - smoothing;
      // C: uint32_t signal_scaled_up = signal[i] << smoothing_bits.
      // Shift wraps to uint32 when signal[i] > 2^22. `>>> 0` matches that.
      const signalScaledUp = (signal[i] * SM_BITS_POW) >>> 0;
      // Estimate = ((uint64)ssu*sm + (uint64)est*om) >> 14, stored as uint32.
      // Sum can exceed 2^32, but stays well under 2^53 — doubles are exact.
      // Floor+>>>0 models the C uint32 store.
      const estSum = signalScaledUp * smoothing + this._noiseEstimate[i] * oneMinus;
      const estimate = Math.floor(estSum / NR_BITS_POW) >>> 0;
      this._noiseEstimate[i] = estimate;
      // Clamp estimate to signal_scaled_up (both uint32) before subtraction.
      const estClamped = estimate > signalScaledUp ? signalScaledUp : estimate;
      // floor = (uint64)signal[i] * min_signal_remaining >> 14, uint32 store.
      const floorVal = Math.floor((signal[i] * NOISE_REDUCTION_MIN_SIGNAL) / NR_BITS_POW) >>> 0;
      // subtracted = (ssu - est) >> 10, uint32. Both uint32, subtraction stays positive.
      const subtracted = ((signalScaledUp - estClamped) / SM_BITS_POW) >>> 0;
      signal[i] = subtracted > floorVal ? subtracted : floorVal;
    }
  }

  _applyPcan(signal, gainLut) {
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const gain = wideDynamicFunction(this._noiseEstimate[i], gainLut);
      const snr = Math.floor((signal[i] * gain) / (1 << SNR_SHIFT));
      signal[i] = pcanShrink(snr);
    }
  }
}

function getSharedState() {
  if (sharedState) return sharedState;
  sharedState = {
    windowCoefficients: buildWindowCoefficients(),
    filterbank: buildFilterbankState(),
    fftPlan: buildFftPlan(FFT_SIZE),
    gainLut: buildGainLut(),
  };
  return sharedState;
}

function buildWindowCoefficients() {
  // C uses float32 (cosf, floorf). Math.fround simulates float32 rounding so
  // coefficient boundaries match C-reference output bit-for-bit.
  const coefficients = new Int16Array(WINDOW_SIZE);
  const arg = Math.fround((Math.PI * 2.0) / WINDOW_SIZE);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const phase = Math.fround(arg * Math.fround(i + 0.5));
    const c = Math.fround(Math.cos(phase));
    const v = Math.fround(0.5 - Math.fround(0.5 * c));
    coefficients[i] = Math.floor(Math.fround(v * (1 << FRONTEND_WINDOW_BITS)) + 0.5);
  }
  return coefficients;
}

function buildFilterbankState() {
  // C uses float32 throughout. Math.fround makes boundary decisions
  // (width computation from FreqToMel comparison) match C exactly — a
  // single-bit precision difference at channel 39/40 boundary shifts
  // which FFT bins feed which filterbank channel.
  const numChannelsPlusOne = FEATURE_SIZE + 1;
  const indexAlignment = 4 / Int16Array.BYTES_PER_ELEMENT;
  const centerMelFreqs = new Float32Array(numChannelsPlusOne);
  const actualChannelStarts = new Int16Array(numChannelsPlusOne);
  const actualChannelWidths = new Int16Array(numChannelsPlusOne);
  const channelFrequencyStarts = new Int16Array(numChannelsPlusOne);
  const channelWeightStarts = new Int16Array(numChannelsPlusOne);
  const channelWidths = new Int16Array(numChannelsPlusOne);

  const melLow = freqToMel(FILTERBANK_LOW_HZ);
  const melHigh = freqToMel(FILTERBANK_HIGH_HZ);
  // C CalculateCenterFrequencies:
  //   const float mel_span    = mel_hi - mel_low;     // float32 round here
  //   const float mel_spacing = mel_span / (float)num_channels;
  // Two float32 ops in sequence — the intermediate mel_span MUST be rounded
  // to float32 before dividing, else we miss by a few ULP and filterbank bin
  // boundaries shift at high channels.  Also: divisor is num_channels_plus_1
  // (41), not FEATURE_SIZE (40) — a naming quirk in CalculateCenterFrequencies.
  const melSpan = Math.fround(melHigh - melLow);
  const melSpacing = Math.fround(melSpan / numChannelsPlusOne);

  for (let i = 0; i < numChannelsPlusOne; i++) {
    centerMelFreqs[i] = Math.fround(melLow + Math.fround(melSpacing * (i + 1)));
  }

  const hzPerSbin = Math.fround((0.5 * SAMPLE_RATE) / (SPECTRUM_SIZE - 1));
  const startIndex = Math.trunc(Math.fround(1.5 + FILTERBANK_LOW_HZ / hzPerSbin));
  let channelFreqIndexStart = startIndex;
  let weightIndexStart = 0;
  let needsZeros = false;

  for (let chan = 0; chan < numChannelsPlusOne; chan++) {
    let freqIndex = channelFreqIndexStart;
    // C: while (FreqToMel((freq_index) * hz_per_sbin) <= center_mel_freqs[chan])
    // All ops in float32.
    while (freqToMel(Math.fround(freqIndex * hzPerSbin)) <= centerMelFreqs[chan]) freqIndex++;

    const width = freqIndex - channelFreqIndexStart;
    actualChannelStarts[chan] = channelFreqIndexStart;
    actualChannelWidths[chan] = width;

    if (width === 0) {
      channelFrequencyStarts[chan] = 0;
      channelWeightStarts[chan] = 0;
      channelWidths[chan] = 4;
      if (!needsZeros) {
        needsZeros = true;
        for (let j = 0; j < chan; j++) channelWeightStarts[j] += 4;
        weightIndexStart += 4;
      }
    } else {
      const alignedStart = Math.floor(channelFreqIndexStart / indexAlignment) * indexAlignment;
      const alignedWidth = channelFreqIndexStart - alignedStart + width;
      const paddedWidth = (Math.floor((alignedWidth - 1) / 4) + 1) * 4;
      channelFrequencyStarts[chan] = alignedStart;
      channelWeightStarts[chan] = weightIndexStart;
      channelWidths[chan] = paddedWidth;
      weightIndexStart += paddedWidth;
    }

    channelFreqIndexStart = freqIndex;
  }

  const weights = new Int16Array(weightIndexStart);
  const unweights = new Int16Array(weightIndexStart);
  let endIndex = 0;

  for (let chan = 0; chan < numChannelsPlusOne; chan++) {
    let frequency = actualChannelStarts[chan];
    const numFrequencies = actualChannelWidths[chan];
    const frequencyOffset = frequency - channelFrequencyStarts[chan];
    const weightStart = channelWeightStarts[chan];
    const denom = chan === 0 ? melLow : centerMelFreqs[chan - 1];

    for (let j = 0; j < numFrequencies; j++, frequency++) {
      // C filterbank_util.cc: weight = (center - FreqToMel(freq * hz_per)) / (center - denom)
      // All arithmetic float32.
      const melFreq = freqToMel(Math.fround(frequency * hzPerSbin));
      const num = Math.fround(centerMelFreqs[chan] - melFreq);
      const den = Math.fround(centerMelFreqs[chan] - denom);
      const weight = Math.fround(num / den);
      const weightIndex = weightStart + frequencyOffset + j;
      // QuantizeFilterbankWeights: floorf(w * (1<<kFilterbankBits) + 0.5f)
      weights[weightIndex] = Math.floor(Math.fround(weight * (1 << FRONTEND_WINDOW_BITS)) + 0.5);
      unweights[weightIndex] = Math.floor(
        Math.fround(Math.fround(1.0 - weight) * (1 << FRONTEND_WINDOW_BITS)) + 0.5,
      );
    }

    if (frequency > endIndex) endIndex = frequency;
  }

  return {
    startIndex,
    endIndex,
    channelFrequencyStarts,
    channelWeightStarts,
    channelWidths,
    weights,
    unweights,
  };
}

// Build the kiss_fftr plan for an N-point real FFT.
// For N=512: ncfft=256 (complex FFT size), factored as 4*4*4*4.
// Returns twiddles for the complex FFT and super-twiddles for the real-FFT
// post-processing, all in Q15 fixed-point (int16).
function buildFftPlan(nfftReal) {
  const ncfft = nfftReal >> 1; // 256 for N=512

  // kiss_fft twiddles: W[i] = (cos(-2*pi*i/ncfft), sin(-2*pi*i/ncfft))
  // scaled by SAMP_MAX=32767 with floor(.5 + x*SAMP_MAX) rounding.
  const twCos = new Int16Array(ncfft);
  const twSin = new Int16Array(ncfft);
  for (let i = 0; i < ncfft; i++) {
    const phase = (-2.0 * Math.PI * i) / ncfft;
    twCos[i] = Math.floor(0.5 + 32767 * Math.cos(phase));
    twSin[i] = Math.floor(0.5 + 32767 * Math.sin(phase));
  }

  // Super-twiddles for kiss_fftr post-processing:
  //   phase = -PI * ((i+1)/ncfft + 0.5), for i in [0, ncfft/2)
  const superCount = ncfft >> 1;
  const stCos = new Int16Array(superCount);
  const stSin = new Int16Array(superCount);
  for (let i = 0; i < superCount; i++) {
    const phase = -Math.PI * ((i + 1) / ncfft + 0.5);
    stCos[i] = Math.floor(0.5 + 32767 * Math.cos(phase));
    stSin[i] = Math.floor(0.5 + 32767 * Math.sin(phase));
  }

  // Factor ncfft: radix-4 + radix-2, matching C kf_factor order.
  // For ncfft=256: [4,64, 4,16, 4,4, 4,1]
  const factors = [];
  let n = ncfft;
  let p = 4;
  const floorSqrt = Math.floor(Math.sqrt(n));
  while (n > 1) {
    while (n % p !== 0) {
      if (p === 4) p = 2;
      else if (p === 2) p = 3;
      else p += 2;
      if (p > floorSqrt) p = n;
    }
    n = (n / p) | 0;
    factors.push(p, n);
  }

  // Temporary buffers for the N/2 complex FFT (shared between stages).
  const tmpR = new Int16Array(ncfft);
  const tmpI = new Int16Array(ncfft);

  return { nfftReal, ncfft, twCos, twSin, stCos, stSin, factors, tmpR, tmpI };
}

// sround(x) = (x + (1<<14)) >> 15 — matches KISS FFT _kiss_fft_guts.h.
// JS: `(x + 16384) | 0` converts to int32; `>> 15` is arithmetic shift.
// Input range must fit in ~int32 (fine for our use — SAMPPROD = int32).
function sround(x) {
  return (x + 16384) >> 15;
}

// C_FIXDIV(x, 2) = sround(smul(x, SAMP_MAX/2=16383)) = sround(x * 16383).
// Not equivalent to x/2: rounds slightly differently (adds +1 on odd values).
function cFixdiv2(x) {
  return sround(x * 16383);
}

// C_FIXDIV(x, 4) = sround(smul(x, 8191)). Used by radix-4 butterflies.
function cFixdiv4(x) {
  return sround(x * 8191);
}

// N/2-point complex FFT: iteratively apply butterflies per C kf_work.
// Reads from (srcR, srcI), writes to (dstR, dstI), both int16 (caller is
// responsible for allocating Int16Arrays).
function kissFftComplex(srcR, srcI, dstR, dstI, plan) {
  const { factors, twCos, twSin } = plan;
  kfWork(dstR, dstI, 0, srcR, srcI, 0, 1, 1, factors, 0, twCos, twSin);
}

function kfWork(dR, dI, dof, sR, sI, sof, fstride, inStride, factors, fi,
                twCos, twSin) {
  const p = factors[fi];
  const m = factors[fi + 1];
  const foutBeg = dof;
  if (m === 1) {
    // Leaf: copy strided input into dst (Int16Array assignment wraps).
    for (let i = 0; i < p; i++) {
      dR[dof + i] = sR[sof + i * fstride * inStride];
      dI[dof + i] = sI[sof + i * fstride * inStride];
    }
  } else {
    // Recursive decimation.
    let s = sof;
    let d = dof;
    for (let k = 0; k < p; k++) {
      kfWork(dR, dI, d, sR, sI, s, fstride * p, inStride,
             factors, fi + 2, twCos, twSin);
      s += fstride * inStride;
      d += m;
    }
  }
  if (p === 2) kfBfly2(dR, dI, foutBeg, fstride, m, twCos, twSin);
  else if (p === 4) kfBfly4(dR, dI, foutBeg, fstride, m, twCos, twSin);
  // (We don't use radix-3/5 for N=512.)
}

// Radix-2 butterfly matching C kf_bfly2 semantics.
// Every store is an Int16Array assignment (wraps on overflow — emulates C).
function kfBfly2(R, I, Fout, fstride, m, twCos, twSin) {
  for (let k = 0; k < m; k++) {
    const a = Fout + k;
    const b = a + m;
    // C_FIXDIV both Fout and Fout2 by 2.
    R[a] = cFixdiv2(R[a]); I[a] = cFixdiv2(I[a]);
    R[b] = cFixdiv2(R[b]); I[b] = cFixdiv2(I[b]);
    // t = Fout2 * tw
    const tIdx = fstride * k;
    const wr = twCos[tIdx];
    const wi = twSin[tIdx];
    const br = R[b], bi = I[b];
    const tr = sround(br * wr - bi * wi);
    const ti = sround(br * wi + bi * wr);
    // Fout2 = Fout - t; Fout += t
    const ar = R[a], ai = I[a];
    R[b] = ar - tr; I[b] = ai - ti;
    R[a] = ar + tr; I[a] = ai + ti;
  }
}

// Radix-4 butterfly matching C kf_bfly4 semantics (forward only).
function kfBfly4(R, I, Fout, fstride, m, twCos, twSin) {
  const m2 = 2 * m;
  const m3 = 3 * m;
  for (let k = 0; k < m; k++) {
    const p0 = Fout + k;
    const p1 = p0 + m;
    const p2 = p0 + m2;
    const p3 = p0 + m3;
    R[p0] = cFixdiv4(R[p0]); I[p0] = cFixdiv4(I[p0]);
    R[p1] = cFixdiv4(R[p1]); I[p1] = cFixdiv4(I[p1]);
    R[p2] = cFixdiv4(R[p2]); I[p2] = cFixdiv4(I[p2]);
    R[p3] = cFixdiv4(R[p3]); I[p3] = cFixdiv4(I[p3]);
    const t1 = fstride * k;
    const t2 = fstride * 2 * k;
    const t3 = fstride * 3 * k;
    const w1r = twCos[t1], w1i = twSin[t1];
    const w2r = twCos[t2], w2i = twSin[t2];
    const w3r = twCos[t3], w3i = twSin[t3];
    // scratch[0] = Fout[m] * tw1
    const r1 = R[p1], i1 = I[p1];
    const s0r = sround(r1 * w1r - i1 * w1i);
    const s0i = sround(r1 * w1i + i1 * w1r);
    // scratch[1] = Fout[m2] * tw2
    const r2 = R[p2], i2 = I[p2];
    const s1r = sround(r2 * w2r - i2 * w2i);
    const s1i = sround(r2 * w2i + i2 * w2r);
    // scratch[2] = Fout[m3] * tw3
    const r3 = R[p3], i3 = I[p3];
    const s2r = sround(r3 * w3r - i3 * w3i);
    const s2i = sround(r3 * w3i + i3 * w3r);
    // scratch[5] = *Fout - scratch[1]
    const p0r = R[p0], p0i = I[p0];
    const s5r = p0r - s1r, s5i = p0i - s1i;
    // *Fout += scratch[1]
    R[p0] = p0r + s1r; I[p0] = p0i + s1i;
    // scratch[3] = scratch[0] + scratch[2]
    const s3r = s0r + s2r, s3i = s0i + s2i;
    // scratch[4] = scratch[0] - scratch[2]
    const s4r = s0r - s2r, s4i = s0i - s2i;
    // Fout[m2] = *Fout - scratch[3]  (*Fout already includes scratch[1])
    R[p2] = R[p0] - s3r; I[p2] = I[p0] - s3i;
    // *Fout += scratch[3]
    R[p0] = R[p0] + s3r; I[p0] = I[p0] + s3i;
    // Forward (non-inverse):
    //   Fout[m].r  = scratch[5].r + scratch[4].i
    //   Fout[m].i  = scratch[5].i - scratch[4].r
    //   Fout[m3].r = scratch[5].r - scratch[4].i
    //   Fout[m3].i = scratch[5].i + scratch[4].r
    R[p1] = s5r + s4i; I[p1] = s5i - s4r;
    R[p3] = s5r - s4i; I[p3] = s5i + s4r;
  }
}

// Real-to-complex FFT matching C kiss_fftr exactly.
// timedata is Int16Array of length nfftReal (= FFT_SIZE).
// Writes to outR, outI of length ncfft+1 (SPECTRUM_SIZE=257 for N=512).
// Pairs of real samples are packed as complex inputs, processed by the N/2
// complex FFT, then split into the real N-point spectrum via super-twiddles.
function kissFftr(timedata, outR, outI, plan) {
  const { ncfft, tmpR, tmpI, stCos, stSin } = plan;

  // Pack real input as complex: cpx[k] = (time[2k], time[2k+1]).
  // tmpR/tmpI start as scratch — we'll overwrite them with the FFT output.
  // To match C reinterpret_cast, build the complex input first.
  const srcR = new Int16Array(ncfft);
  const srcI = new Int16Array(ncfft);
  for (let k = 0; k < ncfft; k++) {
    srcR[k] = timedata[2 * k];
    srcI[k] = timedata[2 * k + 1];
  }

  kissFftComplex(srcR, srcI, tmpR, tmpI, plan);

  // DC / Nyquist: C_FIXDIV(tdc, 2); freq[0] = (tdc.r + tdc.i, 0); freq[N/2] = (tdc.r - tdc.i, 0)
  const tdcR = cFixdiv2(tmpR[0]);
  const tdcI = cFixdiv2(tmpI[0]);
  outR[0] = tdcR + tdcI; outI[0] = 0;
  outR[ncfft] = tdcR - tdcI; outI[ncfft] = 0;

  // For k=1..ncfft/2: combine tmp[k] and conj(tmp[ncfft-k]) via super_twiddle.
  for (let k = 1; k <= ncfft >> 1; k++) {
    // fpk = tmp[k]; fpnk = conj(tmp[ncfft-k]).
    const fpkR_raw = tmpR[k];
    const fpkI_raw = tmpI[k];
    const fpnkR_raw = tmpR[ncfft - k];
    const fpnkI_raw = -tmpI[ncfft - k]; // int16 negation wraps via (v<<16)>>16
    const fpnkIneg = (fpnkI_raw << 16) >> 16;
    // C_FIXDIV each by 2.
    const fpkR = cFixdiv2(fpkR_raw);
    const fpkI = cFixdiv2(fpkI_raw);
    const fpnkR = cFixdiv2(fpnkR_raw);
    const fpnkI = cFixdiv2(fpnkIneg);
    // f1k = fpk + fpnk; f2k = fpk - fpnk.
    const f1kR = fpkR + fpnkR;
    const f1kI = fpkI + fpnkI;
    const f2kR = fpkR - fpnkR;
    const f2kI = fpkI - fpnkI;
    // tw = f2k * super_twiddles[k-1]
    const stR = stCos[k - 1];
    const stI = stSin[k - 1];
    const twR = sround(f2kR * stR - f2kI * stI);
    const twI = sround(f2kR * stI + f2kI * stR);
    // freq[k]       = HALF_OF(f1k + tw)
    // freq[ncfft-k] = (HALF_OF(f1k.r - tw.r), HALF_OF(tw.i - f1k.i))
    outR[k] = (f1kR + twR) >> 1;
    outI[k] = (f1kI + twI) >> 1;
    outR[ncfft - k] = (f1kR - twR) >> 1;
    outI[ncfft - k] = (twI - f1kI) >> 1;
  }
}

function buildGainLut() {
  // The TFLite Micro reference uses a clever pointer trick:
  //   lut[0], lut[1] hold the y values for x=0 and x=1 (the two special-case
  //     inputs handled by the "x <= 2" branch of WideDynamicFunction).
  //   Then `state->gain_lut -= 6` shifts the pointer BEFORE the interval
  //     writes, so `gain_lut[4*interval]` = `original_lut[4*interval - 6]`.
  //   Interval 2's y0 (which is the y value for x=2) lands at lut[2], so
  //     the "x <= 2" branch's `lut[2]` access reads the same slot that
  //     interval 2's table lookup uses.  Indices 5, 9, 13, ... are unused.
  // We replicate that layout directly: writes go to `4*interval - 6`.
  const lut = new Int16Array((4 * WIDE_DYNAMIC_BITS) + 4);
  const inputBits = NOISE_REDUCTION_SMOOTHING_BITS - INPUT_CORRECTION_BITS;

  lut[0] = pcanGainLookup(inputBits, 0);
  lut[1] = pcanGainLookup(inputBits, 1);

  for (let interval = 2; interval <= WIDE_DYNAMIC_BITS; interval++) {
    const x0 = 1 << (interval - 1);
    const x1 = x0 + (x0 >> 1);
    const x2 = interval === WIDE_DYNAMIC_BITS ? x0 + (x0 - 1) : 2 * x0;

    const y0 = pcanGainLookup(inputBits, x0);
    const y1 = pcanGainLookup(inputBits, x1);
    const y2 = pcanGainLookup(inputBits, x2);

    const diff1 = y1 - y0;
    const diff2 = y2 - y0;
    const a1 = (4 * diff1) - diff2;
    const a2 = diff2 - a1;
    const offset = (4 * interval) - 6;
    lut[offset + 0] = y0;
    lut[offset + 1] = a1;
    lut[offset + 2] = a2;
  }

  return { lut, base: 0 };
}

function freqToMel(freq) {
  // C: 1127.0f * log1pf(freq / 700.0f). Use Math.fround to match float32.
  return Math.fround(1127.0 * Math.fround(Math.log1p(Math.fround(freq / 700.0))));
}

function floatToInt16(value) {
  let scaled = value * 32768.0;
  if (scaled > 32767) scaled = 32767;
  else if (scaled < -32768) scaled = -32768;
  return scaled | 0;
}

function toInt16(value) {
  return (value << 16) >> 16;
}

function mostSignificantBit32(value) {
  if (!value) return 0;
  return 32 - Math.clz32(value >>> 0);
}

function pcanGainLookup(inputBits, x) {
  // C: float x_as_float = ((float)x) / ((uint32_t)1 << input_bits);
  //    gain = ((uint32_t)1 << gain_bits) * powf(x_as_float + offset, -strength);
  // All float32. Use Math.fround to match.
  const xAsFloat = Math.fround(x / (1 << inputBits));
  const sum = Math.fround(xAsFloat + PCAN_OFFSET);
  const powVal = Math.fround(Math.pow(sum, -PCAN_STRENGTH));
  const gain = Math.fround((1 << PCAN_GAIN_BITS) * powVal);
  if (gain > 0x7fff) return 0x7fff;
  return Math.floor(gain + 0.5);
}

function wideDynamicFunction(x, state) {
  const { lut } = state;
  if (x <= 2) return lut[x];

  const interval = mostSignificantBit32(x >>> 0);
  const offset = (4 * interval) - 6;
  const frac = ((((interval < 11)
    ? (x << (11 - interval))
    : (x >>> (interval - 11))) & 0x3ff) >>> 0);

  let result = Math.floor((lut[offset + 2] * frac) / 32);
  result += lut[offset + 1] << 5;
  result *= frac;
  result = Math.floor((result + (1 << 14)) / (1 << 15));
  result += lut[offset + 0];
  return result;
}

function pcanShrink(x) {
  if (x < (2 << PCAN_SNR_BITS)) {
    return Math.floor((x * x) / (1 << (2 + (2 * PCAN_SNR_BITS) - PCAN_OUTPUT_BITS)));
  }
  return Math.floor(x / (1 << (PCAN_SNR_BITS - PCAN_OUTPUT_BITS))) - (1 << PCAN_OUTPUT_BITS);
}

function log2FractionPart(x, log2x) {
  let frac = x - (1 << log2x);
  if (log2x < LOG_SCALE_LOG2) frac <<= LOG_SCALE_LOG2 - log2x;
  else frac >>>= log2x - LOG_SCALE_LOG2;

  const baseSeg = frac >>> (LOG_SCALE_LOG2 - LOG_SEGMENTS_LOG2);
  const segUnit = (1 << LOG_SCALE_LOG2) >>> LOG_SEGMENTS_LOG2;
  const c0 = LOG_LUT[baseSeg];
  const c1 = LOG_LUT[baseSeg + 1];
  const segBase = segUnit * baseSeg;
  const relPos = Math.floor(((c1 - c0) * (frac - segBase)) / (1 << LOG_SCALE_LOG2));
  return frac + c0 + relPos;
}

// Banker's rounding (round half to even) — matches numpy's np.round.
// JS's Math.round rounds half-up, which is off by 1 at x.5 values.
export function roundBankers(x) {
  const r = Math.round(x);
  // If x is exactly half-integer, Math.round returned x+0.5. Adjust
  // down by 1 when the result is odd (round to even instead).
  const frac = x - Math.floor(x);
  if (frac === 0.5 && (r & 1) === 1) return r - 1;
  // For negative halves, Math.round(-0.5) = 0 (half away from zero toward +inf).
  // numpy rounds -0.5 → 0 too? Actually numpy rounds to even, so -0.5 → 0.
  // Same for -1.5 → -2. Let me handle both cases:
  if (frac === -0.5 && (r & 1) === 1) return r - 1; // unreachable (frac always ≥ 0)
  return r;
}

function logScale(x) {
  const integer = mostSignificantBit32(x >>> 0) - 1;
  const fraction = log2FractionPart(x >>> 0, integer);
  const log2 = (integer << LOG_SCALE_LOG2) + fraction;
  const round = LOG_SCALE / 2;
  const loge = Math.floor(((LOG_COEFF * log2) + round) / (1 << LOG_SCALE_LOG2));
  return Math.floor(((loge << 6) + round) / (1 << LOG_SCALE_LOG2));
}
