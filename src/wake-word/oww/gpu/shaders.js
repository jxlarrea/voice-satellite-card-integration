/**
 * WGSL compute-shader generators for the openWakeWord embedding model.
 *
 * Per user direction we compile **once per layer with shape/stride/
 * padding constants baked into the shader source** rather than
 * threading them through a uniform buffer.  This gives the WGSL
 * compiler more room to unroll loops and do constant-folding, at the
 * cost of more shader-module objects (one per CONV_2D op = 20).
 *
 * Layout convention (matches the CPU runner):
 *   - Tensors are NHWC float32, flattened.
 *   - CONV_2D weights are stored OHWI: outC × kH × kW × inC.
 *
 * Workgroup sizing strategy:
 *   For ops with three independent output dims (CONV_2D, MAX_POOL_2D)
 *   we dispatch a 3D grid of (ow, oh, oc) and pick a workgroup that
 *   keeps each thread doing ~1 output element.  Element-wise ops use
 *   a flat 1D dispatch with 64-thread workgroups.
 */

const ELEMENTWISE_WORKGROUP = 64;
const CONV_WG_W = 8;
const CONV_WG_H = 8;
const CONV_WG_C = 1;

/**
 * CONV_2D shader for one specific layer.  Bakes the layer's input
 * shape, output shape, kernel size, stride, dilation, and padding as
 * `const`s so the inner loops have known bounds at WGSL compile time.
 *
 * Supported activation: ACT_NONE only - the embedding model's conv
 * layers never have a fused activation (LEAKY_RELU comes as a
 * separate op).  If we encounter another model with fused activations
 * we add them here.
 *
 * @param {object} cfg
 * @param {[number,number,number,number]} cfg.inShape  - [batch, inH, inW, inC]
 * @param {[number,number,number,number]} cfg.outShape - [batch, outH, outW, outC]
 * @param {[number,number,number,number]} cfg.weightShape - [outC, kH, kW, filterC]
 * @param {number} cfg.strideH
 * @param {number} cfg.strideW
 * @param {number} cfg.dilationH
 * @param {number} cfg.dilationW
 * @param {number} cfg.padTop
 * @param {number} cfg.padLeft
 * @returns {string} WGSL source
 */
export function conv2dShader(cfg) {
  const [, inH, inW, inC] = cfg.inShape;
  const [, outH, outW, outC] = cfg.outShape;
  const [, kH, kW] = cfg.weightShape;
  const sH = cfg.strideH;
  const sW = cfg.strideW;
  const dH = cfg.dilationH;
  const dW = cfg.dilationW;
  const padTop = cfg.padTop;
  const padLeft = cfg.padLeft;

  // Strides into the flattened buffers, also baked at WGSL compile time.
  const inRowStride = inW * inC;
  const wKwStride = inC;
  const wKhStride = kW * wKwStride;
  const wOcStride = kH * wKhStride;
  let activation = 'acc';
  if (cfg.activation?.kind === 'leakyReluThenMax') {
    activation = `max(select(acc * ${formatFloat(cfg.activation.alpha)}, acc, acc >= 0.0), ${formatFloat(cfg.activation.maxScalar)})`;
  }

  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> weightsBuf: array<f32>;
    @group(0) @binding(2) var<storage, read> biasBuf: array<f32>;
    @group(0) @binding(3) var<storage, read_write> outputBuf: array<f32>;

    const IN_H: i32 = ${inH};
    const IN_W: i32 = ${inW};
    const IN_C: u32 = ${inC}u;
    const OUT_H: u32 = ${outH}u;
    const OUT_W: u32 = ${outW}u;
    const OUT_C: u32 = ${outC}u;
    const K_H: u32 = ${kH}u;
    const K_W: u32 = ${kW}u;
    const STRIDE_H: i32 = ${sH};
    const STRIDE_W: i32 = ${sW};
    const DIL_H: i32 = ${dH};
    const DIL_W: i32 = ${dW};
    const PAD_TOP: i32 = ${padTop};
    const PAD_LEFT: i32 = ${padLeft};
    const IN_ROW_STRIDE: u32 = ${inRowStride}u;
    const W_KW_STRIDE: u32 = ${wKwStride}u;
    const W_KH_STRIDE: u32 = ${wKhStride}u;
    const W_OC_STRIDE: u32 = ${wOcStride}u;

    @compute @workgroup_size(${CONV_WG_W}, ${CONV_WG_H}, ${CONV_WG_C})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let oc: u32 = gid.z;
      if (ow >= OUT_W || oh >= OUT_H || oc >= OUT_C) {
        return;
      }

      var acc: f32 = biasBuf[oc];
      let wOcBase: u32 = oc * W_OC_STRIDE;

      for (var kh: u32 = 0u; kh < K_H; kh = kh + 1u) {
        let inY: i32 = i32(oh) * STRIDE_H + i32(kh) * DIL_H - PAD_TOP;
        if (inY < 0 || inY >= IN_H) { continue; }
        let inRowBase: u32 = u32(inY) * IN_ROW_STRIDE;
        let wKhBase: u32 = wOcBase + kh * W_KH_STRIDE;

        for (var kw: u32 = 0u; kw < K_W; kw = kw + 1u) {
          let inX: i32 = i32(ow) * STRIDE_W + i32(kw) * DIL_W - PAD_LEFT;
          if (inX < 0 || inX >= IN_W) { continue; }
          let inPixBase: u32 = inRowBase + u32(inX) * IN_C;
          let wKwBase: u32 = wKhBase + kw * W_KW_STRIDE;

          for (var ic: u32 = 0u; ic < IN_C; ic = ic + 1u) {
            acc = acc + inputBuf[inPixBase + ic] * weightsBuf[wKwBase + ic];
          }
        }
      }

      let outIdx: u32 = (oh * OUT_W + ow) * OUT_C + oc;
      outputBuf[outIdx] = ${activation};
    }
  `;
}

/** Workgroup sizes for CONV_2D dispatch - main thread uses these to
 *  compute the workgroup count from output dims. */
export const CONV_DISPATCH_WORKGROUP = [CONV_WG_W, CONV_WG_H, CONV_WG_C];

/**
 * LEAKY_RELU element-wise:  out[i] = max(x, alpha * x)  - equivalent
 * to TFLite's `x >= 0 ? x : x * alpha`.
 */
export function leakyReluShader(numElements, alpha) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;
    const ALPHA: f32 = ${formatFloat(alpha)};

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      let v: f32 = inputBuf[i];
      outputBuf[i] = select(v * ALPHA, v, v >= 0.0);
    }
  `;
}

/**
 * MAXIMUM (binary, element-wise).  Embedding model uses it to clamp
 * negative LEAKY_RELU outputs; our cfg supports broadcast where the
 * second operand is a single scalar (the common case in OWW's
 * embedding model where it's max(x, 0)).
 */
export function maximumScalarShader(numElements, scalar) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;
    const S: f32 = ${formatFloat(scalar)};

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      outputBuf[i] = max(inputBuf[i], S);
    }
  `;
}

/**
 * MAX_POOL_2D shader (NHWC).  Same dispatch shape as CONV_2D; pools
 * over the spatial filter window.
 */
export function maxPool2dShader(cfg) {
  const [, inH, inW, inC] = cfg.inShape;
  const [, outH, outW] = cfg.outShape;
  const filterH = cfg.filterH;
  const filterW = cfg.filterW;
  const sH = cfg.strideH;
  const sW = cfg.strideW;
  const padTop = cfg.padTop;
  const padLeft = cfg.padLeft;
  const inRowStride = inW * inC;

  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const IN_H: i32 = ${inH};
    const IN_W: i32 = ${inW};
    const IN_C: u32 = ${inC}u;
    const OUT_H: u32 = ${outH}u;
    const OUT_W: u32 = ${outW}u;
    const FILTER_H: u32 = ${filterH}u;
    const FILTER_W: u32 = ${filterW}u;
    const STRIDE_H: i32 = ${sH};
    const STRIDE_W: i32 = ${sW};
    const PAD_TOP: i32 = ${padTop};
    const PAD_LEFT: i32 = ${padLeft};
    const IN_ROW_STRIDE: u32 = ${inRowStride}u;

    @compute @workgroup_size(${CONV_WG_W}, ${CONV_WG_H}, ${CONV_WG_C})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let c: u32 = gid.z;
      if (ow >= OUT_W || oh >= OUT_H || c >= IN_C) {
        return;
      }

      var mx: f32 = -1.0e30;  // -Infinity-equivalent for f32
      for (var kh: u32 = 0u; kh < FILTER_H; kh = kh + 1u) {
        let inY: i32 = i32(oh) * STRIDE_H + i32(kh) - PAD_TOP;
        if (inY < 0 || inY >= IN_H) { continue; }
        let rowBase: u32 = u32(inY) * IN_ROW_STRIDE;
        for (var kw: u32 = 0u; kw < FILTER_W; kw = kw + 1u) {
          let inX: i32 = i32(ow) * STRIDE_W + i32(kw) - PAD_LEFT;
          if (inX < 0 || inX >= IN_W) { continue; }
          let v: f32 = inputBuf[rowBase + u32(inX) * IN_C + c];
          mx = max(mx, v);
        }
      }
      let outIdx: u32 = (oh * OUT_W + ow) * IN_C + c;
      // CPU runner emits 0 for fully-padded windows where mx stayed at
      // -inf; mirror that here so outputs match bit-for-bit.
      outputBuf[outIdx] = select(mx, 0.0, mx == -1.0e30);
    }
  `;
}

/**
 * PAD shader.  Generic enough for the openWakeWord embedding model's
 * single PAD op (rank-4 NHWC input, [0,0] outer pads, spatial pads
 * around H/W).  Output is zero-initialized via dispatch over the full
 * output buffer; in-bounds output positions copy the corresponding
 * input element, out-of-bounds positions write 0.
 */
export function padShader(cfg) {
  const [, inH, inW, inC] = cfg.inShape;
  const [, outH, outW] = cfg.outShape;
  const padTop = cfg.padTop;
  const padLeft = cfg.padLeft;
  const inRowStride = inW * inC;
  const outRowStride = outW * inC;

  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const IN_H: i32 = ${inH};
    const IN_W: i32 = ${inW};
    const IN_C: u32 = ${inC}u;
    const OUT_H: u32 = ${outH}u;
    const OUT_W: u32 = ${outW}u;
    const PAD_TOP: i32 = ${padTop};
    const PAD_LEFT: i32 = ${padLeft};
    const IN_ROW_STRIDE: u32 = ${inRowStride}u;
    const OUT_ROW_STRIDE: u32 = ${outRowStride}u;

    @compute @workgroup_size(${CONV_WG_W}, ${CONV_WG_H}, ${CONV_WG_C})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ox: u32 = gid.x;
      let oy: u32 = gid.y;
      let c: u32 = gid.z;
      if (ox >= OUT_W || oy >= OUT_H || c >= IN_C) {
        return;
      }

      let inY: i32 = i32(oy) - PAD_TOP;
      let inX: i32 = i32(ox) - PAD_LEFT;
      let outIdx: u32 = oy * OUT_ROW_STRIDE + ox * IN_C + c;

      if (inY < 0 || inY >= IN_H || inX < 0 || inX >= IN_W) {
        outputBuf[outIdx] = 0.0;
        return;
      }
      let inIdx: u32 = u32(inY) * IN_ROW_STRIDE + u32(inX) * IN_C + c;
      outputBuf[outIdx] = inputBuf[inIdx];
    }
  `;
}

/**
 * Element-wise binary ops between two same-shape tensors.
 * `opCode` is the WGSL infix operator: '+', '-', '*'.  This handles
 * the dominant MUL/ADD/SUB pattern in the mel spec model where both
 * operands are activation tensors of identical shape.
 */
export function binaryElementwiseShader(numElements, opCode) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
    @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      outputBuf[i] = aBuf[i] ${opCode} bBuf[i];
    }
  `;
}

/**
 * Element-wise binary op against a constant scalar baked into the
 * shader source.  Mel spec uses this pattern for MUL × const (windowing
 * scaling), SUB × const (log floor), MAXIMUM/MINIMUM × const.
 */
export function binaryScalarConstShader(numElements, opCode, scalar) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;
    const S: f32 = ${formatFloat(scalar)};

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      outputBuf[i] = aBuf[i] ${opCode} S;
    }
  `;
}

/**
 * Element-wise op against a runtime scalar - second operand is a
 * size-1 buffer produced by an earlier op (REDUCE_MAX → SUB → MAX
 * chain at the end of the mel pipeline).  Reads scalar once and
 * applies it to every element.
 */
export function binaryScalarRuntimeShader(numElements, fnExpr) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> sBuf: array<f32>;
    @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      let a: f32 = aBuf[i];
      let s: f32 = sBuf[0];
      outputBuf[i] = ${fnExpr};
    }
  `;
}

/** Element-wise unary (LOG, etc.).  `fnExpr` is a WGSL expression
 *  using `v` as the input value. */
export function unaryShader(numElements, fnExpr) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      let v: f32 = inputBuf[i];
      outputBuf[i] = ${fnExpr};
    }
  `;
}

/**
 * TRANSPOSE: reorder dims per a perm vector.  Both shapes and perm are
 * baked into the shader source so we can iterate output coords with
 * known dimension bounds.  Generic up to rank 4 (mel spec model uses
 * rank 3 and 4 transposes only).
 */
export function transposeShader(inShape, outShape, perm) {
  const rank = outShape.length;
  if (rank > 4) throw new Error(`TRANSPOSE rank ${rank} not supported (max 4)`);

  // Strides into the input + output flattened buffers.
  const inStrides = stridesOf(inShape);
  const outStrides = stridesOf(outShape);
  const total = outShape.reduce((a, b) => a * b, 1);

  // Build the input-flat-index expression as a constant fold.  For each
  // output dim oi we compute its coord, then multiply by the matching
  // input axis stride (inStrides[perm[oi]]).
  const lines = [];
  lines.push('var rem: u32 = i;');
  let inFlatExpr = '0u';
  for (let oi = 0; oi < rank; oi++) {
    const stride = outStrides[oi];
    const inputAxisStride = inStrides[perm[oi]];
    const coord = `c${oi}`;
    lines.push(`let ${coord}: u32 = rem / ${stride}u;`);
    lines.push(`rem = rem - ${coord} * ${stride}u;`);
    inFlatExpr += ` + ${coord} * ${inputAxisStride}u`;
  }

  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${total}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      ${lines.join('\n      ')}
      let inFlat: u32 = ${inFlatExpr};
      outputBuf[i] = inputBuf[inFlat];
    }
  `;
}

/**
 * REDUCE_MAX over ALL axes - produces a single-element scalar output.
 * Single-thread reduction (one workgroup, one invocation iterating the
 * whole input) since our use case is tiny (256 elements).  If we ever
 * need REDUCE_MAX over a subset of axes, a different shader is required.
 */
export function reduceMaxAllShader(numElements) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;

    @compute @workgroup_size(1)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      if (gid.x != 0u) { return; }
      var mx: f32 = inputBuf[0];
      for (var i: u32 = 1u; i < N; i = i + 1u) {
        let v: f32 = inputBuf[i];
        if (v > mx) { mx = v; }
      }
      outputBuf[0] = mx;
    }
  `;
}

/**
 * BATCH_MATMUL specialized for the mel spec model's pattern:
 *   a: [..., M, K]   (activation, batch dims at front)
 *   b: [K, N]        (constant - mel filterbank weights, no batch)
 *   out: [..., M, N]
 *
 * No transpose flags supported (adj_x = adj_y = false).  Each output
 * element is one workgroup invocation; the K-dim accumulation is
 * sequential within a thread.  For mel's M=8, K=257, N=32, total
 * batch=1, that's 256 threads × 257 multiplies = trivial GPU work.
 */
export function batchMatmulShader(M, K, N, batchCount) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
    @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;

    const M: u32 = ${M}u;
    const K: u32 = ${K}u;
    const N: u32 = ${N}u;
    const BATCH: u32 = ${batchCount}u;

    @compute @workgroup_size(8, 8, 1)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let n: u32 = gid.x;
      let m: u32 = gid.y;
      let bi: u32 = gid.z;
      if (n >= N || m >= M || bi >= BATCH) { return; }

      let aBase: u32 = bi * M * K + m * K;
      var acc: f32 = 0.0;
      for (var k: u32 = 0u; k < K; k = k + 1u) {
        acc = acc + aBuf[aBase + k] * bBuf[k * N + n];
      }
      outputBuf[bi * M * N + m * N + n] = acc;
    }
  `;
}

/**
 * Maintain the embedding model's 76-frame mel input window on the GPU.
 * The mel model emits 8 frames per chunk; openWakeWord then applies
 * x / 10 + 2 before appending those frames to the rolling window.
 */
export function melWindowUpdateShader(windowElements, appendElements) {
  const keepElements = windowElements - appendElements;
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> oldWindow: array<f32>;
    @group(0) @binding(1) var<storage, read> melOut: array<f32>;
    @group(0) @binding(2) var<storage, read_write> newWindow: array<f32>;

    const WINDOW_ELEMENTS: u32 = ${windowElements}u;
    const KEEP_ELEMENTS: u32 = ${keepElements}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= WINDOW_ELEMENTS) { return; }

      if (i < KEEP_ELEMENTS) {
        newWindow[i] = oldWindow[i + ${appendElements}u];
        return;
      }

      let melIdx: u32 = i - KEEP_ELEMENTS;
      newWindow[i] = melOut[melIdx] * 0.1 + 2.0;
    }
  `;
}

function stridesOf(shape) {
  const out = new Array(shape.length);
  let s = 1;
  for (let i = shape.length - 1; i >= 0; i--) { out[i] = s; s *= shape[i]; }
  return out;
}

/** WGSL float literal that round-trips through the lexer.  Plain
 *  toString() on integers like `2` produces `2` which WGSL parses as
 *  i32; we always need an `.0` suffix or scientific notation. */
function formatFloat(v) {
  if (!isFinite(v)) {
    // WGSL rejects literals at the exact f32 boundary because the
    // decimal→binary round-trip pushes them just outside range; use
    // a "large enough" sentinel instead.
    return v > 0 ? '1.0e30' : '-1.0e30';
  }
  const s = String(v);
  if (s.includes('.') || s.includes('e') || s.includes('E')) return s;
  return `${s}.0`;
}

export const ELEMENTWISE_WG = ELEMENTWISE_WORKGROUP;
