const SAMPLE_RATE = 16000;
const WINDOW_SIZE_MS = 30;
const STEP_SIZE_MS = 10;
const FEATURE_SIZE = 40;
const FILTERBANK_LOW_HZ = 125.0;
const FILTERBANK_HIGH_HZ = 7500.0;
const NOISE_REDUCTION_BITS = 14;
const NOISE_REDUCTION_SMOOTHING_BITS = 10;
const NOISE_REDUCTION_EVEN_SMOOTHING = Math.round(0.025 * (1 << NOISE_REDUCTION_BITS));
const NOISE_REDUCTION_ODD_SMOOTHING = Math.round(0.06 * (1 << NOISE_REDUCTION_BITS));
const NOISE_REDUCTION_MIN_SIGNAL = Math.round(0.05 * (1 << NOISE_REDUCTION_BITS));
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
    this._inputScale = 0.10196078568696976;
    this._inputZeroPoint = -128;
    this._featurePool = [];
    this._featurePoolMax = 32;

    this._input = new Int16Array(WINDOW_SIZE);
    this._inputUsed = 0;
    this._windowed = new Int16Array(WINDOW_SIZE);
    this._fftReal = new Float64Array(FFT_SIZE);
    this._fftImag = new Float64Array(FFT_SIZE);
    this._filterbankWork = new Float64Array(FEATURE_SIZE + 1);
    this._noiseEstimate = new Float64Array(FEATURE_SIZE);
  }

  setQuantization(scale, zeroPoint) {
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
      this._inputScale = scale;
    }
    if (typeof zeroPoint === 'number' && Number.isFinite(zeroPoint)) {
      this._inputZeroPoint = zeroPoint;
    }
  }

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
    this._fftReal.fill(0);
    this._fftImag.fill(0);
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

    for (let i = 0; i < WINDOW_SIZE; i++) {
      this._fftReal[i] = toInt16(this._windowed[i] << inputShift);
      this._fftImag[i] = 0;
    }
    for (let i = WINDOW_SIZE; i < FFT_SIZE; i++) {
      this._fftReal[i] = 0;
      this._fftImag[i] = 0;
    }

    runRadix2Fft(this._fftReal, this._fftImag, fftPlan);

    for (let i = 0; i < FFT_SIZE; i++) {
      this._fftReal[i] /= FFT_SIZE;
      this._fftImag[i] /= FFT_SIZE;
    }

    let weightAccumulator = 0;
    let unweightAccumulator = 0;

    for (let channel = 0; channel <= FEATURE_SIZE; channel++) {
      const freqStart = filterbank.channelFrequencyStarts[channel];
      const weightStart = filterbank.channelWeightStarts[channel];
      const width = filterbank.channelWidths[channel];

      for (let j = 0; j < width; j++) {
        const bin = freqStart + j;
        const real = this._fftReal[bin];
        const imag = this._fftImag[bin];
        const magnitude = real * real + imag * imag;
        weightAccumulator += filterbank.weights[weightStart + j] * magnitude;
        unweightAccumulator += filterbank.unweights[weightStart + j] * magnitude;
      }

      this._filterbankWork[channel] = weightAccumulator;
      weightAccumulator = unweightAccumulator;
      unweightAccumulator = 0;
    }

    const signal = new Float64Array(FEATURE_SIZE);
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const sqrtValue = Math.round(Math.sqrt(this._filterbankWork[i + 1]));
      signal[i] = Math.floor(sqrtValue / (1 << inputShift));
    }

    this._applyNoiseReduction(signal);
    this._applyPcan(signal, gainLut);

    const feature = this._featurePool.pop() || new Int8Array(FEATURE_SIZE);
    const invScale = 1.0 / this._inputScale;
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const corrected = signal[i] * (1 << INPUT_CORRECTION_BITS);
      const logged = corrected > 1 ? logScale(corrected) : 0;
      const floatValue = logged * FLOAT32_SCALE;
      let quantized = Math.round(floatValue * invScale + this._inputZeroPoint);
      if (quantized < -128) quantized = -128;
      else if (quantized > 127) quantized = 127;
      feature[i] = quantized;
    }

    return feature;
  }

  _applyNoiseReduction(signal) {
    for (let i = 0; i < FEATURE_SIZE; i++) {
      const smoothing = (i & 1) === 0
        ? NOISE_REDUCTION_EVEN_SMOOTHING
        : NOISE_REDUCTION_ODD_SMOOTHING;
      const oneMinus = (1 << NOISE_REDUCTION_BITS) - smoothing;
      const signalScaledUp = signal[i] * (1 << NOISE_REDUCTION_SMOOTHING_BITS);

      let estimate = Math.floor(
        ((signalScaledUp * smoothing) + (this._noiseEstimate[i] * oneMinus))
        / (1 << NOISE_REDUCTION_BITS),
      );
      this._noiseEstimate[i] = estimate;

      if (estimate > signalScaledUp) estimate = signalScaledUp;

      const floor = Math.floor(
        (signal[i] * NOISE_REDUCTION_MIN_SIGNAL) / (1 << NOISE_REDUCTION_BITS),
      );
      const subtracted = Math.floor(
        (signalScaledUp - estimate) / (1 << NOISE_REDUCTION_SMOOTHING_BITS),
      );
      signal[i] = subtracted > floor ? subtracted : floor;
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
  const coefficients = new Int16Array(WINDOW_SIZE);
  const arg = (Math.PI * 2.0) / WINDOW_SIZE;
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const floatValue = 0.5 - (0.5 * Math.cos(arg * (i + 0.5)));
    coefficients[i] = Math.floor(floatValue * (1 << FRONTEND_WINDOW_BITS) + 0.5);
  }
  return coefficients;
}

function buildFilterbankState() {
  const numChannelsPlusOne = FEATURE_SIZE + 1;
  const indexAlignment = 4 / Int16Array.BYTES_PER_ELEMENT;
  const centerMelFreqs = new Float64Array(numChannelsPlusOne);
  const actualChannelStarts = new Int16Array(numChannelsPlusOne);
  const actualChannelWidths = new Int16Array(numChannelsPlusOne);
  const channelFrequencyStarts = new Int16Array(numChannelsPlusOne);
  const channelWeightStarts = new Int16Array(numChannelsPlusOne);
  const channelWidths = new Int16Array(numChannelsPlusOne);

  const melLow = freqToMel(FILTERBANK_LOW_HZ);
  const melHigh = freqToMel(FILTERBANK_HIGH_HZ);
  const melSpacing = (melHigh - melLow) / FEATURE_SIZE;

  for (let i = 0; i < numChannelsPlusOne; i++) {
    centerMelFreqs[i] = melLow + (melSpacing * (i + 1));
  }

  const hzPerSbin = (0.5 * SAMPLE_RATE) / (SPECTRUM_SIZE - 1);
  const startIndex = Math.trunc(1.5 + FILTERBANK_LOW_HZ / hzPerSbin);
  let channelFreqIndexStart = startIndex;
  let weightIndexStart = 0;
  let needsZeros = false;

  for (let chan = 0; chan < numChannelsPlusOne; chan++) {
    let freqIndex = channelFreqIndexStart;
    while (freqToMel(freqIndex * hzPerSbin) <= centerMelFreqs[chan]) freqIndex++;

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
      const weight = (centerMelFreqs[chan] - freqToMel(frequency * hzPerSbin))
        / (centerMelFreqs[chan] - denom);
      const weightIndex = weightStart + frequencyOffset + j;
      weights[weightIndex] = Math.floor(weight * (1 << FRONTEND_WINDOW_BITS) + 0.5);
      unweights[weightIndex] = Math.floor((1.0 - weight) * (1 << FRONTEND_WINDOW_BITS) + 0.5);
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

function buildFftPlan(size) {
  const bitReverse = new Uint16Array(size);
  const bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit++) {
      reversed = (reversed << 1) | ((i >> bit) & 1);
    }
    bitReverse[i] = reversed;
  }

  const stages = [];
  for (let stageSize = 2; stageSize <= size; stageSize <<= 1) {
    const half = stageSize >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    const step = (Math.PI * 2) / stageSize;
    for (let i = 0; i < half; i++) {
      cos[i] = Math.cos(step * i);
      sin[i] = -Math.sin(step * i);
    }
    stages.push({ size: stageSize, half, cos, sin });
  }

  return { bitReverse, stages };
}

function buildGainLut() {
  const lut = new Int16Array((4 * WIDE_DYNAMIC_BITS) + 4);
  const base = 6;
  const inputBits = NOISE_REDUCTION_SMOOTHING_BITS - INPUT_CORRECTION_BITS;

  lut[base + 0] = pcanGainLookup(inputBits, 0);
  lut[base + 1] = pcanGainLookup(inputBits, 1);

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
    const offset = base + (4 * interval);
    lut[offset + 0] = y0;
    lut[offset + 1] = a1;
    lut[offset + 2] = a2;
  }

  return { lut, base };
}

function runRadix2Fft(real, imag, plan) {
  const { bitReverse, stages } = plan;

  for (let i = 0; i < real.length; i++) {
    const j = bitReverse[i];
    if (j <= i) continue;
    let tmp = real[i];
    real[i] = real[j];
    real[j] = tmp;
    tmp = imag[i];
    imag[i] = imag[j];
    imag[j] = tmp;
  }

  for (const stage of stages) {
    const { size, half, cos, sin } = stage;
    for (let start = 0; start < real.length; start += size) {
      for (let i = 0; i < half; i++) {
        const even = start + i;
        const odd = even + half;
        const wr = cos[i];
        const wi = sin[i];
        const tr = (wr * real[odd]) - (wi * imag[odd]);
        const ti = (wr * imag[odd]) + (wi * real[odd]);

        real[odd] = real[even] - tr;
        imag[odd] = imag[even] - ti;
        real[even] += tr;
        imag[even] += ti;
      }
    }
  }
}

function freqToMel(freq) {
  return 1127.0 * Math.log1p(freq / 700.0);
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
  const xAsFloat = x / (1 << inputBits);
  const gain = (1 << PCAN_GAIN_BITS) * Math.pow(xAsFloat + PCAN_OFFSET, -PCAN_STRENGTH);
  if (gain > 0x7fff) return 0x7fff;
  return Math.floor(gain + 0.5);
}

function wideDynamicFunction(x, state) {
  const { lut, base } = state;
  if (x <= 2) return lut[base + x];

  const interval = mostSignificantBit32(x >>> 0);
  const offset = base + (4 * interval) - 6;
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

function logScale(x) {
  const integer = mostSignificantBit32(x >>> 0) - 1;
  const fraction = log2FractionPart(x >>> 0, integer);
  const log2 = (integer << LOG_SCALE_LOG2) + fraction;
  const round = LOG_SCALE / 2;
  const loge = Math.floor(((LOG_COEFF * log2) + round) / (1 << LOG_SCALE_LOG2));
  return Math.floor(((loge << 6) + round) / (1 << LOG_SCALE_LOG2));
}
