function getModelsBase() {
  return globalThis.__VS_MODELS_BASE || '/voice_satellite/models';
}

const MODEL_OPERATOR_CODES = 1;
const MODEL_SUBGRAPHS = 2;
const MODEL_BUFFERS = 4;

const OPERATOR_CODE_DEPRECATED_BUILTIN_CODE = 0;
const OPERATOR_CODE_VERSION = 2;
const OPERATOR_CODE_BUILTIN_CODE = 3;

const SUBGRAPH_TENSORS = 0;
const SUBGRAPH_INPUTS = 1;
const SUBGRAPH_OUTPUTS = 2;
const SUBGRAPH_OPERATORS = 3;

const TENSOR_SHAPE = 0;
const TENSOR_TYPE = 1;
const TENSOR_BUFFER = 2;
const TENSOR_NAME = 3;
const TENSOR_QUANTIZATION = 4;
const TENSOR_IS_VARIABLE = 5;

const OPERATOR_OPCODE_INDEX = 0;
const OPERATOR_INPUTS = 1;
const OPERATOR_OUTPUTS = 2;
const OPERATOR_BUILTIN_OPTIONS = 4;

const QUANT_MIN = 0;
const QUANT_MAX = 1;
const QUANT_SCALE = 2;
const QUANT_ZERO_POINT = 3;
const QUANT_DIMENSION = 4;

const BUFFER_DATA = 0;

const TENSOR_TYPE_INT32 = 2;
const TENSOR_TYPE_UINT8 = 3;
const TENSOR_TYPE_INT8 = 9;
const TENSOR_TYPE_RESOURCE = 13;

const BUILTIN_CONCATENATION = 2;
const BUILTIN_CONV_2D = 3;
const BUILTIN_DEPTHWISE_CONV_2D = 4;
const BUILTIN_FULLY_CONNECTED = 9;
const BUILTIN_LOGISTIC = 14;
const BUILTIN_RESHAPE = 22;
const BUILTIN_STRIDED_SLICE = 45;
const BUILTIN_SPLIT_V = 102;
const BUILTIN_QUANTIZE = 114;
const BUILTIN_CALL_ONCE = 129;
const BUILTIN_VAR_HANDLE = 142;
const BUILTIN_READ_VARIABLE = 143;
const BUILTIN_ASSIGN_VARIABLE = 144;

const PADDING_SAME = 0;
const PADDING_VALID = 1;

const ACT_NONE = 0;
const ACT_RELU = 1;

const CONV2D_PADDING = 0;
const CONV2D_STRIDE_W = 1;
const CONV2D_STRIDE_H = 2;
const CONV2D_FUSED_ACTIVATION = 3;
const CONV2D_DILATION_W = 4;
const CONV2D_DILATION_H = 5;

const DEPTHWISE_PADDING = 0;
const DEPTHWISE_STRIDE_W = 1;
const DEPTHWISE_STRIDE_H = 2;
const DEPTHWISE_DEPTH_MULTIPLIER = 3;
const DEPTHWISE_FUSED_ACTIVATION = 4;
const DEPTHWISE_DILATION_W = 5;
const DEPTHWISE_DILATION_H = 6;

const CONCAT_AXIS = 0;
const CONCAT_FUSED_ACTIVATION = 1;

const STRIDED_BEGIN_MASK = 0;
const STRIDED_END_MASK = 1;
const STRIDED_ELLIPSIS_MASK = 2;
const STRIDED_NEW_AXIS_MASK = 3;
const STRIDED_SHRINK_AXIS_MASK = 4;

const FULLY_CONNECTED_FUSED_ACTIVATION = 0;
const CALL_ONCE_INIT_SUBGRAPH_INDEX = 0;
const VAR_HANDLE_CONTAINER = 0;
const VAR_HANDLE_SHARED_NAME = 1;

const MIN_VALUE = {
  [TENSOR_TYPE_INT8]: -128,
  [TENSOR_TYPE_UINT8]: 0,
};

const MAX_VALUE = {
  [TENSOR_TYPE_INT8]: 127,
  [TENSOR_TYPE_UINT8]: 255,
};

const MODEL_CACHE = new Map();

export async function loadCustomWakeWordModel(modelName) {
  if (MODEL_CACHE.has(modelName)) return MODEL_CACHE.get(modelName);

  const url = `${getModelsBase()}/${modelName}.tflite`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch wake word model: ${modelName} (HTTP ${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  try {
    const model = compileModel(buffer);
    MODEL_CACHE.set(modelName, model);
    return model;
  } catch (e) {
    throw new Error(
      `Model "${modelName}" is not compatible with Voice Satellite. `
      + `Only microWakeWord models are supported (int8 quantized streaming .tflite). `
      + `openWakeWord and other model formats cannot be used. `
      + `Detail: ${e.message}`,
    );
  }
}

export function releaseCustomWakeWordModels(namesToKeep = []) {
  const keep = new Set(namesToKeep);
  for (const [name] of MODEL_CACHE) {
    if (!keep.has(name)) MODEL_CACHE.delete(name);
  }
}

export function clearCustomWakeWordModels() {
  MODEL_CACHE.clear();
}

export class CustomWakeWordModelRunner {
  constructor(compiledModel) {
    this._model = compiledModel;
    this._input = new Int8Array(compiledModel.inputSize);
    this._output = new Uint8Array(compiledModel.outputSize);
    this._scratch = compiledModel.createExecutionState();
  }

  getInputs() {
    return [new TensorView(this._input)];
  }

  getOutputs() {
    return [new TensorView(this._output)];
  }

  infer() {
    this._model.invoke(this._input, this._output, this._scratch);
    return true;
  }

  cleanUp() {
    this._scratch = null;
  }
}

class TensorView {
  constructor(data) {
    this._data = data;
  }

  data() {
    return this._data;
  }

  delete() {}
}

class FlatbufferReader {
  constructor(arrayBuffer) {
    this.dv = new DataView(arrayBuffer);
    this.buffer = arrayBuffer;
  }

  u8(off) { return this.dv.getUint8(off); }
  i32(off) { return this.dv.getInt32(off, true); }
  u32(off) { return this.dv.getUint32(off, true); }
  u16(off) { return this.dv.getUint16(off, true); }
  f32(off) { return this.dv.getFloat32(off, true); }
  i64(off) {
    const lo = this.dv.getUint32(off, true);
    const hi = this.dv.getInt32(off + 4, true);
    return hi * 0x100000000 + lo;
  }

  field(tableOff, fieldId) {
    const vtableOff = tableOff - this.i32(tableOff);
    const vtableSize = this.u16(vtableOff);
    const slot = 4 + fieldId * 2;
    if (slot >= vtableSize) return 0;
    const fieldOff = this.u16(vtableOff + slot);
    return fieldOff ? tableOff + fieldOff : 0;
  }

  follow(off) {
    return off + this.u32(off);
  }

  vector(vecOff) {
    if (!vecOff) return { length: 0, dataOff: 0 };
    return { length: this.u32(vecOff), dataOff: vecOff + 4 };
  }

  readIntVector(fieldOff) {
    const vec = this.vector(this.follow(fieldOff));
    const out = new Int32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = this.i32(vec.dataOff + i * 4);
    return out;
  }

  readFloatVector(fieldOff) {
    const vec = this.vector(this.follow(fieldOff));
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = this.f32(vec.dataOff + i * 4);
    return out;
  }

  readLongVector(fieldOff) {
    const vec = this.vector(this.follow(fieldOff));
    const out = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = this.i64(vec.dataOff + i * 8);
    return out;
  }

  readBufferData(bufferTableOff) {
    const dataField = this.field(bufferTableOff, BUFFER_DATA);
    if (!dataField) return new Uint8Array(0);
    const vec = this.vector(this.follow(dataField));
    return new Uint8Array(this.buffer, vec.dataOff, vec.length);
  }

  readString(fieldOff) {
    if (!fieldOff) return '';
    const strOff = this.follow(fieldOff);
    const length = this.u32(strOff);
    const bytes = new Uint8Array(this.buffer, strOff + 4, length);
    return new TextDecoder().decode(bytes);
  }
}

function compileModel(arrayBuffer) {
  const fb = new FlatbufferReader(arrayBuffer);
  const modelOff = fb.follow(0);
  const subgraphsField = fb.field(modelOff, MODEL_SUBGRAPHS);
  const subgraphs = fb.vector(fb.follow(subgraphsField));
  const subgraphOff = fb.follow(subgraphs.dataOff);

  const buffersField = fb.field(modelOff, MODEL_BUFFERS);
  const buffersVec = fb.vector(fb.follow(buffersField));
  const operatorCodesField = fb.field(modelOff, MODEL_OPERATOR_CODES);
  const operatorCodesVec = fb.vector(fb.follow(operatorCodesField));

  const tensorsField = fb.field(subgraphOff, SUBGRAPH_TENSORS);
  const tensorsVec = fb.vector(fb.follow(tensorsField));
  const operatorsField = fb.field(subgraphOff, SUBGRAPH_OPERATORS);
  const operatorsVec = fb.vector(fb.follow(operatorsField));
  const inputsField = fb.field(subgraphOff, SUBGRAPH_INPUTS);
  const outputsField = fb.field(subgraphOff, SUBGRAPH_OUTPUTS);

  const tensors = [];
  for (let i = 0; i < tensorsVec.length; i++) {
    const tensorOff = fb.follow(tensorsVec.dataOff + i * 4);
    const shapeField = fb.field(tensorOff, TENSOR_SHAPE);
    const typeField = fb.field(tensorOff, TENSOR_TYPE);
    const bufferField = fb.field(tensorOff, TENSOR_BUFFER);
    const quantField = fb.field(tensorOff, TENSOR_QUANTIZATION);
    const isVariableField = fb.field(tensorOff, TENSOR_IS_VARIABLE);

    const shape = shapeField ? Array.from(fb.readIntVector(shapeField)) : [];
    const type = typeField ? fb.u8(typeField) : 0;
    const bufferIndex = bufferField ? fb.u32(bufferField) : 0;
    const rawBuffer = bufferIndex < buffersVec.length
      ? fb.readBufferData(fb.follow(buffersVec.dataOff + bufferIndex * 4))
      : new Uint8Array(0);

    let quant = null;
    if (quantField) {
      const quantOff = fb.follow(quantField);
      const scaleField = fb.field(quantOff, QUANT_SCALE);
      const zeroField = fb.field(quantOff, QUANT_ZERO_POINT);
      const dimField = fb.field(quantOff, QUANT_DIMENSION);
      quant = {
        scales: scaleField ? Array.from(fb.readFloatVector(scaleField)) : [],
        zeroPoints: zeroField ? fb.readLongVector(zeroField) : [],
        quantizedDimension: dimField ? fb.i32(dimField) : 0,
      };
    }

    tensors.push({
      id: i,
      shape,
      type,
      bufferIndex,
      quant,
      rawBuffer,
      isVariable: !!(isVariableField && fb.u8(isVariableField)),
    });
  }

  const opCodeValues = [];
  for (let i = 0; i < operatorCodesVec.length; i++) {
    const off = fb.follow(operatorCodesVec.dataOff + i * 4);
    const builtinCodeField = fb.field(off, OPERATOR_CODE_BUILTIN_CODE);
    const deprecatedField = fb.field(off, OPERATOR_CODE_DEPRECATED_BUILTIN_CODE);
    const versionField = fb.field(off, OPERATOR_CODE_VERSION);
    opCodeValues.push({
      builtinCode: builtinCodeField ? fb.u8(builtinCodeField) : (deprecatedField ? fb.u8(deprecatedField) : 0),
      version: versionField ? fb.u32(versionField) : 1,
    });
  }

  const inputIds = Array.from(fb.readIntVector(inputsField));
  const outputIds = Array.from(fb.readIntVector(outputsField));

  // Validate: microWakeWord models use INT8 quantized input tensors.
  // Float32 inputs indicate a different model type (e.g. openWakeWord).
  const inputTensor = tensors[inputIds[0]];
  if (inputTensor && inputTensor.type !== TENSOR_TYPE_INT8) {
    const typeNames = { 0: 'float32', 3: 'uint8', 9: 'int8' };
    const typeName = typeNames[inputTensor.type] || `type=${inputTensor.type}`;
    throw new Error(
      `Input tensor is ${typeName} — expected int8. `
      + `This looks like an openWakeWord or other non-microWakeWord model`,
    );
  }

  // Validate: microWakeWord models use 40-feature mel frames.
  const inputShape = inputTensor?.shape || [];
  const featureSize = inputShape[inputShape.length - 1];
  if (featureSize && featureSize !== 40) {
    throw new Error(
      `Input feature size is ${featureSize} — expected 40. `
      + `This model uses a different audio frontend than microWakeWord`,
    );
  }

  const compiledOps = [];
  const variableInfo = new Map();
  const handleKeys = new Map();
  let initSubgraphIndex = null;

  for (let i = 0; i < operatorsVec.length; i++) {
    const opOff = fb.follow(operatorsVec.dataOff + i * 4);
    const opcodeIndexField = fb.field(opOff, OPERATOR_OPCODE_INDEX);
    const outputField = fb.field(opOff, OPERATOR_OUTPUTS);
    const builtinOptionsField = fb.field(opOff, OPERATOR_BUILTIN_OPTIONS);

    const opcodeIndex = opcodeIndexField ? fb.u32(opcodeIndexField) : 0;
    const code = opCodeValues[opcodeIndex].builtinCode;
    const outputs = outputField ? Array.from(fb.readIntVector(outputField)) : [];
    const optionsOff = builtinOptionsField ? fb.follow(builtinOptionsField) : 0;

    if (code === BUILTIN_CALL_ONCE) {
      initSubgraphIndex = readOptionalI32(fb, optionsOff, CALL_ONCE_INIT_SUBGRAPH_INDEX, null);
    } else if (code === BUILTIN_VAR_HANDLE) {
      const sharedName = fb.readString(fb.field(optionsOff, VAR_HANDLE_SHARED_NAME))
        || `tensor:${outputs[0]}`;
      handleKeys.set(outputs[0], sharedName);
    }
  }

  const initInitializers = compileInitInitializers(
    fb, subgraphs, buffersVec, opCodeValues, initSubgraphIndex,
  );

  for (let i = 0; i < operatorsVec.length; i++) {
    const opOff = fb.follow(operatorsVec.dataOff + i * 4);
    const opcodeIndexField = fb.field(opOff, OPERATOR_OPCODE_INDEX);
    const inputField = fb.field(opOff, OPERATOR_INPUTS);
    const outputField = fb.field(opOff, OPERATOR_OUTPUTS);
    const builtinOptionsField = fb.field(opOff, OPERATOR_BUILTIN_OPTIONS);

    const opcodeIndex = opcodeIndexField ? fb.u32(opcodeIndexField) : 0;
    const code = opCodeValues[opcodeIndex].builtinCode;
    const inputs = inputField ? Array.from(fb.readIntVector(inputField)) : [];
    const outputs = outputField ? Array.from(fb.readIntVector(outputField)) : [];
    const optionsOff = builtinOptionsField ? fb.follow(builtinOptionsField) : 0;

    switch (code) {
      case BUILTIN_CALL_ONCE:
      case BUILTIN_VAR_HANDLE:
        break;
      case BUILTIN_READ_VARIABLE: {
        const handleId = handleKeys.get(inputs[0]) || `tensor:${inputs[0]}`;
        const outTensor = tensors[outputs[0]];
        if (!variableInfo.has(handleId)) {
          variableInfo.set(handleId, {
            shape: outTensor.shape,
            quant: outTensor.quant,
            type: outTensor.type,
          });
        }
        compiledOps.push({ kind: 'READ_VARIABLE', handleId, output: outputs[0] });
        break;
      }
      case BUILTIN_ASSIGN_VARIABLE:
        compiledOps.push({
          kind: 'ASSIGN_VARIABLE',
          handleId: handleKeys.get(inputs[0]) || `tensor:${inputs[0]}`,
          input: inputs[1],
        });
        break;
      case BUILTIN_RESHAPE:
        compiledOps.push({ kind: 'RESHAPE', input: inputs[0], output: outputs[0], shape: toInts(tensors[inputs[1]].rawBuffer) });
        break;
      case BUILTIN_CONCATENATION:
        compiledOps.push({
          kind: 'CONCATENATION',
          inputs,
          output: outputs[0],
          axis: readOptionalI32(fb, optionsOff, CONCAT_AXIS, 0),
          activation: readOptionalU8(fb, optionsOff, CONCAT_FUSED_ACTIVATION, ACT_NONE),
        });
        break;
      case BUILTIN_STRIDED_SLICE:
        compiledOps.push({
          kind: 'STRIDED_SLICE',
          input: inputs[0],
          begin: toInts(tensors[inputs[1]].rawBuffer),
          end: toInts(tensors[inputs[2]].rawBuffer),
          strides: toInts(tensors[inputs[3]].rawBuffer),
          output: outputs[0],
          beginMask: readOptionalU32(fb, optionsOff, STRIDED_BEGIN_MASK, 0),
          endMask: readOptionalU32(fb, optionsOff, STRIDED_END_MASK, 0),
          ellipsisMask: readOptionalU32(fb, optionsOff, STRIDED_ELLIPSIS_MASK, 0),
          newAxisMask: readOptionalU32(fb, optionsOff, STRIDED_NEW_AXIS_MASK, 0),
          shrinkAxisMask: readOptionalU32(fb, optionsOff, STRIDED_SHRINK_AXIS_MASK, 0),
        });
        break;
      case BUILTIN_SPLIT_V:
        compiledOps.push({
          kind: 'SPLIT_V',
          input: inputs[0],
          sizeSplits: toInts(tensors[inputs[1]].rawBuffer),
          axis: toScalarInt(tensors[inputs[2]].rawBuffer),
          outputs,
        });
        break;
      case BUILTIN_CONV_2D: {
        const inputTensor = tensors[inputs[0]];
        const weightTensor = tensors[inputs[1]];
        const outTensor = tensors[outputs[0]];
        compiledOps.push({
          kind: 'CONV_2D',
          input: inputs[0],
          weights: compileWeightTensor(weightTensor),
          bias: compileBiasTensor(tensors[inputs[2]]),
          output: outputs[0],
          outputType: outTensor.type,
          inputOffset: -(inputTensor.quant?.zeroPoints?.[0] ?? 0),
          outputOffset: outTensor.quant?.zeroPoints?.[0] ?? 0,
          perChannelMultipliers: computePerChannelMultipliers(inputTensor.quant, weightTensor.quant, outTensor.quant, weightTensor.shape[0]),
          padding: readOptionalU8(fb, optionsOff, CONV2D_PADDING, PADDING_SAME),
          strideW: readOptionalU32(fb, optionsOff, CONV2D_STRIDE_W, 1),
          strideH: readOptionalU32(fb, optionsOff, CONV2D_STRIDE_H, 1),
          activation: readOptionalU8(fb, optionsOff, CONV2D_FUSED_ACTIVATION, ACT_NONE),
          dilationW: readOptionalU32(fb, optionsOff, CONV2D_DILATION_W, 1),
          dilationH: readOptionalU32(fb, optionsOff, CONV2D_DILATION_H, 1),
        });
        break;
      }
      case BUILTIN_DEPTHWISE_CONV_2D: {
        const inputTensor = tensors[inputs[0]];
        const weightTensor = tensors[inputs[1]];
        const outTensor = tensors[outputs[0]];
        compiledOps.push({
          kind: 'DEPTHWISE_CONV_2D',
          input: inputs[0],
          weights: compileWeightTensor(weightTensor),
          bias: compileBiasTensor(tensors[inputs[2]]),
          output: outputs[0],
          outputType: outTensor.type,
          inputOffset: -(inputTensor.quant?.zeroPoints?.[0] ?? 0),
          outputOffset: outTensor.quant?.zeroPoints?.[0] ?? 0,
          perChannelMultipliers: computePerChannelMultipliers(inputTensor.quant, weightTensor.quant, outTensor.quant, weightTensor.shape[3]),
          padding: readOptionalU8(fb, optionsOff, DEPTHWISE_PADDING, PADDING_SAME),
          strideW: readOptionalU32(fb, optionsOff, DEPTHWISE_STRIDE_W, 1),
          strideH: readOptionalU32(fb, optionsOff, DEPTHWISE_STRIDE_H, 1),
          depthMultiplier: readOptionalU32(fb, optionsOff, DEPTHWISE_DEPTH_MULTIPLIER, 1),
          activation: readOptionalU8(fb, optionsOff, DEPTHWISE_FUSED_ACTIVATION, ACT_NONE),
          dilationW: readOptionalU32(fb, optionsOff, DEPTHWISE_DILATION_W, 1),
          dilationH: readOptionalU32(fb, optionsOff, DEPTHWISE_DILATION_H, 1),
        });
        break;
      }
      case BUILTIN_FULLY_CONNECTED: {
        const inputTensor = tensors[inputs[0]];
        const weightTensor = tensors[inputs[1]];
        const outTensor = tensors[outputs[0]];
        compiledOps.push({
          kind: 'FULLY_CONNECTED',
          input: inputs[0],
          weights: compileWeightTensor(weightTensor),
          bias: compileBiasTensor(tensors[inputs[2]]),
          output: outputs[0],
          outputType: outTensor.type,
          inputOffset: -(inputTensor.quant?.zeroPoints?.[0] ?? 0),
          outputOffset: outTensor.quant?.zeroPoints?.[0] ?? 0,
          perChannelMultipliers: computePerChannelMultipliers(inputTensor.quant, weightTensor.quant, outTensor.quant, weightTensor.shape[0]),
          activation: readOptionalU8(fb, optionsOff, FULLY_CONNECTED_FUSED_ACTIVATION, ACT_NONE),
        });
        break;
      }
      case BUILTIN_LOGISTIC: {
        const inputTensor = tensors[inputs[0]];
        const outTensor = tensors[outputs[0]];
        compiledOps.push({
          kind: 'LOGISTIC',
          input: inputs[0],
          output: outputs[0],
          outputType: outTensor.type,
          inputScale: inputTensor.quant?.scales?.[0] ?? 1,
          inputZeroPoint: inputTensor.quant?.zeroPoints?.[0] ?? 0,
          outputScale: outTensor.quant?.scales?.[0] ?? 1,
          outputZeroPoint: outTensor.quant?.zeroPoints?.[0] ?? 0,
        });
        break;
      }
      case BUILTIN_QUANTIZE: {
        const inputTensor = tensors[inputs[0]];
        const outTensor = tensors[outputs[0]];
        compiledOps.push({
          kind: 'QUANTIZE',
          input: inputs[0],
          output: outputs[0],
          outputType: outTensor.type,
          inputScale: inputTensor.quant?.scales?.[0] ?? 1,
          inputZeroPoint: inputTensor.quant?.zeroPoints?.[0] ?? 0,
          outputScale: outTensor.quant?.scales?.[0] ?? 1,
          outputZeroPoint: outTensor.quant?.zeroPoints?.[0] ?? 0,
        });
        break;
      }
      default: {
        const OP_NAMES = { 0:'ADD', 18:'MUL', 39:'BATCH_TO_SPACE_ND', 40:'MEAN', 41:'SUB', 76:'RSQRT', 77:'SHAPE', 81:'REDUCE_PROD', 83:'PACK', 94:'FILL', 99:'SQUARED_DIFFERENCE' };
        const opName = OP_NAMES[code] || `op=${code}`;
        throw new Error(`Unsupported op: ${opName} — this model uses operations not found in microWakeWord models`);
      }
    }
  }

  return new CompiledWakeWordModel(
    tensors, compiledOps, inputIds[0], outputIds[0], variableInfo, initInitializers,
  );
}

function compileInitInitializers(fb, subgraphs, buffersVec, opCodeValues, initSubgraphIndex) {
  if (initSubgraphIndex == null || initSubgraphIndex < 0 || initSubgraphIndex >= subgraphs.length) {
    return [];
  }

  const subgraphOff = fb.follow(subgraphs.dataOff + initSubgraphIndex * 4);
  const tensorsField = fb.field(subgraphOff, SUBGRAPH_TENSORS);
  const tensorsVec = fb.vector(fb.follow(tensorsField));
  const operatorsField = fb.field(subgraphOff, SUBGRAPH_OPERATORS);
  const operatorsVec = fb.vector(fb.follow(operatorsField));

  const tensors = [];
  for (let i = 0; i < tensorsVec.length; i++) {
    const tensorOff = fb.follow(tensorsVec.dataOff + i * 4);
    const shapeField = fb.field(tensorOff, TENSOR_SHAPE);
    const typeField = fb.field(tensorOff, TENSOR_TYPE);
    const bufferField = fb.field(tensorOff, TENSOR_BUFFER);
    const quantField = fb.field(tensorOff, TENSOR_QUANTIZATION);

    const shape = shapeField ? Array.from(fb.readIntVector(shapeField)) : [];
    const type = typeField ? fb.u8(typeField) : 0;
    const bufferIndex = bufferField ? fb.u32(bufferField) : 0;
    const rawBuffer = bufferIndex < buffersVec.length
      ? fb.readBufferData(fb.follow(buffersVec.dataOff + bufferIndex * 4))
      : new Uint8Array(0);

    let quant = null;
    if (quantField) {
      const quantOff = fb.follow(quantField);
      const scaleField = fb.field(quantOff, QUANT_SCALE);
      const zeroField = fb.field(quantOff, QUANT_ZERO_POINT);
      const dimField = fb.field(quantOff, QUANT_DIMENSION);
      quant = {
        scales: scaleField ? Array.from(fb.readFloatVector(scaleField)) : [],
        zeroPoints: zeroField ? fb.readLongVector(zeroField) : [],
        quantizedDimension: dimField ? fb.i32(dimField) : 0,
      };
    }

    tensors.push({ shape, type, quant, rawBuffer });
  }

  const handleKeys = new Map();
  const initializers = [];
  for (let i = 0; i < operatorsVec.length; i++) {
    const opOff = fb.follow(operatorsVec.dataOff + i * 4);
    const opcodeIndexField = fb.field(opOff, OPERATOR_OPCODE_INDEX);
    const inputField = fb.field(opOff, OPERATOR_INPUTS);
    const outputField = fb.field(opOff, OPERATOR_OUTPUTS);
    const builtinOptionsField = fb.field(opOff, OPERATOR_BUILTIN_OPTIONS);

    const opcodeIndex = opcodeIndexField ? fb.u32(opcodeIndexField) : 0;
    const code = opCodeValues[opcodeIndex].builtinCode;
    const inputs = inputField ? Array.from(fb.readIntVector(inputField)) : [];
    const outputs = outputField ? Array.from(fb.readIntVector(outputField)) : [];
    const optionsOff = builtinOptionsField ? fb.follow(builtinOptionsField) : 0;

    if (code === BUILTIN_VAR_HANDLE) {
      const sharedName = fb.readString(fb.field(optionsOff, VAR_HANDLE_SHARED_NAME))
        || `tensor:${outputs[0]}`;
      handleKeys.set(outputs[0], sharedName);
    } else if (code === BUILTIN_ASSIGN_VARIABLE) {
      const src = tensors[inputs[1]];
      // Keep the init buffer as raw int8 bytes when possible so variables
      // can be filled via a byte-level memcpy — matching the reference
      // interpreter's init behavior.
      const rawBytes = src.type === TENSOR_TYPE_INT8 && src.rawBuffer?.length
        ? new Int8Array(src.rawBuffer.buffer, src.rawBuffer.byteOffset, src.rawBuffer.byteLength)
        : null;
      initializers.push({
        handleId: handleKeys.get(inputs[0]) || `tensor:${inputs[0]}`,
        rawBytes,
        data: rawBytes ? null : materializeConstantTensor(src),
        shape: src.shape.slice(),
        quant: src.quant,
        type: src.type,
      });
    }
  }

  return initializers;
}

class CompiledWakeWordModel {
  constructor(tensors, ops, inputId, outputId, variableInfo, initInitializers = []) {
    this.tensors = tensors;
    this.ops = ops;
    this.inputId = inputId;
    this.outputId = outputId;
    this.inputTensor = tensors[inputId];
    this.outputTensor = tensors[outputId];
    this.inputSize = sizeOf(this.inputTensor.shape);
    this.outputSize = sizeOf(this.outputTensor.shape);
    this.variableInfo = variableInfo;
    this.initInitializers = initInitializers;
  }

  createExecutionState() {
    const tensors = this.tensors.map((tensor) => ({
      meta: tensor,
      data: allocTensorData(tensor.type, sizeOf(tensor.shape)),
    }));

    // Initialize constant tensors from their raw buffer.  For INT8/UINT8/INT32
    // tensors this is a direct byte copy — no dequantization, values stay in
    // their native quantized representation exactly like the TFLite reference.
    for (const tensorState of tensors) {
      const { meta, data } = tensorState;
      if (!meta.rawBuffer?.length || meta.type === TENSOR_TYPE_RESOURCE) continue;
      copyRawBufferToTensor(meta, data);
    }

    // Variables are stored in their native type (int8 bytes for quantized
    // state).  ReadVariable/AssignVariable are byte copies — same as the
    // reference which uses memcpy.
    const variables = new Map();
    for (const [handleId, info] of this.variableInfo) {
      variables.set(handleId, {
        shape: info.shape.slice(),
        quant: info.quant,
        type: info.type ?? TENSOR_TYPE_INT8,
        data: allocTensorData(info.type ?? TENSOR_TYPE_INT8, sizeOf(info.shape)),
      });
    }

    // Initialize variables from the CALL_ONCE subgraph if present.  Init
    // values are stored in native type bytes (int8 for quantized state).
    // Fill with the tensor's zero point if no explicit init — matches the
    // reference (micro_resource_variable.cc memset to zero_point).
    for (const [handleId, info] of this.variableInfo) {
      const v = variables.get(handleId);
      if (info.quant?.zeroPoints?.length && v.data instanceof Int8Array) {
        v.data.fill(info.quant.zeroPoints[0] & 0xff);
      }
    }
    for (const init of this.initInitializers) {
      const v = variables.get(init.handleId);
      if (!v) continue;
      if (init.rawBytes && v.data instanceof Int8Array) {
        v.data.set(init.rawBytes.subarray(0, v.data.length));
      } else if (init.data) {
        // Legacy: dequantized float init — requantize to int8 on the fly.
        const scale = v.quant?.scales?.[0] ?? 1;
        const zp = v.quant?.zeroPoints?.[0] ?? 0;
        for (let i = 0; i < init.data.length && i < v.data.length; i++) {
          let q = Math.round(init.data[i] / scale + zp);
          if (q < -128) q = -128;
          else if (q > 127) q = 127;
          v.data[i] = q;
        }
      }
    }

    return { tensors, variables };
  }

  invoke(inputBuffer, outputBuffer, state) {
    // Input: direct byte copy into the model's input tensor.  No
    // dequantization — features stay int8 all the way through conv layers
    // and only get converted to float for sigmoid (LOGISTIC).
    const inputTensor = state.tensors[this.inputId];
    inputTensor.data.set(inputBuffer.subarray(0, inputTensor.data.length));

    for (const op of this.ops) {
      switch (op.kind) {
        case 'READ_VARIABLE':
          // Byte copy — variable and tensor are same native type.
          state.tensors[op.output].data.set(state.variables.get(op.handleId).data);
          break;
        case 'ASSIGN_VARIABLE':
          state.variables.get(op.handleId).data.set(state.tensors[op.input].data);
          break;
        case 'RESHAPE':
          state.tensors[op.output].data.set(state.tensors[op.input].data);
          break;
        case 'CONCATENATION':
          concatTensors(state, op);
          break;
        case 'STRIDED_SLICE':
          stridedSlice(state, op);
          break;
        case 'SPLIT_V':
          splitV(state, op);
          break;
        case 'CONV_2D':
          conv2d(state, op);
          break;
        case 'DEPTHWISE_CONV_2D':
          depthwiseConv2d(state, op);
          break;
        case 'FULLY_CONNECTED':
          fullyConnected(state, op);
          break;
        case 'LOGISTIC':
          logistic(state, op);
          break;
        case 'QUANTIZE':
          quantizeOp(state, op);
          break;
        default:
          break;
      }
    }

    outputBuffer.set(state.tensors[this.outputId].data);
  }
}

function compileWeightTensor(tensor) {
  const q = tensor.quant;
  if (tensor.type !== TENSOR_TYPE_INT8 || !q?.scales?.length) {
    const typeNames = { 0: 'float32', 3: 'uint8', 9: 'int8' };
    const typeName = typeNames[tensor.type] || `type=${tensor.type}`;
    throw new Error(
      `Weight tensor is ${typeName} without per-channel quantization — expected int8 with scales`,
    );
  }
  return {
    shape: tensor.shape,
    quant: q,
    // Keep the raw int8 bytes — no dequantization.  Conv/FC read these
    // int8 values directly into an int32 accumulator, matching TFLite's
    // reference integer-only kernel.
    values: new Int8Array(tensor.rawBuffer.buffer, tensor.rawBuffer.byteOffset, tensor.rawBuffer.byteLength),
  };
}

function compileBiasTensor(tensor) {
  // Return the raw int32 bias values unscaled.  The reference kernel adds
  // the int32 bias directly to the int32 accumulator before the final
  // MultiplyByQuantizedMultiplier requantization step.
  const byteLength = tensor.rawBuffer.byteLength;
  const length = byteLength / 4;
  const out = new Int32Array(length);
  const dv = new DataView(tensor.rawBuffer.buffer, tensor.rawBuffer.byteOffset, byteLength);
  for (let i = 0; i < length; i++) {
    out[i] = dv.getInt32(i * 4, true);
  }
  return out;
}

// Allocate a typed array matching the TFLite tensor type.
function allocTensorData(type, size) {
  switch (type) {
    case TENSOR_TYPE_INT8: return new Int8Array(size);
    case TENSOR_TYPE_UINT8: return new Uint8Array(size);
    case TENSOR_TYPE_INT32: return new Int32Array(size);
    default: return new Float32Array(size);
  }
}

// Copy a model-embedded constant tensor's raw bytes into its execution
// state buffer.  No dequantization — the values stay in their native
// quantized representation, identical to how the reference interpreter
// stores them.
function copyRawBufferToTensor(meta, dst) {
  const buf = meta.rawBuffer;
  if (!buf?.length) return;
  if (dst instanceof Int8Array) {
    const src = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    dst.set(src.subarray(0, dst.length));
  } else if (dst instanceof Uint8Array) {
    const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    dst.set(src.subarray(0, dst.length));
  } else if (dst instanceof Int32Array) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = Math.min(dst.length, Math.floor(buf.byteLength / 4));
    for (let i = 0; i < count; i++) dst[i] = dv.getInt32(i * 4, true);
  } else {
    // Float32 fallback — dequantize int8/uint8 if the tensor is quantized.
    dst.set(materializeConstantTensor(meta).subarray(0, dst.length));
  }
}

// Pre-compute per-channel quantized multiplier + shift for a conv/FC op.
// effective_scale = input_scale * weight_scale[ch] / output_scale
// Each returns a Q0.31 fixed-point multiplier and a power-of-two shift
// exponent, exactly like tflite's QuantizeMultiplier.
function computePerChannelMultipliers(inputQuant, weightQuant, outputQuant, channelCount) {
  const inputScale = inputQuant?.scales?.[0] ?? 1;
  const outputScale = outputQuant?.scales?.[0] ?? 1;
  const weightScales = weightQuant?.scales || [];
  const multipliers = new Int32Array(channelCount);
  const shifts = new Int32Array(channelCount);
  for (let ch = 0; ch < channelCount; ch++) {
    const weightScale = weightScales.length === 1 ? weightScales[0] : weightScales[ch];
    const effective = (inputScale * weightScale) / outputScale;
    const { multiplier, shift } = quantizeMultiplier(effective);
    multipliers[ch] = multiplier;
    shifts[ch] = shift;
  }
  return { multipliers, shifts };
}

// Decompose a positive real number M into (q, n) where M = q * 2^(n - 31)
// and q is a Q0.31 signed int in [2^30, 2^31 - 1] (i.e., representing
// [0.5, 1.0)).  Matches tflite/kernels/internal/quantization_util.cc.
function quantizeMultiplier(doubleMultiplier) {
  if (doubleMultiplier === 0 || !isFinite(doubleMultiplier)) {
    return { multiplier: 0, shift: 0 };
  }
  // frexp: doubleMultiplier = q * 2^shift, q in [0.5, 1.0)
  let shift = 0;
  let q = doubleMultiplier;
  while (q >= 1.0) { q *= 0.5; shift++; }
  while (q < 0.5) { q *= 2.0; shift--; }
  // q now in [0.5, 1.0); represent as Q0.31 fixed-point.
  // 2^31 = 2147483648.  Multiplying by it and rounding gives the int.
  let qFixed = Math.round(q * 2147483648);
  if (qFixed === 2147483648) { qFixed = 1073741824; shift++; }
  if (shift < -31) { shift = 0; qFixed = 0; }
  if (shift > 30) { shift = 30; qFixed = 2147483647; }
  return { multiplier: qFixed | 0, shift };
}

// MultiplyByQuantizedMultiplier using the double-rounding path
// (gemmlowp-style).  This is the DEFAULT in TFLite/TFLite-Micro unless
// TFLITE_SINGLE_ROUNDING is explicitly defined.  Two rounding steps:
//   1. SaturatingRoundingDoublingHighMul — multiply x by multiplier,
//      keeping the high 32 bits with round-half-away-from-zero on the
//      doubled product.
//   2. RoundingDivideByPOT — a correctly-rounded right shift.
// This bit-exactly matches what ESPHome's TFLite Micro uses for wake
// word model inference.
function multiplyByQuantizedMultiplier(x, multiplier, shift) {
  const leftShift = shift > 0 ? shift : 0;
  const rightShift = shift > 0 ? 0 : -shift;

  // Left-shift x (with overflow to BigInt territory handled safely).
  let xShifted = BigInt(x);
  if (leftShift > 0) xShifted <<= BigInt(leftShift);

  // SaturatingRoundingDoublingHighMul(a, b):
  //   ab_64 = a * b (int64)
  //   nudge = ab_64 >= 0 ? (1 << 30) : (1 - (1 << 30))
  //   return (int32_t)((ab_64 + nudge) / (1LL << 31))
  //   — with overflow saturation when a == b == INT32_MIN.
  const ab64 = xShifted * BigInt(multiplier);
  const nudge = ab64 >= 0n ? (1n << 30n) : (1n - (1n << 30n));
  // C integer division truncates toward zero.  BigInt `/` also truncates
  // toward zero (per the BigInt spec), matching the reference exactly —
  // which is CRITICAL here because the nudge is designed to turn
  // trunc-toward-zero into round-half-away-from-zero.  Using `>>` (floor
  // toward -infinity) would give wrong results for negative values.
  let high = (ab64 + nudge) / (1n << 31n);
  // Saturate to int32 range
  const INT32_MAX = (1n << 31n) - 1n;
  const INT32_MIN = -(1n << 31n);
  if (high > INT32_MAX) high = INT32_MAX;
  else if (high < INT32_MIN) high = INT32_MIN;

  // RoundingDivideByPOT(x, exp):
  //   mask = (1 << exp) - 1
  //   remainder = x & mask
  //   threshold = (mask >> 1) + (x < 0 ? 1 : 0)
  //   return (x >> exp) + (remainder > threshold ? 1 : 0)
  if (rightShift === 0) return Number(high);
  const expShift = BigInt(rightShift);
  const mask = (1n << expShift) - 1n;
  const remainder = high & mask;
  const threshold = (mask >> 1n) + (high < 0n ? 1n : 0n);
  let result = high >> expShift;
  if (remainder > threshold) result += 1n;
  return Number(result);
}

function materializeConstantTensor(tensor) {
  const size = sizeOf(tensor.shape);
  const out = new Float32Array(size);

  if (tensor.type === TENSOR_TYPE_INT8) {
    const values = new Int8Array(
      tensor.rawBuffer.buffer, tensor.rawBuffer.byteOffset, tensor.rawBuffer.byteLength,
    );
    dequantizeInto(values, out, tensor.quant);
    return out;
  }

  if (tensor.type === TENSOR_TYPE_UINT8) {
    const values = new Uint8Array(
      tensor.rawBuffer.buffer, tensor.rawBuffer.byteOffset, tensor.rawBuffer.byteLength,
    );
    dequantizeInto(values, out, tensor.quant);
    return out;
  }

  if (tensor.type === TENSOR_TYPE_INT32) {
    const values = new Int32Array(
      tensor.rawBuffer.buffer, tensor.rawBuffer.byteOffset, tensor.rawBuffer.byteLength / 4,
    );
    for (let i = 0; i < values.length; i++) out[i] = values[i];
    return out;
  }

  return out;
}

function assignTensor(target, source) {
  target.data.set(source);
}

function concatTensors(state, op) {
  const out = state.tensors[op.output];
  const inputs = op.inputs.map((id) => state.tensors[id]);
  const rank = out.meta.shape.length;
  const axis = normalizeAxis(op.axis, rank);
  const outer = product(out.meta.shape, 0, axis);
  const inner = product(out.meta.shape, axis + 1);
  const outAxis = out.meta.shape[axis];
  let offset = 0;

  for (let o = 0; o < outer; o++) {
    offset = o * outAxis * inner;
    for (const input of inputs) {
      const axisSize = input.meta.shape[axis];
      const chunk = axisSize * inner;
      const srcStart = o * chunk;
      out.data.set(input.data.subarray(srcStart, srcStart + chunk), offset);
      offset += chunk;
    }
  }
}

function stridedSlice(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const rank = input.meta.shape.length;
  const starts = new Array(rank);
  const stops = new Array(rank);
  const strides = Array.from(op.strides);

  for (let i = 0; i < rank; i++) {
    const dim = input.meta.shape[i];
    const stride = strides[i];
    let begin = op.begin[i];
    let end = op.end[i];

    if (op.beginMask & (1 << i)) begin = stride > 0 ? 0 : dim - 1;
    else if (begin < 0) begin += dim;

    if (op.endMask & (1 << i)) end = stride > 0 ? dim : -1;
    else if (end < 0) end += dim;

    starts[i] = begin;
    stops[i] = end;
  }

  const inStrides = stridesForShape(input.meta.shape);
  const outShape = output.meta.shape;
  const outStrides = stridesForShape(outShape);

  for (let outIndex = 0; outIndex < output.data.length; outIndex++) {
    let remaining = outIndex;
    let inputFlat = 0;
    for (let dim = 0; dim < rank; dim++) {
      const coord = Math.floor(remaining / outStrides[dim]);
      remaining %= outStrides[dim];
      inputFlat += (starts[dim] + coord * strides[dim]) * inStrides[dim];
    }
    output.data[outIndex] = input.data[inputFlat];
  }
}

function splitV(state, op) {
  const input = state.tensors[op.input];
  const axis = normalizeAxis(op.axis, input.meta.shape.length);
  const inner = product(input.meta.shape, axis + 1);
  const outer = product(input.meta.shape, 0, axis);
  let axisOffset = 0;

  for (let outIdx = 0; outIdx < op.outputs.length; outIdx++) {
    const out = state.tensors[op.outputs[outIdx]];
    const axisSize = out.meta.shape[axis];
    const chunk = axisSize * inner;

    for (let outerIdx = 0; outerIdx < outer; outerIdx++) {
      const srcStart = outerIdx * input.meta.shape[axis] * inner + axisOffset * inner;
      const dstStart = outerIdx * chunk;
      out.data.set(input.data.subarray(srcStart, srcStart + chunk), dstStart);
    }

    axisOffset += axisSize;
  }
}

// Integer-only Conv2D matching tflite's reference ConvPerChannel.
// Accumulates in int32, adds int32 bias, then uses per-channel
// MultiplyByQuantizedMultiplier to requantize to int8.
function conv2d(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const [batch, inH, inW, inC] = input.meta.shape;
  const [outC, kernelH, kernelW, filterC] = op.weights.shape;
  const [, outH, outW] = output.meta.shape;
  const pad = computePadding(op.padding, inH, inW, kernelH, kernelW, op.strideH, op.strideW, op.dilationH, op.dilationW, outH, outW);
  const weights = op.weights.values;
  const { multipliers, shifts } = op.perChannelMultipliers;
  const inputOffset = op.inputOffset;
  const outputOffset = op.outputOffset;
  const [actMin, actMax] = activationRange(op.activation, op.outputType, outputOffset);
  const outMin = op.outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const outMax = op.outputType === TENSOR_TYPE_INT8 ? 127 : 255;

  let outIndex = 0;
  for (let n = 0; n < batch; n++) {
    for (let oh = 0; oh < outH; oh++) {
      for (let ow = 0; ow < outW; ow++) {
        for (let oc = 0; oc < outC; oc++) {
          // int32 accumulator — starts at 0.  Weight zero point is 0 for
          // per-channel symmetric quantization, so filter_val is used raw.
          let acc = 0;
          for (let kh = 0; kh < kernelH; kh++) {
            const inY = oh * op.strideH + kh * op.dilationH - pad.top;
            if (inY < 0 || inY >= inH) continue;
            for (let kw = 0; kw < kernelW; kw++) {
              const inX = ow * op.strideW + kw * op.dilationW - pad.left;
              if (inX < 0 || inX >= inW) continue;
              const inputBase = (((n * inH + inY) * inW + inX) * inC);
              const weightBase = (((oc * kernelH + kh) * kernelW + kw) * filterC);
              for (let ic = 0; ic < filterC; ic++) {
                acc += weights[weightBase + ic] * (input.data[inputBase + ic] + inputOffset);
              }
            }
          }
          if (op.bias) acc += op.bias[oc];
          acc = multiplyByQuantizedMultiplier(acc, multipliers[oc], shifts[oc]);
          acc += outputOffset;
          if (acc < actMin) acc = actMin;
          else if (acc > actMax) acc = actMax;
          if (acc < outMin) acc = outMin;
          else if (acc > outMax) acc = outMax;
          output.data[outIndex++] = acc;
        }
      }
    }
  }
}

// Integer-only DepthwiseConv2D matching tflite's DepthwiseConvPerChannel.
function depthwiseConv2d(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const [batch, inH, inW, inC] = input.meta.shape;
  const [, kernelH, kernelW, outC] = op.weights.shape;
  const [, outH, outW] = output.meta.shape;
  const pad = computePadding(op.padding, inH, inW, kernelH, kernelW, op.strideH, op.strideW, op.dilationH, op.dilationW, outH, outW);
  const channelsPerInput = op.depthMultiplier;
  const weights = op.weights.values;
  const { multipliers, shifts } = op.perChannelMultipliers;
  const inputOffset = op.inputOffset;
  const outputOffset = op.outputOffset;
  const [actMin, actMax] = activationRange(op.activation, op.outputType, outputOffset);
  const outMin = op.outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const outMax = op.outputType === TENSOR_TYPE_INT8 ? 127 : 255;

  let outIndex = 0;
  for (let n = 0; n < batch; n++) {
    for (let oh = 0; oh < outH; oh++) {
      for (let ow = 0; ow < outW; ow++) {
        for (let oc = 0; oc < outC; oc++) {
          const ic = Math.floor(oc / channelsPerInput);
          let acc = 0;
          for (let kh = 0; kh < kernelH; kh++) {
            const inY = oh * op.strideH + kh * op.dilationH - pad.top;
            if (inY < 0 || inY >= inH) continue;
            for (let kw = 0; kw < kernelW; kw++) {
              const inX = ow * op.strideW + kw * op.dilationW - pad.left;
              if (inX < 0 || inX >= inW) continue;
              const inputIdx = (((n * inH + inY) * inW + inX) * inC) + ic;
              const weightIdx = (((kh * kernelW + kw) * outC) + oc);
              acc += weights[weightIdx] * (input.data[inputIdx] + inputOffset);
            }
          }
          if (op.bias) acc += op.bias[oc];
          acc = multiplyByQuantizedMultiplier(acc, multipliers[oc], shifts[oc]);
          acc += outputOffset;
          if (acc < actMin) acc = actMin;
          else if (acc > actMax) acc = actMax;
          if (acc < outMin) acc = outMin;
          else if (acc > outMax) acc = outMax;
          output.data[outIndex++] = acc;
        }
      }
    }
  }
}

// Integer-only FullyConnected matching tflite's FullyConnectedPerChannel
// for int8 activations with per-channel symmetric weights.
function fullyConnected(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const inVec = input.data;
  const [outCount, inCount] = op.weights.shape;
  const weights = op.weights.values;
  const { multipliers, shifts } = op.perChannelMultipliers;
  const inputOffset = op.inputOffset;
  const outputOffset = op.outputOffset;
  const [actMin, actMax] = activationRange(op.activation, op.outputType, outputOffset);
  const outMin = op.outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const outMax = op.outputType === TENSOR_TYPE_INT8 ? 127 : 255;

  for (let oc = 0; oc < outCount; oc++) {
    let acc = 0;
    const base = oc * inCount;
    for (let ic = 0; ic < inCount; ic++) {
      acc += weights[base + ic] * (inVec[ic] + inputOffset);
    }
    if (op.bias) acc += op.bias[oc];
    acc = multiplyByQuantizedMultiplier(acc, multipliers[oc], shifts[oc]);
    acc += outputOffset;
    if (acc < actMin) acc = actMin;
    else if (acc > actMax) acc = actMax;
    if (acc < outMin) acc = outMin;
    else if (acc > outMax) acc = outMax;
    output.data[oc] = acc;
  }
}

// LOGISTIC on int8 input producing int8 or uint8 output.  The reference
// TFLite int8 LOGISTIC uses a fixed-point sigmoid approximation; here we
// dequantize to float for the sigmoid (tiny output tensor, negligible
// cost) and quantize back.  The output zero point for a sigmoid int8
// tensor is typically -128 with scale 1/256 so values cover [0, 1].
function logistic(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const invInScale = op.inputScale;
  const inZp = op.inputZeroPoint;
  const outScale = op.outputScale;
  const outZp = op.outputZeroPoint;
  const outMin = op.outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const outMax = op.outputType === TENSOR_TYPE_INT8 ? 127 : 255;
  for (let i = 0; i < input.data.length; i++) {
    const f = (input.data[i] - inZp) * invInScale;
    const s = 1 / (1 + Math.exp(-f));
    let q = Math.round(s / outScale + outZp);
    if (q < outMin) q = outMin;
    else if (q > outMax) q = outMax;
    output.data[i] = q;
  }
}

// QUANTIZE re-quantizes an int8 tensor to a different scale/zero-point
// (e.g., the sigmoid output's int8 [-128..127] at scale 1/256 becomes
// the final uint8 [0..255] at scale 1/256 so `/255` reads correctly).
function quantizeOp(state, op) {
  const input = state.tensors[op.input];
  const output = state.tensors[op.output];
  const inScale = op.inputScale;
  const inZp = op.inputZeroPoint;
  const outScale = op.outputScale;
  const outZp = op.outputZeroPoint;
  const outMin = op.outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const outMax = op.outputType === TENSOR_TYPE_INT8 ? 127 : 255;
  for (let i = 0; i < input.data.length; i++) {
    const f = (input.data[i] - inZp) * inScale;
    let q = Math.round(f / outScale + outZp);
    if (q < outMin) q = outMin;
    else if (q > outMax) q = outMax;
    output.data[i] = q;
  }
}

// Compute the clamp range corresponding to a fused ReLU-style activation
// in the requantized output domain.  Returns [min, max] as ints.  The
// activation is applied AFTER requantization and BEFORE the normal int8
// clamp, matching tflite's CalculateActivationRangeQuantized.
function activationRange(activation, outputType, outputZeroPoint) {
  const typeMin = outputType === TENSOR_TYPE_INT8 ? -128 : 0;
  const typeMax = outputType === TENSOR_TYPE_INT8 ? 127 : 255;
  if (activation === ACT_RELU) {
    // ReLU clamps real values to [0, inf).  In quantized space: q_min = zp.
    return [outputZeroPoint, typeMax];
  }
  return [typeMin, typeMax];
}

function computePadding(paddingType, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW) {
  if (paddingType === PADDING_VALID) return { top: 0, left: 0 };

  const effectiveKernelH = (kernelH - 1) * dilationH + 1;
  const effectiveKernelW = (kernelW - 1) * dilationW + 1;
  const totalPadH = Math.max((outH - 1) * strideH + effectiveKernelH - inH, 0);
  const totalPadW = Math.max((outW - 1) * strideW + effectiveKernelW - inW, 0);
  return {
    top: Math.floor(totalPadH / 2),
    left: Math.floor(totalPadW / 2),
  };
}

function applyActivation(value, activation) {
  if (activation === ACT_RELU) return value < 0 ? 0 : value;
  return value;
}

function dequantizeInto(src, dst, quant) {
  const scale = quant?.scales?.[0] ?? 1;
  const zeroPoint = quant?.zeroPoints?.[0] ?? 0;
  for (let i = 0; i < src.length; i++) {
    dst[i] = (src[i] - zeroPoint) * scale;
  }
}

function dequantizeWeight(weight, index, channel) {
  const scales = weight.quant.scales;
  const zeroPoints = weight.quant.zeroPoints;
  const scale = scales.length === 1 ? scales[0] : scales[channel];
  const zeroPoint = zeroPoints.length === 1 ? zeroPoints[0] : zeroPoints[channel];
  return (weight.values[index] - zeroPoint) * scale;
}

function quantizeValue(value, quant, type) {
  const scale = quant?.scales?.[0] ?? 1;
  const zeroPoint = quant?.zeroPoints?.[0] ?? 0;
  const min = MIN_VALUE[type] ?? -Infinity;
  const max = MAX_VALUE[type] ?? Infinity;
  let q = roundAwayFromZero(value / scale + zeroPoint);
  if (q < min) q = min;
  else if (q > max) q = max;
  return q;
}

function requantizeActivation(value, quant, type) {
  const q = quantizeValue(value, quant, type);
  // We keep most intermediate quantized tensors in dequantized float form to
  // simplify execution, but the wake-word models' final output tensor is
  // uint8. For that case we must preserve the raw quantized byte, otherwise
  // small scores like 20 become ~0.078 and collapse to 0 when written into a
  // Uint8Array.
  if (type === TENSOR_TYPE_UINT8) return q;
  const scale = quant?.scales?.[0] ?? 1;
  const zeroPoint = quant?.zeroPoints?.[0] ?? 0;
  return (q - zeroPoint) * scale;
}

function sizeOf(shape) {
  return shape.length ? shape.reduce((acc, val) => acc * val, 1) : 1;
}

function product(shape, start = 0, end = shape.length) {
  let total = 1;
  for (let i = start; i < end; i++) total *= shape[i];
  return total;
}

function stridesForShape(shape) {
  const out = new Array(shape.length);
  let stride = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = stride;
    stride *= shape[i];
  }
  return out;
}

function normalizeAxis(axis, rank) {
  return axis < 0 ? axis + rank : axis;
}

function toInts(bytes) {
  return Array.from(new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}

function toScalarInt(bytes) {
  return new Int32Array(bytes.buffer, bytes.byteOffset, 1)[0];
}

function roundAwayFromZero(value) {
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

function readOptionalU32(fb, tableOff, fieldId, fallback) {
  const field = fb.field(tableOff, fieldId);
  return field ? fb.u32(field) : fallback;
}

function readOptionalU8(fb, tableOff, fieldId, fallback) {
  const field = fb.field(tableOff, fieldId);
  return field ? fb.u8(field) : fallback;
}

function readOptionalI32(fb, tableOff, fieldId, fallback) {
  const field = fb.field(tableOff, fieldId);
  return field ? fb.i32(field) : fallback;
}
