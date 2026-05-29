import { ELEMENTWISE_WG, melWindowUpdateShader } from './shaders.js';

const MEL_BINS = 32;
const MEL_WINDOW = 76;
const MEL_WINDOW_ELEMENTS = MEL_WINDOW * MEL_BINS;
const INITIAL_MEL_VALUE = 1;

/**
 * Fuses the WebGPU mel and embedding front-end into one command buffer.
 *
 * The unfused path reads the 8x32 mel output back to JS, applies the
 * openWakeWord x/10+2 transform, rebuilds the 76x32 embedding input on
 * the CPU, then uploads that input back to the GPU. This class keeps the
 * rolling 76-frame mel window in GPU memory and only reads back the final
 * 96-dim embedding vector that the CPU classifiers need.
 */
export class FusedOwwGpuFrontend {
  constructor(melRunner, embeddingRunner) {
    if (!melRunner || !embeddingRunner) {
      throw new Error('FusedOwwGpuFrontend requires mel and embedding GPU runners');
    }
    if (melRunner.device !== embeddingRunner.device) {
      throw new Error('FusedOwwGpuFrontend runners must share a GPUDevice');
    }
    this._device = melRunner.device;
    this._melRunner = melRunner;
    this._embeddingRunner = embeddingRunner;
    this._windowElements = MEL_WINDOW_ELEMENTS;
    this._appendElements = melRunner.outputSize;

    if (
      this._appendElements <= 0
      || this._appendElements >= this._windowElements
      || this._appendElements % MEL_BINS !== 0
      || this._windowElements % MEL_BINS !== 0
    ) {
      throw new Error(`Unexpected mel output size for fused OWW path: ${this._appendElements}`);
    }

    this._windowBytes = this._windowElements * 4;
    this._windows = [
      this._createWindowBuffer(),
      this._createWindowBuffer(),
    ];
    this._activeWindow = 0;
    this._initData = new Float32Array(this._windowElements).fill(INITIAL_MEL_VALUE);

    const shader = melWindowUpdateShader(this._windowElements, this._appendElements);
    this._updatePipeline = this._device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
    this._bindGroups = [
      this._createBindGroup(0, 1),
      this._createBindGroup(1, 0),
    ];
    this._dispatchX = Math.ceil(this._windowElements / ELEMENTWISE_WG);
    this.reset();
  }

  reset() {
    this._activeWindow = 0;
    for (const win of this._windows) {
      this._device.queue.writeBuffer(win, 0, this._initData.buffer, 0, this._initData.byteLength);
    }
    this._device.queue.writeBuffer(
      this._embeddingRunner.inputBuffer,
      0,
      this._initData.buffer,
      0,
      this._initData.byteLength,
    );
  }

  async invoke(melInput) {
    this._melRunner.writeInput(melInput);

    const enc = this._device.createCommandEncoder();
    this._melRunner.encode(enc);

    const nextWindow = 1 - this._activeWindow;
    const pass = enc.beginComputePass();
    pass.setPipeline(this._updatePipeline);
    pass.setBindGroup(0, this._bindGroups[this._activeWindow]);
    pass.dispatchWorkgroups(this._dispatchX);
    pass.end();

    enc.copyBufferToBuffer(
      this._windows[nextWindow],
      0,
      this._embeddingRunner.inputBuffer,
      0,
      this._windowBytes,
    );
    this._embeddingRunner.encode(enc);
    this._embeddingRunner.encodeOutputReadback(enc);
    this._device.queue.submit([enc.finish()]);
    this._activeWindow = nextWindow;

    return this._embeddingRunner.readOutput();
  }

  destroy() {
    for (const win of this._windows) win.destroy();
    this._windows = [];
  }

  _createWindowBuffer() {
    return this._device.createBuffer({
      size: this._windowBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  _createBindGroup(sourceIdx, destIdx) {
    return this._device.createBindGroup({
      layout: this._updatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._windows[sourceIdx] } },
        { binding: 1, resource: { buffer: this._melRunner.outputBuffer } },
        { binding: 2, resource: { buffer: this._windows[destIdx] } },
      ],
    });
  }
}
