/**
 * Float32 TFLite interpreter for openWakeWord models.
 *
 * Parallel implementation to ../custom-model-runner.js, which handles only
 * int8-quantized streaming microWakeWord models.  This runner targets
 * openWakeWord's float32 models (mel spectrogram, embedding, classifiers).
 *
 * Each op is bit-compared to the TFLite reference via tmp/oww_reference.py
 * dumps before being considered done.
 *
 * Op coverage is grown incrementally - see OPS_REGISTRY below.  An
 * unknown op throws with the op name so validation catches gaps.
 */

// ─── TFLite schema field IDs ───────────────────────────────────────────
// Mirrors tensorflow/lite/schema/schema.fbs.  Same as custom-model-runner.js.
const MODEL_OPERATOR_CODES = 1;
const MODEL_SUBGRAPHS = 2;
const MODEL_BUFFERS = 4;

const OPCODE_DEPRECATED_BUILTIN = 0;
const OPCODE_VERSION = 2;
const OPCODE_BUILTIN = 3;

const SUBGRAPH_TENSORS = 0;
const SUBGRAPH_INPUTS = 1;
const SUBGRAPH_OUTPUTS = 2;
const SUBGRAPH_OPERATORS = 3;

const TENSOR_SHAPE = 0;
const TENSOR_TYPE = 1;
const TENSOR_BUFFER = 2;
const TENSOR_NAME = 3;

const OP_OPCODE_INDEX = 0;
const OP_INPUTS = 1;
const OP_OUTPUTS = 2;
const OP_BUILTIN_OPTIONS = 4;

const BUFFER_DATA = 0;

// TFLite tensor types we care about.
export const TT_FLOAT32 = 0;
export const TT_INT32 = 2;
export const TT_INT8 = 9;
export const TT_BOOL = 6;

// Builtin op codes - only what we currently implement or recognize.  The
// switch in `executeOp()` is the authoritative list; this map is just for
// readable error messages and op-name lookup during compilation.
const OP_NAME = {
  0: 'ADD',
  9: 'FULLY_CONNECTED',
  14: 'LOGISTIC',
  18: 'MUL',
  22: 'RESHAPE',
  40: 'MEAN',
  41: 'SUB',
  76: 'RSQRT',
  3: 'CONV_2D',
  4: 'DEPTHWISE_CONV_2D',
  17: 'MAX_POOL_2D',
  34: 'PAD',
  39: 'TRANSPOSE',
  43: 'SQUEEZE',
  55: 'MAXIMUM',
  57: 'MINIMUM',
  70: 'EXPAND_DIMS',
  73: 'LOG',
  82: 'REDUCE_MAX',
  98: 'LEAKY_RELU',
  118: 'IF',
  62: 'GREATER_EQUAL',
  126: 'BATCH_MATMUL',
  // Dynamic-shape ops used by openWakeWord's stop classifier.
  45: 'STRIDED_SLICE',
  77: 'SHAPE',
  81: 'REDUCE_PROD',
  83: 'PACK',
  94: 'FILL',
  99: 'SQUARED_DIFFERENCE',
};

// ─── Flatbuffer reader (minimal, schema-aware) ─────────────────────────

class FB {
  constructor(arrayBuffer) {
    this.dv = new DataView(arrayBuffer);
    this.buffer = arrayBuffer;
  }
  u8(o) { return this.dv.getUint8(o); }
  i32(o) { return this.dv.getInt32(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  u16(o) { return this.dv.getUint16(o, true); }
  f32(o) { return this.dv.getFloat32(o, true); }

  /** Resolve a table field offset (returns 0 if field is absent). */
  field(tableOff, fieldId) {
    const vtableOff = tableOff - this.i32(tableOff);
    const vtableSize = this.u16(vtableOff);
    const slot = 4 + fieldId * 2;
    if (slot >= vtableSize) return 0;
    const fieldOff = this.u16(vtableOff + slot);
    return fieldOff ? tableOff + fieldOff : 0;
  }
  follow(off) { return off + this.u32(off); }
  vector(vecOff) {
    if (!vecOff) return { length: 0, dataOff: 0 };
    return { length: this.u32(vecOff), dataOff: vecOff + 4 };
  }
  intVec(fieldOff) {
    const vec = this.vector(this.follow(fieldOff));
    const out = new Int32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = this.i32(vec.dataOff + i * 4);
    return out;
  }
  string(fieldOff) {
    if (!fieldOff) return '';
    const off = this.follow(fieldOff);
    const len = this.u32(off);
    return new TextDecoder().decode(new Uint8Array(this.buffer, off + 4, len));
  }
  /** Raw byte view of a Buffer's data field. */
  bufferBytes(bufferTableOff) {
    const dataField = this.field(bufferTableOff, BUFFER_DATA);
    if (!dataField) return new Uint8Array(0);
    const vec = this.vector(this.follow(dataField));
    return new Uint8Array(this.buffer, vec.dataOff, vec.length);
  }
}

// ─── Compile-time tensor + op extraction ────────────────────────────────

function shapeSize(shape) {
  let n = 1;
  for (const d of shape) n *= d;
  return n;
}

/**
 * Read raw buffer bytes into a typed array of the appropriate dtype.
 * Returns null for empty buffers (i.e. activation tensors with no constant).
 */
function readConstant(meta, rawBytes) {
  if (!rawBytes?.length) return null;
  if (meta.type === TT_FLOAT32) {
    return new Float32Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 4);
  }
  if (meta.type === TT_INT32) {
    return new Int32Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 4);
  }
  if (meta.type === TT_BOOL) {
    return new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }
  if (meta.type === TT_INT8) {
    return new Int8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }
  return null;
}

/**
 * Allocate a typed array sized to a tensor's shape.  All scratch buffers
 * are float32 - int32 is only used for shape tensors which we read at
 * compile time, not during inference.
 */
function allocTensorData(type, size) {
  if (type === TT_FLOAT32) return new Float32Array(size);
  if (type === TT_INT32) return new Int32Array(size);
  if (type === TT_BOOL) return new Uint8Array(size);
  return new Float32Array(size);
}

// Op-options field IDs for ops we currently implement.  Pulled from
// schema.fbs as we add op support - kept narrow on purpose.
const FC_FUSED_ACTIVATION = 0;
const RESHAPE_NEW_SHAPE = 0;  // optional - usually shape comes from inputs[1]
// AddOptions, SubOptions, MulOptions all share field 0 = fused_activation_function.
const ARITH_FUSED_ACTIVATION = 0;
// IfOptions: { then_subgraph_index: int, else_subgraph_index: int }
const IF_THEN_SUBGRAPH = 0;
const IF_ELSE_SUBGRAPH = 1;
// Conv2DOptions: padding, stride_w, stride_h, fused_activation, dilation_w, dilation_h
const CONV2D_PADDING = 0;
const CONV2D_STRIDE_W = 1;
const CONV2D_STRIDE_H = 2;
const CONV2D_FUSED_ACTIVATION = 3;
const CONV2D_DILATION_W = 4;
const CONV2D_DILATION_H = 5;
// Pool2DOptions: padding, stride_w, stride_h, filter_w, filter_h, fused_activation
const POOL_PADDING = 0;
const POOL_STRIDE_W = 1;
const POOL_STRIDE_H = 2;
const POOL_FILTER_W = 3;
const POOL_FILTER_H = 4;
const POOL_FUSED_ACTIVATION = 5;
// LeakyReluOptions: { alpha: float }
const LEAKY_RELU_ALPHA = 0;
// BatchMatMulOptions: { adj_x: bool, adj_y: bool, asymmetric_quantize_inputs: bool }
const BMM_ADJ_X = 0;
const BMM_ADJ_Y = 1;
// Padding enum
const PADDING_SAME = 0;
const PADDING_VALID = 1;
// StridedSliceOptions field IDs.
const SS_BEGIN_MASK = 0;
const SS_END_MASK = 1;
const SS_ELLIPSIS_MASK = 2;
const SS_NEW_AXIS_MASK = 3;
const SS_SHRINK_AXIS_MASK = 4;
// PackOptions field IDs.
const PACK_VALUES_COUNT = 0;
const PACK_AXIS = 1;

/** Activation enum values. */
const ACT_NONE = 0;
const ACT_RELU = 1;
const ACT_RELU_N1_TO_1 = 2;
const ACT_RELU6 = 3;
const ACT_TANH = 4;
const ACT_SIGN_BIT = 5;

function readOptionalU8(fb, tableOff, fieldId, fallback) {
  if (!tableOff) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.u8(f) : fallback;
}

function readOptionalIntVec(fb, tableOff, fieldId) {
  if (!tableOff) return null;
  const f = fb.field(tableOff, fieldId);
  return f ? Array.from(fb.intVec(f)) : null;
}

/**
 * Compile a .tflite buffer into a CompiledModel ready for invoke().
 *
 * All subgraphs are compiled - IF ops dispatch into auxiliary subgraphs
 * by index (then_subgraph_index / else_subgraph_index in IfOptions).
 * The primary entry point is subgraph 0 unless overridden via opts.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} [opts]
 * @param {number} [opts.subgraphIndex=0]
 * @param {object<number, number[]>} [opts.tensorShapeOverrides]
 *   Map of tensorId → new shape, applied during subgraph compile so
 *   models with dynamic input shapes (mel spectrogram's [1,1] placeholder)
 *   can be resized before tensor allocation.
 */
export function compileOwwModel(arrayBuffer, { subgraphIndex = 0, tensorShapeOverrides = null } = {}) {
  const fb = new FB(arrayBuffer);
  const modelOff = fb.follow(0);

  // Operator codes (the "schema" of which builtin ops are referenced).
  const opCodesField = fb.field(modelOff, MODEL_OPERATOR_CODES);
  const opCodesVec = fb.vector(fb.follow(opCodesField));
  const opCodes = [];
  for (let i = 0; i < opCodesVec.length; i++) {
    const off = fb.follow(opCodesVec.dataOff + i * 4);
    const builtinField = fb.field(off, OPCODE_BUILTIN);
    const deprecatedField = fb.field(off, OPCODE_DEPRECATED_BUILTIN);
    const versionField = fb.field(off, OPCODE_VERSION);
    opCodes.push({
      builtin: builtinField ? fb.u8(builtinField) : (deprecatedField ? fb.u8(deprecatedField) : 0),
      version: versionField ? fb.u32(versionField) : 1,
    });
  }

  // Buffers (constant data).
  const buffersField = fb.field(modelOff, MODEL_BUFFERS);
  const buffersVec = fb.vector(fb.follow(buffersField));

  // Compile every subgraph - required so IF can dispatch into any of them.
  const subgraphsField = fb.field(modelOff, MODEL_SUBGRAPHS);
  const subgraphsVec = fb.vector(fb.follow(subgraphsField));
  if (subgraphIndex >= subgraphsVec.length) {
    throw new Error(`Subgraph index ${subgraphIndex} out of range (have ${subgraphsVec.length})`);
  }
  const subgraphs = [];
  for (let s = 0; s < subgraphsVec.length; s++) {
    const subOff = fb.follow(subgraphsVec.dataOff + s * 4);
    // Apply shape overrides only to subgraph 0 - that's where the
    // dynamic input lives in melspectrogram.
    const overrides = s === 0 ? tensorShapeOverrides : null;
    subgraphs.push(compileSubgraph(fb, subOff, buffersVec, opCodes, overrides));
  }

  return new OwwCompiledModel(subgraphs, fb, subgraphIndex);
}

/** Compile a single subgraph into {tensors, ops, inputIds, outputIds}. */
function compileSubgraph(fb, subOff, buffersVec, opCodes, tensorShapeOverrides) {
  // Tensors.
  const tensorsField = fb.field(subOff, SUBGRAPH_TENSORS);
  const tensorsVec = fb.vector(fb.follow(tensorsField));
  const tensors = [];
  for (let i = 0; i < tensorsVec.length; i++) {
    const tOff = fb.follow(tensorsVec.dataOff + i * 4);
    const shapeField = fb.field(tOff, TENSOR_SHAPE);
    const typeField = fb.field(tOff, TENSOR_TYPE);
    const bufferField = fb.field(tOff, TENSOR_BUFFER);
    const nameField = fb.field(tOff, TENSOR_NAME);
    const shape = shapeField ? Array.from(fb.intVec(shapeField)) : [];
    const type = typeField ? fb.u8(typeField) : 0;
    const bufferIndex = bufferField ? fb.u32(bufferField) : 0;
    const name = nameField ? fb.string(nameField) : '';
    const rawBytes = bufferIndex < buffersVec.length
      ? fb.bufferBytes(fb.follow(buffersVec.dataOff + bufferIndex * 4))
      : null;
    // Allow callers (melspectrogram with dynamic [1,1] input) to override
    // tensor shapes that were saved with placeholder values in the file.
    // We don't yet implement TFLite shape inference, so the override map
    // must cover all dynamic-shape tensors.
    const overrideShape = tensorShapeOverrides && tensorShapeOverrides[i];
    const finalShape = overrideShape || shape;
    const meta = { id: i, name, type, shape: finalShape };
    const constant = readConstant(meta, rawBytes);
    tensors.push({ ...meta, constant });
  }

  // Inputs / outputs.
  const inputsField = fb.field(subOff, SUBGRAPH_INPUTS);
  const outputsField = fb.field(subOff, SUBGRAPH_OUTPUTS);
  const inputIds = inputsField ? Array.from(fb.intVec(inputsField)) : [];
  const outputIds = outputsField ? Array.from(fb.intVec(outputsField)) : [];

  // Operators - preserve declared order.
  const opsField = fb.field(subOff, SUBGRAPH_OPERATORS);
  const opsVec = fb.vector(fb.follow(opsField));
  const ops = [];
  for (let i = 0; i < opsVec.length; i++) {
    const opOff = fb.follow(opsVec.dataOff + i * 4);
    const opcodeIdxField = fb.field(opOff, OP_OPCODE_INDEX);
    const inField = fb.field(opOff, OP_INPUTS);
    const outField = fb.field(opOff, OP_OUTPUTS);
    const optionsField = fb.field(opOff, OP_BUILTIN_OPTIONS);

    const opcodeIdx = opcodeIdxField ? fb.u32(opcodeIdxField) : 0;
    const builtin = opCodes[opcodeIdx].builtin;
    const opName = OP_NAME[builtin] || `OP_${builtin}`;
    const optionsOff = optionsField ? fb.follow(optionsField) : 0;
    const inputs = inField ? Array.from(fb.intVec(inField)) : [];
    const outputs = outField ? Array.from(fb.intVec(outField)) : [];

    ops.push({ opName, inputs, outputs, optionsOff, fb });
  }

  return { tensors, ops, inputIds, outputIds };
}

// ─── Compiled model + execution ────────────────────────────────────────

class OwwCompiledModel {
  constructor(subgraphs, fb, primaryIndex) {
    this.subgraphs = subgraphs;
    this.primaryIndex = primaryIndex;
    this._fb = fb;
    // Convenience: expose the primary subgraph's metadata directly so
    // callers don't have to know about subgraph indexing.
    const primary = subgraphs[primaryIndex];
    this.tensors = primary.tensors;
    this.ops = primary.ops;
    this.inputIds = primary.inputIds;
    this.outputIds = primary.outputIds;
  }

  /**
   * Allocate state for a specific subgraph.  Constants are linked
   * directly (read-only); activation tensors get fresh typed arrays.
   */
  createState(subgraphIndex = this.primaryIndex) {
    const sg = this.subgraphs[subgraphIndex];
    const state = new Array(sg.tensors.length);
    for (let i = 0; i < sg.tensors.length; i++) {
      const t = sg.tensors[i];
      if (t.constant) {
        state[i] = t.constant;
      } else {
        state[i] = allocTensorData(t.type, shapeSize(t.shape));
      }
    }
    return state;
  }

  /**
   * Run a specific subgraph with a pre-populated state.  Used internally
   * by IF dispatch and by the public invoke() entry point.
   */
  runSubgraph(subgraphIndex, state, onAfterOp) {
    const sg = this.subgraphs[subgraphIndex];
    for (let i = 0; i < sg.ops.length; i++) {
      const op = sg.ops[i];
      executeOp(op, sg.tensors, state, this._fb, this);
      if (onAfterOp) {
        onAfterOp(i, op, op.outputs.map((id) => state[id]));
      }
    }
    return state;
  }

  /**
   * Run the primary subgraph with the supplied input.
   * @param {Float32Array} inputData - flattened input tensor data
   * @param {object} [opts]
   * @param {object} [opts.state] - reuse a pre-allocated state object
   * @param {function} [opts.onAfterOp] - callback(opIndex, op, outputData[])
   *   for per-op debugging / validation.
   * @returns {Float32Array} flattened output tensor data
   */
  invoke(inputData, opts = {}) {
    const state = opts.state || this.createState();
    const inputId = this.inputIds[0];
    const inputBuf = state[inputId];
    if (inputBuf.length !== inputData.length) {
      throw new Error(`Input length mismatch: expected ${inputBuf.length}, got ${inputData.length}`);
    }
    inputBuf.set(inputData);

    this.runSubgraph(this.primaryIndex, state, opts.onAfterOp);
    return state[this.outputIds[0]];
  }

  /**
   * For debugging - dump the full state after invoke(inputData).
   * Returns an array indexed by tensor id (from the primary subgraph).
   */
  invokeAndDumpAllTensors(inputData) {
    const state = this.createState();
    this.invoke(inputData, { state });
    return state;
  }
}

// ─── Op dispatch ────────────────────────────────────────────────────────

function executeOp(op, tensors, state, fb, model) {
  switch (op.opName) {
    case 'RESHAPE':
      return opReshape(op, tensors, state);
    case 'FULLY_CONNECTED':
      return opFullyConnected(op, tensors, state, fb);
    case 'LOGISTIC':
      return opLogistic(op, state);
    case 'MUL':
      return opBroadcast(op, state, fb, (a, b) => a * b);
    case 'ADD':
      return opBroadcast(op, state, fb, (a, b) => a + b);
    case 'SUB':
      return opBroadcast(op, state, fb, (a, b) => a - b);
    case 'MEAN':
      return opMean(op, tensors, state);
    case 'RSQRT':
      return opUnary(op, state, (x) => 1 / Math.sqrt(x));
    case 'GREATER_EQUAL':
      return opGreaterEqual(op, state);
    case 'IF':
      return opIf(op, state, fb, model);
    case 'MAXIMUM':
      return opBroadcastNoAct(op, state, (a, b) => a > b ? a : b);
    case 'MINIMUM':
      return opBroadcastNoAct(op, state, (a, b) => a < b ? a : b);
    case 'LEAKY_RELU':
      return opLeakyRelu(op, state, fb);
    case 'CONV_2D':
      return opConv2dFloat(op, tensors, state, fb);
    case 'MAX_POOL_2D':
      return opMaxPool2d(op, tensors, state, fb);
    case 'PAD':
      return opPad(op, tensors, state);
    case 'LOG':
      return opUnary(op, state, Math.log);
    case 'EXPAND_DIMS':
    case 'SQUEEZE':
      // Both are reshape-only ops - output tensor shape is already set
      // at compile time, so we just copy the data through unchanged.
      return opReshape(op, tensors, state);
    case 'TRANSPOSE':
      return opTranspose(op, tensors, state);
    case 'REDUCE_MAX':
      return opReduceMax(op, tensors, state);
    case 'BATCH_MATMUL':
      return opBatchMatmul(op, tensors, state, fb);
    case 'SHAPE':
      return opShape(op, tensors, state);
    case 'STRIDED_SLICE':
      return opStridedSlice(op, tensors, state, fb);
    case 'REDUCE_PROD':
      return opReduceProd(op, tensors, state);
    case 'PACK':
      return opPack(op, tensors, state, fb);
    case 'FILL':
      return opFill(op, state);
    case 'SQUARED_DIFFERENCE':
      return opBroadcastNoAct(op, state, (a, b) => (a - b) * (a - b));
    default:
      throw new Error(`Unsupported op: ${op.opName}`);
  }
}

// ─── Op implementations ─────────────────────────────────────────────────

/** RESHAPE: copy input bytes through to output (shape lives in the tensor metadata). */
function opReshape(op, tensors, state) {
  const src = state[op.inputs[0]];
  const dst = state[op.outputs[0]];
  if (src.length !== dst.length) {
    throw new Error(`RESHAPE size mismatch: ${src.length} vs ${dst.length}`);
  }
  dst.set(src);
}

/**
 * FULLY_CONNECTED: out[oc] = sum(in[ic] * weights[oc, ic]) + bias[oc]
 * Float32 path with optional fused ReLU.  Input tensor is automatically
 * flattened to (batch, in_count); we treat batch=1.
 */
function opFullyConnected(op, tensors, state, fb) {
  const input = state[op.inputs[0]];
  const weights = state[op.inputs[1]];
  const bias = op.inputs.length >= 3 ? state[op.inputs[2]] : null;
  const out = state[op.outputs[0]];

  const weightShape = tensors[op.inputs[1]].shape;
  const outCount = weightShape[0];
  const inCount = weightShape[1];

  if (input.length % inCount !== 0) {
    throw new Error(`FC input length ${input.length} not divisible by inCount ${inCount}`);
  }
  const batch = input.length / inCount;

  const fusedAct = readOptionalU8(fb, op.optionsOff, FC_FUSED_ACTIVATION, ACT_NONE);

  for (let b = 0; b < batch; b++) {
    for (let oc = 0; oc < outCount; oc++) {
      let acc = bias ? bias[oc] : 0;
      const base = oc * inCount;
      const inBase = b * inCount;
      for (let ic = 0; ic < inCount; ic++) {
        acc += input[inBase + ic] * weights[base + ic];
      }
      out[b * outCount + oc] = applyFusedActivation(acc, fusedAct);
    }
  }
}

function applyFusedActivation(x, act) {
  switch (act) {
    case ACT_NONE: return x;
    case ACT_RELU: return x < 0 ? 0 : x;
    case ACT_RELU_N1_TO_1: return x < -1 ? -1 : (x > 1 ? 1 : x);
    case ACT_RELU6: return x < 0 ? 0 : (x > 6 ? 6 : x);
    case ACT_TANH: return Math.tanh(x);
    default: return x;
  }
}

/** LOGISTIC: element-wise sigmoid. */
function opLogistic(op, state) {
  const input = state[op.inputs[0]];
  const out = state[op.outputs[0]];
  for (let i = 0; i < input.length; i++) {
    out[i] = 1 / (1 + Math.exp(-input[i]));
  }
}

/**
 * Element-wise binary op with NumPy-style broadcasting + fused activation.
 * Used for MUL / ADD / SUB.  TFLite fuses ReLU-class activations into
 * these ops via the *Options table, field 0.
 */
function opBroadcast(op, state, fb, fn) {
  const a = state[op.inputs[0]];
  const b = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const act = readOptionalU8(fb, op.optionsOff, ARITH_FUSED_ACTIVATION, ACT_NONE);

  // Fast path: same length - element-wise without index math.
  if (a.length === b.length && a.length === out.length) {
    for (let i = 0; i < out.length; i++) out[i] = applyFusedActivation(fn(a[i], b[i]), act);
    return;
  }
  // Scalar broadcast (one side is length 1).
  if (a.length === 1) {
    const av = a[0];
    for (let i = 0; i < out.length; i++) out[i] = applyFusedActivation(fn(av, b[i]), act);
    return;
  }
  if (b.length === 1) {
    const bv = b[0];
    for (let i = 0; i < out.length; i++) out[i] = applyFusedActivation(fn(a[i], bv), act);
    return;
  }
  // General N-D broadcast - cycle the shorter operand.  This handles
  // common cases like [N,C] * [C] in LayerNorm.  If we encounter a model
  // where this isn't sufficient we'll switch to the full strided
  // broadcast iterator.
  if (out.length % a.length === 0 && out.length % b.length === 0) {
    const aRep = out.length / a.length;
    const bRep = out.length / b.length;
    if (aRep === 1) {
      for (let i = 0; i < out.length; i++) out[i] = applyFusedActivation(fn(a[i], b[i % b.length]), act);
      return;
    }
    if (bRep === 1) {
      for (let i = 0; i < out.length; i++) out[i] = applyFusedActivation(fn(a[i % a.length], b[i]), act);
      return;
    }
  }
  throw new Error(`Unsupported broadcast: a.length=${a.length} b.length=${b.length} out.length=${out.length}`);
}

/** Unary element-wise (RSQRT, LOG, etc.). */
function opUnary(op, state, fn) {
  const input = state[op.inputs[0]];
  const out = state[op.outputs[0]];
  for (let i = 0; i < input.length; i++) out[i] = fn(input[i]);
}

/**
 * MEAN: reduction over a set of axes.  inputs[1] is an int32 axes tensor;
 * inputs[0] is the data.  TFLite stores keep_dims in the options table -
 * for now we just trust the output tensor's shape (set at compile time)
 * and figure out which axes were reduced from the shape diff.
 */
function opMean(op, tensors, state) {
  const input = state[op.inputs[0]];
  const axesTensor = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const inShape = tensors[op.inputs[0]].shape;

  // Normalize negative axes and dedup.
  const axes = new Set();
  for (let i = 0; i < axesTensor.length; i++) {
    let ax = axesTensor[i];
    if (ax < 0) ax += inShape.length;
    axes.add(ax);
  }

  // Walk every input element, accumulate into the matching output slot.
  // The output index is computed by skipping reduced dimensions.
  const inStrides = stridesOf(inShape);
  // Build output index map: for each input dim, where does it land in
  // the output shape (or -1 if reduced)?
  const reducedAxes = [];
  const keptAxes = [];
  for (let d = 0; d < inShape.length; d++) {
    if (axes.has(d)) reducedAxes.push(d);
    else keptAxes.push(d);
  }

  let reduceCount = 1;
  for (const d of reducedAxes) reduceCount *= inShape[d];

  out.fill(0);

  // Iterate every input element.
  const total = input.length;
  for (let flat = 0; flat < total; flat++) {
    // Decompose flat index into per-dim coords.
    let rem = flat;
    let outIdx = 0;
    let outStride = 1;
    // Compute kept-dim strides for the output.
    // Process from last kept axis backward.
    const coords = new Array(inShape.length);
    for (let d = 0; d < inShape.length; d++) {
      coords[d] = Math.floor(rem / inStrides[d]);
      rem -= coords[d] * inStrides[d];
    }
    // Build output flat index from kept coords.
    outStride = 1;
    for (let i = keptAxes.length - 1; i >= 0; i--) {
      const d = keptAxes[i];
      outIdx += coords[d] * outStride;
      outStride *= inShape[d];
    }
    out[outIdx] += input[flat];
  }

  for (let i = 0; i < out.length; i++) out[i] /= reduceCount;
}

function stridesOf(shape) {
  const out = new Array(shape.length);
  let s = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = s;
    s *= shape[i];
  }
  return out;
}

/**
 * GREATER_EQUAL: element-wise (a >= b).  Output is BOOL (Uint8Array,
 * 0 or 1).  Supports the same broadcast rules as opBroadcast.
 */
function opGreaterEqual(op, state) {
  const a = state[op.inputs[0]];
  const b = state[op.inputs[1]];
  const out = state[op.outputs[0]];

  if (a.length === b.length && a.length === out.length) {
    for (let i = 0; i < out.length; i++) out[i] = a[i] >= b[i] ? 1 : 0;
    return;
  }
  if (a.length === 1) {
    const av = a[0];
    for (let i = 0; i < out.length; i++) out[i] = av >= b[i] ? 1 : 0;
    return;
  }
  if (b.length === 1) {
    const bv = b[0];
    for (let i = 0; i < out.length; i++) out[i] = a[i] >= bv ? 1 : 0;
    return;
  }
  throw new Error(`Unsupported GREATER_EQUAL broadcast: a.length=${a.length} b.length=${b.length}`);
}

/**
 * IF: dispatch to one of two subgraphs based on a BOOL condition.
 *
 * inputs[0] is the condition tensor (a single BOOL element).  Remaining
 * inputs are passed positionally as the chosen subgraph's inputs.  The
 * chosen subgraph's outputs become this op's outputs.
 *
 * Schema (IfOptions): {then_subgraph_index: int, else_subgraph_index: int}.
 */
function opIf(op, state, fb, model) {
  if (!model) throw new Error('IF requires the compiled model for subgraph dispatch');

  const condTensor = state[op.inputs[0]];
  const cond = !!condTensor[0];

  const thenIdx = readOptionalU32(fb, op.optionsOff, IF_THEN_SUBGRAPH, 0);
  const elseIdx = readOptionalU32(fb, op.optionsOff, IF_ELSE_SUBGRAPH, 0);
  const targetIdx = cond ? thenIdx : elseIdx;
  const target = model.subgraphs[targetIdx];
  if (!target) throw new Error(`IF target subgraph ${targetIdx} missing`);

  // Build child state and copy passed inputs into the subgraph's input slots.
  const childState = model.createState(targetIdx);
  // op.inputs[0] is condition; inputs[1..] are positional subgraph inputs.
  const passed = op.inputs.slice(1);
  if (passed.length !== target.inputIds.length) {
    throw new Error(
      `IF subgraph ${targetIdx} expects ${target.inputIds.length} inputs, got ${passed.length}`,
    );
  }
  for (let i = 0; i < passed.length; i++) {
    const src = state[passed[i]];
    const dst = childState[target.inputIds[i]];
    if (src.length !== dst.length) {
      throw new Error(
        `IF input ${i}: length mismatch ${src.length} → ${dst.length}`,
      );
    }
    dst.set(src);
  }

  // Run the chosen subgraph.
  model.runSubgraph(targetIdx, childState);

  // Copy subgraph outputs back into this op's output tensor slots.
  if (op.outputs.length !== target.outputIds.length) {
    throw new Error(
      `IF subgraph ${targetIdx} produces ${target.outputIds.length} outputs, expected ${op.outputs.length}`,
    );
  }
  for (let i = 0; i < op.outputs.length; i++) {
    const src = childState[target.outputIds[i]];
    const dst = state[op.outputs[i]];
    if (src.length !== dst.length) {
      throw new Error(
        `IF output ${i}: length mismatch ${src.length} → ${dst.length}`,
      );
    }
    dst.set(src);
  }
}

function readOptionalU32(fb, tableOff, fieldId, fallback) {
  if (!tableOff) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.u32(f) : fallback;
}

function readOptionalF32(fb, tableOff, fieldId, fallback) {
  if (!tableOff) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.f32(f) : fallback;
}

/**
 * MAXIMUM / MINIMUM: element-wise binary, no fused activation in their
 * options table.  Same broadcasting rules as opBroadcast.
 */
function opBroadcastNoAct(op, state, fn) {
  const a = state[op.inputs[0]];
  const b = state[op.inputs[1]];
  const out = state[op.outputs[0]];

  if (a.length === b.length && a.length === out.length) {
    for (let i = 0; i < out.length; i++) out[i] = fn(a[i], b[i]);
    return;
  }
  if (a.length === 1) {
    const av = a[0];
    for (let i = 0; i < out.length; i++) out[i] = fn(av, b[i]);
    return;
  }
  if (b.length === 1) {
    const bv = b[0];
    for (let i = 0; i < out.length; i++) out[i] = fn(a[i], bv);
    return;
  }
  if (out.length % a.length === 0 && out.length % b.length === 0) {
    if (out.length === b.length) {
      for (let i = 0; i < out.length; i++) out[i] = fn(a[i % a.length], b[i]);
      return;
    }
    if (out.length === a.length) {
      for (let i = 0; i < out.length; i++) out[i] = fn(a[i], b[i % b.length]);
      return;
    }
  }
  throw new Error(`Unsupported MAXIMUM/MINIMUM broadcast: a=${a.length} b=${b.length} out=${out.length}`);
}

/**
 * LEAKY_RELU: x >= 0 ? x : x * alpha
 * alpha is read from LeakyReluOptions (float, default 0.01 if absent).
 */
function opLeakyRelu(op, state, fb) {
  const input = state[op.inputs[0]];
  const out = state[op.outputs[0]];
  const alpha = readOptionalF32(fb, op.optionsOff, LEAKY_RELU_ALPHA, 0.01);
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    out[i] = v >= 0 ? v : v * alpha;
  }
}

/**
 * Compute SAME / VALID padding amounts for a 2D op given the explicit
 * input and output spatial dims.  Matches TF's reference behavior:
 *   total_pad = max((out - 1) * stride + dilated_kernel - in, 0)
 *   top = total_pad // 2
 */
function compute2dPadding(paddingType, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW) {
  if (paddingType === PADDING_VALID) return { top: 0, left: 0 };
  const effKH = (kernelH - 1) * dilationH + 1;
  const effKW = (kernelW - 1) * dilationW + 1;
  const totalH = Math.max((outH - 1) * strideH + effKH - inH, 0);
  const totalW = Math.max((outW - 1) * strideW + effKW - inW, 0);
  return { top: Math.floor(totalH / 2), left: Math.floor(totalW / 2) };
}

/**
 * CONV_2D (float32).  NHWC layout.
 *
 *   out[n, oh, ow, oc] = bias[oc]
 *     + sum_{kh, kw, ic} weights[oc, kh, kw, ic]
 *                         * input[n, oh*sH + kh*dH - padTop, ow*sW + kw*dW - padLeft, ic]
 *
 * Out-of-bound input positions contribute 0 (zero-padding).  Optional
 * fused activation (ReLU/ReLU6/etc.) is applied after the bias.
 */
function opConv2dFloat(op, tensors, state, fb) {
  const input = state[op.inputs[0]];
  const weights = state[op.inputs[1]];
  const bias = op.inputs.length >= 3 ? state[op.inputs[2]] : null;
  const out = state[op.outputs[0]];

  const inMeta = tensors[op.inputs[0]];
  const wMeta = tensors[op.inputs[1]];
  const outMeta = tensors[op.outputs[0]];

  const [batch, inH, inW, inC] = inMeta.shape;
  const [outC, kernelH, kernelW, filterC] = wMeta.shape;
  const [, outH, outW] = outMeta.shape;
  if (filterC !== inC) {
    throw new Error(`CONV_2D channel mismatch: weights ${filterC} vs input ${inC}`);
  }

  const padding = readOptionalU8(fb, op.optionsOff, CONV2D_PADDING, PADDING_SAME);
  const strideW = readOptionalU32(fb, op.optionsOff, CONV2D_STRIDE_W, 1);
  const strideH = readOptionalU32(fb, op.optionsOff, CONV2D_STRIDE_H, 1);
  const dilationW = readOptionalU32(fb, op.optionsOff, CONV2D_DILATION_W, 1);
  const dilationH = readOptionalU32(fb, op.optionsOff, CONV2D_DILATION_H, 1);
  const fusedAct = readOptionalU8(fb, op.optionsOff, CONV2D_FUSED_ACTIVATION, ACT_NONE);
  const pad = compute2dPadding(padding, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW);

  // Strides into the flattened NHWC input buffer.
  const inRowStride = inW * inC;
  const inBatchStride = inH * inRowStride;
  // Strides into the flattened OHWI weight buffer (outC, kH, kW, inC).
  const wKwStride = inC;
  const wKhStride = kernelW * wKwStride;
  const wOcStride = kernelH * wKhStride;

  // Fast paths: branch once on activation + bias before the loop nest
  // and run a specialized version that skips the per-output function
  // call.  ACT_NONE is the common case for the OWW embedding model
  // (conv layers there feed separate LEAKY_RELU + MAXIMUM ops).
  const hasBias = !!bias;
  const noAct = fusedAct === ACT_NONE;
  // Pre-compute the unrolled-loop tail boundary so V8 can hoist it.
  const icUnroll = inC - 3;

  let outIdx = 0;
  for (let n = 0; n < batch; n++) {
    const inBatchBase = n * inBatchStride;
    for (let oh = 0; oh < outH; oh++) {
      const ohStrideH = oh * strideH;
      for (let ow = 0; ow < outW; ow++) {
        const owStrideW = ow * strideW;
        for (let oc = 0; oc < outC; oc++) {
          let acc = hasBias ? bias[oc] : 0;
          const wOcBase = oc * wOcStride;
          for (let kh = 0; kh < kernelH; kh++) {
            const inY = ohStrideH + kh * dilationH - pad.top;
            if (inY < 0 || inY >= inH) continue;
            const inRowBase = inBatchBase + inY * inRowStride;
            const wKhBase = wOcBase + kh * wKhStride;
            for (let kw = 0; kw < kernelW; kw++) {
              const inX = owStrideW + kw * dilationW - pad.left;
              if (inX < 0 || inX >= inW) continue;
              const inPixBase = inRowBase + inX * inC;
              const wKwBase = wKhBase + kw * wKwStride;
              // 4-wide unrolled accumulation - V8's JIT vectorizes this
              // pattern reliably and channel counts in OWW models
              // (32, 64, 96, 128) are always divisible by 4.
              let ic = 0;
              for (; ic < icUnroll; ic += 4) {
                acc += input[inPixBase + ic] * weights[wKwBase + ic]
                  + input[inPixBase + ic + 1] * weights[wKwBase + ic + 1]
                  + input[inPixBase + ic + 2] * weights[wKwBase + ic + 2]
                  + input[inPixBase + ic + 3] * weights[wKwBase + ic + 3];
              }
              for (; ic < inC; ic++) {
                acc += input[inPixBase + ic] * weights[wKwBase + ic];
              }
            }
          }
          out[outIdx++] = noAct ? acc : applyFusedActivation(acc, fusedAct);
        }
      }
    }
  }
}

/**
 * MAX_POOL_2D (float32).  NHWC.  Returns the max value within each
 * sliding window position; zero-padding contributes -Infinity so that
 * out-of-bound positions never win.
 */
function opMaxPool2d(op, tensors, state, fb) {
  const input = state[op.inputs[0]];
  const out = state[op.outputs[0]];
  const inMeta = tensors[op.inputs[0]];
  const outMeta = tensors[op.outputs[0]];

  const [batch, inH, inW, inC] = inMeta.shape;
  const [, outH, outW] = outMeta.shape;

  const padding = readOptionalU8(fb, op.optionsOff, POOL_PADDING, PADDING_SAME);
  const strideW = readOptionalU32(fb, op.optionsOff, POOL_STRIDE_W, 1);
  const strideH = readOptionalU32(fb, op.optionsOff, POOL_STRIDE_H, 1);
  const filterW = readOptionalU32(fb, op.optionsOff, POOL_FILTER_W, 1);
  const filterH = readOptionalU32(fb, op.optionsOff, POOL_FILTER_H, 1);
  const fusedAct = readOptionalU8(fb, op.optionsOff, POOL_FUSED_ACTIVATION, ACT_NONE);
  const pad = compute2dPadding(padding, inH, inW, filterH, filterW, strideH, strideW, 1, 1, outH, outW);

  const inRowStride = inW * inC;
  const inBatchStride = inH * inRowStride;

  let outIdx = 0;
  for (let n = 0; n < batch; n++) {
    const inBatchBase = n * inBatchStride;
    for (let oh = 0; oh < outH; oh++) {
      for (let ow = 0; ow < outW; ow++) {
        for (let c = 0; c < inC; c++) {
          let mx = -Infinity;
          for (let kh = 0; kh < filterH; kh++) {
            const inY = oh * strideH + kh - pad.top;
            if (inY < 0 || inY >= inH) continue;
            const rowBase = inBatchBase + inY * inRowStride;
            for (let kw = 0; kw < filterW; kw++) {
              const inX = ow * strideW + kw - pad.left;
              if (inX < 0 || inX >= inW) continue;
              const v = input[rowBase + inX * inC + c];
              if (v > mx) mx = v;
            }
          }
          out[outIdx++] = applyFusedActivation(mx === -Infinity ? 0 : mx, fusedAct);
        }
      }
    }
  }
}

/**
 * TRANSPOSE: reorder tensor dimensions per a permutation vector.
 *   inputs[1] is an int32 perm tensor.  Output has shape input.shape[perm].
 *   out[ y0, y1, ... ] = in[ y_perm[0], y_perm[1], ... ]
 */
function opTranspose(op, tensors, state) {
  const input = state[op.inputs[0]];
  const permData = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const inShape = tensors[op.inputs[0]].shape;
  const outShape = tensors[op.outputs[0]].shape;
  const rank = inShape.length;

  const perm = new Array(rank);
  for (let i = 0; i < rank; i++) {
    let p = permData[i];
    if (p < 0) p += rank;
    perm[i] = p;
  }
  const inStrides = stridesOf(inShape);
  const outStrides = stridesOf(outShape);

  // Walk every output element; map its coords back through perm.
  for (let outFlat = 0; outFlat < out.length; outFlat++) {
    let rem = outFlat;
    let inFlat = 0;
    for (let d = 0; d < rank; d++) {
      const coord = Math.floor(rem / outStrides[d]);
      rem -= coord * outStrides[d];
      inFlat += coord * inStrides[perm[d]];
    }
    out[outFlat] = input[inFlat];
  }
}

/**
 * REDUCE_MAX: max reduction over a set of axes.  Same input layout as
 * MEAN (data + axes tensor).  We treat the output shape (set at compile
 * time) as the source of truth for which dims are reduced.
 */
function opReduceMax(op, tensors, state) {
  const input = state[op.inputs[0]];
  const axesTensor = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const inShape = tensors[op.inputs[0]].shape;

  const axes = new Set();
  for (let i = 0; i < axesTensor.length; i++) {
    let ax = axesTensor[i];
    if (ax < 0) ax += inShape.length;
    axes.add(ax);
  }
  const keptAxes = [];
  for (let d = 0; d < inShape.length; d++) {
    if (!axes.has(d)) keptAxes.push(d);
  }

  out.fill(-Infinity);
  const inStrides = stridesOf(inShape);

  for (let flat = 0; flat < input.length; flat++) {
    let rem = flat;
    const coords = new Array(inShape.length);
    for (let d = 0; d < inShape.length; d++) {
      coords[d] = Math.floor(rem / inStrides[d]);
      rem -= coords[d] * inStrides[d];
    }
    let outIdx = 0;
    let outStride = 1;
    for (let i = keptAxes.length - 1; i >= 0; i--) {
      const d = keptAxes[i];
      outIdx += coords[d] * outStride;
      outStride *= inShape[d];
    }
    if (input[flat] > out[outIdx]) out[outIdx] = input[flat];
  }
}

/**
 * BATCH_MATMUL: a @ b for stacks of matrices.
 *   a shape: [..., M, K]  (or [..., K, M] if adj_x)
 *   b shape: [..., K, N]  (or [..., N, K] if adj_y)
 *   out:     [..., M, N]
 *
 * The trailing two dims are matrix dims; everything before is batched.
 * Batch dims must broadcast NumPy-style (we support exact-match and
 * length-1 broadcasting on each batch dim).
 */
function opBatchMatmul(op, tensors, state, fb) {
  const a = state[op.inputs[0]];
  const b = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const aShape = tensors[op.inputs[0]].shape;
  const bShape = tensors[op.inputs[1]].shape;
  const outShape = tensors[op.outputs[0]].shape;

  const adjX = readOptionalU8(fb, op.optionsOff, BMM_ADJ_X, 0) !== 0;
  const adjY = readOptionalU8(fb, op.optionsOff, BMM_ADJ_Y, 0) !== 0;

  // Matrix dims
  const aRank = aShape.length;
  const bRank = bShape.length;
  const outRank = outShape.length;
  if (aRank < 2 || bRank < 2 || outRank < 2) {
    throw new Error('BATCH_MATMUL needs rank >= 2 on all tensors');
  }
  const M = adjX ? aShape[aRank - 1] : aShape[aRank - 2];
  const Ka = adjX ? aShape[aRank - 2] : aShape[aRank - 1];
  const Kb = adjY ? bShape[bRank - 1] : bShape[bRank - 2];
  const N = adjY ? bShape[bRank - 2] : bShape[bRank - 1];
  if (Ka !== Kb) throw new Error(`BATCH_MATMUL inner dims mismatch: ${Ka} vs ${Kb}`);
  const K = Ka;
  if (outShape[outRank - 2] !== M || outShape[outRank - 1] !== N) {
    throw new Error(`BATCH_MATMUL output shape mismatch: expected [...,${M},${N}], got [...,${outShape[outRank-2]},${outShape[outRank-1]}]`);
  }

  // Broadcast batch dims.  Right-align the batch portions of a and b
  // against the output's batch portion.
  const aBatchRank = aRank - 2;
  const bBatchRank = bRank - 2;
  const outBatchRank = outRank - 2;
  const aBatchShape = aShape.slice(0, aBatchRank);
  const bBatchShape = bShape.slice(0, bBatchRank);
  const outBatchShape = outShape.slice(0, outBatchRank);

  // Pre-compute flat strides (innermost dim has stride 1).
  const aMatStride = M * K;        // size of one a matrix
  const bMatStride = K * N;        // size of one b matrix
  const outMatStride = M * N;      // size of one output matrix

  // For batch broadcasting, we need to map an output batch coord to a
  // matrix start offset in a and in b.  Build batch strides (in matrices)
  // for each operand, with broadcast rules: if a's batch dim is 1 we
  // ignore that dim's stride.
  function broadcastStrides(batchShape, outBatchShape) {
    // Right-align.
    const rank = outBatchShape.length;
    const padded = new Array(rank).fill(1);
    const offset = rank - batchShape.length;
    for (let i = 0; i < batchShape.length; i++) padded[offset + i] = batchShape[i];
    // Stride within matrix-units.
    const strides = new Array(rank);
    let s = 1;
    for (let i = rank - 1; i >= 0; i--) {
      strides[i] = padded[i] === 1 ? 0 : s;
      s *= padded[i];
    }
    return strides;
  }
  const aBatchStrides = broadcastStrides(aBatchShape, outBatchShape);
  const bBatchStrides = broadcastStrides(bBatchShape, outBatchShape);
  const outBatchStrides = (() => {
    const r = outBatchShape.length;
    const s = new Array(r);
    let acc = 1;
    for (let i = r - 1; i >= 0; i--) { s[i] = acc; acc *= outBatchShape[i]; }
    return s;
  })();

  // Total batch count (product of output batch dims).
  let batchCount = 1;
  for (const d of outBatchShape) batchCount *= d;

  for (let bi = 0; bi < batchCount; bi++) {
    // Decompose bi into outBatchShape coords.
    let rem = bi;
    let aMat = 0;
    let bMat = 0;
    for (let d = 0; d < outBatchShape.length; d++) {
      const coord = Math.floor(rem / outBatchStrides[d]);
      rem -= coord * outBatchStrides[d];
      aMat += coord * aBatchStrides[d];
      bMat += coord * bBatchStrides[d];
    }
    const aBase = aMat * aMatStride;
    const bBase = bMat * bMatStride;
    const outBase = bi * outMatStride;

    // Inner GEMM with optional transposes.
    for (let m = 0; m < M; m++) {
      for (let n = 0; n < N; n++) {
        let acc = 0;
        for (let k = 0; k < K; k++) {
          const aIdx = adjX ? aBase + k * M + m : aBase + m * K + k;
          const bIdx = adjY ? bBase + n * K + k : bBase + k * N + n;
          acc += a[aIdx] * b[bIdx];
        }
        out[outBase + m * N + n] = acc;
      }
    }
  }
}

/**
 * SHAPE: writes the input tensor's shape (a static int32 vector) into
 * the output buffer.  Used by the dynamic-shape LayerNorm pattern in
 * openWakeWord's stop classifier.
 */
function opShape(op, tensors, state) {
  const inShape = tensors[op.inputs[0]].shape;
  const out = state[op.outputs[0]];
  for (let i = 0; i < inShape.length; i++) out[i] = inShape[i];
}

/**
 * STRIDED_SLICE (float32 / int32).
 *
 * Inputs:
 *   [0] data
 *   [1] begin   (int32 vector, one entry per input dim)
 *   [2] end     (int32 vector)
 *   [3] strides (int32 vector)
 *
 * Options carry begin/end/ellipsis/new-axis/shrink-axis bitmasks.  For
 * each axis i the effective range is:
 *   - if begin_mask & (1<<i): begin = stride > 0 ? 0 : dim - 1
 *   - if end_mask   & (1<<i): end   = stride > 0 ? dim : -1
 *   - negative begin/end are wrapped (begin += dim).
 *
 * The output's pre-baked shape already accounts for shrink_axis_mask, so
 * the kernel just iterates over output elements and maps each back to
 * the strided position in the input.
 */
function opStridedSlice(op, tensors, state, fb) {
  const input = state[op.inputs[0]];
  const begin = state[op.inputs[1]];
  const end = state[op.inputs[2]];
  const strides = state[op.inputs[3]];
  const out = state[op.outputs[0]];

  const inShape = tensors[op.inputs[0]].shape;
  const outShape = tensors[op.outputs[0]].shape;
  const rank = inShape.length;

  const beginMask = readOptionalU32(fb, op.optionsOff, SS_BEGIN_MASK, 0);
  const endMask = readOptionalU32(fb, op.optionsOff, SS_END_MASK, 0);
  const shrinkMask = readOptionalU32(fb, op.optionsOff, SS_SHRINK_AXIS_MASK, 0);

  // Resolve concrete starts / strides per input dim.
  const starts = new Array(rank);
  const stridesArr = new Array(rank);
  for (let i = 0; i < rank; i++) {
    const dim = inShape[i];
    const s = strides[i];
    let b = begin[i];
    if (beginMask & (1 << i)) b = s > 0 ? 0 : dim - 1;
    else if (b < 0) b += dim;
    // shrink_axis_mask: emit just begin[i] for this axis, no iteration.
    starts[i] = b;
    stridesArr[i] = s;
    // end is never consulted past masks for our use cases - TFLite's
    // shape inference has already produced outShape that matches.
    void endMask; void end;
  }

  // Map each shrink-mask flag to an "advance by 0" so that axis stays
  // pinned at starts[i] while we iterate the unshrunk output coords.
  const inStrides = stridesOf(inShape);

  // Build a "kept-axis" list (input dims not collapsed by shrink).
  const keptInputAxes = [];
  for (let i = 0; i < rank; i++) {
    if (!(shrinkMask & (1 << i))) keptInputAxes.push(i);
  }
  const outRank = outShape.length;
  if (keptInputAxes.length !== outRank) {
    throw new Error(
      `STRIDED_SLICE shape mismatch: kept=${keptInputAxes.length} vs outRank=${outRank}`,
    );
  }
  const outStrides = stridesOf(outShape);

  for (let outFlat = 0; outFlat < out.length; outFlat++) {
    let rem = outFlat;
    let inFlat = 0;
    // Initialize input position with the per-axis starts.
    for (let i = 0; i < rank; i++) inFlat += starts[i] * inStrides[i];
    // Walk output coords; each maps to a kept input axis with stride.
    for (let oi = 0; oi < outRank; oi++) {
      const coord = Math.floor(rem / outStrides[oi]);
      rem -= coord * outStrides[oi];
      const inputAxis = keptInputAxes[oi];
      inFlat += coord * stridesArr[inputAxis] * inStrides[inputAxis];
    }
    out[outFlat] = input[inFlat];
  }
}

/**
 * REDUCE_PROD: product reduction over a set of axes.  Same input layout
 * as MEAN (data + axes tensor); output shape is set at compile time and
 * tells us which dims are kept.
 */
function opReduceProd(op, tensors, state) {
  const input = state[op.inputs[0]];
  const axesTensor = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const inShape = tensors[op.inputs[0]].shape;

  const axes = new Set();
  for (let i = 0; i < axesTensor.length; i++) {
    let ax = axesTensor[i];
    if (ax < 0) ax += inShape.length;
    axes.add(ax);
  }
  const keptAxes = [];
  for (let d = 0; d < inShape.length; d++) {
    if (!axes.has(d)) keptAxes.push(d);
  }

  out.fill(1);
  const inStrides = stridesOf(inShape);

  for (let flat = 0; flat < input.length; flat++) {
    let rem = flat;
    const coords = new Array(inShape.length);
    for (let d = 0; d < inShape.length; d++) {
      coords[d] = Math.floor(rem / inStrides[d]);
      rem -= coords[d] * inStrides[d];
    }
    let outIdx = 0;
    let outStride = 1;
    for (let i = keptAxes.length - 1; i >= 0; i--) {
      const d = keptAxes[i];
      outIdx += coords[d] * outStride;
      outStride *= inShape[d];
    }
    out[outIdx] *= input[flat];
  }
}

/**
 * PACK: stack N input tensors along a new axis.  Output rank = input
 * rank + 1; the new axis is at position `axis` and has length N.
 */
function opPack(op, tensors, state, fb) {
  const out = state[op.outputs[0]];
  const outShape = tensors[op.outputs[0]].shape;
  const inputCount = op.inputs.length;
  let axis = readOptionalI32(fb, op.optionsOff, PACK_AXIS, 0);
  if (axis < 0) axis += outShape.length;

  // Layout: outer × inputCount × inner
  let outer = 1;
  for (let i = 0; i < axis; i++) outer *= outShape[i];
  let inner = 1;
  for (let i = axis + 1; i < outShape.length; i++) inner *= outShape[i];

  for (let n = 0; n < inputCount; n++) {
    const src = state[op.inputs[n]];
    for (let o = 0; o < outer; o++) {
      const srcBase = o * inner;
      const dstBase = (o * inputCount + n) * inner;
      for (let i = 0; i < inner; i++) out[dstBase + i] = src[srcBase + i];
    }
  }
}

function readOptionalI32(fb, tableOff, fieldId, fallback) {
  if (!tableOff) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.i32(f) : fallback;
}

/**
 * FILL: write `value` into every element of the output buffer.  inputs[0]
 * is the shape tensor (already encoded in the output's compile-time shape
 * for our use case); inputs[1] is the scalar fill value.
 */
function opFill(op, state) {
  const value = state[op.inputs[1]][0];
  const out = state[op.outputs[0]];
  out.fill(value);
}

/**
 * PAD: pads each dimension by [front, back] zeros.  inputs[1] is a
 * constant int32 tensor of shape [rank, 2].  Optional inputs[2] is the
 * pad value (defaults to 0); we only support 0 here since openWakeWord
 * doesn't need anything else.
 */
function opPad(op, tensors, state) {
  const input = state[op.inputs[0]];
  const paddings = state[op.inputs[1]];
  const out = state[op.outputs[0]];
  const inMeta = tensors[op.inputs[0]];
  const outMeta = tensors[op.outputs[0]];

  const inShape = inMeta.shape;
  const outShape = outMeta.shape;
  const rank = inShape.length;

  // Read paddings: shape [rank, 2].  paddings[i*2] = front, [i*2+1] = back.
  const padFront = new Array(rank);
  for (let i = 0; i < rank; i++) padFront[i] = paddings[i * 2];

  out.fill(0);

  const inStrides = stridesOf(inShape);
  const outStrides = stridesOf(outShape);

  // Iterate every input element and write it at the offset position.
  for (let inFlat = 0; inFlat < input.length; inFlat++) {
    let rem = inFlat;
    let outFlat = 0;
    for (let d = 0; d < rank; d++) {
      const coord = Math.floor(rem / inStrides[d]);
      rem -= coord * inStrides[d];
      outFlat += (coord + padFront[d]) * outStrides[d];
    }
    out[outFlat] = input[inFlat];
  }
}
