/**
 * Waveform Skin - WebGL2 Renderer
 *
 * Dark/light adaptive skin with a WebGL2-based flowing neon waveform
 * centered in the background. WebGL2 provides immediate GPU acceleration
 * (no warmup delay), native additive blending, and efficient multi-pass
 * bloom via framebuffer objects.
 *
 * Fully self-contained: mounts itself at module load time, reads mode
 * from the bar's CSS classes, and audio level from --vs-audio-level.
 * When another skin replaces the CSS, the canvas collapses to 0x0 and
 * draw() short-circuits. When waveform CSS returns, ResizeObserver
 * restores dimensions and drawing resumes.
 */

import css from './waveform.css';
import previewCSS from './waveform-preview.css';

// ── Wave strand definitions ─────────────────────────────────────────
// Each strand is an independent sine-composite wave with its own color,
// glow, speed, and shape. Drawn outer-glow-first so the sharp core
// sits on top of the diffuse bloom.

// ── Dark theme strands (neon on dark overlay) ──
const WAVE_STRANDS_DARK = [
  { rgb: [30, 10, 140],  alpha: 0.08, blur: 55, lineW: 24, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [70, 40, 200],  alpha: 0.13, blur: 40, lineW: 16, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [120, 60, 255], alpha: 0.23, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [30, 160, 255], alpha: 0.18, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [160, 80, 255], alpha: 0.38, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [140, 170, 255], alpha: 0.62, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [200, 210, 255], alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];
const WAVE_STRANDS_DARK_ERROR = [
  { rgb: [140, 10, 10],  alpha: 0.06, blur: 55, lineW: 24, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [200, 30, 30],  alpha: 0.12, blur: 40, lineW: 16, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [240, 50, 50],  alpha: 0.20, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [255, 80, 60],  alpha: 0.16, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [255, 120, 100], alpha: 0.35, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [255, 160, 140], alpha: 0.55, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [255, 200, 190], alpha: 0.80, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];

// ── Light theme strands (deep saturated on light overlay) ──
const WAVE_STRANDS_LIGHT = [
  { rgb: [20, 0, 100],   alpha: 0.10, blur: 55, lineW: 24, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [50, 20, 160],  alpha: 0.16, blur: 40, lineW: 16, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [80, 30, 200],  alpha: 0.30, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [0, 100, 210],  alpha: 0.25, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [120, 40, 200],  alpha: 0.45, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [60, 50, 180],  alpha: 0.65, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [40, 30, 140],  alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];
const WAVE_STRANDS_LIGHT_ERROR = [
  { rgb: [100, 0, 0],    alpha: 0.10, blur: 55, lineW: 24, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [160, 10, 10],  alpha: 0.18, blur: 40, lineW: 16, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [200, 20, 20],  alpha: 0.32, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [220, 40, 30],  alpha: 0.28, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [200, 60, 50],  alpha: 0.50, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [180, 40, 40],  alpha: 0.70, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [150, 20, 20],  alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];

// ── Per-strand dynamics ──────────────────────────────────────────────
const STRAND_DYNAMICS = [
  /* 0  deep glow  */ { smoothUp: 0.08, smoothDown: 0.035, speedReact: 1.5,  alphaReact: 0.30, harmonicGain: 0,    bloomReact: 0.30 },
  /* 1  mid bloom  */ { smoothUp: 0.10, smoothDown: 0.045, speedReact: 2.0,  alphaReact: 0.40, harmonicGain: 0.02, bloomReact: 0.35 },
  /* 2  violet     */ { smoothUp: 0.13, smoothDown: 0.055, speedReact: 2.5,  alphaReact: 0.50, harmonicGain: 0.04, bloomReact: 0.40 },
  /* 3  cyan       */ { smoothUp: 0.16, smoothDown: 0.065, speedReact: 3.0,  alphaReact: 0.55, harmonicGain: 0.06, bloomReact: 0.45 },
  /* 4  pink-mid   */ { smoothUp: 0.20, smoothDown: 0.080, speedReact: 3.5,  alphaReact: 0.65, harmonicGain: 0.08, bloomReact: 0.50 },
  /* 5  sharp      */ { smoothUp: 0.25, smoothDown: 0.100, speedReact: 4.0,  alphaReact: 0.75, harmonicGain: 0.12, bloomReact: 0.55 },
  /* 6  core       */ { smoothUp: 0.32, smoothDown: 0.130, speedReact: 5.0,  alphaReact: 0.90, harmonicGain: 0.15, bloomReact: 0.60 },
];

// ── WebGL2 Shader Sources ───────────────────────────────────────────

const STRAND_VS = `#version 300 es
in vec2 a_pos;
in float a_edge;
uniform vec2 u_res;
out float v_edge;
void main(){
  v_edge = a_edge;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0, 1);
}`;

const STRAND_FS = `#version 300 es
precision mediump float;
in float v_edge;
uniform vec4 u_color;
uniform float u_feather;
out vec4 o;
void main(){
  float d = abs(v_edge);
  float edge0 = max(0.01, 1.0 - u_feather);
  float a = u_color.a * (1.0 - smoothstep(edge0, 1.0, d));
  o = vec4(u_color.rgb * a, a);
}`;

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0, 1);
}`;

const KAWASE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_offset;
out vec4 o;
void main(){
  vec2 d = u_texel * u_offset;
  o  = texture(u_tex, v_uv) * 4.0;
  o += texture(u_tex, v_uv + vec2(-d.x,  0.0));
  o += texture(u_tex, v_uv + vec2( d.x,  0.0));
  o += texture(u_tex, v_uv + vec2( 0.0, -d.y));
  o += texture(u_tex, v_uv + vec2( 0.0,  d.y));
  o += texture(u_tex, v_uv + vec2(-d.x, -d.y)) * 0.5;
  o += texture(u_tex, v_uv + vec2( d.x, -d.y)) * 0.5;
  o += texture(u_tex, v_uv + vec2(-d.x,  d.y)) * 0.5;
  o += texture(u_tex, v_uv + vec2( d.x,  d.y)) * 0.5;
  o *= 0.1;
}`;

const COMPOSITE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 o;
void main(){
  o = texture(u_tex, v_uv) * u_alpha;
}`;

const PARTICLE_VS = `#version 300 es
in vec2 a_quad;
in vec2 a_center;
in float a_size;
in vec4 a_color;
uniform vec2 u_res;
out vec2 v_local;
out vec4 v_color;
void main(){
  v_local = a_quad;
  v_color = a_color;
  vec2 pos = a_center + a_quad * a_size;
  vec2 c = pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0, 1);
}`;

const PARTICLE_FS = `#version 300 es
precision mediump float;
in vec2 v_local;
in vec4 v_color;
out vec4 o;
void main(){
  float d = length(v_local) * 2.0;
  float a = max(0.0, 1.0 - d);
  float fa = v_color.a * a;
  o = vec4(v_color.rgb * fa, fa);
}`;

// ── WebGL2 Helpers ──────────────────────────────────────────────────

function makeProgram(gl, vsSrc, fsSrc, attribs) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
    console.error('[waveform] VS:', gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
    console.error('[waveform] FS:', gl.getShaderInfoLog(fs));
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  for (let i = 0; i < attribs.length; i++) gl.bindAttribLocation(p, i, attribs[i]);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error('[waveform] Link:', gl.getProgramInfoLog(p));
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

function getUniforms(gl, p, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, 'u_' + n);
  return u;
}

function makeFBO(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

function freeFBO(gl, fbo) {
  if (!fbo) return;
  gl.deleteTexture(fbo.tex);
  gl.deleteFramebuffer(fbo.fb);
}

// ── Self-mounting visualizer ─────────────────────────────────────────

let _instanceSeq = 0;

function setup() {
  const ui = document.getElementById('voice-satellite-ui');
  if (!ui) return false;
  if (ui._waveformGL) {
    console.log('[waveform] setup() skipped -- already initialized');
    return true;
  }
  ui._waveformGL = true;
  const ID = ++_instanceSeq;
  const L = (...args) => console.log(`[waveform #${ID}]`, ...args);
  L('setup()');
  const barEl = ui.querySelector('.vs-rainbow-bar');

  // ── Theme detection ──
  let isDark = true;
  const themeProbe = document.createElement('div');
  themeProbe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;color:var(--primary-background-color,#fff)';
  document.body.appendChild(themeProbe);

  let bgR = 0, bgG = 0, bgB = 0;

  function detectTheme() {
    const mode = ui.dataset.themeMode || 'auto';
    let dark;
    if (mode === 'dark') {
      dark = true;
    } else if (mode === 'light') {
      dark = false;
    } else {
      const rgb = getComputedStyle(themeProbe).color;
      const m = rgb.match(/(\d+)/g);
      dark = true;
      if (m) {
        const [r, g, b] = m.map(Number);
        dark = (0.299 * r + 0.587 * g + 0.114 * b) < 128;
      }
    }
    isDark = dark;
    ui.classList.toggle('vs-dark', isDark);
    ui.classList.toggle('vs-light', !isDark);
    readStrandOverrides();
    // Read overlay background for WebGL clear color
    const style = getComputedStyle(ui);
    const bg = parseCSSColor(style.getPropertyValue('--wf-overlay'));
    if (bg) { bgR = bg[0] / 255; bgG = bg[1] / 255; bgB = bg[2] / 255; }
    else { bgR = isDark ? 0 : 0.94; bgG = bgR; bgB = bgR; }
  }

  // ── CSS variable -> strand color overrides ──
  function parseHexToRGB(hex) {
    hex = hex.trim().replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const n = parseInt(hex, 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }

  function parseCSSColor(val) {
    if (!val) return null;
    val = val.trim();
    if (val.startsWith('#')) return parseHexToRGB(val);
    const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }

  function readStrandOverrides() {
    const style = getComputedStyle(ui);
    const strandSets = [
      { normal: isDark ? WAVE_STRANDS_DARK : WAVE_STRANDS_LIGHT,
        error:  isDark ? WAVE_STRANDS_DARK_ERROR : WAVE_STRANDS_LIGHT_ERROR },
    ];
    for (const { normal, error } of strandSets) {
      for (let i = 0; i < normal.length; i++) {
        const cv = style.getPropertyValue(`--wf-strand-${i + 1}`);
        const parsed = parseCSSColor(cv);
        if (parsed) normal[i].rgb = parsed;

        const ev = style.getPropertyValue(`--wf-strand-error-${i + 1}`);
        const eParsed = parseCSSColor(ev);
        if (eParsed) error[i].rgb = eParsed;
      }
    }
  }

  detectTheme();

  // Re-detect theme whenever the card applies data-theme-mode
  new MutationObserver(detectTheme).observe(ui, {
    attributes: true, attributeFilter: ['data-theme-mode'],
  });

  // ── DOM elements ──
  const wrapper = document.createElement('div');
  wrapper.className = 'vs-waveform';
  wrapper.style.opacity = '0'; // prevent flash before skin CSS loads
  const canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);

  // ── WebGL2 state ──
  let gl = null;
  let strandProg, kawaseProg, compositeProg, particleProg;
  let strandU, kawaseU, compositeU, particleU;
  let strandVAO, strandVBO, quadVAO, quadVBO;
  let particleVAO, particleQuadVBO, particleInstVBO;
  let bloomA = null, bloomB = null;
  let glReady = false;
  let loseCtxExt = null;

  // ── Pre-allocated buffers ──
  const STRAND_COUNT = STRAND_DYNAMICS.length;
  const PTS = 280;
  const VERTS_PER_STRAND = (PTS + 1) * 2;
  const strandVerts = new Float32Array(VERTS_PER_STRAND * 3 * STRAND_COUNT);
  const glowColorData = new Float32Array(STRAND_COUNT * 4);
  const coreColorData = new Float32Array(STRAND_COUNT * 4);
  const MAX_PARTICLES = 80;
  const particleInstData = new Float32Array(MAX_PARTICLES * 7);

  const xPos = new Float64Array(PTS + 1);
  let xPosW = -1;
  const strandLevels = new Float64Array(STRAND_COUNT);
  const strandEnergy = new Float64Array(STRAND_COUNT);
  const strandPhase = new Float64Array(STRAND_COUNT);
  const strandCenterY = new Array(STRAND_COUNT);
  for (let i = 0; i < STRAND_COUNT; i++) strandCenterY[i] = new Float64Array(PTS + 1);

  // Feather values per strand group (outer=soft, inner=crisp)
  const FEATHER = [0.85, 0.8, 0.4, 0.4, 0.4, 0.45, 0.55];

  // Kawase blur pass offsets: tight bloom (~10px), wide bloom (~28px total)
  const KAWASE_TIGHT = [1.0, 2.0, 3.0];
  const KAWASE_WIDE  = [4.0, 5.0];

  // Precomputed envelope LUT: pow(sin(i/PTS * PI), 2.4)
  const envLUT = new Float64Array(PTS + 1);
  for (let i = 0; i <= PTS; i++) {
    envLUT[i] = Math.pow(Math.sin((i / PTS) * Math.PI), 2.4);
  }

  // Fast tanh approximation (Padé, max error ~0.003 on [-3,3])
  function fastTanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // Phasor rotation arrays: replaces ~10K Math.sin calls/frame with
  // 2-mul-2-add rotations. Per strand: 3 freq + 1 detail + 2 harmonic
  // + 2 envelope + 1 thickness = 9 max.
  const MAX_PHASORS = 9;
  const TOTAL_PHASORS = STRAND_COUNT * MAX_PHASORS;
  const pSin = new Float64Array(TOTAL_PHASORS);
  const pCos = new Float64Array(TOTAL_PHASORS);
  const pStepSin = new Float64Array(TOTAL_PHASORS);
  const pStepCos = new Float64Array(TOTAL_PHASORS);

  // Cached card element reference (avoids querySelector every frame)
  let cachedCardEl = null;

  function initGL() {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      L('WebGL2 not available');
      return false;
    }
    loseCtxExt = gl.getExtension('WEBGL_lose_context');

    // Compile programs
    strandProg    = makeProgram(gl, STRAND_VS, STRAND_FS, ['a_pos', 'a_edge']);
    kawaseProg    = makeProgram(gl, QUAD_VS, KAWASE_FS, ['a_pos']);
    compositeProg = makeProgram(gl, QUAD_VS, COMPOSITE_FS, ['a_pos']);
    particleProg  = makeProgram(gl, PARTICLE_VS, PARTICLE_FS, ['a_quad', 'a_center', 'a_size', 'a_color']);

    // Cache uniform locations
    strandU    = getUniforms(gl, strandProg, ['res', 'color', 'feather']);
    kawaseU    = getUniforms(gl, kawaseProg, ['tex', 'texel', 'offset']);
    compositeU = getUniforms(gl, compositeProg, ['tex', 'alpha']);
    particleU  = getUniforms(gl, particleProg, ['res']);

    // ── Strand VAO ──
    strandVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, strandVBO);
    gl.bufferData(gl.ARRAY_BUFFER, strandVerts.byteLength, gl.DYNAMIC_DRAW);
    strandVAO = gl.createVertexArray();
    gl.bindVertexArray(strandVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, strandVBO);
    gl.enableVertexAttribArray(0); // a_pos (vec2)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1); // a_edge (float)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);

    // ── Fullscreen quad VAO (shared by kawase + composite) ──
    quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // ── Particle VAO (instanced quads) ──
    particleQuadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleQuadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5]), gl.STATIC_DRAW);
    particleInstVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleInstVBO);
    gl.bufferData(gl.ARRAY_BUFFER, particleInstData.byteLength, gl.DYNAMIC_DRAW);

    particleVAO = gl.createVertexArray();
    gl.bindVertexArray(particleVAO);
    // Per-vertex: quad corners
    gl.bindBuffer(gl.ARRAY_BUFFER, particleQuadVBO);
    gl.enableVertexAttribArray(0); // a_quad
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Per-instance: center(2) + size(1) + color(4) = 7 floats = 28 bytes
    gl.bindBuffer(gl.ARRAY_BUFFER, particleInstVBO);
    gl.enableVertexAttribArray(1); // a_center
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); // a_size
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); // a_color
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 28, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    L('initGL() -- WebGL2 ready');
    glReady = true;
    return true;
  }

  // Context loss handling
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    L('contextlost');
    glReady = false;
    bloomA = null;
    bloomB = null;
    stopLoop();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    L('contextrestored');
    if (initGL()) {
      resizeFBOs();
      if (overlayEl?.classList.contains('visible')) startLoop();
    }
  });

  // ── Layout ──
  let drawW = 0, drawH = 0, rafId = null, lastTime = 0, lastTickTime = 0;
  let mounted = false, resizeObs = null;

  function resizeFBOs() {
    if (!gl) return;
    const bw = Math.max(1, Math.round(canvas.width / 3));
    const bh = Math.max(1, Math.round(canvas.height / 3));
    if (bloomA && bloomA.w === bw && bloomA.h === bh) return;
    freeFBO(gl, bloomA);
    freeFBO(gl, bloomB);
    bloomA = makeFBO(gl, bw, bh);
    bloomB = makeFBO(gl, bw, bh);
  }

  function resize() {
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width || !rect.height || !gl) { drawW = 0; drawH = 0; return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    drawW = rect.width;
    drawH = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    resizeFBOs();
  }

  // ── Mount / Unmount ──
  function mount() {
    if (mounted) return;
    L('mount()');
    ui.appendChild(wrapper);
    mounted = true;
    if (!resizeObs) resizeObs = new ResizeObserver(resize);
    resizeObs.observe(wrapper);
    resize();
  }

  function unmount() {
    if (!mounted) return;
    L('unmount()');
    stopLoop();
    if (resizeObs) resizeObs.disconnect();
    drawW = 0; drawH = 0;
    wrapper.remove();
    mounted = false;
  }

  // ── Skin observer ──
  function checkSkinActive() {
    const styleEl = document.getElementById('voice-satellite-styles');
    const isActive = styleEl?.textContent.includes('.vs-waveform') ?? false;
    if (isActive) mount();
    else unmount();
  }

  function observeStyleEl() {
    const el = document.getElementById('voice-satellite-styles');
    if (el) {
      new MutationObserver(checkSkinActive).observe(el, { childList: true, characterData: true, subtree: true });
      checkSkinActive();
      return;
    }
    const headObs = new MutationObserver(() => {
      const created = document.getElementById('voice-satellite-styles');
      if (created) {
        headObs.disconnect();
        new MutationObserver(checkSkinActive).observe(created, { childList: true, characterData: true, subtree: true });
        checkSkinActive();
      }
    });
    headObs.observe(document.head, { childList: true });
  }
  observeStyleEl();

  // ── FPS debug ──
  let fpsFrameCount = 0, fpsAccum = 0, fpsLast = 0, fpsDisplay = '';
  let fpsDrawMin = Infinity, fpsDrawMax = 0;
  let fpsEl = null;

  // ── Particle pool ──
  const particlePool = [];

  // ── Main draw ─────────────────────────────────────────────────────
  function draw() {
    if (!drawW || !drawH || !glReady) return;

    const centerY = drawH / 2;
    const t = performance.now() / 1000;
    const dt = lastTime ? Math.min(t - lastTime, 0.1) : 0;
    lastTime = t;

    // Derive mode from the bar's CSS classes
    const barVisible = barEl.classList.contains('visible');
    const isError = barEl.classList.contains('error-mode');
    const isProcessing = barEl.classList.contains('processing');
    const isActive = barVisible && !isError && !isProcessing;

    let rawLevel = 0;
    if (isActive) {
      rawLevel = parseFloat(barEl.style.getPropertyValue('--vs-audio-level')) || 0;
    } else if (isProcessing) {
      rawLevel = 0.35;
    } else if (isError) {
      rawLevel = 0.3;
    }

    const strands = isDark
      ? (isError ? WAVE_STRANDS_DARK_ERROR : WAVE_STRANDS_DARK)
      : (isError ? WAVE_STRANDS_LIGHT_ERROR : WAVE_STRANDS_LIGHT);
    const pts = PTS;
    const maxAmp = drawH * 0.32;
    const idleBase = 0.42;

    // Rebuild x-position LUT when canvas width changes
    if (xPosW !== drawW) {
      const step = drawW / pts;
      for (let i = 0; i <= pts; i++) xPos[i] = i * step;
      xPosW = drawW;
    }

    // ── Compute strand ribbons and fill vertex buffer ──
    let vi = 0;
    const piOverPts = Math.PI / pts;

    for (let si = 0; si < strands.length; si++) {
      const s = strands[si];
      const d = STRAND_DYNAMICS[si];

      // Dual smoothing
      const ampRate = rawLevel > strandLevels[si] ? d.smoothUp : d.smoothDown;
      strandLevels[si] += (rawLevel - strandLevels[si]) * ampRate;
      const level = strandLevels[si];

      const engRate = rawLevel > strandEnergy[si] ? 0.25 : 0.12;
      strandEnergy[si] += (rawLevel - strandEnergy[si]) * engRate;
      const energy = strandEnergy[si];

      // Phase accumulation
      const speedMult = 1 + energy * d.speedReact;
      strandPhase[si] += dt * s.speed * speedMult;
      const phase = strandPhase[si];

      // Per-strand modulated values
      const waveAmp = maxAmp * (idleBase + level * (1 - idleBase)) * s.ampScale;
      const baseAlpha = s.alpha;
      const a = Math.min(1, baseAlpha * (1 + level * d.alphaReact));
      const hGain = d.harmonicGain * energy;

      const [r, g, b] = s.rgb;
      const glowA = Math.min(1, a * 4);
      const ci = si * 4;
      glowColorData[ci]     = r / 255;
      glowColorData[ci + 1] = g / 255;
      glowColorData[ci + 2] = b / 255;
      glowColorData[ci + 3] = glowA;
      coreColorData[ci]     = r / 255;
      coreColorData[ci + 1] = g / 255;
      coreColorData[ci + 2] = b / 255;
      coreColorData[ci + 3] = a;

      // ── Initialize phasors (replaces per-point Math.sin calls) ──
      const base = si * MAX_PHASORS;
      const w0 = s.weights[0], w1 = s.weights[1], w2 = s.weights[2];
      const useHarmonics = hGain > 0.001;
      const energyActive = energy > 0.01;

      // 3 main frequency phasors (indices 0-2)
      for (let f = 0; f < 3; f++) {
        const step = s.freqs[f] * 2 * piOverPts;
        const init = phase * (1 + f * 0.6) + s.phase + f * 1.1;
        pSin[base + f] = Math.sin(init);
        pCos[base + f] = Math.cos(init);
        pStepSin[base + f] = Math.sin(step);
        pStepCos[base + f] = Math.cos(step);
      }

      // Detail phasor (index 3)
      const detInit = phase * 2.8 + s.phase * 1.7;
      const detStep = 14 * piOverPts;
      pSin[base + 3] = Math.sin(detInit);
      pCos[base + 3] = Math.cos(detInit);
      pStepSin[base + 3] = Math.sin(detStep);
      pStepCos[base + 3] = Math.cos(detStep);

      // Harmonic phasors (indices 4-5, conditional)
      if (useHarmonics) {
        const h1Init = phase * 3.5 + s.phase * 2.3;
        const h1Step = 22 * piOverPts;
        pSin[base + 4] = Math.sin(h1Init);
        pCos[base + 4] = Math.cos(h1Init);
        pStepSin[base + 4] = Math.sin(h1Step);
        pStepCos[base + 4] = Math.cos(h1Step);

        const h2Init = phase * 4.2 + s.phase * 0.7;
        const h2Step = 34 * piOverPts;
        pSin[base + 5] = Math.sin(h2Init);
        pCos[base + 5] = Math.cos(h2Init);
        pStepSin[base + 5] = Math.sin(h2Step);
        pStepCos[base + 5] = Math.cos(h2Step);
      }

      // Envelope + thickness phasors (indices 6-8, conditional on energy)
      if (energyActive) {
        const e1Init = phase * 1.1 + si * 0.7;
        const e1Step = 1.5 * piOverPts;
        pSin[base + 6] = Math.sin(e1Init);
        pCos[base + 6] = Math.cos(e1Init);
        pStepSin[base + 6] = Math.sin(e1Step);
        pStepCos[base + 6] = Math.cos(e1Step);

        const e2Init = phase * 0.65 + si * 1.3;
        const e2Step = 2.8 * piOverPts;
        pSin[base + 7] = Math.sin(e2Init);
        pCos[base + 7] = Math.cos(e2Init);
        pStepSin[base + 7] = Math.sin(e2Step);
        pStepCos[base + 7] = Math.cos(e2Step);

        const tInit = phase * 0.8 + si * 1.5;
        const tStep = 2.3 * piOverPts;
        pSin[base + 8] = Math.sin(tInit);
        pCos[base + 8] = Math.cos(tInit);
        pStepSin[base + 8] = Math.sin(tStep);
        pStepCos[base + 8] = Math.cos(tStep);
      }

      // How many phasors to advance per point
      const phasorCount = energyActive ? 9 : (useHarmonics ? 6 : 4);

      // Compute wave shape + ribbon vertices
      const halfBase = s.lineW * 0.5;
      const maxDisp = drawH * 0.42;
      const invMaxDisp = 1 / maxDisp;
      const cY = strandCenterY[si];

      for (let i = 0; i <= pts; i++) {
        // Wave from phasors (no trig calls in this loop)
        let wave = pSin[base] * w0
                 + pSin[base + 1] * w1
                 + pSin[base + 2] * w2
                 + pSin[base + 3] * 0.06;

        if (useHarmonics) {
          wave += pSin[base + 4] * hGain
                + pSin[base + 5] * hGain * 0.5;
        }

        // Envelope from precomputed LUT + phasor modulation
        let env = envLUT[i];
        if (energyActive) {
          env *= Math.max(0, 1 + energy * (
            pSin[base + 6] * 0.7 + pSin[base + 7] * 0.5
          ));
        }

        const waveVal = wave * env;
        const raw = waveVal * waveAmp;
        const cy = centerY + maxDisp * fastTanh(raw * invMaxDisp);

        const displacement = Math.abs(waveVal);
        const thickMod = energyActive
          ? Math.max(0.4, 1 + energy * pSin[base + 8] * 0.6)
          : 1;
        const hw = Math.max(1.5, halfBase * (0.25 + 0.75 * displacement) * thickMod);

        // Write center Y for particle tracking
        cY[i] = cy;

        // Triangle strip: top vertex then bottom vertex
        const xi = xPos[i];
        strandVerts[vi++] = xi;
        strandVerts[vi++] = cy - hw;
        strandVerts[vi++] = -1; // edge top
        strandVerts[vi++] = xi;
        strandVerts[vi++] = cy + hw;
        strandVerts[vi++] = 1;  // edge bottom

        // Advance all active phasors via rotation
        for (let p = 0; p < phasorCount; p++) {
          const idx = base + p;
          const s0 = pSin[idx], c0 = pCos[idx];
          pSin[idx] = s0 * pStepCos[idx] + c0 * pStepSin[idx];
          pCos[idx] = c0 * pStepCos[idx] - s0 * pStepSin[idx];
        }
      }
    }

    // Upload strand vertices
    gl.bindBuffer(gl.ARRAY_BUFFER, strandVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, strandVerts, 0, vi);

    // ── Pass 1: Render strands to bloom FBO (additive, glow colors) ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
    gl.viewport(0, 0, bloomA.w, bloomA.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(strandProg);
    gl.uniform2f(strandU.res, drawW, drawH);
    gl.uniform1f(strandU.feather, 0.001); // no feather for glow
    gl.bindVertexArray(strandVAO);
    for (let si = 0; si < strands.length; si++) {
      const ci = si * 4;
      gl.uniform4f(strandU.color, glowColorData[ci], glowColorData[ci+1], glowColorData[ci+2], glowColorData[ci+3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, si * VERTS_PER_STRAND, VERTS_PER_STRAND);
    }

    // ── Pass 2: Kawase blur - tight bloom ──
    gl.disable(gl.BLEND);
    gl.useProgram(kawaseProg);
    gl.bindVertexArray(quadVAO);
    gl.uniform1i(kawaseU.tex, 0);
    const texelX = 1 / bloomA.w, texelY = 1 / bloomA.h;
    gl.uniform2f(kawaseU.texel, texelX, texelY);

    let src = bloomA, dst = bloomB;
    for (let i = 0; i < KAWASE_TIGHT.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1f(kawaseU.offset, KAWASE_TIGHT[i]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const tmp = src; src = dst; dst = tmp;
    }
    // Tight bloom now in `src`

    // ── Pass 3: Composite tight bloom to screen ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(bgR, bgG, bgB, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    if (isDark) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(compositeProg);
    gl.bindVertexArray(quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(compositeU.tex, 0);
    gl.uniform1f(compositeU.alpha, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── Pass 4: Continue blurring for wide bloom ──
    gl.disable(gl.BLEND);
    gl.useProgram(kawaseProg);
    gl.bindVertexArray(quadVAO);
    gl.uniform1i(kawaseU.tex, 0);
    gl.uniform2f(kawaseU.texel, texelX, texelY);
    for (let i = 0; i < KAWASE_WIDE.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1f(kawaseU.offset, KAWASE_WIDE[i]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const tmp = src; src = dst; dst = tmp;
    }
    // Wide bloom now in `src`

    // ── Pass 5: Composite wide bloom to screen ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    if (isDark) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(compositeProg);
    gl.bindVertexArray(quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(compositeU.tex, 0);
    gl.uniform1f(compositeU.alpha, 0.6);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── Pass 6: Draw strand cores (premultiplied alpha blend) ──
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(strandProg);
    gl.uniform2f(strandU.res, drawW, drawH);
    gl.bindVertexArray(strandVAO);
    for (let si = 0; si < strands.length; si++) {
      const ci = si * 4;
      gl.uniform4f(strandU.color, coreColorData[ci], coreColorData[ci+1], coreColorData[ci+2], coreColorData[ci+3]);
      gl.uniform1f(strandU.feather, FEATHER[si]);
      gl.drawArrays(gl.TRIANGLE_STRIP, si * VERTS_PER_STRAND, VERTS_PER_STRAND);
    }

    // ── Particles ──
    // Spawn
    const spawnChance = 0.6 + rawLevel * 3;
    const spawnCount = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0);
    for (let sp = 0; sp < spawnCount && particlePool.length < MAX_PARTICLES; sp++) {
      const si = Math.floor(Math.random() * strands.length);
      const s = strands[si];
      const sa = Math.floor(Math.random() * strands.length);
      const sb = Math.floor(Math.random() * strands.length);
      particlePool.push({
        sa, sb, blend: Math.random(),
        n: 0.08 + Math.random() * 0.84,
        speed: -(0.01 + Math.random() * 0.04),
        yOff: (Math.random() - 0.5) * maxAmp * 0.6,
        yDrift: (Math.random() - 0.5) * 6,
        age: 0, fadeIn: 0.6 + Math.random() * 0.8, life: 1.0,
        decay: 0.003 + Math.random() * 0.008,
        r: s.rgb[0] / 255, g: s.rgb[1] / 255, b: s.rgb[2] / 255,
        size: 1.5 + Math.random() * 2.5,
        baseAlpha: 0.35 + Math.random() * 0.5,
      });
    }

    // Update, compact, and fill instance buffer in one pass
    let writeIdx = 0, pi = 0;
    for (let i = 0; i < particlePool.length; i++) {
      const p = particlePool[i];
      p.n += p.speed * dt;
      p.yOff += p.yDrift * dt;
      p.age += dt;
      p.life -= p.decay;
      if (p.life <= 0 || p.n < 0.02 || p.n > 0.98) continue;

      if (writeIdx !== i) particlePool[writeIdx] = p;
      writeIdx++;

      const fadeInT = Math.min(p.age / p.fadeIn, 1);
      const fadeOutT = Math.min(p.life / 0.3, 1);
      const visibility = fadeInT * fadeInT * fadeOutT;
      const idx = p.n * pts;
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, pts);
      const frac = idx - lo;
      const ya = strandCenterY[p.sa][lo] + (strandCenterY[p.sa][hi] - strandCenterY[p.sa][lo]) * frac;
      const yb = strandCenterY[p.sb][lo] + (strandCenterY[p.sb][hi] - strandCenterY[p.sb][lo]) * frac;
      particleInstData[pi++] = p.n * drawW;
      particleInstData[pi++] = ya + (yb - ya) * p.blend + p.yOff;
      particleInstData[pi++] = p.size * (0.4 + visibility * 0.6) * 3;
      particleInstData[pi++] = p.r;
      particleInstData[pi++] = p.g;
      particleInstData[pi++] = p.b;
      particleInstData[pi++] = visibility * p.baseAlpha;
    }
    particlePool.length = writeIdx;

    if (writeIdx > 0) {
      if (isDark) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(particleProg);
      gl.uniform2f(particleU.res, drawW, drawH);
      gl.bindVertexArray(particleVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleInstVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleInstData, 0, writeIdx * 7);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, writeIdx);
    }

    gl.disable(gl.BLEND);
  }

  // ── Animation loop ────────────────────────────────────────────────
  function tick() {
    // Safety: stop if overlay is no longer visible (observer may have missed)
    if (!overlayEl || !overlayEl.classList.contains('visible')) {
      L('tick() safety bail -- overlay not visible');
      stopLoop();
      return;
    }
    const t0 = performance.now();
    if (!cachedCardEl || !cachedCardEl.isConnected) {
      cachedCardEl = document.querySelector('voice-satellite-card');
    }
    const cfg = cachedCardEl?.config;
    const interval = Number(cfg?.reactive_bar_update_interval_ms) || 33;
    if (t0 - lastTickTime < Math.max(8, interval)) { rafId = requestAnimationFrame(tick); return; }
    lastTickTime = t0;
    const debug = !!cfg?.debug;

    draw();

    if (debug) {
      const drawMs = performance.now() - t0;
      fpsFrameCount++;
      if (drawMs < fpsDrawMin) fpsDrawMin = drawMs;
      if (drawMs > fpsDrawMax) fpsDrawMax = drawMs;
      fpsAccum += drawMs;

      if (t0 - fpsLast >= 2000) {
        const elapsed = t0 - fpsLast;
        const fps = (fpsFrameCount / elapsed * 1000).toFixed(1);
        const avg = (fpsAccum / fpsFrameCount).toFixed(1);
        fpsDisplay = `${fps} fps | draw: ${avg}ms avg, ${fpsDrawMin.toFixed(1)}-${fpsDrawMax.toFixed(1)}ms | ${drawW}x${drawH} | WebGL2`;
        L(fpsDisplay);
        fpsFrameCount = 0; fpsAccum = 0;
        fpsDrawMin = Infinity; fpsDrawMax = 0; fpsLast = t0;
      }

      if (!fpsEl) {
        fpsEl = document.createElement('div');
        fpsEl.style.cssText = 'position:absolute;top:4px;left:8px;font:11px monospace;pointer-events:none;z-index:1';
        wrapper.appendChild(fpsEl);
      }
      fpsEl.style.color = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
      if (fpsDisplay) fpsEl.textContent = fpsDisplay;
    } else if (fpsEl) {
      fpsEl.remove();
      fpsEl = null;
    }

    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId || document.hidden) return;
    if (!glReady) {
      // Context was intentionally lost by stopLoop -- restore it.
      // webglcontextrestored will reinitialize and re-call startLoop.
      if (gl && gl.isContextLost() && loseCtxExt) {
        L('startLoop() -- restoring lost context');
        loseCtxExt.restoreContext();
        return;
      }
      if (!initGL()) return;
    }
    L('startLoop()');
    resize();
    detectTheme();
    lastTime = 0;
    tick();
  }

  function stopLoop() {
    const wasRunning = !!rafId;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // Release GPU resources to prevent mobile browser freeze during idle.
    // The context will be restored on next startLoop() via WEBGL_lose_context.
    const willRelease = glReady && !!loseCtxExt;
    if (wasRunning || willRelease) L('stopLoop()', wasRunning ? 'raf=cancelled' : 'raf=none', willRelease ? 'gpu=releasing' : 'gpu=already-released');
    if (willRelease) {
      freeFBO(gl, bloomA); bloomA = null;
      freeFBO(gl, bloomB); bloomB = null;
      glReady = false;
      loseCtxExt.loseContext();
    }
  }

  // The blur overlay controls waveform CSS visibility (opacity 0 -> 1)
  const overlayEl = ui.querySelector('.vs-blur-overlay');

  document.addEventListener('visibilitychange', () => {
    L('visibilitychange', document.hidden ? 'hidden' : 'visible');
    if (document.hidden) stopLoop();
    else if (overlayEl?.classList.contains('visible')) startLoop();
  });

  if (overlayEl) {
    new MutationObserver(() => {
      const vis = overlayEl.classList.contains('visible');
      L('overlay class changed', vis ? 'visible' : 'hidden');
      if (vis) startLoop();
      else stopLoop();
    }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
  }

  return true;
}

// Try setup immediately; if #voice-satellite-ui doesn't exist yet,
// watch document.body for its creation.
if (!setup()) {
  const bodyObs = new MutationObserver(() => {
    if (document.getElementById('voice-satellite-ui')) {
      bodyObs.disconnect();
      setup();
    }
  });
  bodyObs.observe(document.body, { childList: true });
}

// ── Skin export ──────────────────────────────────────────────────────

export const waveformSkin = {
  id: 'waveform',
  name: 'Waveform',
  css,
  reactiveBar: true,
  overlayColor: null,
  defaultOpacity: 0.90,
  previewCSS,
  fontURL: 'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap',
};
