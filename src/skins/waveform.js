/**
 * Waveform Skin
 *
 * Dark/light adaptive skin with a canvas-based flowing neon waveform
 * centered in the background. The waveform is always visible with a
 * subtle idle animation that intensifies when mic or TTS audio is active.
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
  { rgb: [30, 10, 140],  alpha: 0.08, blur: 55, lineW: 16, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [70, 40, 200],  alpha: 0.13, blur: 40, lineW: 10, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [120, 60, 255], alpha: 0.23, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [30, 160, 255], alpha: 0.18, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [160, 80, 255], alpha: 0.38, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [140, 170, 255], alpha: 0.62, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [200, 210, 255], alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];
const WAVE_STRANDS_DARK_ERROR = [
  { rgb: [140, 10, 10],  alpha: 0.06, blur: 55, lineW: 16, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [200, 30, 30],  alpha: 0.12, blur: 40, lineW: 10, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [240, 50, 50],  alpha: 0.20, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [255, 80, 60],  alpha: 0.16, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [255, 120, 100], alpha: 0.35, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [255, 160, 140], alpha: 0.55, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [255, 200, 190], alpha: 0.80, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];

// ── Light theme strands (deep saturated on light overlay) ──
const WAVE_STRANDS_LIGHT = [
  { rgb: [20, 0, 100],   alpha: 0.10, blur: 55, lineW: 16, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [50, 20, 160],  alpha: 0.16, blur: 40, lineW: 10, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [80, 30, 200],  alpha: 0.30, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [0, 100, 210],  alpha: 0.25, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [120, 40, 200],  alpha: 0.45, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [60, 50, 180],  alpha: 0.65, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [40, 30, 140],  alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];
const WAVE_STRANDS_LIGHT_ERROR = [
  { rgb: [100, 0, 0],    alpha: 0.10, blur: 55, lineW: 16, speed: 0.4, freqs: [1.2, 2.0, 5.0],  weights: [0.55, 0.30, 0.15], phase: 0,    ampScale: 1.3, feather: 8 },
  { rgb: [160, 10, 10],  alpha: 0.18, blur: 40, lineW: 10, speed: 0.55, freqs: [1.5, 3.0, 6.0],  weights: [0.50, 0.30, 0.20], phase: 0.8,  ampScale: 1.2, feather: 6 },
  { rgb: [200, 20, 20],  alpha: 0.32, blur: 28, lineW: 5,  speed: 0.7, freqs: [2.0, 3.5, 7.0],  weights: [0.45, 0.35, 0.20], phase: 1.6,  ampScale: 1.1, feather: 3.5 },
  { rgb: [220, 40, 30],  alpha: 0.28, blur: 30, lineW: 6,  speed: 0.65, freqs: [1.8, 4.2, 8.0],  weights: [0.40, 0.35, 0.25], phase: 2.8,  ampScale: 1.15, feather: 4 },
  { rgb: [200, 60, 50],  alpha: 0.50, blur: 22, lineW: 3.5, speed: 0.85, freqs: [2.2, 4.0, 6.5],  weights: [0.45, 0.30, 0.25], phase: 0.4,  ampScale: 1.0, feather: 2 },
  { rgb: [180, 40, 40],  alpha: 0.70, blur: 16, lineW: 2,  speed: 0.75, freqs: [1.6, 3.2, 5.5],  weights: [0.40, 0.35, 0.25], phase: 2.0,  ampScale: 0.9, feather: 0.8 },
  { rgb: [150, 20, 20],  alpha: 0.90, blur: 10, lineW: 1.2, speed: 0.7, freqs: [2.0, 3.0, 5.0],  weights: [0.45, 0.30, 0.25], phase: 0.3,  ampScale: 0.8, feather: 0 },
];

// ── Per-strand dynamics ──────────────────────────────────────────────
// Each strand smooths audio independently so peaks cascade outward:
// core snaps to audio first, glow swells after. Subtle speed and
// brightness boosts reinforce the layered feel without breaking cohesion.
//
//   smoothUp/Down  – attack/decay rate (higher = faster response)
//   speedReact     – animation speed boost at max audio (fraction of base)
//   alphaReact     – opacity boost at max audio (fraction of base)
//   harmonicGain   – extra high-freq ripple at max audio
//   bloomReact     – shadowBlur boost at max audio (fraction of base)

const STRAND_DYNAMICS = [
  /* 0  deep glow  */ { smoothUp: 0.08, smoothDown: 0.035, speedReact: 1.5,  alphaReact: 0.30, harmonicGain: 0,    bloomReact: 0.30 },
  /* 1  mid bloom  */ { smoothUp: 0.10, smoothDown: 0.045, speedReact: 2.0,  alphaReact: 0.40, harmonicGain: 0.02, bloomReact: 0.35 },
  /* 2  violet     */ { smoothUp: 0.13, smoothDown: 0.055, speedReact: 2.5,  alphaReact: 0.50, harmonicGain: 0.04, bloomReact: 0.40 },
  /* 3  cyan       */ { smoothUp: 0.16, smoothDown: 0.065, speedReact: 3.0,  alphaReact: 0.55, harmonicGain: 0.06, bloomReact: 0.45 },
  /* 4  pink-mid   */ { smoothUp: 0.20, smoothDown: 0.080, speedReact: 3.5,  alphaReact: 0.65, harmonicGain: 0.08, bloomReact: 0.50 },
  /* 5  sharp      */ { smoothUp: 0.25, smoothDown: 0.100, speedReact: 4.0,  alphaReact: 0.75, harmonicGain: 0.12, bloomReact: 0.55 },
  /* 6  core       */ { smoothUp: 0.32, smoothDown: 0.130, speedReact: 5.0,  alphaReact: 0.90, harmonicGain: 0.15, bloomReact: 0.60 },
];

// ── Self-mounting visualizer ─────────────────────────────────────────
// Runs once at module load. The wrapper + canvas are added to the DOM
// only while the waveform skin CSS is active. A MutationObserver on the
// shared <style> element detects skin changes and mounts/unmounts.
//
// Because the waveform chunk may load before #voice-satellite-ui or
// #voice-satellite-styles exist (race with ensureGlobalUI), setup()
// retries via MutationObserver on document.body until the UI appears.

let _waveform2dSetupDone = false;
const HIDDEN_WARMUP_BLOCKED =
  /Fully Kiosk/i.test(navigator.userAgent || '')
  || /\bwv\b/i.test(navigator.userAgent || '');

function setup() {
  const ui = document.getElementById('voice-satellite-ui');
  if (!ui) return false;
  if (_waveform2dSetupDone) return true;
  _waveform2dSetupDone = true;
  const barEl = ui.querySelector('.vs-rainbow-bar');

  // Theme detection — re-evaluated each time the overlay opens so
  // dark/light switches take effect without a page reload.
  let isDark = true;
  const themeProbe = document.createElement('div');
  themeProbe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;color:var(--primary-background-color,#fff)';
  document.body.appendChild(themeProbe);

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
  }

  // ── CSS variable → strand color overrides ──────────────────────────
  // Reads --wf-strand-N and --wf-strand-error-N from computed styles.
  // Called after detectTheme() so the correct .vs-dark/.vs-light vars
  // are active. Users override via the custom CSS field.
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

  // Canvas setup — elements created once, contexts deferred to first startLoop().
  // Deferring getContext('2d') avoids Android WebView's lazy GPU init race:
  // if called too early (at page load), Skia silently falls back to software
  // rendering. By waiting until the overlay opens, the GPU process has had
  // time to initialize.
  const wrapper = document.createElement('div');
  wrapper.className = 'vs-waveform';
  wrapper.style.opacity = '0'; // prevent flash before skin CSS loads
  let canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);

  const CTX_OPTS = { willReadFrequently: false };
  let ctx = null;

  // Offscreen canvas for glow pass — rendered at half res, composited
  // with a single blur instead of per-strand ctx.filter + shadowBlur.
  let glowCanvas = document.createElement('canvas');
  let glowCtx = null;
  let contextsInitialized = false;

  function initContexts() {
    if (contextsInitialized) return;
    console.log('[waveform] Initializing canvas contexts (deferred)');
    ctx = canvas.getContext('2d', CTX_OPTS);
    glowCtx = glowCanvas.getContext('2d', CTX_OPTS);
    contextsInitialized = true;
  }

  let drawW = 0, drawH = 0, rafId = null, lastTime = 0, lastTickTime = 0;
  let mounted = false;
  let resizeObs = null;
  let warmupTimer = null;
  let warmupActive = false;
  let warmupStopTimer = null;
  let overlayEl = null;

  // FPS metrics (visible when card config has debug: true)
  let fpsFrameCount = 0;
  let fpsAccum = 0;
  let fpsLast = 0;
  let fpsDisplay = '';
  let fpsDrawMin = Infinity;
  let fpsDrawMax = 0;
  const strandLevels = new Float64Array(STRAND_DYNAMICS.length);
  const strandEnergy = new Float64Array(STRAND_DYNAMICS.length);
  const strandPhase = new Float64Array(STRAND_DYNAMICS.length);
  const PTS = 280;
  const waveBuffer = new Float64Array(PTS + 1);
  const ribbonY = new Float64Array(PTS + 1);
  const ribbonW = new Float64Array(PTS + 1);
  const xPos = new Float64Array(PTS + 1);
  let xPosW = -1; // drawW used to compute xPos; -1 forces first rebuild
  const strandPaths = new Array(STRAND_DYNAMICS.length);
  const strandCoreColors = new Array(STRAND_DYNAMICS.length);

  // ── Particle system ──
  const MAX_PARTICLES = 50;
  const particlePool = [];

  // Pre-rendered particle sprite (white soft circle, 64x64)
  const SPRITE_SZ = 64;
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = SPRITE_SZ;
  spriteCanvas.height = SPRITE_SZ;
  const spriteCtx = spriteCanvas.getContext('2d');
  const half = SPRITE_SZ / 2;
  const spriteGrad = spriteCtx.createRadialGradient(half, half, 0, half, half, half);
  spriteGrad.addColorStop(0, 'rgba(255,255,255,0.8)');
  spriteGrad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  spriteGrad.addColorStop(0.6, 'rgba(255,255,255,0.1)');
  spriteGrad.addColorStop(1, 'rgba(255,255,255,0)');
  spriteCtx.fillStyle = spriteGrad;
  spriteCtx.fillRect(0, 0, SPRITE_SZ, SPRITE_SZ);

  // Tinted sprite cache: "r,g,b" -> canvas
  const tintCache = new Map();
  function getTintedSprite(r, g, b) {
    const key = `${r},${g},${b}`;
    let c = tintCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = SPRITE_SZ;
    c.height = SPRITE_SZ;
    const tc = c.getContext('2d');
    tc.drawImage(spriteCanvas, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    tc.fillStyle = `rgb(${r},${g},${b})`;
    tc.fillRect(0, 0, SPRITE_SZ, SPRITE_SZ);
    tintCache.set(key, c);
    return c;
  }
  // Per-strand center Y cache so particles can follow their strand
  const strandCenterY = new Array(STRAND_DYNAMICS.length);
  for (let i = 0; i < STRAND_DYNAMICS.length; i++) {
    strandCenterY[i] = new Float64Array(PTS + 1);
  }

  function mount() {
    if (mounted) return;
    ui.appendChild(wrapper);
    mounted = true;
    if (!resizeObs) {
      resizeObs = new ResizeObserver(resize);
    }
    resizeObs.observe(wrapper);
    resize();
    scheduleWarmup('mount');
  }

  function unmount() {
    if (!mounted) return;
    cancelWarmup();
    stopLoop();
    if (resizeObs) resizeObs.disconnect();
    drawW = 0; drawH = 0;
    wrapper.remove();
    mounted = false;
  }

  function resize() {
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width || !rect.height || !ctx) { drawW = 0; drawH = 0; return; }
    // Cap DPR — background waveform doesn't need retina sharpness
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    drawW = rect.width;
    drawH = rect.height;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Glow canvas at half resolution
    glowCanvas.width = Math.round(rect.width * dpr * 0.5);
    glowCanvas.height = Math.round(rect.height * dpr * 0.5);
    glowCtx.setTransform(dpr * 0.5, 0, 0, dpr * 0.5, 0, 0);
  }

  // Watch the shared skin <style> element — mount when waveform CSS is
  // active, unmount when another skin replaces it.
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
    // Style element doesn't exist yet — watch <head> for its creation
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

  function draw() {
    if (!drawW || !drawH) return;

    const centerY = drawH / 2;
    const t = performance.now() / 1000;
    const dt = lastTime ? t - lastTime : 0;
    lastTime = t;

    // Derive mode from the bar's CSS classes
    const barVisible = barEl.classList.contains('visible');
    const isError = barEl.classList.contains('error-mode');
    const isProcessing = barEl.classList.contains('processing');
    const isActive = barVisible && !isError && !isProcessing;

    // Raw audio level from --vs-audio-level (set by analyser tick loop)
    let rawLevel = 0;
    if (isActive) {
      rawLevel = parseFloat(barEl.style.getPropertyValue('--vs-audio-level')) || 0;
    } else if (isProcessing) {
      rawLevel = 0.35;
    } else if (isError) {
      rawLevel = 0.3;
    }

    ctx.clearRect(0, 0, drawW, drawH);
    glowCtx.clearRect(0, 0, drawW, drawH);

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

    // ── Phase 1: compute all strands, draw glows to offscreen canvas ──
    glowCtx.globalCompositeOperation = 'lighter';

    for (let si = 0; si < strands.length; si++) {
      const s = strands[si];
      const d = STRAND_DYNAMICS[si];

      // ── Dual smoothing ──
      const ampRate = rawLevel > strandLevels[si] ? d.smoothUp : d.smoothDown;
      strandLevels[si] += (rawLevel - strandLevels[si]) * ampRate;
      const level = strandLevels[si];

      const engRate = rawLevel > strandEnergy[si] ? 0.25 : 0.12;
      strandEnergy[si] += (rawLevel - strandEnergy[si]) * engRate;
      const energy = strandEnergy[si];

      // ── Phase accumulation ──
      const speedMult = 1 + energy * d.speedReact;
      strandPhase[si] += dt * s.speed * speedMult;
      const phase = strandPhase[si];

      // ── Per-strand modulated values ──
      const waveAmp = maxAmp * (idleBase + level * (1 - idleBase)) * s.ampScale;
      const baseAlpha = s.alpha;
      const a = Math.min(1, baseAlpha * (1 + level * d.alphaReact));
      const hGain = d.harmonicGain * energy;

      const [r, g, b] = s.rgb;
      strandCoreColors[si] = `rgba(${r},${g},${b},${a})`;

      const glowA = Math.min(1, a * 4);
      const glowColor = `rgba(${r},${g},${b},${glowA})`;

      // Compute raw wave shape + ribbon in a single pass
      const halfBase = s.lineW * 0.5;
      const maxDisp = drawH * 0.42;
      const invMaxDisp = 1 / maxDisp;
      const energyActive = energy > 0.01;
      for (let i = 0; i <= pts; i++) {
        const nPi = (i / pts) * Math.PI;
        let wave = 0;
        for (let f = 0; f < s.freqs.length; f++) {
          wave += Math.sin(nPi * s.freqs[f] * 2
            + phase * (1 + f * 0.6)
            + s.phase + f * 1.1) * s.weights[f];
        }
        wave += Math.sin(nPi * 14 + phase * 2.8 + s.phase * 1.7) * 0.06;
        if (hGain > 0.001) {
          wave += Math.sin(nPi * 22 + phase * 3.5 + s.phase * 2.3) * hGain;
          wave += Math.sin(nPi * 34 + phase * 4.2 + s.phase * 0.7) * hGain * 0.5;
        }
        waveBuffer[i] = wave;

        // Ribbon envelope + width (fused from separate loop)
        const sinNPi = Math.sin(nPi);
        let env = Math.pow(sinNPi, 2.4);
        if (energyActive) {
          env *= Math.max(0, 1 + energy * (
            Math.sin(nPi * 1.5 + phase * 1.1 + si * 0.7) * 0.7 +
            Math.sin(nPi * 2.8 + phase * 0.65 + si * 1.3) * 0.5
          ));
        }
        const waveVal = wave * env;
        const raw = waveVal * waveAmp;
        ribbonY[i] = centerY + maxDisp * Math.tanh(raw * invMaxDisp);

        const displacement = Math.abs(waveVal);
        const thickMod = energyActive
          ? Math.max(0.4, 1 + energy * Math.sin(nPi * 2.3 + phase * 0.8 + si * 1.5) * 0.6)
          : 1;
        ribbonW[i] = Math.max(0.3, halfBase * (0.25 + 0.75 * displacement) * thickMod);
      }

      // Cache center Y for particle tracking
      strandCenterY[si].set(ribbonY);

      // Build ribbon path
      const path = new Path2D();
      for (let i = 0; i <= pts; i++) {
        const y = ribbonY[i] - ribbonW[i];
        if (i === 0) path.moveTo(xPos[i], y); else path.lineTo(xPos[i], y);
      }
      for (let i = pts; i >= 0; i--) {
        path.lineTo(xPos[i], ribbonY[i] + ribbonW[i]);
      }
      path.closePath();
      strandPaths[si] = path;

      // Draw glow to offscreen canvas (no per-strand blur or shadow)
      glowCtx.fillStyle = glowColor;
      glowCtx.fill(path);
    }

    // ── Composite glow layer onto main canvas ──
    // Two passes: tight bloom + wide bloom to replace per-strand shadowBlur.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(10px)';
    ctx.drawImage(glowCanvas, 0, 0, drawW, drawH);
    ctx.filter = 'blur(28px)';
    ctx.globalAlpha = 0.6;
    ctx.drawImage(glowCanvas, 0, 0, drawW, drawH);
    ctx.restore();

    // ── Phase 2: draw cores in 3 feather groups ──
    // Heavy (strands 0-1, feather 6-8), Medium (2-4, feather 2-4), Crisp (5-6, feather 0-0.8)
    // Each group renders to the offscreen canvas, then composites with a
    // single blur — 2 blur passes instead of 5 per-strand blurs.
    ctx.globalCompositeOperation = 'source-over';

    // Group A: heavy feather (strands 0, 1)
    glowCtx.globalCompositeOperation = 'source-over';
    glowCtx.clearRect(0, 0, drawW, drawH);
    for (let si = 0; si < 2; si++) {
      glowCtx.fillStyle = strandCoreColors[si];
      glowCtx.fill(strandPaths[si]);
    }
    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.drawImage(glowCanvas, 0, 0, drawW, drawH);
    ctx.restore();

    // Group B: medium feather (strands 2, 3, 4)
    glowCtx.clearRect(0, 0, drawW, drawH);
    for (let si = 2; si < 5; si++) {
      glowCtx.fillStyle = strandCoreColors[si];
      glowCtx.fill(strandPaths[si]);
    }
    ctx.save();
    ctx.filter = 'blur(3px)';
    ctx.drawImage(glowCanvas, 0, 0, drawW, drawH);
    ctx.restore();

    // Group C: crisp (strands 5, 6) — direct, no blur
    for (let si = 5; si < strands.length; si++) {
      ctx.fillStyle = strandCoreColors[si];
      ctx.fill(strandPaths[si]);
    }

    // ── Particles: soft light specks drifting with the wave current ──
    // Spawn — higher audio level = more particles
    const spawnChance = 0.4 + rawLevel * 2;
    const spawnCount = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0);
    for (let sp = 0; sp < spawnCount && particlePool.length < MAX_PARTICLES; sp++) {
      // Pick a color from a random strand but don't lock to its path
      const si = Math.floor(Math.random() * strands.length);
      const s = strands[si];
      // Blend Y from 2 random strands for loose positioning
      const sa = Math.floor(Math.random() * strands.length);
      const sb = Math.floor(Math.random() * strands.length);
      const blend = Math.random();
      const startN = 0.08 + Math.random() * 0.84;
      particlePool.push({
        sa, sb, blend,
        n: startN,
        speed: -(0.01 + Math.random() * 0.04),       // flow left (same as strands), varied rates
        yOff: (Math.random() - 0.5) * maxAmp * 0.6,  // wide vertical scatter
        yDrift: (Math.random() - 0.5) * 6,            // vertical wander
        age: 0,
        fadeIn: 0.6 + Math.random() * 0.8,             // 0.6–1.4s to fully appear
        life: 1.0,
        decay: 0.003 + Math.random() * 0.008,         // ~2–5s lifetime
        r: s.rgb[0], g: s.rgb[1], b: s.rgb[2],
        size: 1.5 + Math.random() * 2.5,
        baseAlpha: 0.35 + Math.random() * 0.5,
      });
    }

    // Update & draw particles
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = particlePool.length - 1; i >= 0; i--) {
      const p = particlePool[i];
      p.n += p.speed * dt;
      p.yOff += p.yDrift * dt;
      p.age += dt;
      p.life -= p.decay;
      if (p.life <= 0 || p.n < 0.02 || p.n > 0.98) {
        particlePool.splice(i, 1);
        continue;
      }
      // Slow fade-in + fade-out at end of life
      const fadeInT = Math.min(p.age / p.fadeIn, 1);
      const fadeOutT = Math.min(p.life / 0.3, 1); // fade out over last 0.3 of life
      const visibility = fadeInT * fadeInT * fadeOutT; // ease-in curve
      // Blend Y from two strands for organic placement
      const idx = p.n * pts;
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, pts);
      const frac = idx - lo;
      const ya = strandCenterY[p.sa][lo] + (strandCenterY[p.sa][hi] - strandCenterY[p.sa][lo]) * frac;
      const yb = strandCenterY[p.sb][lo] + (strandCenterY[p.sb][hi] - strandCenterY[p.sb][lo]) * frac;
      const strandY = ya + (yb - ya) * p.blend;
      const px = p.n * drawW;
      const py = strandY + p.yOff;
      const a = visibility * p.baseAlpha;
      const sz = p.size * (0.4 + visibility * 0.6);
      // Draw pre-rendered tinted sprite instead of creating gradient per frame
      const diameter = sz * 10;
      const sprite = getTintedSprite(p.r, p.g, p.b);
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, px - diameter * 0.5, py - diameter * 0.5, diameter, diameter);
    }
    ctx.restore();
  }

  function tick() {
    const t0 = performance.now();
    const interval = Number(document.querySelector('voice-satellite-card')?.config?.reactive_bar_update_interval_ms) || 33;
    if (t0 - lastTickTime < Math.max(8, interval)) { rafId = requestAnimationFrame(tick); return; }
    lastTickTime = t0;
    const debug = !!document.querySelector('voice-satellite-card')?.config?.debug;
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
        fpsDisplay = `${fps} fps | draw: ${avg}ms avg, ${fpsDrawMin.toFixed(1)}-${fpsDrawMax.toFixed(1)}ms | ${drawW}x${drawH}`;
        console.log(`[waveform] ${fpsDisplay}`);
        fpsFrameCount = 0;
        fpsAccum = 0;
        fpsDrawMin = Infinity;
        fpsDrawMax = 0;
        fpsLast = t0;
      }

      if (fpsDisplay) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = '11px monospace';
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
        ctx.fillText(fpsDisplay, 8, 14);
        ctx.restore();
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (!rafId && !document.hidden) {
      initContexts();
      resize();
      detectTheme();
      tintCache.clear();
      lastTime = 0;
      tick();
    }
  }

  function cancelWarmup() {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    if (warmupStopTimer) {
      clearTimeout(warmupStopTimer);
      warmupStopTimer = null;
    }
    warmupActive = false;
  }

  function scheduleWarmup(reason) {
    if (HIDDEN_WARMUP_BLOCKED) return;
    if (document.hidden || !mounted || overlayEl?.classList.contains('visible')) return;
    if (warmupTimer || rafId) return;
    warmupTimer = setTimeout(() => {
      warmupTimer = null;
      if (document.hidden || !mounted || overlayEl?.classList.contains('visible')) return;
      warmupActive = true;
      console.log(`[waveform] Starting hidden warmup (${reason})`);
      startLoop();
      warmupStopTimer = setTimeout(() => {
        warmupStopTimer = null;
        if (warmupActive && !overlayEl?.classList.contains('visible')) {
          console.log('[waveform] Hidden warmup complete');
          stopLoop();
        }
      }, 1800);
    }, 1200);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    warmupActive = false;
  }

  // The blur overlay controls waveform CSS visibility (opacity 0 → 1)
  overlayEl = ui.querySelector('.vs-blur-overlay');

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelWarmup();
      stopLoop();
    } else if (overlayEl?.classList.contains('visible')) {
      startLoop();
    } else {
      scheduleWarmup('visibility');
    }
  });

  if (overlayEl) {
    new MutationObserver(() => {
      if (overlayEl.classList.contains('visible')) {
        cancelWarmup();
        startLoop();
      } else {
        stopLoop();
        scheduleWarmup('overlay-hidden');
      }
    }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
  }

  const warmupEvents = ['pointerdown', 'touchstart', 'keydown'];
  for (const type of warmupEvents) {
    window.addEventListener(type, () => scheduleWarmup(type), { passive: true });
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
};
