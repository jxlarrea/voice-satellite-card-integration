/**
 * WebGPU device initialization for the openWakeWord embedding model.
 *
 * Lives inside the inference Worker (Workers have their own
 * navigator.gpu in modern browsers).  The OWW backend asks for a device
 * up front - if WebGPU isn't available we fail HARD here so the
 * WakeWordManager can surface a clear toast instead of silently
 * degrading to a CPU JS path that can't keep up on slow tablets.
 */

import { checkpointVwwStartup } from '../startup-breadcrumb.js';

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
 * Tries a core adapter first, then falls back to a compatibility-tier
 * adapter (`featureLevel: 'compatibility'`).  Chrome backs the compat
 * tier with OpenGL ES instead of Vulkan, which unlocks hardware WebGPU
 * on devices the core tier blocklists - e.g. Android 11 tablets, where
 * core requestAdapter() always returns null but a real Mali/Adreno
 * compat adapter is available.  Compat limits (128 invocations per
 * workgroup, 4+ storage buffers) comfortably cover our shaders (max
 * workgroup 64, max 4 storage buffers).
 *
 * @returns {Promise<{device: GPUDevice, compatibilityTier: boolean}>}
 */
export async function acquireWebGpuDevice() {
  await checkpointVwwStartup('device:begin');

  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGpuUnavailableError(
      'navigator.gpu is undefined - WebGPU is not available in this environment',
    );
  }

  let adapter;
  let compatibilityTier = false;
  try {
    await checkpointVwwStartup('device:request-adapter');
    adapter = await navigator.gpu.requestAdapter();
  } catch (e) {
    throw new WebGpuUnavailableError(`requestAdapter threw: ${e?.message || e}`);
  }
  if (!adapter) {
    try {
      await checkpointVwwStartup('device:request-adapter-compat');
      adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
      compatibilityTier = !!adapter;
    } catch (_e) {
      // Older browsers may reject the option dictionary - treat as null.
    }
  }
  if (!adapter) {
    throw new WebGpuUnavailableError(
      'WebGPU adapter request returned null for both core and compatibility tiers - no compatible GPU driver',
    );
  }

  let device;
  try {
    await checkpointVwwStartup('device:request-device', {
      adapterInfo: summarizeAdapterInfo(adapter),
      compatibilityTier,
    });
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

  // NOTE: packed int8 dot support (dot4I8Packed) is deliberately NOT
  // required here.  The int8 conv path is dormant - every shipped model
  // is rank-3 Conv1d and runs the fp32 OC4 kernel - so a device without
  // the WGSL feature loads and runs normally.  GpuModelRunner checks
  // the feature itself and only enables the int8 path (future rank-4
  // models) when it is actually available.

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

  await checkpointVwwStartup('device:ready', {
    adapterInfo: summarizeAdapterInfo(adapter),
    limits: summarizeDeviceLimits(device),
    compatibilityTier,
  });

  return { device, compatibilityTier };
}

function summarizeAdapterInfo(adapter) {
  const info = adapter?.info || {};
  return {
    vendor: info.vendor || '',
    architecture: info.architecture || '',
    device: info.device || '',
    description: info.description || '',
  };
}

function summarizeDeviceLimits(device) {
  const limits = device?.limits || {};
  return {
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
  };
}
