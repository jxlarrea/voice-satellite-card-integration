/**
 * WebGPU device initialization for the openWakeWord embedding model.
 *
 * Lives inside the inference Worker (Workers have their own
 * navigator.gpu in modern browsers).  The OWW backend asks for a device
 * up front - if WebGPU isn't available we fail HARD here so the
 * WakeWordManager can surface a clear toast instead of silently
 * degrading to a CPU JS path that can't keep up on slow tablets.
 */

/** Custom error class so callers can distinguish "no WebGPU support"
 *  from generic init failures and emit a model-switch suggestion. */
export class WebGpuUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'WebGpuUnavailableError';
    // Tag so the panel toast/logging can format a user-facing message
    // with a "switch to microWakeWord" call to action.
    this.code = 'webgpu-unavailable';
  }
}

/**
 * Acquire a `GPUDevice` for the embedding-model runner.  Throws
 * WebGpuUnavailableError if the browser/runtime can't deliver one.
 *
 * @returns {Promise<GPUDevice>}
 */
export async function acquireWebGpuDevice() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGpuUnavailableError(
      'navigator.gpu is undefined - WebGPU is not available in this environment',
    );
  }

  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter({
      // High-performance preference picks the discrete GPU on machines
      // that have one; on integrated-only devices (most tablets) it's
      // a no-op.  The OWW embedding model is small enough that integrated
      // GPUs should still hit our 20-ms-per-chunk target.
      powerPreference: 'high-performance',
    });
  } catch (e) {
    throw new WebGpuUnavailableError(`requestAdapter threw: ${e?.message || e}`);
  }
  if (!adapter) {
    throw new WebGpuUnavailableError(
      'WebGPU adapter request returned null - no compatible GPU driver',
    );
  }

  let device;
  try {
    // We don't need any non-default features.  The default storage-buffer
    // size limit is 128 MiB which is plenty for our ~1.3 MB of weights
    // plus per-chunk activations.
    device = await adapter.requestDevice();
  } catch (e) {
    throw new WebGpuUnavailableError(`requestDevice threw: ${e?.message || e}`);
  }
  if (!device) {
    throw new WebGpuUnavailableError('WebGPU adapter returned null device');
  }

  // Lost-device handler - tear down the worker on a context loss so the
  // outer manager re-initializes from scratch instead of inferring on a
  // dead device handle.
  device.lost.then((info) => {
    // self.postMessage logs flow back to the main-thread logger.
    if (typeof self !== 'undefined' && self.postMessage) {
      self.postMessage({
        type: 'log',
        category: 'wake-word',
        level: 'error',
        message: `WebGPU device lost: ${info.reason} - ${info.message || '(no message)'}`,
      });
    }
  }).catch(() => {});

  return device;
}
