/**
 * DirectModelRunner
 *
 * Zero-allocation wrapper around TFLiteWebModelRunner that bypasses
 * Embind tensor wrappers after an initial calibration.
 *
 * The first inference runs through the normal Embind path. After that
 * succeeds, the stable WASM heap pointers are captured and all subsequent
 * inferences write/read directly to/from WASM linear memory via
 * cpp.Infer() -- no Embind objects created per-call, eliminating the
 * ~31 bytes/call WASM heap leak.
 */

export class DirectModelRunner {
  /**
   * @param {object} runner - TFLiteWebModelRunner instance
   */
  constructor(runner) {
    this._runner = runner;
    this._cpp = runner.cppClassifier;
    this._module = runner.module;
    this._inputView = null;
    this._outputView = null;
    this._ready = false;
  }

  /** @type {Int8Array|null} Direct view into WASM input tensor memory */
  get inputView() { return this._inputView; }

  /** @type {Uint8Array|null} Direct view into WASM output tensor memory */
  get outputView() { return this._outputView; }

  /** @type {boolean} True after pointers have been captured */
  get ready() { return this._ready; }

  /**
   * Capture tensor pointers from a completed Embind inference cycle.
   * Called once after the first successful _runModelEmbind().
   * @param {TypedArray} inputBuffer - from inputTensor.data()
   * @param {TypedArray} outputView - from outputTensor.data()
   */
  capturePointers(inputBuffer, outputView) {
    const heap = this._module.HEAPU8.buffer;
    this._inputView = new Int8Array(heap, inputBuffer.byteOffset, inputBuffer.length);
    this._outputView = new Uint8Array(heap, outputView.byteOffset, outputView.length);
    this._ready = true;
  }

  /**
   * Run inference directly via WASM. Write to inputView before calling.
   * @returns {boolean} true if inference succeeded
   */
  infer() {
    // Refresh views if WASM heap grew (detaches all ArrayBuffer views)
    if (this._inputView.buffer.byteLength === 0) {
      const heap = this._module.HEAPU8.buffer;
      const ip = this._inputView.byteOffset;
      const il = this._inputView.length;
      const op = this._outputView.byteOffset;
      const ol = this._outputView.length;
      this._inputView = new Int8Array(heap, ip, il);
      this._outputView = new Uint8Array(heap, op, ol);
    }
    return this._cpp.Infer();
  }

  /**
   * Clean up the underlying runner.
   */
  cleanUp() {
    this._runner.cleanUp();
    this._inputView = null;
    this._outputView = null;
    this._ready = false;
  }
}
