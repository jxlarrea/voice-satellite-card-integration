#!/usr/bin/env node
/**
 * Convert openWakeWord classifier TFLite models to compact ONNX models.
 *
 * This intentionally targets the classifier graphs used by openWakeWord:
 * dense-only classifiers, dense + layer-norm classifiers, and the
 * hey_jarvis two-stage verifier graph. The shared OWW frontend models
 * (melspectrogram / embedding_model) are not converted here.
 *
 * Usage:
 *   node scripts/convert-oww-tflite-to-onnx.mjs
 *   node scripts/convert-oww-tflite-to-onnx.mjs --out-dir tmp/ported_onnx
 *   node scripts/convert-oww-tflite-to-onnx.mjs path/to/model.tflite path/to/model.onnx
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileOwwModel } from '../src/wake-word/oww/model-runner.js';
import { compileOwwOnnxModel } from '../src/wake-word/oww/onnx-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MODELS_DIR = path.join(ROOT, 'custom_components/voice_satellite/models/openwakeword');
const SKIP_SHARED = new Set(['melspectrogram', 'embedding_model']);

const TT_FLOAT32 = 0;
const TT_INT32 = 2;
const TT_BOOL = 6;

const ONNX_FLOAT = 1;
const ONNX_INT64 = 7;
const ONNX_BOOL = 9;

const ATTR_INT = 2;
const ATTR_TENSOR = 4;
const ATTR_GRAPH = 5;
const ATTR_INTS = 7;

const ACT_NONE = 0;
const ACT_RELU = 1;
const FC_FUSED_ACTIVATION = 0;
const ARITH_FUSED_ACTIVATION = 0;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobs = findJobs(args);
  if (!jobs.length) {
    console.log('No classifier .tflite models found to convert.');
    return;
  }

  for (const job of jobs) {
    const inputBuffer = readArrayBuffer(job.input);
    const tflite = compileOwwModel(inputBuffer);
    const onnx = convertClassifier(job.name, tflite);
    fs.mkdirSync(path.dirname(job.output), { recursive: true });
    fs.writeFileSync(job.output, onnx);

    if (args.validate) validateParity(job.name, inputBuffer, onnx);
    console.log(`Converted ${path.relative(ROOT, job.input)} -> ${path.relative(ROOT, job.output)}`);
  }
}

function parseArgs(argv) {
  const out = {
    input: null,
    output: null,
    outDir: null,
    validate: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--no-validate') {
      out.validate = false;
      continue;
    }
    if (arg === '--out-dir') {
      out.outDir = path.resolve(argv[++i]);
      continue;
    }
    if (!out.input) out.input = path.resolve(arg);
    else if (!out.output) out.output = path.resolve(arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  return out;
}

function printUsage() {
  console.log(`Usage:
  node scripts/convert-oww-tflite-to-onnx.mjs
  node scripts/convert-oww-tflite-to-onnx.mjs --out-dir tmp/ported_onnx
  node scripts/convert-oww-tflite-to-onnx.mjs path/to/model.tflite path/to/model.onnx

Options:
  --out-dir <dir>     Write converted models to this directory.
  --no-validate       Skip ONNX-vs-TFLite parity validation.
`);
}

function findJobs(args) {
  if (args.input && fs.statSync(args.input).isFile()) {
    const name = path.basename(args.input, '.tflite');
    if (SKIP_SHARED.has(name)) {
      throw new Error(`${name}.tflite is a shared OWW frontend model, not a classifier.`);
    }
    return [{
      name,
      input: args.input,
      output: args.output || path.join(args.outDir || path.dirname(args.input), `${name}.onnx`),
    }];
  }

  const dir = args.input || DEFAULT_MODELS_DIR;
  const outDir = args.outDir || dir;
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.tflite'))
    .map((file) => path.basename(file, '.tflite'))
    .filter((name) => !SKIP_SHARED.has(name))
    .sort()
    .map((name) => ({
      name,
      input: path.join(dir, `${name}.tflite`),
      output: path.join(outDir, `${name}.onnx`),
    }));
}

function convertClassifier(name, model) {
  const graph = new OnnxGraph(`${name}_from_tflite`);
  const primary = model.subgraphs[model.primaryIndex];
  const ifOp = primary.ops.find((op) => op.opName === 'IF');

  graph.input('input', ONNX_FLOAT, [1, 16, 96]);

  if (ifOp) buildIfClassifier(graph, model, primary, ifOp);
  else buildSingleGraphClassifier(graph, primary);

  graph.output('output', ONNX_FLOAT, [1, 1]);
  return encodeModel(graph);
}

function buildSingleGraphClassifier(graph, sg) {
  const fcOps = sg.ops.filter((op) => op.opName === 'FULLY_CONNECTED');
  if (fcOps.length !== 3) {
    throw new Error(`Expected 3 FULLY_CONNECTED ops, found ${fcOps.length}`);
  }

  let x = addFlatten(graph, sg, 'input');

  if (!sg.ops.some((op) => op.opName === 'MEAN')) {
    x = addDense(graph, sg, x, fcOps[0], 'fc0');
    x = addDense(graph, sg, x, fcOps[1], 'fc1');
    x = addDense(graph, sg, x, fcOps[2], 'fc2');
    graph.node('Sigmoid', [x], ['output']);
    return;
  }

  x = addDense(graph, sg, x, fcOps[0], 'fc0', { forceNoRelu: true });
  x = addLayerNormRelu(graph, sg, x, layerNormBetween(sg, fcOps[0], fcOps[1]), 'ln0');
  x = addDense(graph, sg, x, fcOps[1], 'fc1', { forceNoRelu: true });
  x = addLayerNormRelu(graph, sg, x, layerNormBetween(sg, fcOps[1], fcOps[2]), 'ln1');
  x = addDense(graph, sg, x, fcOps[2], 'fc2', { forceNoRelu: true });
  graph.node('Sigmoid', [x], ['output']);
}

function buildIfClassifier(graph, model, sg, ifOp) {
  const fcOps = sg.ops.filter((op) => op.opName === 'FULLY_CONNECTED');
  if (fcOps.length !== 3) {
    throw new Error(`Expected 3 primary FULLY_CONNECTED ops for IF classifier, found ${fcOps.length}`);
  }

  let x = addFlatten(graph, sg, 'input');
  x = addDense(graph, sg, x, fcOps[0], 'primary_fc0', { forceNoRelu: true });
  x = addLayerNormRelu(graph, sg, x, layerNormBetween(sg, fcOps[0], fcOps[1]), 'primary_ln0');
  x = addDense(graph, sg, x, fcOps[1], 'primary_fc1', { forceNoRelu: true });
  x = addLayerNormRelu(graph, sg, x, layerNormBetween(sg, fcOps[1], fcOps[2]), 'primary_ln1');
  x = addDense(graph, sg, x, fcOps[2], 'primary_fc2', { forceNoRelu: true });
  const primaryScore = graph.node('Sigmoid', [x], [graph.uid('primary_score')]);

  const greater = sg.ops.find((op) => op.opName === 'GREATER_EQUAL');
  if (!greater) throw new Error('IF classifier missing GREATER_EQUAL threshold op');
  const threshold = graph.constFromTensor(sg, greater.inputs[1]);
  const ge = graph.node('GreaterOrEqual', [primaryScore, threshold], [graph.uid('primary_ge')]);
  const scalarShape = graph.const('scalar_shape', ONNX_INT64, [0], new BigInt64Array(0));
  const cond = graph.node('Reshape', [ge, scalarShape], [graph.uid('if_cond')]);

  const verifierSg = model.subgraphs.find((candidate, index) => (
    index !== model.primaryIndex && candidate.ops.some((op) => op.opName === 'FULLY_CONNECTED')
  ));
  if (!verifierSg) throw new Error('IF classifier has no verifier subgraph');

  const thenBranch = buildVerifierBranch(graph, sg, verifierSg, ifOp);
  const elseBranch = new OnnxGraph('else_branch');
  elseBranch.output('else_output', ONNX_FLOAT, [1, 1]);
  elseBranch.node('Identity', [primaryScore], ['else_output']);

  graph.node('If', [cond], ['output'], {
    then_branch: thenBranch,
    else_branch: elseBranch,
  });
}

function buildVerifierBranch(parentGraph, parentSg, verifierSg, ifOp) {
  const graph = new OnnxGraph('then_branch');
  graph.output('then_output', ONNX_FLOAT, [1, 1]);

  const passed = ifOp.inputs.slice(1);
  const childToParent = new Map();
  verifierSg.inputIds.forEach((childId, index) => childToParent.set(childId, passed[index]));

  const shape = parentGraph.const('verifier_shape', ONNX_INT64, [2], BigInt64Array.from([1n, 1536n]));
  let x = graph.node('Reshape', ['input', shape], [graph.uid('verifier_flat')]);
  const fcOps = verifierSg.ops.filter((op) => op.opName === 'FULLY_CONNECTED');
  if (fcOps.length !== 3) throw new Error(`Verifier expected 3 FULLY_CONNECTED ops, found ${fcOps.length}`);

  const isMappedConst = (id) => id >= 0 && (verifierSg.tensors[id]?.constant || childToParent.has(id));
  x = addMappedDense(parentGraph, graph, parentSg, verifierSg, childToParent, x, fcOps[0], 'verifier_fc0');
  x = addMappedLayerNormRelu(parentGraph, graph, parentSg, verifierSg, childToParent, x, layerNormBetween(verifierSg, fcOps[0], fcOps[1], isMappedConst), 'verifier_ln0');
  x = addMappedDense(parentGraph, graph, parentSg, verifierSg, childToParent, x, fcOps[1], 'verifier_fc1');
  x = addMappedLayerNormRelu(parentGraph, graph, parentSg, verifierSg, childToParent, x, layerNormBetween(verifierSg, fcOps[1], fcOps[2], isMappedConst), 'verifier_ln1');
  x = addMappedDense(parentGraph, graph, parentSg, verifierSg, childToParent, x, fcOps[2], 'verifier_fc2');
  graph.node('Sigmoid', [x], ['then_output']);
  return graph;
}

function addFlatten(graph, sg, inputName) {
  const reshape = sg.ops.find((op) => op.opName === 'RESHAPE' && op.inputs[0] === sg.inputIds[0]);
  const shapeName = reshape?.inputs[1] >= 0
    ? graph.constFromTensor(sg, reshape.inputs[1], { int64: true })
    : graph.const('flat_shape', ONNX_INT64, [2], BigInt64Array.from([1n, 1536n]));
  return graph.node('Reshape', [inputName, shapeName], [graph.uid('flat')]);
}

function addDense(graph, sg, x, fcOp, prefix, opts = {}) {
  const weights = graph.constFromTensor(sg, fcOp.inputs[1]);
  const inputs = [x, weights];
  if (fcOp.inputs[2] >= 0) inputs.push(graph.constFromTensor(sg, fcOp.inputs[2]));
  let y = graph.node('Gemm', inputs, [graph.uid(prefix)], { transB: 1 });
  if (!opts.forceNoRelu && fusedActivation(fcOp) === ACT_RELU) {
    y = graph.node('Relu', [y], [graph.uid(`${prefix}_relu`)]);
  }
  return y;
}

function addMappedDense(parentGraph, graph, parentSg, sg, childToParent, x, fcOp, prefix) {
  const weights = mappedConstName(parentGraph, parentSg, sg, childToParent, fcOp.inputs[1]);
  const inputs = [x, weights];
  const bias = mappedBiasForDense(sg, childToParent, fcOp);
  if (bias >= 0) inputs.push(mappedConstName(parentGraph, parentSg, sg, childToParent, bias));
  return graph.node('Gemm', inputs, [graph.uid(prefix)], { transB: 1 });
}

function addLayerNormRelu(graph, sg, x, ln, prefix) {
  return addLayerNormReluWithNames(
    graph,
    x,
    graph.constFromTensor(sg, ln.gamma),
    graph.constFromTensor(sg, ln.beta),
    graph.constFromTensor(sg, ln.eps),
    prefix,
  );
}

function addMappedLayerNormRelu(parentGraph, graph, parentSg, sg, childToParent, x, ln, prefix) {
  return addLayerNormReluWithNames(
    graph,
    x,
    mappedConstName(parentGraph, parentSg, sg, childToParent, ln.gamma),
    mappedConstName(parentGraph, parentSg, sg, childToParent, ln.beta),
    mappedConstName(parentGraph, parentSg, sg, childToParent, ln.eps),
    prefix,
  );
}

function addLayerNormReluWithNames(graph, x, gamma, beta, eps, prefix) {
  const mean = graph.node('ReduceMean', [x], [graph.uid(`${prefix}_mean`)], { axes: [-1], keepdims: 1 });
  const centered = graph.node('Sub', [x, mean], [graph.uid(`${prefix}_center`)]);
  const sq = graph.node('Mul', [centered, centered], [graph.uid(`${prefix}_sq`)]);
  const variance = graph.node('ReduceMean', [sq], [graph.uid(`${prefix}_var`)], { axes: [-1], keepdims: 1 });
  const variancePlusEps = graph.node('Add', [variance, eps], [graph.uid(`${prefix}_eps`)]);
  const sqrt = graph.node('Sqrt', [variancePlusEps], [graph.uid(`${prefix}_sqrt`)]);
  const norm = graph.node('Div', [centered, sqrt], [graph.uid(`${prefix}_norm`)]);
  const scaled = graph.node('Mul', [norm, gamma], [graph.uid(`${prefix}_scale`)]);
  const shifted = graph.node('Add', [scaled, beta], [graph.uid(`${prefix}_shift`)]);
  return graph.node('Relu', [shifted], [graph.uid(`${prefix}_relu`)]);
}

function layerNormBetween(sg, fcOp, nextFcOp, isConstant = (id) => id >= 0 && sg.tensors[id]?.constant) {
  const start = sg.ops.indexOf(fcOp) + 1;
  const end = sg.ops.indexOf(nextFcOp);
  if (start <= 0 || end <= start) throw new Error('Unable to locate layer norm segment');

  const targetInput = nextFcOp.inputs[0];
  const finalAdd = findLastOp(sg.ops, start, end, (op) => op.opName === 'ADD' && op.outputs[0] === targetInput);
  if (!finalAdd) throw new Error(`Unable to locate layer norm final ADD before tensor ${targetInput}`);

  const beta = constantInput(sg, finalAdd, isConstant);
  const scaleInput = finalAdd.inputs.find((id) => id !== beta);
  const scaleMul = findLastOp(sg.ops, start, end, (op) => op.opName === 'MUL' && op.outputs[0] === scaleInput);
  if (!scaleMul) throw new Error('Unable to locate layer norm scale MUL');
  const gamma = constantInput(sg, scaleMul, isConstant);

  const rsqrt = findLastOp(sg.ops, start, end, (op) => op.opName === 'RSQRT');
  if (!rsqrt) throw new Error('Unable to locate layer norm RSQRT');
  const epsAdd = findLastOp(sg.ops, start, sg.ops.indexOf(rsqrt), (op) => op.opName === 'ADD' && op.outputs[0] === rsqrt.inputs[0]);
  if (!epsAdd) throw new Error('Unable to locate layer norm epsilon ADD');
  const eps = constantInput(sg, epsAdd, isConstant);

  return { gamma, beta, eps };
}

function findLastOp(ops, start, end, pred) {
  for (let i = end - 1; i >= start; i--) {
    if (pred(ops[i], i)) return ops[i];
  }
  return null;
}

function constantInput(sg, op, isConstant) {
  const id = op.inputs.find((input) => isConstant(input));
  if (id === undefined) throw new Error(`Op ${op.opName} has no constant input`);
  return id;
}

function mappedConstName(parentGraph, parentSg, childSg, childToParent, childId) {
  const parentId = childToParent.get(childId);
  if (parentId !== undefined) return parentGraph.constFromTensor(parentSg, parentId);
  if (childId >= 0 && childSg.tensors[childId]?.constant) {
    return parentGraph.constFromTensor(childSg, childId, { name: `then_t${childId}` });
  }
  throw new Error(`Unable to map verifier constant ${childId}`);
}

function mappedBiasForDense(sg, childToParent, fcOp) {
  void childToParent;
  if (fcOp.inputs[2] >= 0) return fcOp.inputs[2];

  const fcOut = fcOp.outputs[0];
  const add = sg.ops.find((op) => op.opName === 'ADD' && op.inputs.includes(fcOut));
  if (!add) return -1;
  const biasChild = add.inputs.find((id) => id !== fcOut);
  return biasChild;
}

function fusedActivation(op) {
  return readOptionalU8(op.fb, op.optionsOff, op.opName === 'FULLY_CONNECTED' ? FC_FUSED_ACTIVATION : ARITH_FUSED_ACTIVATION, ACT_NONE);
}

function readOptionalU8(fb, tableOff, fieldId, fallback) {
  if (!tableOff || !fb) return fallback;
  const field = fb.field(tableOff, fieldId);
  return field ? fb.u8(field) : fallback;
}

function validateParity(name, tfliteBuffer, onnxBuffer) {
  const tflite = compileOwwModel(tfliteBuffer);
  const onnx = compileOwwOnnxModel(onnxBuffer, { inputShape: [1, 16, 96] });
  const cases = [
    new Float32Array(16 * 96),
    deterministicInput(1),
    deterministicInput(2),
    deterministicInput(3),
    deterministicInput(4),
    deterministicInput(5),
    deterministicInput(6),
    deterministicInput(7),
  ];

  let maxAbs = 0;
  for (const input of cases) {
    const a = onnx.invoke(input, { state: onnx.createState(), inputShape: [1, 16, 96] })[0];
    const b = tflite.invoke(input, { state: tflite.createState() })[0];
    maxAbs = Math.max(maxAbs, Math.abs(a - b));
  }

  if (maxAbs > 1e-5) {
    throw new Error(`${name}: ONNX/TFLite validation failed, maxAbs=${maxAbs}`);
  }
}

function deterministicInput(seed0) {
  const out = new Float32Array(16 * 96);
  let seed = seed0 >>> 0;
  for (let i = 0; i < out.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    out[i] = ((seed / 0x100000000) - 0.5) * 4;
  }
  return out;
}

function readArrayBuffer(file) {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

class OnnxGraph {
  constructor(name) {
    this.name = name;
    this.nodes = [];
    this.initializers = new Map();
    this.inputs = [];
    this.outputs = [];
    this._uids = new Map();
  }

  uid(prefix) {
    const n = this._uids.get(prefix) || 0;
    this._uids.set(prefix, n + 1);
    return `${prefix}_${n}`;
  }

  input(name, elemType, shape) {
    this.inputs.push({ name, elemType, shape });
  }

  output(name, elemType, shape) {
    this.outputs.push({ name, elemType, shape });
  }

  const(name, elemType, shape, data) {
    if (!this.initializers.has(name)) {
      this.initializers.set(name, { name, elemType, shape, data });
    }
    return name;
  }

  constFromTensor(sg, tensorId, opts = {}) {
    const tensor = sg.tensors[tensorId];
    if (!tensor?.constant) throw new Error(`Tensor ${tensorId} is not constant`);
  const name = opts.name || `t${tensorId}`;
    let elemType;
    let data;
    if (opts.int64 || tensor.type === TT_INT32) {
      elemType = ONNX_INT64;
      data = toBigInt64Array(tensor.constant);
    } else if (tensor.type === TT_BOOL) {
      elemType = ONNX_BOOL;
      data = tensor.constant;
    } else {
      elemType = ONNX_FLOAT;
      data = tensor.constant;
    }
    return this.const(name, elemType, tensor.shape, data);
  }

  node(opType, inputs, outputs, attrs = {}) {
    this.nodes.push({ opType, inputs, outputs, attrs });
    return outputs[0];
  }
}

function toBigInt64Array(values) {
  const out = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = BigInt(values[i]);
  return out;
}

function encodeModel(graph) {
  const model = [
    fieldVarint(1, 10),
    fieldString(2, 'voice-satellite-tflite-port'),
    fieldMessage(7, encodeGraph(graph)),
    fieldMessage(8, encodeOpset(12)),
  ];
  return Buffer.concat(model);
}

function encodeOpset(version) {
  return Buffer.concat([fieldVarint(2, version)]);
}

function encodeGraph(graph) {
  const parts = [];
  for (const node of graph.nodes) parts.push(fieldMessage(1, encodeNode(node)));
  parts.push(fieldString(2, graph.name));
  for (const init of graph.initializers.values()) parts.push(fieldMessage(5, encodeTensor(init)));
  for (const input of graph.inputs) parts.push(fieldMessage(11, encodeValueInfo(input)));
  for (const output of graph.outputs) parts.push(fieldMessage(12, encodeValueInfo(output)));
  return Buffer.concat(parts);
}

function encodeNode(node) {
  const parts = [];
  for (const input of node.inputs) parts.push(fieldString(1, input));
  for (const output of node.outputs) parts.push(fieldString(2, output));
  parts.push(fieldString(3, node.outputs[0] || node.opType));
  parts.push(fieldString(4, node.opType));
  for (const [name, value] of Object.entries(node.attrs || {})) {
    parts.push(fieldMessage(5, encodeAttribute(name, value)));
  }
  return Buffer.concat(parts);
}

function encodeAttribute(name, value) {
  const parts = [fieldString(1, name)];
  if (Number.isInteger(value)) {
    parts.push(fieldSignedVarint(3, value));
    parts.push(fieldVarint(20, ATTR_INT));
  } else if (Array.isArray(value) && value.every(Number.isInteger)) {
    for (const item of value) parts.push(fieldSignedVarint(8, item));
    parts.push(fieldVarint(20, ATTR_INTS));
  } else if (value instanceof OnnxGraph) {
    parts.push(fieldMessage(6, encodeGraph(value)));
    parts.push(fieldVarint(20, ATTR_GRAPH));
  } else if (value?.elemType) {
    parts.push(fieldMessage(5, encodeTensor(value)));
    parts.push(fieldVarint(20, ATTR_TENSOR));
  } else {
    throw new Error(`Unsupported ONNX attr ${name}`);
  }
  return Buffer.concat(parts);
}

function encodeTensor(tensor) {
  const parts = [];
  for (const dim of tensor.shape) parts.push(fieldSignedVarint(1, dim));
  parts.push(fieldVarint(2, tensor.elemType));
  parts.push(fieldString(8, tensor.name));
  parts.push(fieldBytes(9, tensorRawData(tensor)));
  return Buffer.concat(parts);
}

function tensorRawData(tensor) {
  if (tensor.elemType === ONNX_FLOAT) return typedArrayBytes(tensor.data);
  if (tensor.elemType === ONNX_BOOL) return typedArrayBytes(tensor.data);
  if (tensor.elemType === ONNX_INT64) {
    const data = tensor.data instanceof BigInt64Array ? tensor.data : toBigInt64Array(tensor.data);
    const out = Buffer.alloc(data.length * 8);
    for (let i = 0; i < data.length; i++) out.writeBigInt64LE(data[i], i * 8);
    return out;
  }
  throw new Error(`Unsupported ONNX tensor type ${tensor.elemType}`);
}

function typedArrayBytes(data) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function encodeValueInfo(info) {
  return Buffer.concat([
    fieldString(1, info.name),
    fieldMessage(2, encodeType(info.elemType, info.shape)),
  ]);
}

function encodeType(elemType, shape) {
  const tensorType = Buffer.concat([
    fieldVarint(1, elemType),
    fieldMessage(2, encodeShape(shape)),
  ]);
  return fieldMessage(1, tensorType);
}

function encodeShape(shape) {
  return Buffer.concat(shape.map((dim) => fieldMessage(1, fieldSignedVarint(1, dim))));
}

function fieldVarint(field, value) {
  return Buffer.concat([tag(field, 0), varint(BigInt(value))]);
}

function fieldSignedVarint(field, value) {
  return Buffer.concat([tag(field, 0), varint(BigInt.asUintN(64, BigInt(value)))]);
}

function fieldString(field, value) {
  return fieldBytes(field, Buffer.from(value, 'utf8'));
}

function fieldBytes(field, value) {
  return Buffer.concat([tag(field, 2), varint(BigInt(value.length)), value]);
}

function fieldMessage(field, value) {
  return fieldBytes(field, value);
}

function tag(field, wire) {
  return varint(BigInt((field << 3) | wire));
}

function varint(value) {
  const bytes = [];
  let v = value;
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
