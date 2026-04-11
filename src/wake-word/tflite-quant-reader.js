/**
 * Runtime TFLite input quantization reader.
 *
 * Parses just enough of a .tflite flatbuffer to extract the input
 * tensor's affine quantization parameters (scale + zero_point), which
 * the WASM micro_frontend uses to convert float features → int8 model
 * input. The HA Android app does the equivalent at native level via
 * TfLiteAffineQuantization (see microwakeword/src/main/cpp/MicroWakeWordEngine.cpp).
 *
 * Why this is a runtime parser, not a build-time tool:
 *
 *   1. Users can install custom .tflite wake word models that were
 *      never seen at build time. A baked-in JSON wouldn't have entries
 *      for them and we'd silently fall back to wrong defaults.
 *
 *   2. The TFLite Web API client we use (tflite_web_api_client.js,
 *      Closure-compiled by Google) does not expose tensor quantization
 *      parameters at all — only id/name/dataType/shape/data(). So even
 *      with the model loaded into the runtime, we cannot ask it for
 *      scale/zero_point. Reading them out of the .tflite buffer
 *      ourselves is the only path.
 *
 * The TFLite schema lives at
 *   https://github.com/tensorflow/tensorflow/blob/master/tensorflow/lite/schema/schema.fbs
 *
 * We need only a fixed traversal:
 *   Model -> Subgraphs[0] -> Inputs[0] -> Tensors[idx] -> Quantization
 * which is small enough to hand-roll without pulling in a full
 * flatbuffer runtime.
 */

// ─── Schema field IDs (must match tensorflow/lite/schema/schema.fbs) ──

// table Model { version, operator_codes, subgraphs, description, buffers, ... }
const MODEL_SUBGRAPHS = 2;

// table SubGraph { tensors, inputs, outputs, operators, name, ... }
const SUBGRAPH_TENSORS = 0;
const SUBGRAPH_INPUTS = 1;

// table Tensor { shape, type, buffer, name, quantization, ... }
const TENSOR_QUANTIZATION = 4;

// table QuantizationParameters { min, max, scale, zero_point, ... }
const QUANT_SCALE = 2;
const QUANT_ZEROPOINT = 3;

// ─── Minimal flatbuffer reader ────────────────────────────────────────

class FBReader {
  constructor(arrayBuffer) {
    this.dv = new DataView(
      arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer,
      arrayBuffer instanceof ArrayBuffer ? 0 : arrayBuffer.byteOffset,
      arrayBuffer instanceof ArrayBuffer ? arrayBuffer.byteLength : arrayBuffer.byteLength,
    );
  }
  u32(off) { return this.dv.getUint32(off, true); }
  i32(off) { return this.dv.getInt32(off, true); }
  u16(off) { return this.dv.getUint16(off, true); }
  f32(off) { return this.dv.getFloat32(off, true); }
  i64(off) {
    // zero_point is int64. Wake word models always have small zero_points
    // (typically -128) that fit comfortably in a JS number.
    const lo = this.dv.getUint32(off, true);
    const hi = this.dv.getInt32(off + 4, true);
    return hi * 0x100000000 + lo;
  }

  /**
   * Read a field's absolute offset from the table at `tableOff`. Returns
   * 0 if the field is absent (default value). Flatbuffer table layout:
   *   table[0..4] = SOffset (signed) pointing BACK to the vtable
   *   table[4..]  = field data
   * Vtable layout (uint16 LE):
   *   vt[0..2] = vtable size in bytes
   *   vt[2..4] = inline table size
   *   vt[4..6] = field 0 offset (relative to start of table)
   *   vt[6..8] = field 1 offset
   *   ...
   * If the offset is 0, the field is absent.
   */
  field(tableOff, fieldId) {
    const vtableOff = tableOff - this.i32(tableOff);
    const vtSize = this.u16(vtableOff);
    const slot = 4 + fieldId * 2;
    if (slot >= vtSize) return 0;
    const fieldOff = this.u16(vtableOff + slot);
    if (fieldOff === 0) return 0;
    return tableOff + fieldOff;
  }

  /**
   * Follow a UOffset stored at `off`. NOTE: do NOT call this with a 0
   * argument as a guard — byte 0 is where the root table offset lives,
   * which is meaningful. Caller is responsible for skipping absent
   * fields (i.e. when field() returned 0).
   */
  follow(off) {
    return off + this.u32(off);
  }

  /** Read a vector header at `vecOff`. Returns { length, dataOff }. */
  vector(vecOff) {
    if (vecOff === 0) return { length: 0, dataOff: 0 };
    return { length: this.u32(vecOff), dataOff: vecOff + 4 };
  }
}

/**
 * Extract the input tensor's affine quantization from a .tflite buffer.
 *
 * @param {ArrayBuffer | Uint8Array} buffer - the raw .tflite file bytes
 * @returns {{scale: number, zeroPoint: number} | null}
 *   null if extraction fails (malformed file, missing quantization,
 *   per-axis quantization with no per-tensor scale, etc.) — caller
 *   should fall back to its own defaults in that case.
 */
export function readInputQuantization(buffer) {
  try {
    const fb = new FBReader(buffer);

    // Root: u32 offset to Model table at byte 0.
    const modelOff = fb.follow(0);

    // Model -> subgraphs vector
    const subgraphsField = fb.field(modelOff, MODEL_SUBGRAPHS);
    if (!subgraphsField) return null;
    const subgraphsVec = fb.vector(fb.follow(subgraphsField));
    if (subgraphsVec.length === 0) return null;

    // First subgraph
    const subgraphOff = fb.follow(subgraphsVec.dataOff);

    // Subgraph -> inputs[0]
    const inputsField = fb.field(subgraphOff, SUBGRAPH_INPUTS);
    if (!inputsField) return null;
    const inputsVec = fb.vector(fb.follow(inputsField));
    if (inputsVec.length === 0) return null;
    const inputTensorIdx = fb.i32(inputsVec.dataOff);

    // Subgraph -> tensors[inputTensorIdx]
    const tensorsField = fb.field(subgraphOff, SUBGRAPH_TENSORS);
    if (!tensorsField) return null;
    const tensorsVec = fb.vector(fb.follow(tensorsField));
    if (inputTensorIdx >= tensorsVec.length) return null;
    const tensorOff = fb.follow(tensorsVec.dataOff + inputTensorIdx * 4);

    // Tensor -> quantization
    const quantField = fb.field(tensorOff, TENSOR_QUANTIZATION);
    if (!quantField) return null;
    const quantOff = fb.follow(quantField);

    // Quantization -> scale[0]
    const scaleField = fb.field(quantOff, QUANT_SCALE);
    if (!scaleField) return null;
    const scaleVec = fb.vector(fb.follow(scaleField));
    if (scaleVec.length === 0) return null;
    const scale = fb.f32(scaleVec.dataOff);

    // Quantization -> zero_point[0]
    const zpField = fb.field(quantOff, QUANT_ZEROPOINT);
    if (!zpField) return null;
    const zpVec = fb.vector(fb.follow(zpField));
    if (zpVec.length === 0) return null;
    const zeroPoint = fb.i64(zpVec.dataOff);

    if (!Number.isFinite(scale) || scale <= 0) return null;
    return { scale, zeroPoint };
  } catch (_) {
    return null;
  }
}
