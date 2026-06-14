/**
 * GPU-accelerated runner for openWakeWord float32 TFLite subgraphs.
 *
 * Takes a CompiledModel from `model-runner.js` (which already parsed
 * the .tflite into op + tensor lists) and replays it on the GPU.
 * The mel spec and embedding models go through here; classifiers stay
 * on CPU because they are already tiny.
 *
 * Pipeline (records once at init, replays per chunk):
 *
 *   CPU input ── writeBuffer ──▶ GPU input buffer
 *                                       │
 *                                       ▼
 *                              ┌────────────────┐
 *                              │ recorded ops:  │
 *                              │ CONV_2D        │
 *                              │ MAXIMUM(0)     │
 *                              │ LEAKY_RELU     │
 *                              │ MAX_POOL_2D    │
 *                              │ PAD            │
 *                              │ ... × 64       │
 *                              └────────┬───────┘
 *                                       │
 *                                       ▼
 *   CPU output ◀── mapAsync(READ) ─── staging buffer ◀── copy
 *
 * One bind group per layer.  Weights live in persistent GPU buffers
 * for the whole runner lifetime; intermediate activations cycle
 * through a small pool of buffers (ping-pong style) to keep total
 * GPU memory bounded.
 */

import {
  CONV_DISPATCH_WORKGROUP,
  COMPAT_CONV_DISPATCH_WORKGROUP,
  COMPAT_CONV_W_VECTOR,
  COMPAT_CONV_OC_VECTOR,
  compatConv2dNhwcShader,
  compatConv1dNcwShader,
  compatConv2dNchwShader,
  clearU32Shader,
  reduceMaxAbsShader,
  quantizePackNhwcShader,
  int8ConvNhwcShader,
  INT8_CONV_WG,
  MATMUL_DISPATCH_WORKGROUP,
  leakyReluShader,
  maximumScalarShader,
  maxPool2dShader,
  maxPool2dNchwShader,
  padShader,
  ELEMENTWISE_WG,
  binaryElementwiseShader,
  binaryScalarConstShader,
  binaryScalarRuntimeShader,
  unaryShader,
  transposeShader,
  reduceMaxAllShader,
  batchMatmulShader,
  gemmShader,
  reduceMeanTailShader,
  sliceShader,
  concatInputShader,
} from './shaders.js';
import { clearVwwStartupBreadcrumb, checkpointVwwStartup } from '../startup-breadcrumb.js';

const TT_FLOAT32 = 0;

/**
 * Wrapper around a CompiledModel that runs the graph on the GPU.
 * Construction is async because we have to compile and prep all
 * the per-layer pipelines up front.
 */
export class GpuModelRunner {
  /**
   * @param {GPUDevice} device
   * @param {object} compiled - the CompiledOwwModel-like object from model-runner.js
   *                            (has subgraphs[0] with tensors[] + ops[])
   */
  static async create(device, compiled, options = {}) {
    const runner = new GpuModelRunner(device, compiled, options);
    await runner._build();
    return runner;
  }

  constructor(device, compiled, options = {}) {
    this._device = device;
    this._compiled = compiled;
    this._log = options.log || null;
    this._pipelineLog = options.pipelineLog === true;
    // int8 conv path (dot4I8Packed, NHWC channel-packed) is THE conv path,
    // not an optional one: acquireWebGpuDevice() already hard-requires the
    // 'packed_4x8_integer_dot_product' WGSL feature (a device without it
    // almost certainly can't run the fp32 path in real time either, so we
    // refuse to load there - same posture as no-WebGPU). ~2x faster conv on
    // the floor-device GPU (Tab A): over -> under the real-time budget, ~1%
    // numeric error. options.int8 === false is a debug-only fp32 escape.
    this._int8 = options.int8 !== false;
    // Count of convs actually built on the int8 path (for the load log).
    this._int8ConvCount = 0;
    // Map<tensorId, GPUBuffer> for constants (weights/biases) loaded once.
    this._constantBuffers = new Map();
    this._zeroBuffers = new Map();
    this._uniformBuffers = [];
    // Map<tensorId, GPUBuffer> for activation intermediates re-used per call.
    this._activationBuffers = new Map();
    // Recorded compute pipelines + bind groups in op order.
    this._steps = [];
    // Pre-allocated staging buffer for reading the output back to CPU.
    this._readBuffer = null;
    // Final output tensor metadata (id + element count) for invoke().
    this._outputId = null;
    this._outputSize = 0;
    // Float32Array view into the output (filled by invoke()).
    this._outputView = null;
    this._invokeCount = 0;
  }

  async _build() {
    const sg = this._compiled.subgraphs[this._compiled.primaryIndex];
    const tensors = sg.tensors;
    const ops = sg.ops;
    this._tensorUseCounts = countTensorUses(ops);

    // Allocate buffers.  Constant tensors get pre-uploaded, everything
    // else gets a fresh activation buffer sized to its shape.
    for (const t of tensors) {
      if (t.type !== TT_FLOAT32 && t.type !== 2 /* INT32 */) {
        // OWW embedding model uses only float32 + a couple of int32
        // shape constants; nothing else should appear.
        continue;
      }
      if (t.constant) {
        this._uploadConstant(t);
      } else {
        const size = shapeSize(t.shape);
        if (size > 0) this._allocActivation(t, size);
      }
    }

    // Walk ops in declared order; build a pipeline + bind group per step.
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      this._buildOpIndex = i;
      this._buildOpName = op.opName;
      const fused = await this._tryBuildFusedConvActivation(ops, i, tensors);
      if (fused) {
        this._steps.push(fused);
        i += 2;
        continue;
      }
      const step = await this._buildStep(op, tensors);
      // int8 convs expand to several sequenced dispatches (clear/maxabs/
      // pack/conv); _buildOnnxConvInt8 returns them as an array.
      if (Array.isArray(step)) { for (const s of step) this._steps.push(s); }
      else if (step) this._steps.push(step);
    }

    // Output buffer: the model's primary output tensor.  We add a
    // separate readback (MAP_READ) buffer of the same size so the per-
    // call path can copy → map → consume without involving the storage
    // buffer's usage flags.
    const outputId = sg.outputIds[0];
    const outShape = tensors[outputId].shape;
    this._outputId = outputId;
    this._outputSize = shapeSize(outShape);
    this._outputView = new Float32Array(this._outputSize);
    this._readBuffer = this._device.createBuffer({
      size: this._outputSize * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      mappedAtCreation: false,
    });

    // Pre-allocated staging buffer for input-tensor uploads.  Single
    // input is the standard case; the embedding model has one input.
    const inputId = sg.inputIds[0];
    this._inputId = inputId;
    this._inputSize = shapeSize(tensors[inputId].shape);
    this._buildOpIndex = null;
    this._buildOpName = null;

    // Surface the int8 status in the debug log so it's clear which conv path
    // a loaded model is running (int8 is default-on; device.js already
    // hard-requires dot4I8Packed support).
    this._log?.log?.(
      'wake-word',
      this._int8
        ? `VWW conv path: int8 ENABLED (${this._int8ConvCount} convs int8 via dot4I8Packed; conv1 + classifier fp32)`
        : 'VWW conv path: fp32 (int8 disabled)',
    );
  }

  async _createComputePipeline(wgsl, label) {
    const detail = {
      label,
      opIndex: this._buildOpIndex,
      opName: this._buildOpName,
    };
    this._logPipelineStep('module:start', detail);
    await checkpointVwwStartup('pipeline:module:start', detail);
    const module = this._device.createShaderModule({ code: wgsl });
    this._logPipelineStep('module:created', detail);
    await checkpointVwwStartup('pipeline:module:created', detail);

    const createAsync = typeof this._device.createComputePipelineAsync === 'function';
    const descriptor = {
      layout: 'auto',
      compute: {
        module,
        entryPoint: 'main',
      },
    };
    this._logPipelineStep(`create:start method=${createAsync ? 'async' : 'sync'}`, detail);
    await checkpointVwwStartup('pipeline:create:start', {
      ...detail,
      method: createAsync ? 'async' : 'sync',
    });
    const pipeline = createAsync
      ? await this._device.createComputePipelineAsync(descriptor)
      : this._device.createComputePipeline(descriptor);
    this._logPipelineStep('create:returned', detail);
    await checkpointVwwStartup('pipeline:create:returned', {
      ...detail,
      method: createAsync ? 'async' : 'sync',
    });
    return pipeline;
  }

  _logPipelineStep(step, detail) {
    if (!this._pipelineLog) return;
    this._log?.log?.(
      'diag',
      `VWW GPU pipeline ${step} `
      + `op=${detail.opIndex}:${detail.opName} label=${detail.label}`,
    );
  }

  _uploadConstant(t) {
    const size = t.constant.byteLength;
    const buf = this._device.createBuffer({
      size: alignedSize(size),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._device.queue.writeBuffer(buf, 0, t.constant.buffer, t.constant.byteOffset, size);
    this._constantBuffers.set(t.id, buf);
  }

  _allocActivation(t, elementCount) {
    const buf = this._device.createBuffer({
      size: alignedSize(elementCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this._activationBuffers.set(t.id, buf);
  }

  _bufferFor(tensorId) {
    return this._constantBuffers.get(tensorId) || this._activationBuffers.get(tensorId);
  }

  _zeroFloatBuffer(elements) {
    const key = elements;
    if (!this._zeroBuffers.has(key)) {
      const data = new Float32Array(elements);
      const buf = this._device.createBuffer({
        size: alignedSize(data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this._device.queue.writeBuffer(buf, 0, data.buffer, 0, data.byteLength);
      this._zeroBuffers.set(key, buf);
    }
    return this._zeroBuffers.get(key);
  }

  _createCompatConvParams(ints, floats = []) {
    const buffer = new ArrayBuffer(80);
    const i32 = new Int32Array(buffer);
    const f32 = new Float32Array(buffer);
    for (let i = 0; i < Math.min(16, ints.length); i++) i32[i] = ints[i] | 0;
    for (let i = 0; i < Math.min(4, floats.length); i++) f32[16 + i] = floats[i];
    const gpuBuffer = this._device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._device.queue.writeBuffer(gpuBuffer, 0, buffer, 0, buffer.byteLength);
    this._uniformBuffers.push(gpuBuffer);
    return gpuBuffer;
  }

  get device() {
    return this._device;
  }

  get inputBuffer() {
    return this._activationBuffers.get(this._inputId);
  }

  get outputBuffer() {
    return this._activationBuffers.get(this._outputId);
  }

  get outputSize() {
    return this._outputSize;
  }

  writeInput(input) {
    if (input.length !== this._inputSize) {
      throw new Error(`Input length mismatch: expected ${this._inputSize}, got ${input.length}`);
    }
    this._device.queue.writeBuffer(this.inputBuffer, 0, input.buffer, input.byteOffset, input.byteLength);
  }

  encode(enc) {
    let pass = null;
    const ensurePass = () => {
      if (!pass) pass = enc.beginComputePass();
    };
    const endPass = () => {
      if (pass) { pass.end(); pass = null; }
    };
    for (const step of this._steps) {
      if (step.kind === 'copy') {
        // Buffer-to-buffer copy isn't a compute op; needs the pass
        // closed before encoding.  EXPAND_DIMS / SQUEEZE land here.
        endPass();
        enc.copyBufferToBuffer(step.srcBuf, 0, step.dstBuf, 0, step.byteCount);
        continue;
      }
      if (step.kind === 'concat') {
        // One sub-dispatch per Concat input (see _buildConcat for why).
        // They all write to the same output buffer at different offsets,
        // so they're independent and safe to run inside the same pass.
        ensurePass();
        for (const sub of step.subSteps) {
          pass.setPipeline(sub.pipeline);
          pass.setBindGroup(0, sub.bindGroup);
          pass.dispatchWorkgroups(sub.dispatchX, sub.dispatchY, sub.dispatchZ);
        }
        continue;
      }
      ensurePass();
      pass.setPipeline(step.pipeline);
      pass.setBindGroup(0, step.bindGroup);
      pass.dispatchWorkgroups(step.dispatchX, step.dispatchY, step.dispatchZ);
    }
    endPass();
  }

  encodeOutputReadback(enc) {
    enc.copyBufferToBuffer(this.outputBuffer, 0, this._readBuffer, 0, this._outputSize * 4);
  }

  async readOutput() {
    await this._readBuffer.mapAsync(GPUMapMode.READ);
    const view = new Float32Array(this._readBuffer.getMappedRange());
    this._outputView.set(view);
    this._readBuffer.unmap();
    return this._outputView;
  }

  async _buildStep(op, tensors) {
    if (op.opName === 'Constant') return null;
    if (op.opName === 'CONV_2D') return this._buildConv(op, tensors);
    if (op.opName === 'Conv') return this._buildOnnxConv(op, tensors);
    if (op.opName === 'LEAKY_RELU') return this._buildLeakyRelu(op, tensors);
    if (op.opName === 'LeakyRelu') return this._buildLeakyRelu(op, tensors);
    if (op.opName === 'MAXIMUM') return this._buildBinaryWithBroadcast(op, tensors, 'MAXIMUM');
    if (op.opName === 'Max') return this._buildBinaryWithBroadcast(op, tensors, 'MAXIMUM');
    if (op.opName === 'MINIMUM') return this._buildBinaryWithBroadcast(op, tensors, 'MINIMUM');
    if (op.opName === 'MUL') return this._buildBinaryWithBroadcast(op, tensors, 'MUL');
    if (op.opName === 'Mul') return this._buildBinaryWithBroadcast(op, tensors, 'MUL');
    if (op.opName === 'ADD') return this._buildBinaryWithBroadcast(op, tensors, 'ADD');
    if (op.opName === 'Add') return this._buildBinaryWithBroadcast(op, tensors, 'ADD');
    if (op.opName === 'SUB') return this._buildBinaryWithBroadcast(op, tensors, 'SUB');
    if (op.opName === 'Sub') return this._buildBinaryWithBroadcast(op, tensors, 'SUB');
    if (op.opName === 'Div') return this._buildBinaryWithBroadcast(op, tensors, 'DIV');
    if (op.opName === 'Pow') return this._buildBinaryWithBroadcast(op, tensors, 'POW');
    if (op.opName === 'LOG') return this._buildUnary(op, tensors, 'log(v)');
    if (op.opName === 'Log') return this._buildUnary(op, tensors, 'log(v)');
    if (op.opName === 'Clip') return this._buildClip(op, tensors);
    if (op.opName === 'TRANSPOSE') return this._buildTranspose(op, tensors);
    if (op.opName === 'Transpose') return this._buildTranspose(op, tensors);
    if (op.opName === 'REDUCE_MAX') return this._buildReduceMax(op, tensors);
    if (op.opName === 'ReduceMax') return this._buildReduceMax(op, tensors);
    if (op.opName === 'BATCH_MATMUL') return this._buildBatchMatmul(op, tensors);
    if (op.opName === 'MatMul') return this._buildBatchMatmul(op, tensors);
    if (op.opName === 'EXPAND_DIMS' || op.opName === 'SQUEEZE') {
      return this._buildReshape(op, tensors);
    }
    if (op.opName === 'Unsqueeze' || op.opName === 'Reshape' || op.opName === 'Cast' || op.opName === 'Flatten') {
      return this._buildReshape(op, tensors);
    }
    if (op.opName === 'MAX_POOL_2D') return this._buildMaxPool(op, tensors);
    if (op.opName === 'MaxPool') return this._buildOnnxMaxPool(op, tensors);
    if (op.opName === 'PAD') return this._buildPad(op, tensors);
    // vsWakeWord additions: trivial unaries + the four ops the v3 graph
    // uses that weren't in OWW's mel/embedding pipeline.
    if (op.opName === 'Sigmoid') return this._buildUnary(op, tensors, '1.0 / (1.0 + exp(-v))');
    if (op.opName === 'Relu') return this._buildUnary(op, tensors, 'max(v, 0.0)');
    if (op.opName === 'Gemm') return this._buildGemm(op, tensors);
    if (op.opName === 'ReduceMean') return this._buildReduceMean(op, tensors);
    if (op.opName === 'Slice') return this._buildSlice(op, tensors);
    if (op.opName === 'Concat') return this._buildConcat(op, tensors);
    throw new Error(`GpuModelRunner: unsupported op ${op.opName}`);
  }

  async _tryBuildFusedConvActivation(ops, i, tensors) {
    const conv = ops[i];
    const leaky = ops[i + 1];
    const maximum = ops[i + 2];
    if (!conv || !leaky || !maximum) return null;
    if (conv.opName !== 'CONV_2D' || leaky.opName !== 'LEAKY_RELU' || maximum.opName !== 'MAXIMUM') {
      return null;
    }
    if (
      conv.outputs.length !== 1
      || leaky.inputs[0] !== conv.outputs[0]
      || leaky.outputs.length !== 1
      || maximum.outputs.length !== 1
    ) {
      return null;
    }
    const leakyOut = leaky.outputs[0];
    if (
      this._tensorUseCounts.get(conv.outputs[0]) !== 1
      || this._tensorUseCounts.get(leakyOut) !== 1
    ) {
      return null;
    }
    let scalarMeta = null;
    if (maximum.inputs[0] === leakyOut) {
      scalarMeta = tensors[maximum.inputs[1]];
    } else if (maximum.inputs[1] === leakyOut) {
      scalarMeta = tensors[maximum.inputs[0]];
    } else {
      return null;
    }
    if (!scalarMeta?.constant || shapeSize(scalarMeta.shape) !== 1) return null;

    const convOutMeta = tensors[conv.outputs[0]];
    const leakyOutMeta = tensors[leakyOut];
    const maxOutMeta = tensors[maximum.outputs[0]];
    if (
      !sameShape(leakyOutMeta.shape, convOutMeta.shape)
      || !sameShape(maxOutMeta.shape, convOutMeta.shape)
    ) {
      return null;
    }

    const alpha = readLeakyReluAlpha(leaky);
    const maxScalar = scalarMeta.constant[0];
    if (!Number.isFinite(alpha) || !Number.isFinite(maxScalar)) return null;

    return this._buildConv(conv, tensors, {
      outputId: maximum.outputs[0],
      activation: {
        kind: 'leakyReluThenMax',
        alpha,
        maxScalar,
      },
    });
  }

  // The following helpers each:
  //   1. Read op options (padding, stride, kernel size, etc.) from the
  //      flatbuffer the same way the CPU runner does.  We ferry the
  //      reader and option-field IDs in via the caller-side `op` object
  //      so we don't need to import them again here.
  //   2. Generate a per-layer WGSL source string.
  //   3. Create a compute pipeline + bind group whose buffers reference
  //      the right input/weight/bias/output tensors for this op.
  //   4. Return a closure that records `pass.setPipeline`, `pass.setBindGroup`,
  //      and `pass.dispatchWorkgroups` for invoke()'s command pass.

  async _buildConv(op, tensors, fused = null) {
    // Conv options live in the model file.  CPU runner reads them via
    // its own helpers; here we read identically.  We do it eagerly at
    // build time because shape constants need to be baked into shader
    // source.
    const {
      padding, strideH, strideW, dilationH, dilationW, fusedActivation,
    } = readConv2dOptions(op);
    if (fusedActivation !== ACT_NONE) {
      throw new Error(`GpuModelRunner: CONV_2D fused activation ${fusedActivation} not supported`);
    }
    const inMeta = tensors[op.inputs[0]];
    const wMeta = tensors[op.inputs[1]];
    const outId = fused?.outputId ?? op.outputs[0];
    const outMeta = tensors[outId];
    const [, inH, inW] = inMeta.shape;
    const [, outH, outW, outputChannels] = outMeta.shape;
    const [, kernelH, kernelW] = wMeta.shape;
    const pad = computePadding(padding, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW);

    const wgsl = compatConv2dNhwcShader();
    const pipeline = await this._createComputePipeline(wgsl, 'conv.nhwc');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const weightsBuf = this._bufferFor(op.inputs[1]);
    const biasBuf = this._bufferFor(op.inputs[2]);
    const outputBuf = this._bufferFor(outId);
    const paramsBuf = this._createCompatConvParams(
      [
        inH, inW, inMeta.shape[3],
        outH, outW, outputChannels, kernelH, kernelW,
        strideH, strideW, dilationH, dilationW,
        pad.top, pad.left, fused?.activation?.kind === 'leakyReluThenMax' ? 1 : 0, 0,
      ],
      [fused?.activation?.alpha ?? 0, fused?.activation?.maxScalar ?? 0, 0, 0],
    );
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: weightsBuf } },
        { binding: 2, resource: { buffer: biasBuf } },
        { binding: 3, resource: { buffer: outputBuf } },
        { binding: 4, resource: { buffer: paramsBuf } },
      ],
    });
    const [outBatch, outHt, outWd, outC] = outMeta.shape;
    void outBatch;
    const wg = COMPAT_CONV_DISPATCH_WORKGROUP;
    const dispatchX = Math.ceil(outWd / wg[0]);
    const dispatchY = Math.ceil(outHt / wg[1]);
    const dispatchZ = Math.ceil(outC / wg[2]);
    return { kind: 'conv', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  async _buildOnnxConv(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const wMeta = tensors[op.inputs[1]];
    const outMeta = tensors[op.outputs[0]];
    // int8 path: only 2D convs with >=4 input channels benefit from channel
    // packing.  conv1 (1 channel) and the Conv1d classifier stay fp32.
    if (this._int8 && inMeta.shape.length === 4 && inMeta.shape[1] >= 4) {
      return this._buildOnnxConvInt8(op, tensors, inMeta, wMeta, outMeta);
    }
    const strides = onnxIntsAttr(op, 'strides') || new Array(inMeta.shape.length - 2).fill(1);
    const pads = onnxIntsAttr(op, 'pads') || new Array((inMeta.shape.length - 2) * 2).fill(0);
    const dilations = onnxIntsAttr(op, 'dilations') || new Array(inMeta.shape.length - 2).fill(1);
    let wgsl;
    let dispatchX;
    let dispatchY;
    let dispatchZ;
    let paramsBuf;
    const wg = COMPAT_CONV_DISPATCH_WORKGROUP;
    if (inMeta.shape.length === 3) {
      wgsl = compatConv1dNcwShader();
      paramsBuf = this._createCompatConvParams([
        inMeta.shape[1], inMeta.shape[2], outMeta.shape[1], outMeta.shape[2],
        wMeta.shape[2], 0, 0, 0,
        strides[0], dilations[0], 0, 0,
        pads[0], 0, 0, 0,
      ]);
      dispatchX = Math.ceil(outMeta.shape[2] / wg[0]);
      dispatchY = Math.ceil(outMeta.shape[1] / wg[1]);
      dispatchZ = 1;
    } else {
      wgsl = compatConv2dNchwShader();
      paramsBuf = this._createCompatConvParams([
        inMeta.shape[1], inMeta.shape[2], inMeta.shape[3], outMeta.shape[1],
        outMeta.shape[2], outMeta.shape[3], wMeta.shape[2], wMeta.shape[3],
        strides[0], strides[1], dilations[0], dilations[1],
        pads[0], pads[1], 0, 0,
      ]);
      // The vectorized NCHW shader covers COMPAT_CONV_W_VECTOR outputs
      // along W and COMPAT_CONV_OC_VECTOR output channels per invocation.
      dispatchX = Math.ceil(outMeta.shape[3] / (wg[0] * COMPAT_CONV_W_VECTOR));
      dispatchY = Math.ceil(outMeta.shape[2] / wg[1]);
      dispatchZ = Math.ceil(outMeta.shape[1] / (wg[2] * COMPAT_CONV_OC_VECTOR));
    }
    const pipeline = await this._createComputePipeline(wgsl, 'conv.onnx');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const weightsBuf = this._bufferFor(op.inputs[1]);
    const biasBuf = op.inputs[2] !== undefined
      ? this._bufferFor(op.inputs[2])
      : this._zeroFloatBuffer(outMeta.shape[1]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: weightsBuf } },
        { binding: 2, resource: { buffer: biasBuf } },
        { binding: 3, resource: { buffer: outputBuf } },
        ...(paramsBuf ? [{ binding: 4, resource: { buffer: paramsBuf } }] : []),
      ],
    });
    return { kind: 'conv', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  // int8 NHWC conv.  Drop-in for _buildOnnxConv: NCHW fp32 in/out, but
  // internally reduces max|x|, quantize+packs the input to int8 NHWC, and
  // runs dot4I8Packed.  Weights are pre-quantized per-output-channel here.
  // Returns FOUR sequenced steps (clear, maxabs, pack, conv).  ReLU is left to
  // the graph's separate Relu op (relu flag = 0).
  async _buildOnnxConvInt8(op, tensors, inMeta, wMeta, outMeta) {
    const strides = onnxIntsAttr(op, 'strides') || [1, 1];
    const pads = onnxIntsAttr(op, 'pads') || [0, 0, 0, 0];
    const dilations = onnxIntsAttr(op, 'dilations') || [1, 1];
    const C = inMeta.shape[1], H = inMeta.shape[2], W = inMeta.shape[3];
    const OC = outMeta.shape[1], outH = outMeta.shape[2], outW = outMeta.shape[3];
    const kH = wMeta.shape[2], kW = wMeta.shape[3];
    const cgroups = Math.ceil(C / 4);
    this._int8ConvCount += 1;

    // --- pre-quantize weights (fp32 [OC][C][kH][kW] -> per-OC int8, packed
    //     NHWC [OC][kH][kW][cgroups] u32, 4 channels per lane). ---
    const wSrc = new Float32Array(
      wMeta.constant.buffer, wMeta.constant.byteOffset, wMeta.constant.byteLength / 4,
    );
    const wscale = new Float32Array(OC);
    const wPacked = new Uint32Array(OC * kH * kW * cgroups);
    for (let oc = 0; oc < OC; oc++) {
      const base = oc * C * kH * kW;
      let m = 0;
      for (let i = 0; i < C * kH * kW; i++) { const a = Math.abs(wSrc[base + i]); if (a > m) m = a; }
      const s = (m / 127) || 1e-8;
      wscale[oc] = s;
      for (let kh = 0; kh < kH; kh++) {
        for (let kw = 0; kw < kW; kw++) {
          for (let g = 0; g < cgroups; g++) {
            let packed = 0;
            for (let l = 0; l < 4; l++) {
              const ic = g * 4 + l;
              let q = 0;
              if (ic < C) {
                q = Math.round(wSrc[((oc * C + ic) * kH + kh) * kW + kw] / s);
                if (q > 127) q = 127; if (q < -128) q = -128;
              }
              packed |= (q & 0xFF) << (l * 8);
            }
            wPacked[((oc * kH + kh) * kW + kw) * cgroups + g] = packed >>> 0;
          }
        }
      }
    }

    const mkStorage = (bytes, data) => {
      const b = this._device.createBuffer({
        size: alignedSize(bytes),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      if (data) this._device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    const wPackedBuf = mkStorage(wPacked.byteLength, wPacked);
    const wscaleBuf = mkStorage(wscale.byteLength, wscale);
    const maxabsBuf = mkStorage(4, null);
    const packedInBuf = mkStorage(cgroups * H * W * 4, null);
    const inputBuf = this._bufferFor(op.inputs[0]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const biasBuf = op.inputs[2] !== undefined
      ? this._bufferFor(op.inputs[2]) : this._zeroFloatBuffer(OC);

    // params uniform (4x vec4<i32>) for the int8 conv.
    const params = new Int32Array([
      H, W, C, OC,
      outH, outW, kH, kW,
      strides[0], strides[1], dilations[0], dilations[1],
      pads[0], pads[1], cgroups, 0 /* relu: separate Relu op */,
    ]);
    const paramsBuf = this._device.createBuffer({
      size: alignedSize(params.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._device.queue.writeBuffer(paramsBuf, 0, params.buffer, 0, params.byteLength);

    const bg = (pipeline, entries) => this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map((buffer, i) => ({ binding: i, resource: { buffer } })),
    });

    // 1) clear maxabs
    const clearPipe = await this._createComputePipeline(clearU32Shader(), 'int8.clear');
    const stepClear = { kind: 'int8', pipeline: clearPipe, bindGroup: bg(clearPipe, [maxabsBuf]), dispatchX: 1, dispatchY: 1, dispatchZ: 1 };
    // 2) reduce max|x| over the NCHW input
    const numEl = C * H * W;
    const maxPipe = await this._createComputePipeline(reduceMaxAbsShader(numEl), 'int8.maxabs');
    const stepMax = { kind: 'int8', pipeline: maxPipe, bindGroup: bg(maxPipe, [inputBuf, maxabsBuf]), dispatchX: Math.ceil(numEl / 64), dispatchY: 1, dispatchZ: 1 };
    // 3) quantize + pack to int8 NHWC
    const packPipe = await this._createComputePipeline(quantizePackNhwcShader(C, H, W), 'int8.pack');
    const stepPack = { kind: 'int8', pipeline: packPipe, bindGroup: bg(packPipe, [inputBuf, maxabsBuf, packedInBuf]), dispatchX: Math.ceil(W / 8), dispatchY: Math.ceil(H / 8), dispatchZ: cgroups };
    // 4) int8 conv
    const convPipe = await this._createComputePipeline(int8ConvNhwcShader(), 'int8.conv');
    const stepConv = {
      kind: 'int8', pipeline: convPipe,
      bindGroup: bg(convPipe, [packedInBuf, wPackedBuf, wscaleBuf, biasBuf, outputBuf, maxabsBuf, paramsBuf]),
      dispatchX: Math.ceil(outW / INT8_CONV_WG[0]),
      dispatchY: Math.ceil(outH / INT8_CONV_WG[1]),
      dispatchZ: Math.ceil(OC / 4),
    };
    return [stepClear, stepMax, stepPack, stepConv];
  }

  async _buildLeakyRelu(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const elementCount = shapeSize(inMeta.shape);
    const alpha = readLeakyReluAlpha(op);
    const wgsl = leakyReluShader(elementCount, alpha);
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  async _buildUnary(op, tensors, fnExpr) {
    const elementCount = shapeSize(tensors[op.inputs[0]].shape);
    const wgsl = unaryShader(elementCount, fnExpr);
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  async _buildClip(op, tensors) {
    const elementCount = shapeSize(tensors[op.inputs[0]].shape);
    const minMeta = tensors[op.inputs[1]];
    const maxMeta = tensors[op.inputs[2]];
    const maxValue = maxMeta?.constant?.[0] ?? Infinity;
    if (minMeta && !minMeta.constant) {
      const wgsl = /* wgsl */`
        @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
        @group(0) @binding(1) var<storage, read> minBuf: array<f32>;
        @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;
        const N: u32 = ${elementCount}u;
        const MAX_V: f32 = ${formatF(maxValue)};
        @compute @workgroup_size(${ELEMENTWISE_WG})
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let i: u32 = gid.x;
          if (i >= N) { return; }
          outputBuf[i] = min(max(inputBuf[i], minBuf[0]), MAX_V);
        }
      `;
      const pipeline = await this._createComputePipeline(wgsl, 'clip');
      const bindGroup = this._device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._bufferFor(op.inputs[0]) } },
          { binding: 1, resource: { buffer: this._bufferFor(op.inputs[1]) } },
          { binding: 2, resource: { buffer: this._bufferFor(op.outputs[0]) } },
        ],
      });
      return {
        kind: 'clip',
        pipeline,
        bindGroup,
        dispatchX: Math.ceil(elementCount / ELEMENTWISE_WG),
        dispatchY: 1,
        dispatchZ: 1,
      };
    }
    const minValue = minMeta?.constant?.[0] ?? -Infinity;
    const wgsl = unaryShader(
      elementCount,
      `min(max(v, ${formatF(minValue)}), ${formatF(maxValue)})`,
    );
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  /**
   * Element-wise binary op for MUL/ADD/SUB/MAXIMUM/MINIMUM with the
   * broadcast patterns we actually see in mel + embedding models:
   *   1) Both operands same shape - straight element-wise.
   *   2) Second operand is a constant scalar (length-1) - bake the
   *      value into the shader.
   *   3) Second operand is a runtime scalar buffer (length 1, no
   *      constant) - read once at dispatch time, broadcast.
   *   4) First operand is the scalar one - swap operands so we hit
   *      case 2 or 3 (only valid for commutative ops MUL/MAX/MIN; ADD
   *      we also can swap).  For SUB this is handled separately.
   * If none of those match we throw - full N-D broadcasting isn't
   * needed by either OWW model.
   */
  async _buildBinaryWithBroadcast(op, tensors, kind) {
    const aMeta = tensors[op.inputs[0]];
    const bMeta = tensors[op.inputs[1]];
    const outMeta = tensors[op.outputs[0]];
    const aSize = shapeSize(aMeta.shape);
    const bSize = shapeSize(bMeta.shape);
    const outSize = shapeSize(outMeta.shape);
    const wgslOp = WGSL_BINARY_OP[kind];

    // Case 1: same-size element-wise.
    if (aSize === bSize && aSize === outSize) {
      const wgsl = wgslOp.elementwise
        ? wgslOp.elementwise(aSize)
        : binaryElementwiseShader(aSize, wgslOp.infix);
      return this._build2InElementwiseStep(op, wgsl, aSize, op.inputs[0], op.inputs[1]);
    }

    // Decide which operand is the "broadcast scalar" - the smaller side
    // (always size 1 in our supported patterns).  If kind isn't
    // commutative AND the scalar is the first operand, we'd need a
    // dedicated shader; for now bail.
    let scalarSideMeta = null;
    let scalarSideId = null;
    let dataSideId = null;
    if (bSize === 1) {
      scalarSideMeta = bMeta; scalarSideId = op.inputs[1]; dataSideId = op.inputs[0];
    } else if (aSize === 1 && wgslOp.commutative) {
      scalarSideMeta = aMeta; scalarSideId = op.inputs[0]; dataSideId = op.inputs[1];
    } else {
      throw new Error(
        `GpuModelRunner: ${kind} broadcast pattern unsupported `
        + `(a=${JSON.stringify(aMeta.shape)}, b=${JSON.stringify(bMeta.shape)})`,
      );
    }

    // Case 2: scalar is a compile-time constant - bake it.
    if (scalarSideMeta.constant && scalarSideMeta.constant.length === 1) {
      const value = scalarSideMeta.constant[0];
      const wgsl = wgslOp.scalarConst
        ? wgslOp.scalarConst(outSize, value)
        : binaryScalarConstShader(outSize, wgslOp.infix, value);
      return this._build1InElementwiseStep({ ...op, inputs: [dataSideId, ...op.inputs.slice(2)] },
        wgsl, outSize);
    }

    // Case 3: scalar is a runtime tensor - pass via second binding.
    const wgsl = wgslOp.scalarRuntime
      ? wgslOp.scalarRuntime(outSize)
      : binaryScalarRuntimeShader(outSize, wgslOp.runtimeFnExpr || `a ${wgslOp.infix} s`);
    return this._build2InElementwiseStep(op, wgsl, outSize, dataSideId, scalarSideId);
  }

  async _build1InElementwiseStep(op, wgsl, elementCount) {
    const pipeline = await this._createComputePipeline(wgsl, 'elementwise-1in');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
      ],
    });
    const dispatchX = Math.ceil(elementCount / ELEMENTWISE_WG);
    return { kind: 'ew', pipeline, bindGroup, dispatchX, dispatchY: 1, dispatchZ: 1 };
  }

  async _build2InElementwiseStep(op, wgsl, elementCount, aId, bId) {
    const pipeline = await this._createComputePipeline(wgsl, 'elementwise-2in');
    const aBuf = this._bufferFor(aId);
    const bBuf = this._bufferFor(bId);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aBuf } },
        { binding: 1, resource: { buffer: bBuf } },
        { binding: 2, resource: { buffer: outputBuf } },
      ],
    });
    const dispatchX = Math.ceil(elementCount / ELEMENTWISE_WG);
    return { kind: 'ew2', pipeline, bindGroup, dispatchX, dispatchY: 1, dispatchZ: 1 };
  }

  async _buildTranspose(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    const permMeta = tensors[op.inputs[1]];
    const perm = op.opName === 'Transpose'
      ? onnxIntsAttr(op, 'perm')
      : (permMeta?.constant ? Array.from(permMeta.constant) : null);
    if (!perm) throw new Error('GpuModelRunner: TRANSPOSE with dynamic perm not supported');
    const wgsl = transposeShader(inMeta.shape, outMeta.shape, perm);
    const elementCount = shapeSize(outMeta.shape);
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  async _buildReduceMax(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    // Mel spec only uses REDUCE_MAX over all axes (output rank 0).
    // If we ever encounter partial reductions we'll add a different
    // shader; for now assert that the output is a single scalar.
    const outSize = shapeSize(outMeta.shape);
    if (outSize !== 1) {
      throw new Error(
        `GpuModelRunner: REDUCE_MAX with non-scalar output (${JSON.stringify(outMeta.shape)}) not supported`,
      );
    }
    const inSize = shapeSize(inMeta.shape);
    const wgsl = reduceMaxAllShader(inSize);
    return this._build1InElementwiseStep(op, wgsl, 1);
  }

  async _buildBatchMatmul(op, tensors) {
    const aMeta = tensors[op.inputs[0]];
    const bMeta = tensors[op.inputs[1]];
    const outMeta = tensors[op.outputs[0]];
    // Only support the mel spec pattern: a [..., M, K] × b [K, N] → [..., M, N]
    // where b has rank 2 (no batch).
    if (bMeta.shape.length !== 2) {
      throw new Error(`GpuModelRunner: BATCH_MATMUL b must be rank-2, got ${JSON.stringify(bMeta.shape)}`);
    }
    const M = aMeta.shape[aMeta.shape.length - 2];
    const Ka = aMeta.shape[aMeta.shape.length - 1];
    const Kb = bMeta.shape[0];
    const N = bMeta.shape[1];
    if (Ka !== Kb) throw new Error(`BATCH_MATMUL inner dim mismatch: ${Ka} vs ${Kb}`);
    let batchCount = 1;
    for (let i = 0; i < aMeta.shape.length - 2; i++) batchCount *= aMeta.shape[i];

    const wgsl = batchMatmulShader(M, Ka, N, batchCount);
    const pipeline = await this._createComputePipeline(wgsl, 'matmul');
    const aBuf = this._bufferFor(op.inputs[0]);
    const bBuf = this._bufferFor(op.inputs[1]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aBuf } },
        { binding: 1, resource: { buffer: bBuf } },
        { binding: 2, resource: { buffer: outputBuf } },
      ],
    });
    return {
      kind: 'matmul',
      pipeline, bindGroup,
      dispatchX: Math.ceil(N / MATMUL_DISPATCH_WORKGROUP[0]),
      dispatchY: Math.ceil(M / MATMUL_DISPATCH_WORKGROUP[1]),
      dispatchZ: batchCount,
    };
  }

  /** EXPAND_DIMS / SQUEEZE: same data, different shape - encoded as a
   *  buffer-to-buffer copy step.  The runner's invoke() handles 'copy'
   *  steps inline via copyBufferToBuffer. */
  _buildReshape(op, tensors) {
    const elementCount = shapeSize(tensors[op.inputs[0]].shape);
    return {
      kind: 'copy',
      srcBuf: this._bufferFor(op.inputs[0]),
      dstBuf: this._bufferFor(op.outputs[0]),
      byteCount: elementCount * 4,
    };
  }

  async _buildMaxPool(op, tensors) {
    const { padding, strideH, strideW, filterH, filterW, fusedActivation } = readPool2dOptions(op);
    if (fusedActivation !== ACT_NONE) {
      throw new Error(`GpuModelRunner: MAX_POOL_2D fused activation ${fusedActivation} not supported`);
    }
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    const [, inH, inW] = inMeta.shape;
    const [, outH, outW] = outMeta.shape;
    const pad = computePadding(padding, inH, inW, filterH, filterW, strideH, strideW, 1, 1, outH, outW);

    const wgsl = maxPool2dShader({
      inShape: inMeta.shape,
      outShape: outMeta.shape,
      filterH, filterW, strideH, strideW,
      padTop: pad.top,
      padLeft: pad.left,
    });
    const pipeline = await this._createComputePipeline(wgsl, 'pool');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
      ],
    });
    const [, outHt, outWd, outC] = outMeta.shape;
    const dispatchX = Math.ceil(outWd / CONV_DISPATCH_WORKGROUP[0]);
    const dispatchY = Math.ceil(outHt / CONV_DISPATCH_WORKGROUP[1]);
    const dispatchZ = Math.ceil(outC / CONV_DISPATCH_WORKGROUP[2]);
    return { kind: 'pool', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  /**
   * Gemm: Y = alpha * A * B[^T] + beta * C.  PyTorch's nn.Linear export
   * uses alpha=1, beta=1, transA=0, transB=1, B shape [N, K], optional
   * 1-D bias C of length N.  We support that exact pattern (which is
   * what vsWakeWord's classifier head emits) and reject anything else.
   */
  async _buildGemm(op, tensors) {
    const alpha = onnxFloatAttr(op, 'alpha') ?? 1.0;
    const beta = onnxFloatAttr(op, 'beta') ?? 1.0;
    const transA = (onnxIntAttr(op, 'transA') ?? 0) !== 0;
    const transB = (onnxIntAttr(op, 'transB') ?? 0) !== 0;
    if (transA) {
      throw new Error('GpuModelRunner: Gemm transA=1 not supported');
    }
    const aMeta = tensors[op.inputs[0]];
    const bMeta = tensors[op.inputs[1]];
    const cMeta = op.inputs.length > 2 ? tensors[op.inputs[2]] : null;
    if (aMeta.shape.length !== 2 || bMeta.shape.length !== 2) {
      throw new Error(
        `GpuModelRunner: Gemm only supports rank-2 A and B (got A=${JSON.stringify(aMeta.shape)} B=${JSON.stringify(bMeta.shape)})`,
      );
    }
    const M = aMeta.shape[0];
    const Ka = aMeta.shape[1];
    const N = transB ? bMeta.shape[0] : bMeta.shape[1];
    const Kb = transB ? bMeta.shape[1] : bMeta.shape[0];
    if (Ka !== Kb) {
      throw new Error(`GpuModelRunner: Gemm K mismatch (A.K=${Ka} B.K=${Kb})`);
    }
    const hasBias = !!cMeta && shapeSize(cMeta.shape) === N;
    const wgsl = gemmShader(M, Ka, N, hasBias, alpha, beta, transB);
    const pipeline = await this._createComputePipeline(wgsl, 'gemm');
    const entries = [
      { binding: 0, resource: { buffer: this._bufferFor(op.inputs[0]) } },
      { binding: 1, resource: { buffer: this._bufferFor(op.inputs[1]) } },
    ];
    if (hasBias) {
      entries.push({ binding: 2, resource: { buffer: this._bufferFor(op.inputs[2]) } });
      entries.push({ binding: 3, resource: { buffer: this._bufferFor(op.outputs[0]) } });
    } else {
      entries.push({ binding: 2, resource: { buffer: this._bufferFor(op.outputs[0]) } });
    }
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    return {
      kind: 'gemm', pipeline, bindGroup,
      dispatchX: Math.ceil(N / MATMUL_DISPATCH_WORKGROUP[0]),
      dispatchY: Math.ceil(M / MATMUL_DISPATCH_WORKGROUP[1]),
      dispatchZ: 1,
    };
  }

  /**
   * ReduceMean: contiguous-tail pattern.  Supports both keepdims=1
   * (output keeps reduced axes as size 1) and keepdims=0 (reduced
   * axes are dropped).  The shader is identical for both - only the
   * output shape's declared rank differs.  Anything other than
   * contiguous trailing axes would need a different shader.
   */
  async _buildReduceMean(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    const inShape = inMeta.shape;
    const outShape = outMeta.shape;
    const rank = inShape.length;
    const keepdims = (onnxIntAttr(op, 'keepdims') ?? 1) !== 0;
    // For keepdims=0 the declared output shape has the reduced axes
    // dropped; rebuild the "logical" output shape (= inShape with
    // reduced axes set to 1) for trailing-tail detection below.
    // Without an explicit `axes` attribute or input, ONNX defaults to
    // reducing ALL axes.
    let axes = onnxIntsAttr(op, 'axes');
    if (axes && axes.length) {
      axes = axes.map(a => (a < 0 ? rank + a : a)).sort((a, b) => a - b);
    } else {
      // All-axis reduction.
      axes = Array.from({ length: rank }, (_, i) => i);
    }
    const logicalOutShape = inShape.slice();
    for (const a of axes) logicalOutShape[a] = 1;
    // Validate declared output matches expected shape (rank changes
    // when keepdims=0, dims stay 1 when keepdims=1).
    const expectedOut = keepdims
      ? logicalOutShape
      : inShape.filter((_, i) => !axes.includes(i));
    if (outShape.length !== expectedOut.length
        || outShape.some((d, i) => d !== expectedOut[i])) {
      throw new Error(
        `GpuModelRunner: ReduceMean output shape mismatch `
        + `(in=${JSON.stringify(inShape)} declared=${JSON.stringify(outShape)} `
        + `expected=${JSON.stringify(expectedOut)} keepdims=${keepdims ? 1 : 0})`,
      );
    }
    // Identify trailing axes that are reduced.  Must be contiguous + trailing.
    let firstReduced = rank;
    for (let i = 0; i < rank; i++) {
      if (logicalOutShape[i] !== inShape[i]) {
        if (logicalOutShape[i] !== 1) {
          throw new Error('GpuModelRunner: ReduceMean logical output dim mismatch');
        }
        firstReduced = i;
        break;
      }
    }
    for (let i = firstReduced; i < rank; i++) {
      if (logicalOutShape[i] !== 1) {
        throw new Error('GpuModelRunner: ReduceMean non-trailing reduction not supported');
      }
    }
    let outerCount = 1;
    for (let i = 0; i < firstReduced; i++) outerCount *= inShape[i];
    let reduceCount = 1;
    for (let i = firstReduced; i < rank; i++) reduceCount *= inShape[i];
    const wgsl = reduceMeanTailShader(outerCount, reduceCount);
    const pipeline = await this._createComputePipeline(wgsl, 'reduce-mean');
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._bufferFor(op.inputs[0]) } },
        { binding: 1, resource: { buffer: this._bufferFor(op.outputs[0]) } },
      ],
    });
    return {
      kind: 'reduce_mean', pipeline, bindGroup,
      dispatchX: Math.ceil(outerCount / ELEMENTWISE_WG),
      dispatchY: 1, dispatchZ: 1,
    };
  }

  /**
   * Slice (opset 13+): copy a strided sub-region of the input into a
   * dense output buffer.  starts/ends/axes/steps must be Constants
   * (folded at export time) - dynamic slice isn't supported.
   */
  async _buildSlice(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    const inShape = inMeta.shape;
    const outShape = outMeta.shape;
    const rank = inShape.length;
    const startsT = tensors[op.inputs[1]];
    const endsT = tensors[op.inputs[2]];
    const axesT = op.inputs.length > 3 ? tensors[op.inputs[3]] : null;
    const stepsT = op.inputs.length > 4 ? tensors[op.inputs[4]] : null;
    if (!startsT.constant || !endsT.constant) {
      throw new Error('GpuModelRunner: Slice with non-constant starts/ends not supported');
    }
    if (axesT && !axesT.constant) {
      throw new Error('GpuModelRunner: Slice with non-constant axes not supported');
    }
    if (stepsT && !stepsT.constant) {
      throw new Error('GpuModelRunner: Slice with non-constant steps not supported');
    }
    const startsIn = Array.from(startsT.constant);
    const endsIn = Array.from(endsT.constant);
    const axesIn = axesT ? Array.from(axesT.constant) : startsIn.map((_, i) => i);
    const stepsIn = stepsT ? Array.from(stepsT.constant) : startsIn.map(() => 1);
    const perAxisStart = new Array(rank).fill(0);
    const perAxisStep = new Array(rank).fill(1);
    for (let i = 0; i < axesIn.length; i++) {
      const rawAxis = axesIn[i];
      const a = rawAxis < 0 ? rawAxis + rank : rawAxis;
      const dim = inShape[a];
      let s = startsIn[i];
      let e = endsIn[i];
      const stp = stepsIn[i] || 1;
      if (stp < 0) {
        throw new Error('GpuModelRunner: Slice with negative steps not supported');
      }
      if (s < 0) s += dim;
      if (e < 0) e += dim;
      s = Math.max(0, Math.min(s, dim));
      perAxisStart[a] = s;
      perAxisStep[a] = stp;
    }
    const wgsl = sliceShader(inShape, outShape, perAxisStart, perAxisStep);
    const pipeline = await this._createComputePipeline(wgsl, 'slice');
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._bufferFor(op.inputs[0]) } },
        { binding: 1, resource: { buffer: this._bufferFor(op.outputs[0]) } },
      ],
    });
    const total = shapeSize(outShape);
    return {
      kind: 'slice', pipeline, bindGroup,
      dispatchX: Math.ceil(total / ELEMENTWISE_WG),
      dispatchY: 1, dispatchZ: 1,
    };
  }

  /**
   * Concat: N inputs along `axis` into a single output.  Run one shader
   * dispatch per input so the binding count stays at 2 regardless of N
   * (a 12-input torch.cat would otherwise blow past the 8-buffer limit
   * common on tablets).
   */
  async _buildConcat(op, tensors) {
    const axisAttr = onnxIntAttr(op, 'axis') ?? 0;
    const outMeta = tensors[op.outputs[0]];
    const outShape = outMeta.shape;
    const rank = outShape.length;
    const axis = axisAttr < 0 ? axisAttr + rank : axisAttr;
    const outerCount = outShape.slice(0, axis).reduce((p, v) => p * v, 1);
    const innerCount = outShape.slice(axis + 1).reduce((p, v) => p * v, 1);
    const outAxisSize = outShape[axis];
    const outBuf = this._bufferFor(op.outputs[0]);
    const subSteps = [];
    let axisOffset = 0;
    for (const inputId of op.inputs) {
      const inMeta = tensors[inputId];
      const axisSize = inMeta.shape[axis];
      const wgsl = concatInputShader(outerCount, axisSize, innerCount, outAxisSize, axisOffset);
      const pipeline = await this._createComputePipeline(wgsl, 'concat');
      const bindGroup = this._device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._bufferFor(inputId) } },
          { binding: 1, resource: { buffer: outBuf } },
        ],
      });
      const total = outerCount * axisSize * innerCount;
      subSteps.push({
        pipeline, bindGroup,
        dispatchX: Math.ceil(total / ELEMENTWISE_WG),
        dispatchY: 1, dispatchZ: 1,
      });
      axisOffset += axisSize;
    }
    return { kind: 'concat', subSteps };
  }

  async _buildPad(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const paddingsMeta = tensors[op.inputs[1]];
    const outMeta = tensors[op.outputs[0]];
    if (!paddingsMeta.constant) {
      throw new Error('GpuModelRunner: PAD with dynamic paddings not supported');
    }
    // paddings shape [rank, 2]; for our NHWC model rank is 4.  We only
    // care about H/W spatial pads; channel + batch pads are always 0.
    const padTop = paddingsMeta.constant[1 * 2];
    const padLeft = paddingsMeta.constant[2 * 2];

    const wgsl = padShader({
      inShape: inMeta.shape,
      outShape: outMeta.shape,
      padTop, padLeft,
    });
    const pipeline = await this._createComputePipeline(wgsl, 'pad');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
      ],
    });
    const [, outHt, outWd, outC] = outMeta.shape;
    const dispatchX = Math.ceil(outWd / CONV_DISPATCH_WORKGROUP[0]);
    const dispatchY = Math.ceil(outHt / CONV_DISPATCH_WORKGROUP[1]);
    const dispatchZ = Math.ceil(outC / CONV_DISPATCH_WORKGROUP[2]);
    return { kind: 'pad', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  async _buildOnnxMaxPool(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const outMeta = tensors[op.outputs[0]];
    const kernel = onnxIntsAttr(op, 'kernel_shape') || [1, 1];
    const strides = onnxIntsAttr(op, 'strides') || kernel;
    const pads = onnxIntsAttr(op, 'pads') || [0, 0, 0, 0];
    const wgsl = maxPool2dNchwShader({
      inShape: inMeta.shape,
      outShape: outMeta.shape,
      filterH: kernel[0],
      filterW: kernel[1],
      strideH: strides[0],
      strideW: strides[1],
      padTop: pads[0],
      padLeft: pads[1],
    });
    const pipeline = await this._createComputePipeline(wgsl, 'pool');
    const inputBuf = this._bufferFor(op.inputs[0]);
    const outputBuf = this._bufferFor(op.outputs[0]);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
      ],
    });
    const dispatchX = Math.ceil(outMeta.shape[3] / CONV_DISPATCH_WORKGROUP[0]);
    const dispatchY = Math.ceil(outMeta.shape[2] / CONV_DISPATCH_WORKGROUP[1]);
    const dispatchZ = Math.ceil(outMeta.shape[1] / CONV_DISPATCH_WORKGROUP[2]);
    return { kind: 'pool', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  /**
   * Submit GPU work for the supplied input.  Returns synchronously after
   * the command buffer is queued — the GPU runs in the background.  Use
   * readOutput() (or its private companion _awaitReadback() inside invoke())
   * to fetch the result.  Allows the caller to overlap CPU work (e.g.
   * extracting log-mel features for the next window) with this inference.
   * @param {Float32Array} input
   */
  submitInference(input) {
    const firstInvoke = this._invokeCount === 0;
    if (firstInvoke) {
      checkpointVwwStartup('invoke:first-submit', {
        outputSize: this._outputSize,
        inputLength: input.length,
      });
    }
    this.writeInput(input);
    const enc = this._device.createCommandEncoder();
    this.encode(enc);
    this.encodeOutputReadback(enc);
    this._device.queue.submit([enc.finish()]);
  }

  /**
   * Run the GPU pipeline over the supplied input data.  Returns a
   * Promise<Float32Array> of the output tensor; the same view is
   * recycled across calls so callers must consume it before invoking
   * again.
   * @param {Float32Array} input
   * @returns {Promise<Float32Array>}
   */
  async invoke(input) {
    const firstInvoke = this._invokeCount === 0;
    this.submitInference(input);

    if (firstInvoke && typeof this._device.queue.onSubmittedWorkDone === 'function') {
      await checkpointVwwStartup('invoke:first-wait');
      await this._device.queue.onSubmittedWorkDone();
    }

    if (firstInvoke) {
      await checkpointVwwStartup('invoke:first-readback');
    }
    const out = await this.readOutput();
    this._invokeCount++;
    if (firstInvoke) {
      clearVwwStartupBreadcrumb({ phase: 'invoke:first-complete' });
    }
    return out;
  }

  destroy() {
    for (const b of this._constantBuffers.values()) b.destroy();
    for (const b of this._zeroBuffers.values()) b.destroy();
    for (const b of this._uniformBuffers) b.destroy();
    for (const b of this._activationBuffers.values()) b.destroy();
    if (this._readBuffer) this._readBuffer.destroy();
    this._constantBuffers.clear();
    this._zeroBuffers.clear();
    this._uniformBuffers = [];
    this._activationBuffers.clear();
    this._steps = [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Per-op metadata: WGSL infix operator + whether the op is commutative
 * (so we can swap operands when broadcasting).  SUB and "MAX/MIN with
 * the runtime-scalar operand on the *first* side" need dedicated paths;
 * for MAX/MIN we pass through the runtime fn expression.
 */
const WGSL_BINARY_OP = {
  MUL: { infix: '*', commutative: true },
  ADD: { infix: '+', commutative: true },
  SUB: { infix: '-', commutative: false },
  DIV: { infix: '/', commutative: false },
  POW: {
    infix: 'pow',
    commutative: false,
    elementwise: (n) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
      @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = pow(aBuf[i], bBuf[i]);
      }
    `,
    scalarConst: (n, s) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      const S: f32 = ${formatF(s)};
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = pow(aBuf[i], S);
      }
    `,
    runtimeFnExpr: 'pow(a, s)',
  },
  MAXIMUM: {
    infix: 'max',
    commutative: true,
    elementwise: (n) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
      @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = max(aBuf[i], bBuf[i]);
      }
    `,
    scalarConst: (n, s) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      const S: f32 = ${formatF(s)};
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = max(aBuf[i], S);
      }
    `,
    runtimeFnExpr: 'max(a, s)',
  },
  MINIMUM: {
    infix: 'min',
    commutative: true,
    elementwise: (n) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
      @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = min(aBuf[i], bBuf[i]);
      }
    `,
    scalarConst: (n, s) => /* wgsl */`
      @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
      @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;
      const N: u32 = ${n}u;
      const S: f32 = ${formatF(s)};
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i: u32 = gid.x;
        if (i >= N) { return; }
        outputBuf[i] = min(aBuf[i], S);
      }
    `,
    runtimeFnExpr: 'min(a, s)',
  },
};

function formatF(v) {
  if (!isFinite(v)) return v > 0 ? '1.0e30' : '-1.0e30';
  const s = String(v);
  return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : `${s}.0`;
}

function shapeSize(shape) {
  if (!shape || shape.length === 0) return 1;
  let s = 1;
  for (const d of shape) s *= d;
  return s;
}

function sameShape(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function countTensorUses(ops) {
  const counts = new Map();
  for (const op of ops) {
    for (const tensorId of op.inputs) {
      counts.set(tensorId, (counts.get(tensorId) || 0) + 1);
    }
  }
  return counts;
}

/** WebGPU buffer sizes must be multiples of 4. */
function alignedSize(bytes) {
  return Math.max(4, (bytes + 3) & ~3);
}

// ─── Op-options readers ────────────────────────────────────────────────
// Mirror the field IDs in model-runner.js.  Kept private here so the
// GPU runner doesn't depend on the CPU runner's internal exports.

const FIELD_CONV2D_PADDING = 0;
const FIELD_CONV2D_STRIDE_W = 1;
const FIELD_CONV2D_STRIDE_H = 2;
const FIELD_CONV2D_FUSED_ACTIVATION = 3;
const FIELD_CONV2D_DILATION_W = 4;
const FIELD_CONV2D_DILATION_H = 5;
const FIELD_POOL_PADDING = 0;
const FIELD_POOL_STRIDE_W = 1;
const FIELD_POOL_STRIDE_H = 2;
const FIELD_POOL_FILTER_W = 3;
const FIELD_POOL_FILTER_H = 4;
const FIELD_POOL_FUSED_ACTIVATION = 5;
const FIELD_LEAKY_RELU_ALPHA = 0;
const ACT_NONE = 0;
const PADDING_SAME = 0;
const PADDING_VALID = 1;

function readU8(fb, tableOff, fieldId, fallback) {
  if (!tableOff || !fb) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.u8(f) : fallback;
}
function readU32(fb, tableOff, fieldId, fallback) {
  if (!tableOff || !fb) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.u32(f) : fallback;
}
function readF32(fb, tableOff, fieldId, fallback) {
  if (!tableOff || !fb) return fallback;
  const f = fb.field(tableOff, fieldId);
  return f ? fb.f32(f) : fallback;
}

function readConv2dOptions(op) {
  return {
    padding: readU8(op.fb, op.optionsOff, FIELD_CONV2D_PADDING, PADDING_SAME),
    strideW: readU32(op.fb, op.optionsOff, FIELD_CONV2D_STRIDE_W, 1),
    strideH: readU32(op.fb, op.optionsOff, FIELD_CONV2D_STRIDE_H, 1),
    fusedActivation: readU8(op.fb, op.optionsOff, FIELD_CONV2D_FUSED_ACTIVATION, ACT_NONE),
    dilationW: readU32(op.fb, op.optionsOff, FIELD_CONV2D_DILATION_W, 1),
    dilationH: readU32(op.fb, op.optionsOff, FIELD_CONV2D_DILATION_H, 1),
  };
}
function readPool2dOptions(op) {
  return {
    padding: readU8(op.fb, op.optionsOff, FIELD_POOL_PADDING, PADDING_SAME),
    strideW: readU32(op.fb, op.optionsOff, FIELD_POOL_STRIDE_W, 1),
    strideH: readU32(op.fb, op.optionsOff, FIELD_POOL_STRIDE_H, 1),
    filterW: readU32(op.fb, op.optionsOff, FIELD_POOL_FILTER_W, 1),
    filterH: readU32(op.fb, op.optionsOff, FIELD_POOL_FILTER_H, 1),
    fusedActivation: readU8(op.fb, op.optionsOff, FIELD_POOL_FUSED_ACTIVATION, ACT_NONE),
  };
}
function readLeakyReluAlpha(op) {
  const onnxAlpha = onnxFloatAttr(op, 'alpha');
  if (typeof onnxAlpha === 'number') return onnxAlpha;
  return readF32(op.fb, op.optionsOff, FIELD_LEAKY_RELU_ALPHA, 0.01);
}

function onnxAttr(op, name) {
  return op.node?.attrs?.get?.(name) || null;
}

function onnxIntsAttr(op, name) {
  const a = onnxAttr(op, name);
  return a?.ints?.length ? a.ints.slice() : null;
}

function onnxFloatAttr(op, name) {
  const a = onnxAttr(op, name);
  return a ? a.f : null;
}

function onnxIntAttr(op, name) {
  const a = onnxAttr(op, name);
  return a && typeof a.i === 'number' ? a.i : null;
}
function computePadding(paddingType, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW) {
  if (paddingType === PADDING_VALID) return { top: 0, left: 0 };
  const effKH = (kernelH - 1) * dilationH + 1;
  const effKW = (kernelW - 1) * dilationW + 1;
  const totalH = Math.max((outH - 1) * strideH + effKH - inH, 0);
  const totalW = Math.max((outW - 1) * strideW + effKW - inW, 0);
  return { top: Math.floor(totalH / 2), left: Math.floor(totalW / 2) };
}
