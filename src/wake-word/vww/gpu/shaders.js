/**
 * WGSL compute-shader generators for the vsWakeWord GPU runner.
 *
 * Conv shaders keep shape/stride/padding in a uniform buffer (one
 * generic module reused across layers) rather than baking them as
 * compile-time constants.  We used to ship per-layer specialized
 * "fast" conv shaders alongside these, but the heavily unrolled
 * kernels they produce crash fragile shader compilers (Fully Kiosk /
 * Android WebView, GLES-backed compatibility-tier adapters), and on
 * healthy drivers the measured win over the vectorized generic kernel
 * was ~1 ms per 80 ms chunk - so the generic kernels are the only conv
 * path now.  Non-conv ops (pool, pad, element-wise) still bake their
 * shapes: they're tiny single-loop kernels that no compiler chokes on.
 *
 * Layout convention (matches the CPU runner):
 *   - TFLite tensors are NHWC float32, flattened; CONV_2D weights are
 *     OHWI: outC × kH × kW × inC.  ONNX models are NCHW / OIHW.
 *
 * Workgroup sizing strategy:
 *   For ops with three independent output dims (CONV_2D, MAX_POOL_2D)
 *   we dispatch a 3D grid of (ow, oh, oc).  The NCHW conv additionally
 *   computes four adjacent W outputs per invocation (vec4 accumulator,
 *   see COMPAT_CONV_W_VECTOR).  Element-wise ops use a flat 1D dispatch
 *   with smaller workgroups to reduce per-dispatch pressure on
 *   mobile/WebView GPU drivers.
 */

const ELEMENTWISE_WORKGROUP = 32;
const CONV_WG_W = 4;
const CONV_WG_H = 4;
const CONV_WG_C = 1;
// 8x8x1 = 64 invocations: fits the compatibility-tier cap (128) and the
// shaders use no workgroup memory or barriers, so a larger workgroup
// carries none of the fragile-driver risk the compat path guards
// against - while 1x1x1 wasted an entire Mali warp per workgroup and
// made dispatch overhead dominate (~2x real-time budget on Mali-G71).
const COMPAT_CONV_WG_W = 8;
const COMPAT_CONV_WG_H = 8;
const COMPAT_CONV_WG_C = 1;
const MATMUL_WG_W = 4;
const MATMUL_WG_H = 4;

/** Workgroup sizes for CONV_2D dispatch - main thread uses these to
 *  compute the workgroup count from output dims. */
export const CONV_DISPATCH_WORKGROUP = [CONV_WG_W, CONV_WG_H, CONV_WG_C];
export const COMPAT_CONV_DISPATCH_WORKGROUP = [COMPAT_CONV_WG_W, COMPAT_CONV_WG_H, COMPAT_CONV_WG_C];
export const MATMUL_DISPATCH_WORKGROUP = [MATMUL_WG_W, MATMUL_WG_H, 1];

/**
 * NHWC (TFLite) Conv shader.  Shape/stride/padding live in a uniform
 * buffer so one small generic module serves every layer - safe on
 * fragile shader compilers that choke on big specialized kernels.
 * Supports the fused leakyReluThenMax activation via the params
 * uniform (activationKind = 1).
 */
export function compatConv2dNhwcShader() {
  return /* wgsl */`
    struct ConvCompatParams {
      dims0: vec4<i32>,  // inH, inW, inC, outH
      dims1: vec4<i32>,  // outW, outC, kH, kW
      steps0: vec4<i32>, // strideH, strideW, dilationH, dilationW
      pad0: vec4<i32>,   // padTop, padLeft, activationKind, unused
      act0: vec4<f32>,   // alpha, maxScalar, unused, unused
    };

    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> weightsBuf: array<f32>;
    @group(0) @binding(2) var<storage, read> biasBuf: array<f32>;
    @group(0) @binding(3) var<storage, read_write> outputBuf: array<f32>;
    @group(0) @binding(4) var<uniform> p: ConvCompatParams;

    @compute @workgroup_size(${COMPAT_CONV_WG_W}, ${COMPAT_CONV_WG_H}, ${COMPAT_CONV_WG_C})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let oc: u32 = gid.z;
      let outW: u32 = u32(p.dims1.x);
      let outH: u32 = u32(p.dims0.w);
      let outC: u32 = u32(p.dims1.y);
      if (ow >= outW || oh >= outH || oc >= outC) {
        return;
      }

      let inH: i32 = p.dims0.x;
      let inW: i32 = p.dims0.y;
      let inC: u32 = u32(p.dims0.z);
      let kH: u32 = u32(p.dims1.z);
      let kW: u32 = u32(p.dims1.w);
      var acc: f32 = biasBuf[oc];

      for (var kh: u32 = 0u; kh < kH; kh = kh + 1u) {
        let inY: i32 = i32(oh) * p.steps0.x + i32(kh) * p.steps0.z - p.pad0.x;
        if (inY < 0 || inY >= inH) { continue; }
        for (var kw: u32 = 0u; kw < kW; kw = kw + 1u) {
          let inX: i32 = i32(ow) * p.steps0.y + i32(kw) * p.steps0.w - p.pad0.y;
          if (inX < 0 || inX >= inW) { continue; }
          let inPixBase: u32 = (u32(inY) * u32(inW) + u32(inX)) * inC;
          let wKwBase: u32 = ((oc * kH + kh) * kW + kw) * inC;
          for (var ic: u32 = 0u; ic < inC; ic = ic + 1u) {
            acc = acc + inputBuf[inPixBase + ic] * weightsBuf[wKwBase + ic];
          }
        }
      }

      if (p.pad0.z == 1) {
        acc = max(select(acc * p.act0.x, acc, acc >= 0.0), p.act0.y);
      }
      outputBuf[(oh * outW + ow) * outC + oc] = acc;
    }
  `;
}

/**
 * Each invocation of the NCHW compat Conv computes this many adjacent
 * outputs along W (vec4 accumulators) for this many output channels.
 * The runner divides its X dispatch by the W factor and its Z dispatch
 * by the OC factor.
 */
export const COMPAT_CONV_W_VECTOR = 4;
export const COMPAT_CONV_OC_VECTOR = 4;

export function compatConv2dNchwShader(wg = COMPAT_CONV_DISPATCH_WORKGROUP) {
  // Vectorized 4-wide along output W and 4-deep along output channels:
  // each invocation produces a 4-output strip for four channels.  Each
  // loaded input vec4 is reused across all four channels' weights -
  // input loads are the dominant memory traffic of this kernel, and on
  // Mali-class GPUs (no usable workgroup memory, L2-cached weights)
  // register-level reuse like this measured ~1.4x where shared-memory
  // tiling and f16 weights both measured slower.  Keeps the uniform
  // params and simple un-unrolled loops that fragile shader compilers
  // require (see compatConv2dNhwcShader docs).
  //
  // `wg` is the workgroup shape: (8,8,1) for genuinely 2-D outputs, a
  // W-heavy shape like (16,1,4) for rank-3 (Conv1d) graphs routed
  // through here as H=1 convs - an 8-deep H dimension would idle 7/8
  // of every workgroup there.  pad0.z != 0 fuses a ReLU into the
  // output write (Conv+Relu peephole in the runner).
  return /* wgsl */`
    struct ConvCompatParams {
      dims0: vec4<i32>,  // inC, inH, inW, outC
      dims1: vec4<i32>,  // outH, outW, kH, kW
      steps0: vec4<i32>, // strideH, strideW, dilationH, dilationW
      pad0: vec4<i32>,   // padTop, padLeft, reluFlag, unused
      act0: vec4<f32>,
    };

    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> weightsBuf: array<f32>;
    @group(0) @binding(2) var<storage, read> biasBuf: array<f32>;
    @group(0) @binding(3) var<storage, read_write> outputBuf: array<f32>;
    @group(0) @binding(4) var<uniform> p: ConvCompatParams;

    @compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let owBase: u32 = gid.x * ${COMPAT_CONV_W_VECTOR}u;
      let oh: u32 = gid.y;
      let ocBase: u32 = gid.z * ${COMPAT_CONV_OC_VECTOR}u;
      let inC: u32 = u32(p.dims0.x);
      let inH: i32 = p.dims0.y;
      let inW: i32 = p.dims0.z;
      let outC: u32 = u32(p.dims0.w);
      let outH: u32 = u32(p.dims1.x);
      let outW: u32 = u32(p.dims1.y);
      let kH: u32 = u32(p.dims1.z);
      let kW: u32 = u32(p.dims1.w);
      if (owBase >= outW || oh >= outH || ocBase >= outC) { return; }

      let sW: i32 = p.steps0.y;
      var acc0: vec4<f32> = vec4<f32>(0.0);
      var acc1: vec4<f32> = vec4<f32>(0.0);
      var acc2: vec4<f32> = vec4<f32>(0.0);
      var acc3: vec4<f32> = vec4<f32>(0.0);
      for (var ic: u32 = 0u; ic < inC; ic = ic + 1u) {
        let inIcBase: u32 = ic * u32(inH) * u32(inW);
        let wIcStride: u32 = inC * kH * kW;
        let wBase0: u32 = ((ocBase * inC + ic) * kH) * kW;
        for (var kh: u32 = 0u; kh < kH; kh = kh + 1u) {
          let ih: i32 = i32(oh) * p.steps0.x + i32(kh) * p.steps0.z - p.pad0.x;
          if (ih < 0 || ih >= inH) { continue; }
          let rowBase: u32 = inIcBase + u32(ih) * u32(inW);
          let wRowOff: u32 = kh * kW;
          for (var kw: u32 = 0u; kw < kW; kw = kw + 1u) {
            let x0: i32 = i32(owBase) * sW + i32(kw) * p.steps0.w - p.pad0.y;
            let x1: i32 = x0 + sW;
            let x2: i32 = x1 + sW;
            let x3: i32 = x2 + sW;
            var v: vec4<f32> = vec4<f32>(0.0);
            if (x0 >= 0 && x0 < inW) { v.x = inputBuf[rowBase + u32(x0)]; }
            if (x1 >= 0 && x1 < inW) { v.y = inputBuf[rowBase + u32(x1)]; }
            if (x2 >= 0 && x2 < inW) { v.z = inputBuf[rowBase + u32(x2)]; }
            if (x3 >= 0 && x3 < inW) { v.w = inputBuf[rowBase + u32(x3)]; }
            let wIdx: u32 = wBase0 + wRowOff + kw;
            acc0 = fma(v, vec4<f32>(weightsBuf[wIdx]), acc0);
            acc1 = fma(v, vec4<f32>(weightsBuf[wIdx + wIcStride]), acc1);
            acc2 = fma(v, vec4<f32>(weightsBuf[wIdx + 2u * wIcStride]), acc2);
            acc3 = fma(v, vec4<f32>(weightsBuf[wIdx + 3u * wIcStride]), acc3);
          }
        }
      }
      let strip0: u32 = (ocBase * outH + oh) * outW + owBase;
      let stripStride: u32 = outH * outW;
      let lanes: u32 = min(outW - owBase, ${COMPAT_CONV_W_VECTOR}u);
      let relu: bool = p.pad0.z != 0;
      for (var j: u32 = 0u; j < ${COMPAT_CONV_OC_VECTOR}u; j = j + 1u) {
        if (ocBase + j >= outC) { break; }
        var a: vec4<f32>;
        if (j == 0u) { a = acc0; } else if (j == 1u) { a = acc1; } else if (j == 2u) { a = acc2; } else { a = acc3; }
        a = a + vec4<f32>(biasBuf[ocBase + j]);
        if (relu) { a = max(a, vec4<f32>(0.0)); }
        let strip: u32 = strip0 + j * stripStride;
        outputBuf[strip] = a.x;
        if (lanes > 1u) { outputBuf[strip + 1u] = a.y; }
        if (lanes > 2u) { outputBuf[strip + 2u] = a.z; }
        if (lanes > 3u) { outputBuf[strip + 3u] = a.w; }
      }
    }
  `;
}

/**
 * fp32 NCHW conv, 4-deep along output channels only (no W
 * vectorization).  The W-vectorized shader above wins on genuinely 2-D
 * outputs (measured ~1.4x on Mali), but on H=1 graphs (rank-3 convs
 * routed through the 2-D machinery) it measured SLOWER than even the
 * old scalar Conv1d shader on Adreno 7xx: dividing both W and OC by 4
 * left too few invocations to hide memory latency, and adjacent lanes
 * read inputs 4 apart (uncoalesced).  This variant mirrors the int8
 * conv's geometry instead - one thread per output position covering 4
 * output channels - so each loaded input is reused 4x while adjacent
 * lanes keep adjacent (coalesced) input reads.  pad0.z != 0 fuses ReLU.
 */
export function compatConvNchwOc4Shader(wg = [64, 1, 1]) {
  return /* wgsl */`
    struct ConvCompatParams {
      dims0: vec4<i32>,  // inC, inH, inW, outC
      dims1: vec4<i32>,  // outH, outW, kH, kW
      steps0: vec4<i32>, // strideH, strideW, dilationH, dilationW
      pad0: vec4<i32>,   // padTop, padLeft, reluFlag, unused
      act0: vec4<f32>,
    };

    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> weightsBuf: array<f32>;
    @group(0) @binding(2) var<storage, read> biasBuf: array<f32>;
    @group(0) @binding(3) var<storage, read_write> outputBuf: array<f32>;
    @group(0) @binding(4) var<uniform> p: ConvCompatParams;

    @compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let ocBase: u32 = gid.z * 4u;
      let inC: u32 = u32(p.dims0.x);
      let inH: i32 = p.dims0.y;
      let inW: i32 = p.dims0.z;
      let outC: u32 = u32(p.dims0.w);
      let outH: u32 = u32(p.dims1.x);
      let outW: u32 = u32(p.dims1.y);
      let kH: u32 = u32(p.dims1.z);
      let kW: u32 = u32(p.dims1.w);
      if (ow >= outW || oh >= outH || ocBase >= outC) { return; }

      let wOcStride: u32 = inC * kH * kW;
      var acc: vec4<f32> = vec4<f32>(0.0);
      for (var ic: u32 = 0u; ic < inC; ic = ic + 1u) {
        let inIcBase: u32 = ic * u32(inH) * u32(inW);
        let wIcBase: u32 = (ocBase * inC + ic) * kH * kW;
        for (var kh: u32 = 0u; kh < kH; kh = kh + 1u) {
          let ih: i32 = i32(oh) * p.steps0.x + i32(kh) * p.steps0.z - p.pad0.x;
          if (ih < 0 || ih >= inH) { continue; }
          let rowBase: u32 = inIcBase + u32(ih) * u32(inW);
          let wRowBase: u32 = wIcBase + kh * kW;
          for (var kw: u32 = 0u; kw < kW; kw = kw + 1u) {
            let iw: i32 = i32(ow) * p.steps0.y + i32(kw) * p.steps0.w - p.pad0.y;
            if (iw < 0 || iw >= inW) { continue; }
            let x: f32 = inputBuf[rowBase + u32(iw)];
            let wIdx: u32 = wRowBase + kw;
            acc = fma(
              vec4<f32>(x),
              vec4<f32>(
                weightsBuf[wIdx],
                weightsBuf[wIdx + wOcStride],
                weightsBuf[wIdx + 2u * wOcStride],
                weightsBuf[wIdx + 3u * wOcStride],
              ),
              acc,
            );
          }
        }
      }

      acc = acc + vec4<f32>(
        biasBuf[ocBase],
        biasBuf[min(ocBase + 1u, outC - 1u)],
        biasBuf[min(ocBase + 2u, outC - 1u)],
        biasBuf[min(ocBase + 3u, outC - 1u)],
      );
      if (p.pad0.z != 0) { acc = max(acc, vec4<f32>(0.0)); }
      let stripStride: u32 = outH * outW;
      let outBase: u32 = (ocBase * outH + oh) * outW + ow;
      outputBuf[outBase] = acc.x;
      if (ocBase + 1u < outC) { outputBuf[outBase + stripStride] = acc.y; }
      if (ocBase + 2u < outC) { outputBuf[outBase + 2u * stripStride] = acc.z; }
      if (ocBase + 3u < outC) { outputBuf[outBase + 3u * stripStride] = acc.w; }
    }
  `;
}

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
export function binaryElementwiseShader(numElements, opCode, fuseRelu = false) {
  const expr = `aBuf[i] ${opCode} bBuf[i]`;
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
    @group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      outputBuf[i] = ${fuseRelu ? `max(${expr}, 0.0)` : expr};
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
 * Parallel workgroup reduction: 64 threads each take a stride of the
 * input to find a local max, then a tree-reduce in workgroup-shared
 * memory collapses them to one value.  Dispatched as a single workgroup
 * (the build site passes elementCount=1 so dispatchX=1) which is fine
 * here because all 64 threads cooperate within that one workgroup.
 * For our typical N (a few hundred to a few thousand), this beats the
 * single-thread version by avoiding the serial inner loop.
 */
export function reduceMaxAllShader(numElements) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;
    const WG: u32 = 64u;

    var<workgroup> partial: array<f32, 64>;

    @compute @workgroup_size(64)
    fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
      let tid: u32 = lid.x;

      // Stride-loop: each thread visits every WG-th element.
      // Seed with the thread's first in-range value, or input[0] when N<=tid.
      var mx: f32;
      if (tid < N) {
        mx = inputBuf[tid];
      } else {
        mx = inputBuf[0];
      }
      var i: u32 = tid + WG;
      while (i < N) {
        let v: f32 = inputBuf[i];
        if (v > mx) { mx = v; }
        i = i + WG;
      }
      partial[tid] = mx;
      workgroupBarrier();

      // Tree reduction in shared memory: 64 -> 32 -> 16 -> ... -> 1.
      var stride: u32 = WG >> 1u;
      while (stride > 0u) {
        if (tid < stride) {
          let other: f32 = partial[tid + stride];
          if (other > partial[tid]) { partial[tid] = other; }
        }
        workgroupBarrier();
        stride = stride >> 1u;
      }

      if (tid == 0u) { outputBuf[0] = partial[0]; }
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

    @compute @workgroup_size(${MATMUL_WG_W}, ${MATMUL_WG_H}, 1)
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

export function maxPool2dNchwShader(cfg) {
  const [, inC, inH, inW] = cfg.inShape;
  const [, , outH, outW] = cfg.outShape;
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const IN_C: u32 = ${inC}u;
    const IN_H: i32 = ${inH};
    const IN_W: i32 = ${inW};
    const OUT_H: u32 = ${outH}u;
    const OUT_W: u32 = ${outW}u;
    const FILTER_H: u32 = ${cfg.filterH}u;
    const FILTER_W: u32 = ${cfg.filterW}u;
    const STRIDE_H: i32 = ${cfg.strideH};
    const STRIDE_W: i32 = ${cfg.strideW};
    const PAD_TOP: i32 = ${cfg.padTop};
    const PAD_LEFT: i32 = ${cfg.padLeft};

    @compute @workgroup_size(${CONV_WG_W}, ${CONV_WG_H}, ${CONV_WG_C})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let c: u32 = gid.z;
      if (ow >= OUT_W || oh >= OUT_H || c >= IN_C) { return; }
      var mx: f32 = -1.0e30;
      for (var kh: u32 = 0u; kh < FILTER_H; kh = kh + 1u) {
        let ih: i32 = i32(oh) * STRIDE_H + i32(kh) - PAD_TOP;
        if (ih < 0 || ih >= IN_H) { continue; }
        for (var kw: u32 = 0u; kw < FILTER_W; kw = kw + 1u) {
          let iw: i32 = i32(ow) * STRIDE_W + i32(kw) - PAD_LEFT;
          if (iw < 0 || iw >= IN_W) { continue; }
          mx = max(mx, inputBuf[(c * u32(IN_H) + u32(ih)) * u32(IN_W) + u32(iw)]);
        }
      }
      outputBuf[(c * OUT_H + oh) * OUT_W + ow] = select(mx, 0.0, mx == -1.0e30);
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

/**
 * GEMM: y = alpha * A*B[^T] + beta * C.  Specialized to the PyTorch
 * Linear-export pattern (alpha=1, beta=1, transA=0, transB=1, optional
 * bias).  A is [M, K], B is [N, K] (transposed in storage), C is [N]
 * broadcast along the M axis.  No batch dim - vsWakeWord's classifier
 * head is a single Linear after a Flatten, so a 2-D A is exactly what
 * the exporter emits.
 */
export function gemmShader(M, K, N, hasBias, alpha, beta, transB) {
  const aIdx = (m, k) => `${m} * ${K}u + ${k}`;
  const bIdx = transB ? `n * ${K}u + k` : `k * ${N}u + n`;
  const biasBinding = hasBias ? `@group(0) @binding(2) var<storage, read> cBuf: array<f32>;` : '';
  const outBinding = hasBias
    ? `@group(0) @binding(3) var<storage, read_write> outputBuf: array<f32>;`
    : `@group(0) @binding(2) var<storage, read_write> outputBuf: array<f32>;`;
  const biasTerm = hasBias ? ` + ${formatFloat(beta)} * cBuf[n]` : '';
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> aBuf: array<f32>;
    @group(0) @binding(1) var<storage, read> bBuf: array<f32>;
    ${biasBinding}
    ${outBinding}

    const M: u32 = ${M}u;
    const K: u32 = ${K}u;
    const N: u32 = ${N}u;

    @compute @workgroup_size(${MATMUL_WG_W}, ${MATMUL_WG_H}, 1)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let n: u32 = gid.x;
      let m: u32 = gid.y;
      if (n >= N || m >= M) { return; }
      var acc: f32 = 0.0;
      for (var k: u32 = 0u; k < K; k = k + 1u) {
        acc = acc + aBuf[${aIdx('m', 'k')}] * bBuf[${bIdx}];
      }
      outputBuf[m * N + n] = ${formatFloat(alpha)} * acc${biasTerm};
    }
  `;
}

/**
 * Reduce-mean over a contiguous-from-the-end axis range.  vsWakeWord's
 * adaptive-pool tail reduces the last two dims (H, W) of a [B, C, H, W]
 * tile down to a [B, C, 1, 1] scalar per channel - so `reduceCount`
 * elements are averaged per output element.  Used with keepdims=True.
 */
export function reduceMeanTailShader(outerCount, reduceCount) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const OUTER: u32 = ${outerCount}u;
    const REDUCE: u32 = ${reduceCount}u;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let o: u32 = gid.x;
      if (o >= OUTER) { return; }
      let base: u32 = o * REDUCE;
      var acc: f32 = 0.0;
      for (var i: u32 = 0u; i < REDUCE; i = i + 1u) {
        acc = acc + inputBuf[base + i];
      }
      outputBuf[o] = acc / f32(REDUCE);
    }
  `;
}

/**
 * Reduce-mean over ALL elements to a single scalar.  The tail shader
 * above degenerates for this case (outerCount=1 leaves one active
 * thread doing a serial N-element loop); this variant uses the same
 * stride-loop + shared-memory tree reduction as reduceMaxAllShader.
 * Dispatched as a single workgroup.
 */
export function reduceMeanAllShader(numElements) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${numElements}u;
    const WG: u32 = 64u;

    var<workgroup> partial: array<f32, 64>;

    @compute @workgroup_size(64)
    fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
      let tid: u32 = lid.x;

      var acc: f32 = 0.0;
      var i: u32 = tid;
      while (i < N) {
        acc = acc + inputBuf[i];
        i = i + WG;
      }
      partial[tid] = acc;
      workgroupBarrier();

      var stride: u32 = WG >> 1u;
      while (stride > 0u) {
        if (tid < stride) {
          partial[tid] = partial[tid] + partial[tid + stride];
        }
        workgroupBarrier();
        stride = stride >> 1u;
      }

      if (tid == 0u) { outputBuf[0] = partial[0] / f32(N); }
    }
  `;
}

/**
 * Slice: copy a strided sub-region of `inputBuf` into a dense output.
 * Per-axis start offsets and steps are baked into the shader.  Rank is
 * arbitrary (up to 4 in practice for the adaptive-pool slices); shapes
 * are constant so we constant-fold all index arithmetic.
 */
export function sliceShader(inShape, outShape, starts, steps) {
  const rank = outShape.length;
  if (rank === 0 || rank > 4) {
    throw new Error(`Slice rank ${rank} not supported (max 4)`);
  }
  const inStrides = stridesOf(inShape);
  const outStrides = stridesOf(outShape);
  const total = outShape.reduce((a, b) => a * b, 1);

  const lines = ['var rem: u32 = i;'];
  let inFlatExpr = '0';
  for (let d = 0; d < rank; d++) {
    const outStride = outStrides[d];
    const inStride = inStrides[d];
    const offset = starts[d];
    const step = steps[d];
    lines.push(`let c${d}: u32 = rem / ${outStride}u;`);
    lines.push(`rem = rem - c${d} * ${outStride}u;`);
    inFlatExpr += ` + (${offset}u + c${d} * ${step}u) * ${inStride}u`;
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
      outputBuf[i] = inputBuf[${inFlatExpr}];
    }
  `;
}

/**
 * Concat input-slice copy: writes one Concat input's contribution into
 * the combined output buffer at the right offset.  Per-input shader
 * (we run one dispatch per Concat input) keeps the binding count down
 * - a 12-input torch.cat would exceed the 8-buffer default if we tried
 * a single shader with N input bindings.
 *
 *   input:  [outer, axisSize, inner]   (flat)
 *   output: [outer, outAxisSize, inner]
 *   we copy input[o, a, i] → output[o, axisOffset + a, i]
 */
export function concatInputShader(outer, axisSize, inner, outAxisSize, axisOffset) {
  const total = outer * axisSize * inner;
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inputBuf: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputBuf: array<f32>;

    const N: u32 = ${total}u;
    const AXIS: u32 = ${axisSize}u;
    const INNER: u32 = ${inner}u;
    const OUT_AXIS: u32 = ${outAxisSize}u;
    const AXIS_OFFSET: u32 = ${axisOffset}u;
    const SLICE: u32 = AXIS * INNER;
    const OUT_SLICE: u32 = OUT_AXIS * INNER;

    @compute @workgroup_size(${ELEMENTWISE_WORKGROUP})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= N) { return; }
      let o: u32 = i / SLICE;
      let rem: u32 = i - o * SLICE;
      let a: u32 = rem / INNER;
      let inner_i: u32 = rem - a * INNER;
      let outFlat: u32 = o * OUT_SLICE + (AXIS_OFFSET + a) * INNER + inner_i;
      outputBuf[outFlat] = inputBuf[i];
    }
  `;
}

// int8 conv path (experimental).  Drop-in replacement for an ONNX Conv: takes
// NCHW fp32 in, returns NCHW fp32 out, but internally quantizes the input to
// per-tensor symmetric int8, packs it NHWC (4 channels per u32), and uses
// dot4I8Packed so the dominant input-load traffic drops 4x.  Validated math:
// tmp/int8_conv_validate.js (~1% per-conv error).  Three helper dispatches
// precede the conv: clear the maxabs scalar, reduce |x| max (atomic), then
// quantize+pack.  Weights are pre-quantized per-output-channel on the CPU.
// ---------------------------------------------------------------------------

export const INT8_CONV_WG = [8, 8, 1];

/** Zero a single u32 (the per-tensor maxabs accumulator) before the reduce. */
export function clearU32Shader() {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read_write> buf: array<u32>;
    @compute @workgroup_size(1, 1, 1)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      if (gid.x == 0u) { buf[0] = 0u; }
    }
  `;
}

/** Per-tensor max(|x|) via atomicMax on the sign-cleared float bits.  For any
 *  float, (bits & 0x7fffffff) is the bit pattern of |x|, which is monotonic in
 *  |x|, so atomicMax yields max|x|.  Result read back as bitcast<f32>. */
export function reduceMaxAbsShader(numElements) {
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inp: array<f32>;
    @group(0) @binding(1) var<storage, read_write> maxabs: atomic<u32>;
    @compute @workgroup_size(64, 1, 1)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i: u32 = gid.x;
      if (i >= ${numElements}u) { return; }
      let bits: u32 = bitcast<u32>(inp[i]) & 0x7fffffffu;
      atomicMax(&maxabs, bits);
    }
  `;
}

/** Quantize NCHW fp32 [C][H][W] -> packed int8 NHWC [H][W][cgroups] (u32, 4
 *  channels per lane, tail group zero-padded).  Per-tensor symmetric scale =
 *  max|x|/127 read from the maxabs scalar. */
export function quantizePackNhwcShader(C, H, W, wg = [8, 8, 1]) {
  const cgroups = Math.ceil(C / 4);
  return /* wgsl */`
    @group(0) @binding(0) var<storage, read> inp: array<f32>;
    @group(0) @binding(1) var<storage, read> maxabs: array<u32>;
    @group(0) @binding(2) var<storage, read_write> outp: array<u32>;
    @compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let w: u32 = gid.x;
      let h: u32 = gid.y;
      let g: u32 = gid.z;
      if (w >= ${W}u || h >= ${H}u || g >= ${cgroups}u) { return; }
      let m: f32 = bitcast<f32>(maxabs[0]);
      let scale: f32 = max(m, 1e-8) / 127.0;
      var packed: u32 = 0u;
      for (var l: u32 = 0u; l < 4u; l = l + 1u) {
        let ic: u32 = g * 4u + l;
        var q: i32 = 0;
        if (ic < ${C}u) {
          let v: f32 = inp[(ic * ${H}u + h) * ${W}u + w];
          q = i32(round(v / scale));
          if (q > 127) { q = 127; }
          if (q < -128) { q = -128; }
        }
        packed = packed | ((u32(q) & 0xFFu) << (l * 8u));
      }
      outp[(h * ${W}u + w) * ${cgroups}u + g] = packed;
    }
  `;
}

/** int8 NHWC conv, 4-deep along output channels (one input packed-vec reused
 *  across 4 OCs).  Packed int8 input + per-OC int8 weights -> NCHW fp32 + ReLU.
 *  dims0: inH,inW,inC,outC ; dims1: outH,outW,kH,kW ; steps0: sH,sW,dH,dW ;
 *  pad0: padTop,padLeft,cgroups,reluFlag. */
export function int8ConvNhwcShader(wg = INT8_CONV_WG) {
  return /* wgsl */`
    struct P {
      dims0: vec4<i32>,
      dims1: vec4<i32>,
      steps0: vec4<i32>,
      pad0: vec4<i32>,
    };
    @group(0) @binding(0) var<storage, read> inPacked: array<u32>;
    @group(0) @binding(1) var<storage, read> wPacked: array<u32>;
    @group(0) @binding(2) var<storage, read> wscale: array<f32>;
    @group(0) @binding(3) var<storage, read> bias: array<f32>;
    @group(0) @binding(4) var<storage, read_write> outBuf: array<f32>;
    @group(0) @binding(5) var<storage, read> maxabs: array<u32>;
    @group(0) @binding(6) var<uniform> p: P;

    @compute @workgroup_size(${wg[0]}, ${wg[1]}, ${wg[2]})
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ow: u32 = gid.x;
      let oh: u32 = gid.y;
      let ocBase: u32 = gid.z * 4u;
      let inH: i32 = p.dims0.x;
      let inW: i32 = p.dims0.y;
      let outC: u32 = u32(p.dims0.w);
      let outH: u32 = u32(p.dims1.x);
      let outW: u32 = u32(p.dims1.y);
      let kH: u32 = u32(p.dims1.z);
      let kW: u32 = u32(p.dims1.w);
      let cgroups: u32 = u32(p.pad0.z);
      if (ow >= outW || oh >= outH || ocBase >= outC) { return; }

      let wocStride: u32 = kH * kW * cgroups;
      var acc0: i32 = 0; var acc1: i32 = 0; var acc2: i32 = 0; var acc3: i32 = 0;
      for (var kh: u32 = 0u; kh < kH; kh = kh + 1u) {
        let ih: i32 = i32(oh) * p.steps0.x + i32(kh) * p.steps0.z - p.pad0.x;
        if (ih < 0 || ih >= inH) { continue; }
        for (var kw: u32 = 0u; kw < kW; kw = kw + 1u) {
          let iw: i32 = i32(ow) * p.steps0.y + i32(kw) * p.steps0.w - p.pad0.y;
          if (iw < 0 || iw >= inW) { continue; }
          let inPixBase: u32 = (u32(ih) * u32(inW) + u32(iw)) * cgroups;
          let wKwBase: u32 = ((ocBase * kH + kh) * kW + kw) * cgroups;
          for (var g: u32 = 0u; g < cgroups; g = g + 1u) {
            let av: u32 = inPacked[inPixBase + g];
            let wIdx: u32 = wKwBase + g;
            acc0 = acc0 + dot4I8Packed(av, wPacked[wIdx]);
            acc1 = acc1 + dot4I8Packed(av, wPacked[wIdx + wocStride]);
            acc2 = acc2 + dot4I8Packed(av, wPacked[wIdx + 2u * wocStride]);
            acc3 = acc3 + dot4I8Packed(av, wPacked[wIdx + 3u * wocStride]);
          }
        }
      }
      let ascale: f32 = max(bitcast<f32>(maxabs[0]), 1e-8) / 127.0;
      let relu: bool = p.pad0.w == 1;
      for (var j: u32 = 0u; j < 4u; j = j + 1u) {
        let oc: u32 = ocBase + j;
        if (oc >= outC) { break; }
        var a: i32;
        if (j == 0u) { a = acc0; } else if (j == 1u) { a = acc1; } else if (j == 2u) { a = acc2; } else { a = acc3; }
        var v: f32 = f32(a) * wscale[oc] * ascale + bias[oc];
        if (relu && v < 0.0) { v = 0.0; }
        outBuf[(oc * outH + oh) * outW + ow] = v;
      }
    }
  `;
}
