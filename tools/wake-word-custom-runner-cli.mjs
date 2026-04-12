import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const modelsBase = path.join(cwd, 'custom_components', 'voice_satellite', 'models');

globalThis.__VS_MODELS_BASE = '/voice_satellite/models';
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  const filePath = path.join(modelsBase, name);
  try {
    const data = await fs.readFile(filePath);
    return new Response(data, { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
};

const moduleUrl = pathToFileURL(path.join(cwd, 'src', 'wake-word', 'custom-model-runner.js')).href;
const {
  CustomWakeWordModelRunner,
  loadCustomWakeWordModel,
} = await import(moduleUrl);

const inputText = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

const request = JSON.parse(inputText);
const compiled = await loadCustomWakeWordModel(request.modelName);
const runner = new CustomWakeWordModelRunner(compiled);

try {
  const inputTensor = runner.getInputs()[0];
  const input = inputTensor.data();
  inputTensor.delete();

  const outputTensor = runner.getOutputs()[0];
  const output = outputTensor.data();
  outputTensor.delete();

  const results = [];
  for (const frame of request.sequence) {
    input.set(frame);
    const ok = runner.infer();
    if (!ok) {
      throw new Error(`infer() failed for ${request.modelName}`);
    }
    results.push(output[0]);
  }

  process.stdout.write(JSON.stringify({
    modelName: request.modelName,
    inputLength: input.length,
    outputs: results,
  }));
} finally {
  try { runner.cleanUp(); } catch (_) {}
}
