/**
 * Audio Processing
 *
 * AudioWorklet/ScriptProcessor setup, resampling, and buffer management.
 */

import { sendBinaryAudio } from './comms.js';

/**
 * Set up AudioWorklet capture.
 * @param {import('./index.js').AudioManager} mgr
 * @param {MediaStreamAudioSourceNode} sourceNode
 */
export async function setupAudioWorklet(mgr, sourceNode) {
  // Batch 10 render quanta (10 * 128 = 1280 samples) before posting.
  // This reduces postMessage structured-clone overhead from 125/s to 12.5/s
  // at 16 kHz, and produces 5120-byte ArrayBuffers that V8 tracks as external
  // memory — preventing native backing-store buildup on low-RAM devices.
  const BATCH_QUANTA = 10;
  const workletCode =
    'var B=' + BATCH_QUANTA + ';' +
    'class VoiceSatelliteProcessor extends AudioWorkletProcessor {' +
    'constructor(){super();this._buf=null;this._pos=0;}' +
    'process(inputs){' +
    'var input=inputs[0];' +
    'if(input&&input[0]){' +
    'var ch=input[0];' +
    'var len=ch.length;' +
    'if(!this._buf)this._buf=new Float32Array(len*B);' +
    'this._buf.set(ch,this._pos);' +
    'this._pos+=len;' +
    'if(this._pos>=this._buf.length){' +
    'this.port.postMessage(this._buf);' +
    'this._pos=0;' +
    '}' +
    '}' +
    'return true;' +
    '}' +
    '}' +
    'registerProcessor("voice-satellite-processor",VoiceSatelliteProcessor);';

  const blob = new Blob([workletCode], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await mgr.audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  mgr.workletNode = new AudioWorkletNode(mgr.audioContext, 'voice-satellite-processor');
  mgr.workletNode.port.onmessage = (e) => {
    // Only buffer audio when actively sending to the pipeline — otherwise
    // the array grows unbounded during on-device wake word detection
    // (no sendInterval to drain it).
    if (mgr._sendInterval) {
      mgr.audioBuffer.push(e.data);
    }
    // Feed on-device wake word engine if active or in stop-only mode (resampled to 16kHz)
    const wakeWord = mgr.card?.wakeWord;
    if (wakeWord?.active || wakeWord?.stopOnlyMode) {
      const samples = mgr.actualSampleRate !== 16000
        ? resample(e.data, mgr.actualSampleRate, 16000)
        : e.data;
      wakeWord.feedAudio(samples);
    }
  };
  sourceNode.connect(mgr.workletNode);
  // Connect through a silent gain node - keeps the graph alive for processing
  // without routing mic audio to speakers (which would cause feedback).
  const silentGain = mgr.audioContext.createGain();
  silentGain.gain.value = 0;
  mgr.workletNode.connect(silentGain);
  silentGain.connect(mgr.audioContext.destination);
}

/**
 * Combine buffered audio, resample, and send via WebSocket.
 * @param {import('./index.js').AudioManager} mgr
 * @param {number|null} binaryHandlerId
 */
export function sendAudioBuffer(mgr, binaryHandlerId) {
  if (binaryHandlerId === null || binaryHandlerId === undefined) return;
  if (mgr.audioBuffer.length === 0) return;

  let totalLength = 0;
  for (const chunk of mgr.audioBuffer) {
    totalLength += chunk.length;
  }
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of mgr.audioBuffer) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  mgr.audioBuffer = [];

  const resampled = mgr.actualSampleRate !== 16000
    ? resample(combined, mgr.actualSampleRate, 16000)
    : combined;

  const pcmData = floatTo16BitPCM(resampled);
  sendBinaryAudio(mgr.card, pcmData, binaryHandlerId);
}

/**
 * Linear interpolation resampler.
 * Reuses a cached output buffer when the output length matches (which is
 * the common case — worklet chunks are always the same size). The caller
 * must consume or copy the returned data before the next call.
 * @param {Float32Array} inputSamples
 * @param {number} fromSampleRate
 * @param {number} toSampleRate
 * @returns {Float32Array}
 */
let _resampleBuf = null;
let _resampleBufLen = 0;
function resample(inputSamples, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) return inputSamples;
  const ratio = fromSampleRate / toSampleRate;
  const outputLength = Math.round(inputSamples.length / ratio);
  if (outputLength !== _resampleBufLen) {
    _resampleBuf = new Float32Array(outputLength);
    _resampleBufLen = outputLength;
  }
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, inputSamples.length - 1);
    const frac = srcIndex - low;
    _resampleBuf[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
  }
  return _resampleBuf;
}

/**
 * Convert float audio samples to 16-bit PCM.
 * @param {Float32Array} float32Array
 * @returns {Int16Array}
 */
function floatTo16BitPCM(float32Array) {
  const pcmData = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcmData;
}
