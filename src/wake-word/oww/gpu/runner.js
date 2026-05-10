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
  conv2dShader,
  conv1dNcwShader,
  conv2dNchwShader,
  CONV_DISPATCH_WORKGROUP,
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
} from './shaders.js';

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
  static async create(device, compiled) {
    const runner = new GpuModelRunner(device, compiled);
    await runner._build();
    return runner;
  }

  constructor(device, compiled) {
    this._device = device;
    this._compiled = compiled;
    // Map<tensorId, GPUBuffer> for constants (weights/biases) loaded once.
    this._constantBuffers = new Map();
    this._zeroBuffers = new Map();
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
      const fused = this._tryBuildFusedConvActivation(ops, i, tensors);
      if (fused) {
        this._steps.push(fused);
        i += 2;
        continue;
      }
      const step = await this._buildStep(op, tensors);
      if (step) this._steps.push(step);
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
    if (op.opName === 'Unsqueeze' || op.opName === 'Reshape' || op.opName === 'Cast') {
      return this._buildReshape(op, tensors);
    }
    if (op.opName === 'MAX_POOL_2D') return this._buildMaxPool(op, tensors);
    if (op.opName === 'MaxPool') return this._buildOnnxMaxPool(op, tensors);
    if (op.opName === 'PAD') return this._buildPad(op, tensors);
    throw new Error(`GpuModelRunner: unsupported op ${op.opName}`);
  }

  _tryBuildFusedConvActivation(ops, i, tensors) {
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

  _buildConv(op, tensors, fused = null) {
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
    const [, outH, outW] = outMeta.shape;
    const [, kernelH, kernelW] = wMeta.shape;
    const pad = computePadding(padding, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW);

    const wgsl = conv2dShader({
      inShape: inMeta.shape,
      outShape: outMeta.shape,
      weightShape: wMeta.shape,
      strideH, strideW, dilationH, dilationW,
      padTop: pad.top,
      padLeft: pad.left,
      activation: fused?.activation,
    });
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
    const inputBuf = this._bufferFor(op.inputs[0]);
    const weightsBuf = this._bufferFor(op.inputs[1]);
    const biasBuf = this._bufferFor(op.inputs[2]);
    const outputBuf = this._bufferFor(outId);
    const bindGroup = this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: weightsBuf } },
        { binding: 2, resource: { buffer: biasBuf } },
        { binding: 3, resource: { buffer: outputBuf } },
      ],
    });
    const [outBatch, outHt, outWd, outC] = outMeta.shape;
    void outBatch;
    const dispatchX = Math.ceil(outWd / CONV_DISPATCH_WORKGROUP[0]);
    const dispatchY = Math.ceil(outHt / CONV_DISPATCH_WORKGROUP[1]);
    const dispatchZ = Math.ceil(outC / CONV_DISPATCH_WORKGROUP[2]);
    return { kind: 'conv', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  _buildOnnxConv(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const wMeta = tensors[op.inputs[1]];
    const outMeta = tensors[op.outputs[0]];
    const strides = onnxIntsAttr(op, 'strides') || new Array(inMeta.shape.length - 2).fill(1);
    const pads = onnxIntsAttr(op, 'pads') || new Array((inMeta.shape.length - 2) * 2).fill(0);
    const dilations = onnxIntsAttr(op, 'dilations') || new Array(inMeta.shape.length - 2).fill(1);
    let wgsl;
    let dispatchX;
    let dispatchY;
    let dispatchZ;
    if (inMeta.shape.length === 3) {
      wgsl = conv1dNcwShader({
        inShape: inMeta.shape,
        outShape: outMeta.shape,
        weightShape: wMeta.shape,
        strideW: strides[0],
        dilationW: dilations[0],
        padLeft: pads[0],
      });
      dispatchX = Math.ceil(outMeta.shape[2] / CONV_DISPATCH_WORKGROUP[0]);
      dispatchY = Math.ceil(outMeta.shape[1] / CONV_DISPATCH_WORKGROUP[1]);
      dispatchZ = 1;
    } else {
      wgsl = conv2dNchwShader({
        inShape: inMeta.shape,
        outShape: outMeta.shape,
        weightShape: wMeta.shape,
        strideH: strides[0],
        strideW: strides[1],
        dilationH: dilations[0],
        dilationW: dilations[1],
        padTop: pads[0],
        padLeft: pads[1],
      });
      dispatchX = Math.ceil(outMeta.shape[3] / CONV_DISPATCH_WORKGROUP[0]);
      dispatchY = Math.ceil(outMeta.shape[2] / CONV_DISPATCH_WORKGROUP[1]);
      dispatchZ = Math.ceil(outMeta.shape[1] / CONV_DISPATCH_WORKGROUP[2]);
    }
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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
      ],
    });
    return { kind: 'conv', pipeline, bindGroup, dispatchX, dispatchY, dispatchZ };
  }

  _buildLeakyRelu(op, tensors) {
    const inMeta = tensors[op.inputs[0]];
    const elementCount = shapeSize(inMeta.shape);
    const alpha = readLeakyReluAlpha(op);
    const wgsl = leakyReluShader(elementCount, alpha);
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  _buildUnary(op, tensors, fnExpr) {
    const elementCount = shapeSize(tensors[op.inputs[0]].shape);
    const wgsl = unaryShader(elementCount, fnExpr);
    return this._build1InElementwiseStep(op, wgsl, elementCount);
  }

  _buildClip(op, tensors) {
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
      const pipeline = this._device.createComputePipeline({
        layout: 'auto',
        compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
      });
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
  _buildBinaryWithBroadcast(op, tensors, kind) {
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

  _build1InElementwiseStep(op, wgsl, elementCount) {
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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

  _build2InElementwiseStep(op, wgsl, elementCount, aId, bId) {
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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

  _buildTranspose(op, tensors) {
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

  _buildReduceMax(op, tensors) {
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

  _buildBatchMatmul(op, tensors) {
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
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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
      dispatchX: Math.ceil(N / 8),
      dispatchY: Math.ceil(M / 8),
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

  _buildMaxPool(op, tensors) {
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
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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

  _buildPad(op, tensors) {
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
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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

  _buildOnnxMaxPool(op, tensors) {
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
    const pipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: wgsl }), entryPoint: 'main' },
    });
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
   * Run the GPU pipeline over the supplied input data.  Returns a
   * Promise<Float32Array> of the output tensor; the same view is
   * recycled across calls so callers must consume it before invoking
   * again.
   * @param {Float32Array} input
   * @returns {Promise<Float32Array>}
   */
  async invoke(input) {
    this.writeInput(input);
    const enc = this._device.createCommandEncoder();
    this.encode(enc);
    this.encodeOutputReadback(enc);
    this._device.queue.submit([enc.finish()]);

    return this.readOutput();
  }

  destroy() {
    for (const b of this._constantBuffers.values()) b.destroy();
    for (const b of this._zeroBuffers.values()) b.destroy();
    for (const b of this._activationBuffers.values()) b.destroy();
    if (this._readBuffer) this._readBuffer.destroy();
    this._constantBuffers.clear();
    this._zeroBuffers.clear();
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
function computePadding(paddingType, inH, inW, kernelH, kernelW, strideH, strideW, dilationH, dilationW, outH, outW) {
  if (paddingType === PADDING_VALID) return { top: 0, left: 0 };
  const effKH = (kernelH - 1) * dilationH + 1;
  const effKW = (kernelW - 1) * dilationW + 1;
  const totalH = Math.max((outH - 1) * strideH + effKH - inH, 0);
  const totalW = Math.max((outW - 1) * strideW + effKW - inW, 0);
  return { top: Math.floor(totalH / 2), left: Math.floor(totalW / 2) };
}
