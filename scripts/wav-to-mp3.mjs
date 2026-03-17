#!/usr/bin/env node
/**
 * Convert WAV chime files to MP3 using @breezystack/lamejs.
 *
 * Usage:  node scripts/wav-to-mp3.mjs
 * Input:  scripts/chimes/*.wav
 * Output: custom_components/voice_satellite/sounds/*.mp3
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Mp3Encoder } from '@breezystack/lamejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(__dirname, 'chimes');
const OUTPUT_DIR = path.join(__dirname, '..', 'custom_components', 'voice_satellite', 'sounds');

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  const sampleRate = buf.readUInt32LE(24);
  const numChannels = buf.readUInt16LE(22);

  // Find data chunk
  let offset = 12;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      const dataStart = offset + 8;
      const samples = new Int16Array(buf.buffer, buf.byteOffset + dataStart, size / 2);
      return { sampleRate, numChannels, samples };
    }
    offset += 8 + size;
  }
  throw new Error('No data chunk found');
}

function encodeToMp3(wav) {
  const mp3encoder = new Mp3Encoder(1, wav.sampleRate, 128);
  const blockSize = 1152;
  const mp3Data = [];

  for (let i = 0; i < wav.samples.length; i += blockSize) {
    const chunk = wav.samples.subarray(i, i + blockSize);
    const mp3buf = mp3encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) mp3Data.push(Buffer.from(mp3buf));
  }

  const end = mp3encoder.flush();
  if (end.length > 0) mp3Data.push(Buffer.from(end));

  return Buffer.concat(mp3Data);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const wavFiles = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.wav'));

for (const file of wavFiles) {
  const wav = readWav(path.join(INPUT_DIR, file));
  const mp3 = encodeToMp3(wav);
  const outName = file.replace('.wav', '.mp3');
  const outPath = path.join(OUTPUT_DIR, outName);
  fs.writeFileSync(outPath, mp3);

  const wavSize = fs.statSync(path.join(INPUT_DIR, file)).size;
  console.log(`  ${file} (${wavSize} B) → ${outName} (${mp3.length} B)  ${Math.round((1 - mp3.length / wavSize) * 100)}% smaller`);
}

console.log(`\nMP3 files written to ${OUTPUT_DIR}`);
