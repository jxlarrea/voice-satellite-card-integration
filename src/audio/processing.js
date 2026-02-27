/**
 * Voice Satellite Card  -  Audio Processing
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
  const workletCode =
    'class VoiceSatelliteProcessor extends AudioWorkletProcessor {' +
    'constructor() { super(); this.buffer = []; }' +
    'process(inputs, outputs, parameters) {' +
    'var input = inputs[0];' +
    'if (input && input[0]) {' +
    'var channelData = new Float32Array(input[0]);' +
    'this.port.postMessage(channelData);' +
    '}' +
    'return true;' +
    '}' +
    '}' +
    'registerProcessor("voice-satellite-processor", VoiceSatelliteProcessor);';

  const blob = new Blob([workletCode], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await mgr.audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  mgr.workletNode = new AudioWorkletNode(mgr.audioContext, 'voice-satellite-processor');
  mgr.workletNode.port.onmessage = (e) => {
    mgr.audioBuffer.push(e.data);
  };
  sourceNode.connect(mgr.workletNode);
  // Connect through a silent gain node  -  keeps the graph alive for processing
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
 * @param {Float32Array} inputSamples
 * @param {number} fromSampleRate
 * @param {number} toSampleRate
 * @returns {Float32Array}
 */
function resample(inputSamples, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) return inputSamples;
  const ratio = fromSampleRate / toSampleRate;
  const outputLength = Math.round(inputSamples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, inputSamples.length - 1);
    const frac = srcIndex - low;
    output[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
  }
  return output;
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
