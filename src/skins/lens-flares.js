/**
 * Lens Flares Skin
 *
 * Anamorphic vertical light streaks in blue and warm tones, with
 * scattered bokeh dots and audio-reactive intensity. The whole scene
 * lives behind a heavy multi-pass bloom so every shape reads as a
 * soft glow rather than a sharp primitive. Audio level pulses the
 * brightness of the flares; a slow horizontal drift keeps the scene
 * alive even at idle.
 *
 * Runtime is activated explicitly by the skin registry when selected.
 * This keeps static bundling from starting unused skin observers/RAF loops.
 */

import css from './lens-flares.css';
import previewCSS from './lens-flares-preview.css';

// ── Color palette ───────────────────────────────────────────────────

const PALETTE = {
  blueDeep:   [10, 50, 240],
  blueMid:    [40, 130, 255],
  blueLight:  [120, 200, 255],
  blueWhite:  [200, 230, 255],
  warmDeep:   [230, 25, 90],
  warmMid:    [255, 60, 120],
  warmLight:  [255, 130, 170],
  white:      [255, 250, 250],
};

function pickBlue() {
  const r = Math.random();
  if (r < 0.20) return PALETTE.blueDeep;
  if (r < 0.65) return PALETTE.blueMid;
  if (r < 0.92) return PALETTE.blueLight;
  return PALETTE.blueWhite;
}

function pickWarm() {
  const r = Math.random();
  if (r < 0.30) return PALETTE.warmDeep;
  if (r < 0.75) return PALETTE.warmMid;
  return PALETTE.warmLight;
}

function rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

// ── Self-mounting visualizer ────────────────────────────────────────

let _setupDone = false;
const HIDDEN_WARMUP_BLOCKED =
  /Fully Kiosk/i.test(navigator.userAgent || '')
  || /\bwv\b/i.test(navigator.userAgent || '');

function setup() {
  const ui = document.getElementById('voice-satellite-ui');
  if (!ui) return false;
  if (_setupDone) return true;
  _setupDone = true;
  const barEl = ui.querySelector('.vs-rainbow-bar');

  // ── Wrapper + canvas ──
  const wrapper = document.createElement('div');
  wrapper.className = 'vs-lens-flares';
  wrapper.style.opacity = '0';
  const canvas = document.createElement('canvas');
  wrapper.appendChild(canvas);

  const CTX_OPTS = { willReadFrequently: false };
  let ctx = null;
  const sceneCanvas = document.createElement('canvas');
  let sceneCtx = null;
  let contextsInitialized = false;

  function initContexts() {
    if (contextsInitialized) return;
    console.log('[lens-flares] Initializing canvas contexts (deferred)');
    ctx = canvas.getContext('2d', CTX_OPTS);
    sceneCtx = sceneCanvas.getContext('2d', CTX_OPTS);
    contextsInitialized = true;
  }

  let drawW = 0, drawH = 0, rafId = null, lastTime = 0, lastTickTime = 0;
  let mounted = false;
  let resizeObs = null;
  let warmupTimer = null;
  let warmupActive = false;
  let warmupStopTimer = null;
  let overlayEl = null;

  // FPS metrics (debug mode)
  let fpsFrameCount = 0;
  let fpsAccum = 0;
  let fpsLast = 0;
  let fpsDisplay = '';

  // Audio smoothing: smoothLevel snaps; energyLevel lags so bloom
  // swells after the strike.
  let smoothLevel = 0;
  let energyLevel = 0;

  // Slow horizontal drift offset (fraction of screen width per loop).
  let drift = 0;

  // ── Scene specs ──
  // Streaks and bokeh dots are generated once per resize. Each frame
  // re-renders the offscreen scene canvas with the current twinkle
  // and audio modulation, then composites three blurred copies onto
  // the main canvas.
  let streakSpecs = [];
  let bokehSpecs = [];

  function buildSpecs() {
    streakSpecs = [];
    bokehSpecs = [];

    // Main blue streaks. Even-ish horizontal distribution with jitter
    // so they don't read as a regular grid.
    const N_BLUE = 16;
    for (let i = 0; i < N_BLUE; i++) {
      const t = (i + 0.5) / N_BLUE + (Math.random() - 0.5) * (0.5 / N_BLUE);
      const isCore = Math.random() < 0.45;
      streakSpecs.push({
        x: t,
        width: 30 + Math.random() * 220,
        heightFrac: 0.55 + Math.random() * 0.40,
        yOff: (Math.random() - 0.5) * 0.20,
        color: pickBlue(),
        alpha: 0.36 + Math.random() * 0.40,
        coreColor: isCore ? PALETTE.blueWhite : null,
        coreAlpha: isCore ? 0.42 + Math.random() * 0.36 : 0,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleRate: 0.4 + Math.random() * 1.4,
        audioReactive: Math.random() < 0.55,
        driftScale: 0.6 + Math.random() * 0.8,
      });
    }

    // Warm accent streaks (pink/red lens flares).
    const N_WARM = 4;
    for (let i = 0; i < N_WARM; i++) {
      const isCore = Math.random() < 0.6;
      streakSpecs.push({
        x: Math.random(),
        width: 25 + Math.random() * 90,
        heightFrac: 0.45 + Math.random() * 0.45,
        yOff: (Math.random() - 0.5) * 0.25,
        color: pickWarm(),
        alpha: 0.44 + Math.random() * 0.36,
        coreColor: isCore ? PALETTE.warmLight : null,
        coreAlpha: isCore ? 0.40 + Math.random() * 0.34 : 0,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleRate: 0.5 + Math.random() * 1.2,
        audioReactive: Math.random() < 0.65,
        driftScale: 0.6 + Math.random() * 0.8,
      });
    }

    // Bokeh dots: out-of-focus light points scattered across the scene.
    const N_BOKEH = 36;
    for (let i = 0; i < N_BOKEH; i++) {
      const isWarm = Math.random() < 0.22;
      bokehSpecs.push({
        x: Math.random(),
        y: Math.random(),
        size: 18 + Math.random() * 90,
        color: isWarm ? pickWarm() : pickBlue(),
        alpha: 0.18 + Math.random() * 0.42,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleRate: 0.3 + Math.random() * 1.0,
        audioReactive: Math.random() < 0.35,
        driftScale: 0.2 + Math.random() * 0.4,  // slower than streaks (parallax)
      });
    }
  }

  function buildScene(time) {
    if (!sceneCtx) return null;
    sceneCtx.clearRect(0, 0, drawW, drawH);
    sceneCtx.globalCompositeOperation = 'lighter';

    // Horizontal falloff applied per element based on its on-screen
    // X. 1.0 at center, ~0.45 at left/right edges. Curve uses a
    // raised-power on distance-from-center so the middle ~50% of the
    // canvas stays bright and only the outer ~25% on each side dims.
    function edgeFalloff(xNorm) {
      const d = Math.abs(xNorm - 0.5) * 2; // 0 at center, 1 at edges
      return 1 - Math.pow(d, 1.6) * 0.55;
    }

    // ── Streaks ──
    for (const s of streakSpecs) {
      const twinkle = Math.sin(time * s.twinkleRate + s.twinklePhase) * 0.30 + 0.70;
      const audioBoost = s.audioReactive ? smoothLevel * 0.62 : 0;
      const cx = (((s.x + drift * s.driftScale) % 1) + 1) % 1 * drawW;
      const falloff = edgeFalloff(cx / drawW);
      const alpha = Math.min(1, (s.alpha * twinkle + audioBoost) * falloff);
      if (alpha < 0.005) continue;
      const h = drawH * s.heightFrac * (1 + smoothLevel * 0.10);
      const cy = drawH * (0.5 + s.yOff);
      const x = cx - s.width / 2;
      const y = cy - h / 2;

      // Vertical gradient: bright middle, fades top + bottom.
      const grad = sceneCtx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0,    'rgba(0,0,0,0)');
      grad.addColorStop(0.18, rgba(s.color, alpha * 0.45));
      grad.addColorStop(0.50, rgba(s.color, alpha));
      grad.addColorStop(0.82, rgba(s.color, alpha * 0.45));
      grad.addColorStop(1,    'rgba(0,0,0,0)');
      sceneCtx.fillStyle = grad;
      sceneCtx.fillRect(x, y, s.width, h);

      // Bright thin core (only on a fraction of streaks).
      if (s.coreAlpha > 0) {
        const coreA = Math.min(1, s.coreAlpha * twinkle + audioBoost * 0.6);
        const coreW = Math.min(s.width * 0.18, 12);
        const coreX = cx - coreW / 2;
        const cg = sceneCtx.createLinearGradient(0, y, 0, y + h);
        cg.addColorStop(0,    'rgba(0,0,0,0)');
        cg.addColorStop(0.20, rgba(s.coreColor, coreA * 0.55));
        cg.addColorStop(0.50, rgba(s.coreColor, coreA));
        cg.addColorStop(0.80, rgba(s.coreColor, coreA * 0.55));
        cg.addColorStop(1,    'rgba(0,0,0,0)');
        sceneCtx.fillStyle = cg;
        sceneCtx.fillRect(coreX, y, coreW, h);
      }
    }

    // ── Bokeh dots ──
    for (const b of bokehSpecs) {
      const twinkle = Math.sin(time * b.twinkleRate + b.twinklePhase) * 0.35 + 0.65;
      const audioBoost = b.audioReactive ? smoothLevel * 0.42 : 0;
      const cx = (((b.x + drift * b.driftScale) % 1) + 1) % 1 * drawW;
      const falloff = edgeFalloff(cx / drawW);
      const alpha = Math.min(1, (b.alpha * twinkle + audioBoost) * falloff);
      if (alpha < 0.005) continue;

      const cy = b.y * drawH;
      const grad = sceneCtx.createRadialGradient(cx, cy, 0, cx, cy, b.size);
      grad.addColorStop(0,   rgba(b.color, alpha));
      grad.addColorStop(0.45, rgba(b.color, alpha * 0.40));
      grad.addColorStop(1,   rgba(b.color, 0));
      sceneCtx.fillStyle = grad;
      sceneCtx.fillRect(cx - b.size, cy - b.size, b.size * 2, b.size * 2);
    }

    return sceneCanvas;
  }

  function draw() {
    if (!drawW || !drawH || !ctx) return;

    const t = performance.now() / 1000;
    const dt = lastTime ? Math.min(0.05, t - lastTime) : 0;
    lastTime = t;

    // Audio level
    const barVisible = barEl?.classList.contains('visible') ?? false;
    const isProcessing = barEl?.classList.contains('processing') ?? false;
    let rawLevel = 0;
    if (barVisible && !isProcessing) {
      rawLevel = parseFloat(barEl.style.getPropertyValue('--vs-audio-level')) || 0;
    } else if (isProcessing) {
      rawLevel = 0.4;
    }

    const ampRate = rawLevel > smoothLevel ? 0.20 : 0.08;
    smoothLevel += (rawLevel - smoothLevel) * ampRate;
    const engRate = rawLevel > energyLevel ? 0.08 : 0.03;
    energyLevel += (rawLevel - energyLevel) * engRate;

    // Slow horizontal drift, accelerating slightly with audio.
    drift += dt * (0.0035 + energyLevel * 0.012);
    if (drift > 1) drift -= 1;

    // Build the sharp scene snapshot for this frame.
    buildScene(t);

    // ── Composite to main canvas with multi-pass bloom ──
    // The aesthetic IS the blur: three passes at decreasing radii sum
    // into a soft anamorphic bloom that's bright at the streak cores
    // and falls off naturally to the edges.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, drawW, drawH);

    ctx.globalCompositeOperation = 'lighter';

    // Three additive blur passes. Alphas tuned so they sum to a rich
    // glow without saturating to white at audio peaks.
    ctx.filter = 'blur(60px)';
    ctx.globalAlpha = 0.48 + energyLevel * 0.28;
    ctx.drawImage(sceneCanvas, 0, 0);

    ctx.filter = 'blur(22px)';
    ctx.globalAlpha = 0.62 + smoothLevel * 0.20;
    ctx.drawImage(sceneCanvas, 0, 0);

    ctx.filter = 'blur(6px)';
    ctx.globalAlpha = 0.70;
    ctx.drawImage(sceneCanvas, 0, 0);

    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function mount() {
    if (mounted) return;
    ui.appendChild(wrapper);
    mounted = true;
    if (!resizeObs) resizeObs = new ResizeObserver(resize);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const newW = Math.round(rect.width * dpr);
    const newH = Math.round(rect.height * dpr);
    if (newW !== drawW || newH !== drawH) {
      drawW = newW;
      drawH = newH;
      canvas.width = drawW;
      canvas.height = drawH;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      sceneCanvas.width = drawW;
      sceneCanvas.height = drawH;
      buildSpecs();
    }
  }

  function checkSkinActive() {
    const styleEl = document.getElementById('voice-satellite-styles');
    const isActive = styleEl?.textContent.includes('.vs-lens-flares') ?? false;
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
      fpsAccum += drawMs;
      if (t0 - fpsLast >= 2000) {
        const elapsed = t0 - fpsLast;
        const fps = (fpsFrameCount / elapsed * 1000).toFixed(1);
        const avg = (fpsAccum / fpsFrameCount).toFixed(1);
        fpsDisplay = `${fps} fps | draw: ${avg}ms avg | ${drawW}x${drawH}`;
        console.log(`[lens-flares] ${fpsDisplay}`);
        fpsFrameCount = 0;
        fpsAccum = 0;
        fpsLast = t0;
      }
      if (fpsDisplay) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = '11px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
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
      lastTime = 0;
      tick();
    }
  }

  function cancelWarmup() {
    if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
    if (warmupStopTimer) { clearTimeout(warmupStopTimer); warmupStopTimer = null; }
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
      console.log(`[lens-flares] Starting hidden warmup (${reason})`);
      startLoop();
      warmupStopTimer = setTimeout(() => {
        warmupStopTimer = null;
        if (warmupActive && !overlayEl?.classList.contains('visible')) {
          console.log('[lens-flares] Hidden warmup complete');
          stopLoop();
        }
      }, 1800);
    }, 1200);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    warmupActive = false;
  }

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

export function ensureLensFlaresSkinRuntime() {
  if (setup()) return;
  const bodyObs = new MutationObserver(() => {
    if (document.getElementById('voice-satellite-ui')) {
      bodyObs.disconnect();
      setup();
    }
  });
  bodyObs.observe(document.body, { childList: true });
}

// ── Skin export ──────────────────────────────────────────────────────

export const lensFlaresSkin = {
  id: 'lens-flares',
  name: 'Lens Flares',
  css,
  reactiveBar: true,
  // Pure black backdrop so the bloom reads as pure light against void.
  overlayColor: [0, 0, 0],
  darkOverlayColor: [0, 0, 0],
  defaultOpacity: 1,
  darkDefaultOpacity: 1,
  previewCSS,
};
