/**
 * Tiny ONNX runner for openWakeWord models.
 *
 * This is intentionally not a general ONNX runtime.  It supports the small
 * op set used by the official openWakeWord mel spectrogram, embedding, and
 * classifier graphs.
 */

const TENSOR_FLOAT = 1;
const TENSOR_INT32 = 6;
const TENSOR_INT64 = 7;
const TENSOR_BOOL = 9;

const ATTR_FLOAT = 1;
const ATTR_INT = 2;
const ATTR_STRING = 3;
const ATTR_TENSOR = 4;
const ATTR_GRAPH = 5;
const ATTR_FLOATS = 6;
const ATTR_INTS = 7;

class ProtoReader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
    this.end = this.bytes.length;
  }

  eof() { return this.pos >= this.end; }

  readTag() {
    const tag = this.readVarint();
    return { field: tag >>> 3, wire: tag & 7 };
  }

  readVarint() {
    const result = this.readVarintBig();
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number(result);
  }

  readVarintBig() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.end) {
      const b = this.bytes[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw new Error('Unexpected EOF while reading varint');
  }

  readSignedVarint() {
    const value = this.readVarintBig();
    const signed = value >= (1n << 63n) ? value - (1n << 64n) : value;
    return Number(signed);
  }

  readFixed32() {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat32() {
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readBytes() {
    const len = this.readVarint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Unexpected EOF while reading bytes');
    return this.bytes.subarray(start, start + len);
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wire) {
    if (wire === 0) { this.readVarint(); return; }
    if (wire === 1) { this.pos += 8; return; }
    if (wire === 2) {
      const len = this.readVarint();
      this.pos += len;
      return;
    }
    if (wire === 5) { this.pos += 4; return; }
    throw new Error(`Unsupported protobuf wire type ${wire} at byte ${this.pos}`);
  }
}

function readMessage(bytes, fn) {
  const r = new ProtoReader(bytes);
  while (!r.eof()) {
    const tagPos = r.pos;
    const { field, wire } = r.readTag();
    fn(r, field, wire, tagPos);
  }
}

function parseModel(arrayBuffer) {
  let graph = null;
  readMessage(new Uint8Array(arrayBuffer), (r, field, wire, tagPos) => {
    if (field === 7 && wire === 2) graph = parseGraph(r.readBytes());
    else {
      try {
        r.skip(wire);
      } catch (err) {
        throw new Error(`ONNX model parse failed at root field=${field} wire=${wire} tagByte=${tagPos}: ${err.message}`);
      }
    }
  });
  if (!graph) throw new Error('ONNX model has no graph');
  return graph;
}

function parseGraph(bytes) {
  const graph = {
    nodes: [],
    initializers: new Map(),
    inputs: [],
    outputs: [],
  };
  readMessage(bytes, (r, field, wire) => {
    if (wire !== 2) { r.skip(wire); return; }
    if (field === 1) graph.nodes.push(parseNode(r.readBytes()));
    else if (field === 5) {
      const tensor = parseTensor(r.readBytes());
      graph.initializers.set(tensor.name, tensor);
    } else if (field === 11) graph.inputs.push(parseValueInfo(r.readBytes()));
    else if (field === 12) graph.outputs.push(parseValueInfo(r.readBytes()));
    else r.skip(wire);
  });
  return graph;
}

function parseNode(bytes) {
  const node = { inputs: [], outputs: [], opType: '', attrs: new Map() };
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 2) node.inputs.push(r.readString());
    else if (field === 2 && wire === 2) node.outputs.push(r.readString());
    else if (field === 4 && wire === 2) node.opType = r.readString();
    else if (field === 5 && wire === 2) {
      const attr = parseAttribute(r.readBytes());
      node.attrs.set(attr.name, attr);
    } else r.skip(wire);
  });
  return node;
}

function parseAttribute(bytes) {
  const attr = {
    name: '',
    type: 0,
    f: 0,
    i: 0,
    s: '',
    tensor: null,
    graph: null,
    floats: [],
    ints: [],
  };
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 2) attr.name = r.readString();
    else if (field === 2 && wire === 5) attr.f = r.readFloat32();
    else if (field === 3 && wire === 0) attr.i = r.readSignedVarint();
    else if (field === 4 && wire === 2) attr.s = r.readString();
    else if (field === 5 && wire === 2) attr.tensor = parseTensor(r.readBytes());
    else if (field === 6 && wire === 2) attr.graph = parseGraph(r.readBytes());
    else if (field === 7 && wire === 5) attr.floats.push(r.readFloat32());
    else if (field === 7 && wire === 2) attr.floats.push(...readPackedFloats(r.readBytes()));
    else if (field === 8 && wire === 0) attr.ints.push(r.readSignedVarint());
    else if (field === 8 && wire === 2) attr.ints.push(...readPackedSignedInts(r.readBytes()));
    else if (field === 20 && wire === 0) attr.type = r.readVarint();
    else r.skip(wire);
  });
  return attr;
}

function parseTensor(bytes) {
  const tensor = {
    name: '',
    dataType: 0,
    shape: [],
    rawData: null,
    floatData: [],
    int32Data: [],
    int64Data: [],
  };
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 0) tensor.shape.push(r.readSignedVarint());
    else if (field === 1 && wire === 2) tensor.shape.push(...readPackedSignedInts(r.readBytes()));
    else if (field === 2 && wire === 0) tensor.dataType = r.readVarint();
    else if (field === 4 && wire === 5) tensor.floatData.push(r.readFloat32());
    else if (field === 4 && wire === 2) tensor.floatData.push(...readPackedFloats(r.readBytes()));
    else if (field === 5 && wire === 0) tensor.int32Data.push(r.readSignedVarint());
    else if (field === 5 && wire === 2) tensor.int32Data.push(...readPackedSignedInts(r.readBytes()));
    else if (field === 7 && wire === 0) tensor.int64Data.push(r.readSignedVarint());
    else if (field === 7 && wire === 2) tensor.int64Data.push(...readPackedInt64(r.readBytes()));
    else if (field === 8 && wire === 2) tensor.name = r.readString();
    else if (field === 9 && wire === 2) tensor.rawData = r.readBytes();
    else r.skip(wire);
  });
  return tensorFromProto(tensor);
}

function parseValueInfo(bytes) {
  const info = { name: '', shape: [] };
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 2) info.name = r.readString();
    else if (field === 2 && wire === 2) info.shape = parseType(r.readBytes());
    else r.skip(wire);
  });
  return info;
}

function parseType(bytes) {
  let shape = [];
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 2) shape = parseTensorType(r.readBytes());
    else r.skip(wire);
  });
  return shape;
}

function parseTensorType(bytes) {
  let shape = [];
  readMessage(bytes, (r, field, wire) => {
    if (field === 2 && wire === 2) shape = parseShape(r.readBytes());
    else r.skip(wire);
  });
  return shape;
}

function parseShape(bytes) {
  const dims = [];
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 2) dims.push(parseDimension(r.readBytes()));
    else r.skip(wire);
  });
  return dims;
}

function parseDimension(bytes) {
  let value = 0;
  readMessage(bytes, (r, field, wire) => {
    if (field === 1 && wire === 0) value = r.readVarint();
    else r.skip(wire);
  });
  return value;
}

function readPackedFloats(bytes) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i += 4) out.push(dv.getFloat32(i, true));
  return out;
}

function readPackedInts(bytes) {
  const r = new ProtoReader(bytes);
  const out = [];
  while (!r.eof()) out.push(r.readVarint());
  return out;
}

function readPackedSignedInts(bytes) {
  const r = new ProtoReader(bytes);
  const out = [];
  while (!r.eof()) out.push(r.readSignedVarint());
  return out;
}

function readPackedInt64(bytes) {
  return readPackedSignedInts(bytes);
}

function tensorFromProto(t) {
  let data;
  if (t.rawData) data = readRawTensor(t.rawData, t.dataType);
  else if (t.dataType === TENSOR_FLOAT) data = new Float32Array(t.floatData);
  else if (t.dataType === TENSOR_INT32) data = new Int32Array(t.int32Data);
  else if (t.dataType === TENSOR_INT64) data = new Int32Array(t.int64Data);
  else if (t.dataType === TENSOR_BOOL) data = new Uint8Array(t.int32Data);
  else throw new Error(`Unsupported ONNX tensor type ${t.dataType}`);
  return { name: t.name, type: t.dataType, shape: t.shape, data };
}

function readRawTensor(raw, dataType) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dataType === TENSOR_FLOAT) {
    const out = new Float32Array(raw.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  if (dataType === TENSOR_INT32) {
    const out = new Int32Array(raw.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
    return out;
  }
  if (dataType === TENSOR_INT64) {
    const out = new Int32Array(raw.byteLength / 8);
    for (let i = 0; i < out.length; i++) out[i] = Number(dv.getBigInt64(i * 8, true));
    return out;
  }
  if (dataType === TENSOR_BOOL) return new Uint8Array(raw);
  throw new Error(`Unsupported ONNX raw tensor type ${dataType}`);
}

function cloneTensor(t) {
  return { shape: t.shape.slice(), data: t.data };
}

export function compileOwwOnnxModel(arrayBuffer, opts = {}) {
  return new OwwOnnxModel(parseModel(arrayBuffer), opts);
}

export function compileOwwOnnxClassifier(arrayBuffer) {
  return compileOwwOnnxModel(arrayBuffer);
}

class OwwOnnxModel {
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.inputName = graph.inputs.find((input) => !graph.initializers.has(input.name))?.name;
    this.outputName = graph.outputs[0]?.name;
    this.inputShape = opts.inputShape || null;
    if (!this.inputName || !this.outputName) {
      throw new Error('ONNX graph is missing input/output metadata');
    }
    this.primaryIndex = 0;
    this.subgraphs = [indexGraphForGpu(graph, this.inputName, this.outputName, this.inputShape)];
    this.tensors = this.subgraphs[0].tensors;
    this.ops = this.subgraphs[0].ops;
    this.inputIds = this.subgraphs[0].inputIds;
    this.outputIds = this.subgraphs[0].outputIds;
  }

  createState() {
    const state = new Map();
    for (const [name, tensor] of this.graph.initializers) {
      state.set(name, cloneTensor(tensor));
    }
    return state;
  }

  invoke(inputData, opts = {}) {
    const state = opts.state || this.createState();
    const inputMeta = this.graph.inputs.find((i) => i.name === this.inputName);
    state.set(this.inputName, {
      shape: opts.inputShape || this.inputShape || normalizeInputShape(inputMeta?.shape, inputData.length),
      data: inputData,
    });
    runGraph(this.graph, state);
    const out = state.get(this.outputName);
    if (!out) throw new Error(`ONNX output not produced: ${this.outputName}`);
    return out.data;
  }
}

function indexGraphForGpu(graph, inputName, outputName, inputShape) {
  const idByName = new Map();
  const tensors = [];
  const ops = [];

  const ensureTensor = (name, shape = null, data = null) => {
    if (!idByName.has(name)) {
      idByName.set(name, tensors.length);
      tensors.push({
        id: tensors.length,
        name,
        type: data && !(data instanceof Float32Array) ? 2 : 0,
        shape: shape ? shape.slice() : [],
        constant: data || null,
      });
    } else if (shape && (!tensors[idByName.get(name)].shape?.length || tensors[idByName.get(name)].shape.includes(0))) {
      tensors[idByName.get(name)].shape = shape.slice();
    }
    return idByName.get(name);
  };

  for (const [name, tensor] of graph.initializers) {
    ensureTensor(name, tensor.shape, tensor.data);
  }
  ensureTensor(inputName, inputShape || normalizeInputShape(graph.inputs.find((i) => i.name === inputName)?.shape, 0));

  const shapeOf = (name) => tensors[ensureTensor(name)].shape;
  const dataOf = (name) => tensors[ensureTensor(name)].constant;
  const setShape = (name, shape, data = null) => {
    const id = ensureTensor(name, shape, data);
    tensors[id].shape = shape.slice();
    if (data) tensors[id].constant = data;
  };

  for (const node of graph.nodes) {
    let outShape = null;
    let outData = null;
    switch (node.opType) {
      case 'Constant': {
        const t = tensorAttr(node, 'value');
        outShape = t.shape;
        outData = t.data;
        break;
      }
      case 'Identity':
      case 'LayerNormalization':
      case 'Log':
      case 'LeakyRelu':
      case 'Relu':
      case 'Sigmoid':
      case 'Sqrt':
      case 'Reciprocal':
      case 'Clip':
      case 'Cast':
        outShape = shapeOf(node.inputs[0]);
        break;
      case 'Unsqueeze':
        outShape = inferUnsqueezeShape(shapeOf(node.inputs[0]), dataOf(node.inputs[1]) ? Array.from(dataOf(node.inputs[1])) : intsAttr(node, 'axes') || []);
        break;
      case 'Flatten': {
        // Merges the first `axis` dims into the outer dim, the rest
        // into the inner dim.  PyTorch nn.Linear emits Flatten(axis=1)
        // before Gemm, so e.g. [1, 48, 12, 5] → [1, 2880].  Without
        // this case the default branch keeps the input shape and the
        // GPU Gemm dispatch fails on rank-4 input.
        const inShape = shapeOf(node.inputs[0]);
        const rank = inShape.length;
        let axis = intAttr(node, 'axis', 1);
        if (axis < 0) axis += rank;
        let outer = 1;
        for (let i = 0; i < axis; i++) outer *= inShape[i];
        let inner = 1;
        for (let i = axis; i < rank; i++) inner *= inShape[i];
        outShape = [outer, inner];
        break;
      }
      case 'Reshape':
        outShape = inferReshapeShape(shapeOf(node.inputs[0]), dataOf(node.inputs[1]));
        break;
      case 'Transpose':
        outShape = inferTransposeShape(shapeOf(node.inputs[0]), intsAttr(node, 'perm'));
        break;
      case 'Conv':
        outShape = inferConvShape(shapeOf(node.inputs[0]), shapeOf(node.inputs[1]), node);
        break;
      case 'MaxPool':
        outShape = inferMaxPoolShape(shapeOf(node.inputs[0]), node);
        break;
      case 'MatMul':
        outShape = inferMatMulShape(shapeOf(node.inputs[0]), shapeOf(node.inputs[1]));
        break;
      case 'Gemm':
        outShape = inferGemmShape(shapeOf(node.inputs[0]), shapeOf(node.inputs[1]), intAttr(node, 'transA', 0) !== 0, intAttr(node, 'transB', 0) !== 0);
        break;
      case 'ReduceMean':
      case 'ReduceMax':
        outShape = inferReduceShape(shapeOf(node.inputs[0]), intsAttr(node, 'axes'), intAttr(node, 'keepdims', 1) !== 0);
        break;
      case 'Slice': {
        // opset 13+: starts/ends/axes/steps are input tensors, not attributes.
        // For a static graph the exporter folds them to Constants whose data
        // we already have via dataOf(); without that we can't infer shape.
        const inShape = shapeOf(node.inputs[0]);
        const startsData = dataOf(node.inputs[1]);
        const endsData = dataOf(node.inputs[2]);
        const axesData = node.inputs.length > 3 ? dataOf(node.inputs[3]) : null;
        const stepsData = node.inputs.length > 4 ? dataOf(node.inputs[4]) : null;
        if (startsData && endsData) {
          outShape = inferSliceShape(
            inShape,
            Array.from(startsData),
            Array.from(endsData),
            axesData ? Array.from(axesData) : null,
            stepsData ? Array.from(stepsData) : null,
          );
        } else {
          outShape = inShape;
        }
        break;
      }
      case 'Concat': {
        const axis = intAttr(node, 'axis', 0);
        const firstShape = shapeOf(node.inputs[0]);
        const rank = firstShape.length;
        const a = axis < 0 ? axis + rank : axis;
        let total = 0;
        for (const name of node.inputs) total += shapeOf(name)[a];
        outShape = firstShape.slice();
        outShape[a] = total;
        break;
      }
      case 'Add':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'Pow':
      case 'Max':
      case 'GreaterOrEqual':
        outShape = broadcastShape(shapeOf(node.inputs[0]), shapeOf(node.inputs[1]));
        break;
      default:
        outShape = shapeOf(node.inputs[0]) || [];
        break;
    }
    for (const output of node.outputs) setShape(output, outShape || [], outData);
    ops.push({
      opName: node.opType,
      inputs: node.inputs.filter(Boolean).map((name) => ensureTensor(name)),
      outputs: node.outputs.map((name) => ensureTensor(name)),
      node,
    });
  }

  return {
    tensors,
    ops,
    inputIds: [ensureTensor(inputName)],
    outputIds: [ensureTensor(outputName)],
  };
}

function inferUnsqueezeShape(shape, axes) {
  const out = shape.slice();
  const rank = shape.length + axes.length;
  const normalized = axes.map((a) => a < 0 ? a + rank : a).sort((a, b) => a - b);
  for (const axis of normalized) out.splice(axis, 0, 1);
  return out;
}

function inferReshapeShape(inputShape, shapeData) {
  if (!shapeData) return inputShape.slice();
  const shape = Array.from(shapeData);
  let known = 1;
  let inferAt = -1;
  const inputSize = product(inputShape);
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] === 0) shape[i] = inputShape[i];
    if (shape[i] === -1) inferAt = i;
    else known *= shape[i];
  }
  if (inferAt >= 0) shape[inferAt] = inputSize / known;
  return shape;
}

function inferTransposeShape(shape, perm) {
  const p = perm || shape.map((_, i) => shape.length - 1 - i);
  return p.map((i) => shape[i]);
}

function inferConvShape(inputShape, weightShape, node) {
  const strides = intsAttr(node, 'strides') || new Array(inputShape.length - 2).fill(1);
  const pads = intsAttr(node, 'pads') || new Array((inputShape.length - 2) * 2).fill(0);
  const dilations = intsAttr(node, 'dilations') || new Array(inputShape.length - 2).fill(1);
  const spatial = [];
  for (let i = 0; i < inputShape.length - 2; i++) {
    const inDim = inputShape[i + 2];
    const kernel = weightShape[i + 2];
    const out = Math.floor((inDim + pads[i] + pads[i + inputShape.length - 2] - dilations[i] * (kernel - 1) - 1) / strides[i] + 1);
    spatial.push(out);
  }
  return [inputShape[0], weightShape[0], ...spatial];
}

function inferMaxPoolShape(inputShape, node) {
  const kernel = intsAttr(node, 'kernel_shape') || new Array(inputShape.length - 2).fill(1);
  const strides = intsAttr(node, 'strides') || kernel;
  const pads = intsAttr(node, 'pads') || new Array((inputShape.length - 2) * 2).fill(0);
  const spatial = [];
  for (let i = 0; i < inputShape.length - 2; i++) {
    spatial.push(Math.floor((inputShape[i + 2] + pads[i] + pads[i + inputShape.length - 2] - kernel[i]) / strides[i] + 1));
  }
  return [inputShape[0], inputShape[1], ...spatial];
}

function inferMatMulShape(a, b) {
  return [...a.slice(0, -2), a[a.length - 2], b[b.length - 1]];
}

function inferGemmShape(a, b, transA, transB) {
  const M = transA ? a[1] : a[0];
  const N = transB ? b[0] : b[1];
  return [M, N];
}

function inferReduceShape(shape, axes, keepdims) {
  const rank = shape.length;
  const reduceAxes = new Set((axes || shape.map((_, i) => i)).map((a) => a < 0 ? a + rank : a));
  const out = [];
  for (let i = 0; i < rank; i++) {
    if (reduceAxes.has(i)) {
      if (keepdims) out.push(1);
    } else out.push(shape[i]);
  }
  return out.length ? out : [1];
}

function inferSliceShape(shape, starts, ends, axes, steps) {
  const rank = shape.length;
  const ax = axes || starts.map((_, i) => i);
  const stp = steps || starts.map(() => 1);
  const out = shape.slice();
  for (let i = 0; i < ax.length; i++) {
    const rawAxis = ax[i];
    const axis = rawAxis < 0 ? rawAxis + rank : rawAxis;
    const dim = shape[axis];
    let s = starts[i];
    let e = ends[i];
    const step = stp[i] || 1;
    if (s < 0) s += dim;
    if (e < 0) e += dim;
    if (step > 0) {
      s = Math.max(0, Math.min(s, dim));
      e = Math.max(0, Math.min(e, dim));
      out[axis] = Math.max(0, Math.ceil((e - s) / step));
    } else {
      s = Math.max(0, Math.min(s, dim - 1));
      e = Math.max(-1, Math.min(e, dim - 1));
      out[axis] = Math.max(0, Math.ceil((s - e) / -step));
    }
  }
  return out;
}

function runGraph(graph, state) {
  for (const node of graph.nodes) {
    executeNode(node, state);
  }
  return state;
}

function executeNode(node, state) {
  switch (node.opType) {
    case 'Constant': return setOutput(state, node, tensorAttr(node, 'value'));
    case 'Identity': return setOutput(state, node, getTensor(state, node.inputs[0]));
    case 'Flatten': return setOutput(state, node, opFlatten(getTensor(state, node.inputs[0]), intAttr(node, 'axis', 1)));
    case 'Reshape': return setOutput(state, node, opReshape(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]).data));
    case 'Unsqueeze': return setOutput(state, node, opUnsqueeze(getTensor(state, node.inputs[0]), axesForNode(node, state)));
    case 'Transpose': return setOutput(state, node, opTranspose(getTensor(state, node.inputs[0]), intsAttr(node, 'perm')));
    case 'Conv': return setOutput(state, node, opConv(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), getOptionalTensor(state, node.inputs[2]), node));
    case 'MaxPool': return setOutput(state, node, opMaxPool(getTensor(state, node.inputs[0]), node));
    case 'MatMul': return setOutput(state, node, opMatMul(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1])));
    case 'Gemm': return setOutput(state, node, opGemm(
      getTensor(state, node.inputs[0]),
      getTensor(state, node.inputs[1]),
      getOptionalTensor(state, node.inputs[2]),
      floatAttr(node, 'alpha', 1),
      floatAttr(node, 'beta', 1),
      intAttr(node, 'transA', 0) !== 0,
      intAttr(node, 'transB', 0) !== 0,
    ));
    case 'ReduceMean': return setOutput(state, node, opReduceMean(getTensor(state, node.inputs[0]), intsAttr(node, 'axes'), intAttr(node, 'keepdims', 1) !== 0));
    case 'LayerNormalization': return setOutput(state, node, opLayerNormalization(
      getTensor(state, node.inputs[0]),
      getTensor(state, node.inputs[1]),
      getOptionalTensor(state, node.inputs[2]),
      intAttr(node, 'axis', -1),
      floatAttr(node, 'epsilon', 1e-5),
    ));
    case 'Add': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a + b));
    case 'Sub': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a - b));
    case 'Mul': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a * b));
    case 'Div': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a / b));
    case 'Pow': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), Math.pow));
    case 'Sqrt': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), Math.sqrt));
    case 'Log': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), Math.log));
    case 'Reciprocal': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), (x) => 1 / x));
    case 'Max': return setOutput(state, node, opBroadcast(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a > b ? a : b));
    case 'Clip': return setOutput(state, node, opClip(getTensor(state, node.inputs[0]), getOptionalTensor(state, node.inputs[1]), getOptionalTensor(state, node.inputs[2])));
    case 'ReduceMax': return setOutput(state, node, opReduceMax(getTensor(state, node.inputs[0]), intsAttr(node, 'axes'), intAttr(node, 'keepdims', 1) !== 0));
    case 'Slice': {
      const data = getTensor(state, node.inputs[0]);
      const starts = Array.from(getTensor(state, node.inputs[1]).data);
      const ends = Array.from(getTensor(state, node.inputs[2]).data);
      const axes = node.inputs.length > 3
        ? Array.from(getTensor(state, node.inputs[3]).data)
        : starts.map((_, i) => i);
      const steps = node.inputs.length > 4
        ? Array.from(getTensor(state, node.inputs[4]).data)
        : starts.map(() => 1);
      return setOutput(state, node, opSlice(data, starts, ends, axes, steps));
    }
    case 'Concat': {
      const inputs = node.inputs.map((name) => getTensor(state, name));
      return setOutput(state, node, opConcat(inputs, intAttr(node, 'axis', 0)));
    }
    case 'LeakyRelu': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), (x) => x >= 0 ? x : x * floatAttr(node, 'alpha', 0.01)));
    case 'Relu': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), (x) => x > 0 ? x : 0));
    case 'Sigmoid': return setOutput(state, node, opUnary(getTensor(state, node.inputs[0]), (x) => 1 / (1 + Math.exp(-x))));
    case 'GreaterOrEqual': return setOutput(state, node, opBroadcastBool(getTensor(state, node.inputs[0]), getTensor(state, node.inputs[1]), (a, b) => a >= b));
    case 'Cast': return setOutput(state, node, opCast(getTensor(state, node.inputs[0]), intAttr(node, 'to', TENSOR_FLOAT)));
    case 'If': return executeIf(node, state);
    default:
      throw new Error(`Unsupported ONNX classifier op: ${node.opType}`);
  }
}

function getTensor(state, name) {
  const tensor = state.get(name);
  if (!tensor) throw new Error(`ONNX tensor not found: ${name}`);
  return tensor;
}

function getOptionalTensor(state, name) {
  return name ? getTensor(state, name) : null;
}

function setOutput(state, node, tensor) {
  state.set(node.outputs[0], tensor);
}

function attr(node, name) {
  return node.attrs.get(name) || null;
}

function intAttr(node, name, fallback) {
  const a = attr(node, name);
  return a && a.type === ATTR_INT ? a.i : fallback;
}

function floatAttr(node, name, fallback) {
  const a = attr(node, name);
  return a && a.type === ATTR_FLOAT ? a.f : fallback;
}

function intsAttr(node, name) {
  const a = attr(node, name);
  return a && a.type === ATTR_INTS ? a.ints.slice() : null;
}

function tensorAttr(node, name) {
  const a = attr(node, name);
  if (!a || a.type !== ATTR_TENSOR || !a.tensor) {
    throw new Error(`ONNX node ${node.opType} missing tensor attr ${name}`);
  }
  return cloneTensor(a.tensor);
}

function graphAttr(node, name) {
  const a = attr(node, name);
  if (!a || a.type !== ATTR_GRAPH || !a.graph) {
    throw new Error(`ONNX node ${node.opType} missing graph attr ${name}`);
  }
  return a.graph;
}

function opFlatten(input, axis) {
  const rank = input.shape.length;
  if (axis < 0) axis += rank;
  const outer = product(input.shape.slice(0, axis));
  const inner = product(input.shape.slice(axis));
  return { shape: [outer, inner], data: input.data };
}

function opReshape(input, shapeData) {
  const shape = Array.from(shapeData);
  let known = 1;
  let inferAt = -1;
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] === 0) shape[i] = input.shape[i];
    if (shape[i] === -1) inferAt = i;
    else known *= shape[i];
  }
  if (inferAt >= 0) shape[inferAt] = input.data.length / known;
  return { shape, data: input.data };
}

function opUnsqueeze(input, axes) {
  const outShape = input.shape.slice();
  const rank = input.shape.length + axes.length;
  const normalized = axes.map((a) => a < 0 ? a + rank : a).sort((a, b) => a - b);
  for (const axis of normalized) outShape.splice(axis, 0, 1);
  return { shape: outShape, data: input.data };
}

function opTranspose(input, perm) {
  const rank = input.shape.length;
  const p = perm || input.shape.map((_, i) => rank - 1 - i);
  const outShape = p.map((i) => input.shape[i]);
  const out = new Float32Array(input.data.length);
  const inStrides = stridesOf(input.shape);
  const outStrides = stridesOf(outShape);
  for (let outFlat = 0; outFlat < out.length; outFlat++) {
    let rem = outFlat;
    let inFlat = 0;
    for (let d = 0; d < outShape.length; d++) {
      const coord = Math.floor(rem / outStrides[d]);
      rem -= coord * outStrides[d];
      inFlat += coord * inStrides[p[d]];
    }
    out[outFlat] = input.data[inFlat];
  }
  return { shape: outShape, data: out };
}

function opSlice(input, starts, ends, axes, steps) {
  const inShape = input.shape;
  const rank = inShape.length;
  const offset = new Array(rank).fill(0);
  const step = new Array(rank).fill(1);
  const outShape = inShape.slice();
  for (let i = 0; i < axes.length; i++) {
    const rawAxis = axes[i];
    const a = rawAxis < 0 ? rawAxis + rank : rawAxis;
    const dim = inShape[a];
    let s = starts[i];
    let e = ends[i];
    const stp = steps[i] || 1;
    if (s < 0) s += dim;
    if (e < 0) e += dim;
    if (stp > 0) {
      s = Math.max(0, Math.min(s, dim));
      e = Math.max(0, Math.min(e, dim));
      outShape[a] = Math.max(0, Math.ceil((e - s) / stp));
    } else {
      s = Math.max(0, Math.min(s, dim - 1));
      e = Math.max(-1, Math.min(e, dim - 1));
      outShape[a] = Math.max(0, Math.ceil((s - e) / -stp));
    }
    offset[a] = s;
    step[a] = stp;
  }
  const outSize = product(outShape);
  const out = new Float32Array(outSize);
  const inStrides = stridesOf(inShape);
  const idx = new Array(rank).fill(0);
  for (let o = 0; o < outSize; o++) {
    let inFlat = 0;
    for (let d = 0; d < rank; d++) inFlat += (offset[d] + idx[d] * step[d]) * inStrides[d];
    out[o] = input.data[inFlat];
    for (let d = rank - 1; d >= 0; d--) {
      if (++idx[d] < outShape[d]) break;
      idx[d] = 0;
    }
  }
  return { shape: outShape, data: out };
}

function opConcat(inputs, axis) {
  const firstShape = inputs[0].shape;
  const rank = firstShape.length;
  const a = axis < 0 ? axis + rank : axis;
  const outShape = firstShape.slice();
  outShape[a] = inputs.reduce((sum, t) => sum + t.shape[a], 0);
  const outerSize = firstShape.slice(0, a).reduce((p, v) => p * v, 1);
  const innerSize = firstShape.slice(a + 1).reduce((p, v) => p * v, 1);
  const outAxis = outShape[a];
  const out = new Float32Array(outerSize * outAxis * innerSize);
  let writeOffsetInAxis = 0;
  for (const inp of inputs) {
    const inAxis = inp.shape[a];
    const chunk = inAxis * innerSize;
    for (let outer = 0; outer < outerSize; outer++) {
      const srcStart = outer * chunk;
      const dstStart = outer * outAxis * innerSize + writeOffsetInAxis * innerSize;
      out.set(inp.data.subarray(srcStart, srcStart + chunk), dstStart);
    }
    writeOffsetInAxis += inAxis;
  }
  return { shape: outShape, data: out };
}

function opConv(input, weights, bias, node) {
  if (input.shape.length === 3) return opConv1d(input, weights, bias, node);
  if (input.shape.length === 4) return opConv2d(input, weights, bias, node);
  throw new Error(`Conv rank ${input.shape.length} is not supported`);
}

function opConv1d(input, weights, bias, node) {
  const [N, C, W] = input.shape;
  const [M, wC, kW] = weights.shape;
  if (wC !== C) throw new Error(`Conv1d channel mismatch ${wC} vs ${C}`);
  const strides = intsAttr(node, 'strides') || [1];
  const pads = intsAttr(node, 'pads') || [0, 0];
  const dilations = intsAttr(node, 'dilations') || [1];
  const stride = strides[0];
  const dilation = dilations[0];
  const outW = Math.floor((W + pads[0] + pads[1] - dilation * (kW - 1) - 1) / stride + 1);
  const out = new Float32Array(N * M * outW);
  for (let n = 0; n < N; n++) {
    for (let m = 0; m < M; m++) {
      for (let ow = 0; ow < outW; ow++) {
        let acc = bias ? bias.data[m] : 0;
        for (let c = 0; c < C; c++) {
          for (let kw = 0; kw < kW; kw++) {
            const iw = ow * stride + kw * dilation - pads[0];
            if (iw < 0 || iw >= W) continue;
            acc += input.data[(n * C + c) * W + iw] * weights.data[(m * C + c) * kW + kw];
          }
        }
        out[(n * M + m) * outW + ow] = acc;
      }
    }
  }
  return { shape: [N, M, outW], data: out };
}

function opConv2d(input, weights, bias, node) {
  const [N, C, H, W] = input.shape;
  const [M, wC, kH, kW] = weights.shape;
  if (wC !== C) throw new Error(`Conv2d channel mismatch ${wC} vs ${C}`);
  const strides = intsAttr(node, 'strides') || [1, 1];
  const pads = intsAttr(node, 'pads') || [0, 0, 0, 0];
  const dilations = intsAttr(node, 'dilations') || [1, 1];
  const outH = Math.floor((H + pads[0] + pads[2] - dilations[0] * (kH - 1) - 1) / strides[0] + 1);
  const outW = Math.floor((W + pads[1] + pads[3] - dilations[1] * (kW - 1) - 1) / strides[1] + 1);
  const out = new Float32Array(N * M * outH * outW);
  const inHW = H * W;
  const outHW = outH * outW;
  const wHW = kH * kW;
  for (let n = 0; n < N; n++) {
    const nBase = n * C * inHW;
    for (let m = 0; m < M; m++) {
      const wMBase = m * C * wHW;
      for (let oh = 0; oh < outH; oh++) {
        for (let ow = 0; ow < outW; ow++) {
          let acc = bias ? bias.data[m] : 0;
          for (let c = 0; c < C; c++) {
            const inCBase = nBase + c * inHW;
            const wCBase = wMBase + c * wHW;
            for (let kh = 0; kh < kH; kh++) {
              const ih = oh * strides[0] + kh * dilations[0] - pads[0];
              if (ih < 0 || ih >= H) continue;
              for (let kw = 0; kw < kW; kw++) {
                const iw = ow * strides[1] + kw * dilations[1] - pads[1];
                if (iw < 0 || iw >= W) continue;
                acc += input.data[inCBase + ih * W + iw] * weights.data[wCBase + kh * kW + kw];
              }
            }
          }
          out[(n * M + m) * outHW + oh * outW + ow] = acc;
        }
      }
    }
  }
  return { shape: [N, M, outH, outW], data: out };
}

function opMaxPool(input, node) {
  const [N, C, H, W] = input.shape;
  const kernel = intsAttr(node, 'kernel_shape') || [1, 1];
  const strides = intsAttr(node, 'strides') || kernel;
  const pads = intsAttr(node, 'pads') || [0, 0, 0, 0];
  const outH = Math.floor((H + pads[0] + pads[2] - kernel[0]) / strides[0] + 1);
  const outW = Math.floor((W + pads[1] + pads[3] - kernel[1]) / strides[1] + 1);
  const out = new Float32Array(N * C * outH * outW);
  const inHW = H * W;
  const outHW = outH * outW;
  for (let n = 0; n < N; n++) {
    for (let c = 0; c < C; c++) {
      const inBase = (n * C + c) * inHW;
      const outBase = (n * C + c) * outHW;
      for (let oh = 0; oh < outH; oh++) {
        for (let ow = 0; ow < outW; ow++) {
          let mx = -Infinity;
          for (let kh = 0; kh < kernel[0]; kh++) {
            const ih = oh * strides[0] + kh - pads[0];
            if (ih < 0 || ih >= H) continue;
            for (let kw = 0; kw < kernel[1]; kw++) {
              const iw = ow * strides[1] + kw - pads[1];
              if (iw < 0 || iw >= W) continue;
              const v = input.data[inBase + ih * W + iw];
              if (v > mx) mx = v;
            }
          }
          out[outBase + oh * outW + ow] = mx === -Infinity ? 0 : mx;
        }
      }
    }
  }
  return { shape: [N, C, outH, outW], data: out };
}

function opMatMul(a, b) {
  if (b.shape.length !== 2 || a.shape.length < 2) {
    throw new Error(`MatMul only supports [...,M,K] @ [K,N], got ${a.shape} @ ${b.shape}`);
  }
  const M = a.shape[a.shape.length - 2];
  const K = a.shape[a.shape.length - 1];
  const Kb = b.shape[0];
  const N = b.shape[1];
  if (K !== Kb) throw new Error(`MatMul dimension mismatch: ${K} vs ${Kb}`);
  const batchShape = a.shape.slice(0, -2);
  const batch = product(batchShape);
  const out = new Float32Array(batch * M * N);
  for (let bi = 0; bi < batch; bi++) {
    const aBase = bi * M * K;
    const outBase = bi * M * N;
    for (let m = 0; m < M; m++) {
      for (let n = 0; n < N; n++) {
        let acc = 0;
        for (let k = 0; k < K; k++) acc += a.data[aBase + m * K + k] * b.data[k * N + n];
        out[outBase + m * N + n] = acc;
      }
    }
  }
  return { shape: [...batchShape, M, N], data: out };
}

function opGemm(a, b, c, alpha, beta, transA, transB) {
  const aShape = a.shape.length === 1 ? [1, a.shape[0]] : a.shape;
  const bShape = b.shape.length === 1 ? [b.shape[0], 1] : b.shape;
  const M = transA ? aShape[1] : aShape[0];
  const K = transA ? aShape[0] : aShape[1];
  const N = transB ? bShape[0] : bShape[1];
  const bK = transB ? bShape[1] : bShape[0];
  if (K !== bK) throw new Error(`Gemm dimension mismatch: ${K} vs ${bK}`);
  const out = new Float32Array(M * N);
  for (let m = 0; m < M; m++) {
    for (let n = 0; n < N; n++) {
      let acc = 0;
      for (let k = 0; k < K; k++) {
        const av = transA ? a.data[k * M + m] : a.data[m * K + k];
        const bv = transB ? b.data[n * K + k] : b.data[k * N + n];
        acc += av * bv;
      }
      const bias = c ? c.data[c.data.length === 1 ? 0 : n] : 0;
      out[m * N + n] = alpha * acc + beta * bias;
    }
  }
  return { shape: [M, N], data: out };
}

function opReduceMean(input, axes, keepdims) {
  const rank = input.shape.length;
  const reduceAxes = new Set((axes || input.shape.map((_, i) => i)).map((a) => a < 0 ? a + rank : a));
  const outShape = [];
  for (let i = 0; i < rank; i++) {
    if (reduceAxes.has(i)) {
      if (keepdims) outShape.push(1);
    } else outShape.push(input.shape[i]);
  }
  const finalShape = outShape.length ? outShape : [1];
  const out = new Float32Array(product(finalShape));
  const counts = new Int32Array(out.length);
  const inStrides = stridesOf(input.shape);
  const outStrides = stridesOf(finalShape);
  for (let flat = 0; flat < input.data.length; flat++) {
    let rem = flat;
    let outDim = 0;
    let outFlat = 0;
    for (let d = 0; d < rank; d++) {
      const coord = Math.floor(rem / inStrides[d]);
      rem -= coord * inStrides[d];
      if (reduceAxes.has(d)) {
        if (keepdims) outDim++;
      } else {
        outFlat += coord * outStrides[outDim++];
      }
    }
    out[outFlat] += input.data[flat];
    counts[outFlat]++;
  }
  for (let i = 0; i < out.length; i++) out[i] /= counts[i] || 1;
  return { shape: finalShape, data: out };
}

function opLayerNormalization(input, scale, bias, axis, epsilon) {
  const rank = input.shape.length;
  const normAxis = axis < 0 ? axis + rank : axis;
  if (normAxis < 0 || normAxis >= rank) {
    throw new Error(`LayerNormalization axis ${axis} is invalid for shape ${input.shape}`);
  }
  const outer = product(input.shape.slice(0, normAxis));
  const inner = product(input.shape.slice(normAxis));
  if (scale.data.length !== inner && scale.data.length !== 1) {
    throw new Error(`LayerNormalization scale length ${scale.data.length} does not match normalized size ${inner}`);
  }
  if (bias && bias.data.length !== inner && bias.data.length !== 1) {
    throw new Error(`LayerNormalization bias length ${bias.data.length} does not match normalized size ${inner}`);
  }
  const out = new Float32Array(input.data.length);
  const x = input.data;
  const gamma = scale.data;
  const beta = bias?.data || null;
  for (let o = 0; o < outer; o++) {
    const base = o * inner;
    let mean = 0;
    for (let i = 0; i < inner; i++) mean += x[base + i];
    mean /= inner;
    let variance = 0;
    for (let i = 0; i < inner; i++) {
      const d = x[base + i] - mean;
      variance += d * d;
    }
    const invStd = 1 / Math.sqrt(variance / inner + epsilon);
    for (let i = 0; i < inner; i++) {
      out[base + i] = (x[base + i] - mean) * invStd
        * gamma[gamma.length === 1 ? 0 : i]
        + (beta ? beta[beta.length === 1 ? 0 : i] : 0);
    }
  }
  return { shape: input.shape.slice(), data: out };
}

function opUnary(input, fn) {
  const out = new Float32Array(input.data.length);
  for (let i = 0; i < out.length; i++) out[i] = fn(input.data[i]);
  return { shape: input.shape.slice(), data: out };
}

function opBroadcast(a, b, fn) {
  const shape = broadcastShape(a.shape, b.shape);
  const out = new Float32Array(product(shape));
  fillBroadcast(out, shape, a, b, fn);
  return { shape, data: out };
}

function opBroadcastBool(a, b, fn) {
  const shape = broadcastShape(a.shape, b.shape);
  const out = new Uint8Array(product(shape));
  fillBroadcast(out, shape, a, b, (x, y) => fn(x, y) ? 1 : 0);
  return { shape, data: out };
}

function fillBroadcast(out, shape, a, b, fn) {
  const outStrides = stridesOf(shape);
  const aStrides = broadcastStrides(a.shape, shape);
  const bStrides = broadcastStrides(b.shape, shape);
  for (let flat = 0; flat < out.length; flat++) {
    let rem = flat;
    let ai = 0;
    let bi = 0;
    for (let d = 0; d < shape.length; d++) {
      const coord = Math.floor(rem / outStrides[d]);
      rem -= coord * outStrides[d];
      ai += coord * aStrides[d];
      bi += coord * bStrides[d];
    }
    out[flat] = fn(a.data[ai], b.data[bi]);
  }
}

function opCast(input, toType) {
  if (toType === TENSOR_BOOL) {
    const out = new Uint8Array(input.data.length);
    for (let i = 0; i < out.length; i++) out[i] = input.data[i] ? 1 : 0;
    return { shape: input.shape.slice(), data: out };
  }
  if (toType === TENSOR_FLOAT) {
    const out = new Float32Array(input.data.length);
    for (let i = 0; i < out.length; i++) out[i] = input.data[i];
    return { shape: input.shape.slice(), data: out };
  }
  throw new Error(`Unsupported ONNX Cast target ${toType}`);
}

function opClip(input, minTensor, maxTensor) {
  const min = minTensor ? minTensor.data[0] : -Infinity;
  const max = maxTensor ? maxTensor.data[0] : Infinity;
  const out = new Float32Array(input.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = input.data[i];
    out[i] = v < min ? min : (v > max ? max : v);
  }
  return { shape: input.shape.slice(), data: out };
}

function opReduceMax(input, axes, keepdims) {
  return opReduce(input, axes, keepdims, -Infinity, (acc, v) => v > acc ? v : acc, (v) => v);
}

function opReduce(input, axes, keepdims, initial, reducer, finalizer) {
  const rank = input.shape.length;
  const reduceAxes = new Set((axes || input.shape.map((_, i) => i)).map((a) => a < 0 ? a + rank : a));
  const outShape = [];
  for (let i = 0; i < rank; i++) {
    if (reduceAxes.has(i)) {
      if (keepdims) outShape.push(1);
    } else outShape.push(input.shape[i]);
  }
  const finalShape = outShape.length ? outShape : [1];
  const out = new Float32Array(product(finalShape));
  out.fill(initial);
  const inStrides = stridesOf(input.shape);
  const outStrides = stridesOf(finalShape);
  for (let flat = 0; flat < input.data.length; flat++) {
    let rem = flat;
    let outDim = 0;
    let outFlat = 0;
    for (let d = 0; d < rank; d++) {
      const coord = Math.floor(rem / inStrides[d]);
      rem -= coord * inStrides[d];
      if (reduceAxes.has(d)) {
        if (keepdims) outDim++;
      } else {
        outFlat += coord * outStrides[outDim++];
      }
    }
    out[outFlat] = reducer(out[outFlat], input.data[flat]);
  }
  for (let i = 0; i < out.length; i++) out[i] = finalizer(out[i]);
  return { shape: finalShape, data: out };
}

function executeIf(node, state) {
  const cond = getTensor(state, node.inputs[0]).data[0] !== 0;
  const branch = graphAttr(node, cond ? 'then_branch' : 'else_branch');
  runGraph(branch, state);
  const branchOutput = getTensor(state, branch.outputs[0].name);
  state.set(node.outputs[0], branchOutput);
}

function axesForNode(node, state) {
  const inputAxis = node.inputs[1] ? getTensor(state, node.inputs[1]) : null;
  if (inputAxis) return Array.from(inputAxis.data);
  return intsAttr(node, 'axes') || [];
}

function normalizeInputShape(shape, inputLength) {
  if (shape?.length && shape.every((d) => d > 0)) return shape.slice();
  if (inputLength === 16 * 96) return [1, 16, 96];
  if (inputLength === 76 * 32) return [1, 76, 32, 1];
  return [1, inputLength];
}

function broadcastShape(a, b) {
  const rank = Math.max(a.length, b.length);
  const out = new Array(rank);
  for (let i = 0; i < rank; i++) {
    const av = a[a.length - rank + i] ?? 1;
    const bv = b[b.length - rank + i] ?? 1;
    if (av !== bv && av !== 1 && bv !== 1) {
      throw new Error(`Broadcast shape mismatch: ${a} vs ${b}`);
    }
    out[i] = Math.max(av, bv);
  }
  return out;
}

function broadcastStrides(shape, outShape) {
  const rank = outShape.length;
  const padded = new Array(rank).fill(1);
  const offset = rank - shape.length;
  for (let i = 0; i < shape.length; i++) padded[offset + i] = shape[i];
  const base = stridesOf(padded);
  return padded.map((dim, i) => dim === 1 ? 0 : base[i]);
}

function stridesOf(shape) {
  const out = new Array(shape.length);
  let stride = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = stride;
    stride *= shape[i];
  }
  return out;
}

function product(shape) {
  return shape.reduce((acc, n) => acc * n, 1);
}
