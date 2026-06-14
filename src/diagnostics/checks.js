/**
 * Client-side diagnostics check registry.
 *
 * Each check receives { session, hass, config, entityId } and returns
 * { status, detail?, remediation? }. Status is one of
 * 'pass' | 'warn' | 'fail' | 'info' | 'skip'.
 *
 * Checks that need server state (HA config, pipeline inspection, file
 * presence) live in the Python side. See voice_satellite/run_diagnostics.
 */

import { getSelectState } from '../shared/satellite-state.js';
import * as kiosk from '../kiosk/index.js';

const WAKE_WORD_DETECTION_OWW = 'On Device (openWakeWord)';
const WAKE_WORD_DETECTION_VWW = 'On Device (vsWakeWord)';

/**
 * Probe WebGPU availability for diagnostics checks. Returns a normalized
 * shape so engine-specific checks can produce their own messaging without
 * re-implementing the detection logic.
 *
 * Mirrors the engines' acquisition logic: core adapter first, then the
 * GLES-backed compatibility tier (which unlocks devices like Android 11
 * tablets where the core Vulkan path is blocklisted).
 *
 * @returns {Promise<{ok: true, desc: string} | {ok: false, reason: 'missing'|'no-adapter'|'probe-error', error?: any}>}
 */
async function probeWebGpu() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'missing' };
  try {
    let adapter = await navigator.gpu.requestAdapter();
    let tier = '';
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
        if (adapter) tier = ' (compatibility tier)';
      } catch (_e) { /* option unsupported - treat as null */ }
    }
    if (!adapter) return { ok: false, reason: 'no-adapter' };
    const info = adapter.info || {};
    const desc = ([info.vendor, info.architecture].filter(Boolean).join(' / ') || 'adapter available') + tier;
    return { ok: true, desc };
  } catch (err) {
    return { ok: false, reason: 'probe-error', error: err };
  }
}

const CATEGORY = {
  ENVIRONMENT: 'Browser environment',
  FRONTEND: 'Voice Satellite bundle',
  SATELLITE: 'Satellite configuration',
  AUDIO: 'Audio',
  PLATFORM: 'Platform',
};

/**
 * Classify the runtime container so remediation text can point at the
 * right setting. The same symptom (e.g. mic denied, audio blocked) has
 * very different fixes across these three hosts.
 */
function detectPlatform() {
  const kioskPlatform = kiosk.platform();
  if (kioskPlatform) return kioskPlatform; // 'fullykiosk' | 'kiosker'
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Home Assistant\//.test(ua) || /HomeAssistant\//.test(ua)) return 'companion';
  return 'browser';
}

/**
 * The HA Companion App's "Autoplay videos" toggle controls BOTH media
 * element playback AND microphone capture, so several checks point at
 * the same Companion-App setting. Fully Kiosk splits those into two
 * Web Content Settings toggles. Plain browsers route through site
 * settings (and for mic, a permission prompt triggered by a gesture).
 */
const PLATFORM_FIX = {
  companion: {
    audio: 'Open the Home Assistant Companion app → Settings → Companion App → enable "Autoplay videos". This single toggle controls both audio playback and microphone capture.',
    micPrompt: 'Open the Home Assistant Companion app → Settings → Companion App → enable "Autoplay videos". This single toggle grants both microphone access and audio playback.',
    micDenied: 'Home Assistant Companion app → Settings → Companion App → enable "Autoplay videos". Also confirm the Android app permissions for Home Assistant include Microphone.',
  },
  fullykiosk: {
    audio: 'Fully Kiosk → Web Content Settings → enable "Autoplay Audio". Also make sure "Enable JavaScript Interface" is on if you use the screensaver.',
    micPrompt: 'Fully Kiosk → Web Content Settings → enable "Enable Microphone Access". Tapping the start button once after enabling will finalize the permission.',
    micDenied: 'Fully Kiosk → Web Content Settings → enable "Enable Microphone Access". Also confirm the Android app permissions for Fully Kiosk include Microphone.',
  },
  kiosker: {
    audio: 'Kiosker → Settings → enable inline media playback / autoplay. Also make sure Settings → Security → "Allow JavaScript integration" is on if you use the screensaver.',
    micPrompt: 'Kiosker → Settings → Security → "Camera and microphone permission" → set to "Allow". The default "Prompt" asks on every page load; "Allow" grants it silently.',
    micDenied: 'Kiosker → Settings → Security → "Camera and microphone permission" → set to "Allow", and confirm iOS Settings → Kiosker → Microphone is enabled. Reload the page afterwards.',
  },
  browser: {
    audio: 'In Chrome/Edge: click the lock icon → Site settings → Sound: Allow. In Safari: Settings → Websites → Auto-Play → Allow All Auto-Play for this site.',
    micPrompt: 'Tap the start button in the overlay. The browser will prompt for microphone permission the first time a user gesture triggers capture.',
    micDenied: 'Open the browser site settings (Chrome/Edge: lock icon → Site settings → Microphone: Allow) and reload the page.',
  },
};

function fixFor(bucket) {
  const p = detectPlatform();
  return PLATFORM_FIX[p][bucket];
}

export const CLIENT_CHECKS = [
  // ── Browser environment ────────────────────────────────────────────
  {
    id: 'env.secure-context',
    category: CATEGORY.ENVIRONMENT,
    title: 'Secure context (HTTPS or localhost)',
    run: async () => {
      if (window.isSecureContext) {
        return { status: 'pass', detail: `Page is served securely (${window.location.protocol})` };
      }
      return {
        status: 'fail',
        detail: `Page is not in a secure context (${window.location.protocol}). Browsers block microphone access outside HTTPS or localhost.`,
        remediation: 'Serve Home Assistant over HTTPS (Nabu Casa, a reverse proxy, or the Let\'s Encrypt add-on). A self-signed certificate is enough for testing.',
      };
    },
  },
  {
    id: 'env.media-devices',
    category: CATEGORY.ENVIRONMENT,
    title: 'navigator.mediaDevices.getUserMedia available',
    run: async () => {
      if (navigator.mediaDevices?.getUserMedia) {
        return { status: 'pass' };
      }
      return {
        status: 'fail',
        detail: 'navigator.mediaDevices is undefined. The browser will not allow microphone capture.',
        remediation: 'Almost always a non-secure-context problem. Confirm the page is HTTPS and the URL matches the certificate.',
      };
    },
  },
  {
    id: 'env.audio-context',
    category: CATEGORY.ENVIRONMENT,
    title: 'AudioContext available',
    run: async () => {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) return { status: 'pass' };
      return {
        status: 'fail',
        detail: 'AudioContext is not available in this browser.',
        remediation: 'Use a current version of Chrome, Edge, Firefox, or Safari.',
      };
    },
  },
  {
    id: 'env.permissions-policy-microphone',
    category: CATEGORY.ENVIRONMENT,
    title: 'Permissions-Policy allows microphone',
    run: async () => {
      const policy = document.featurePolicy || document.permissionsPolicy;
      if (!policy?.allowsFeature) {
        return { status: 'skip', detail: 'Browser does not expose Permissions-Policy inspection.' };
      }
      if (policy.allowsFeature('microphone')) {
        return { status: 'pass' };
      }
      return {
        status: 'fail',
        detail: 'A Permissions-Policy response header blocks microphone access on this page.',
        remediation: 'If you use a reverse proxy, update its Permissions-Policy to include "microphone=self". Example: Permissions-Policy "geolocation=self, microphone=self, camera=(), payment=(), usb=()".',
      };
    },
  },
  {
    id: 'env.permissions-policy-autoplay',
    category: CATEGORY.ENVIRONMENT,
    title: 'Permissions-Policy allows autoplay',
    run: async () => {
      const policy = document.featurePolicy || document.permissionsPolicy;
      if (!policy?.allowsFeature) return { status: 'skip' };
      if (policy.allowsFeature('autoplay')) return { status: 'pass' };
      return {
        status: 'warn',
        detail: 'Autoplay is blocked by Permissions-Policy. Chimes and TTS may require a user tap each session.',
        remediation: 'Add "autoplay=self" to your reverse proxy Permissions-Policy header.',
      };
    },
  },
  {
    id: 'env.microphone-permission',
    category: CATEGORY.ENVIRONMENT,
    title: 'Microphone permission granted',
    run: async () => {
      // Primary signal: enumerateDevices() only populates audio-input
      // `label` fields after the origin has been granted mic access at
      // some point. This is reliable across Chrome, Safari, and (critically)
      // the HA Companion App's Android WebView, where
      // navigator.permissions.query returns 'prompt' even when mic capture
      // is actively working.
      if (navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasLabel = devices.some(
            (d) => d.kind === 'audioinput' && d.label,
          );
          if (hasLabel) {
            return { status: 'pass', detail: 'Microphone has been authorized for this origin.' };
          }
        } catch (_) { /* fall through to Permissions API */ }
      }

      // Secondary signal: the Permissions API. Accurate on desktop browsers
      // but unreliable on WebViews, so treat anything other than 'denied' as
      // a warn (not a fail), since the user may not have exercised the mic
      // yet on this page.
      if (!navigator.permissions?.query) {
        return { status: 'skip', detail: 'Browser does not expose Permissions API and no labeled input devices are visible yet.' };
      }
      try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        if (result.state === 'granted') {
          return { status: 'pass' };
        }
        if (result.state === 'denied') {
          return {
            status: 'fail',
            detail: 'Microphone permission is denied for this origin.',
            remediation: fixFor('micDenied'),
          };
        }
        // 'prompt' or other is uncertain. In the Companion App this is the
        // default reply even when the mic actually works; surface that
        // caveat in the detail so the user knows to try the engine first.
        return {
          status: 'warn',
          detail: 'Microphone permission has not been exercised yet on this page. If the engine has not been started since the last page load, audio input devices will not report labels and this check cannot confirm access.',
          remediation: fixFor('micPrompt'),
        };
      } catch (_) {
        return { status: 'skip', detail: 'Microphone permission query not supported.' };
      }
    },
  },
  {
    id: 'env.audio-input-devices',
    category: CATEGORY.ENVIRONMENT,
    title: 'At least one audio input device',
    run: async () => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        return { status: 'skip' };
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        if (inputs.length === 0) {
          return {
            status: 'fail',
            detail: 'No audio input devices are visible to the browser.',
            remediation: 'Check that a microphone is connected and that the operating system exposes it to the browser.',
          };
        }
        return { status: 'pass', detail: `${inputs.length} input device(s) detected.` };
      } catch (err) {
        return { status: 'warn', detail: `enumerateDevices failed: ${err?.message || err}` };
      }
    },
  },
  {
    id: 'env.localstorage',
    category: CATEGORY.ENVIRONMENT,
    title: 'localStorage available',
    run: async () => {
      try {
        const k = '__vs_diag_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return { status: 'pass' };
      } catch (_) {
        return {
          status: 'warn',
          detail: 'localStorage is not writable. Panel settings and the selected satellite will not persist across reloads.',
          remediation: 'Disable private browsing or lift any storage restrictions on this origin.',
        };
      }
    },
  },

  // ── Voice Satellite bundle ─────────────────────────────────────────
  {
    id: 'front.bundle-loaded',
    category: CATEGORY.FRONTEND,
    title: 'Voice Satellite overlay bundle loaded on this page',
    run: async () => {
      // The main bundle registers the voice-satellite-card element during
      // startup; its presence proves the overlay engine is running on this
      // page. The element hosts the full-screen overlay, not a Lovelace card.
      if (customElements.get('voice-satellite-card')) {
        return { status: 'pass' };
      }
      return {
        status: 'fail',
        detail: 'The Voice Satellite overlay JS is not running on this page.',
        remediation: 'Clear the browser cache and reload. If the problem persists, check Settings → Dashboards → Resources for outdated or duplicate entries (for example from the archived standalone card repository).',
      };
    },
  },

  // ── Satellite configuration ────────────────────────────────────────
  {
    id: 'sat.entity-selected',
    category: CATEGORY.SATELLITE,
    title: 'Satellite entity selected',
    run: async ({ entityId }) => {
      if (entityId) return { status: 'pass', detail: entityId };
      return {
        status: 'fail',
        detail: 'No satellite entity is selected for this browser.',
        remediation: 'Pick a satellite in the Satellite entity card above.',
      };
    },
  },
  {
    id: 'sat.entity-exists',
    category: CATEGORY.SATELLITE,
    title: 'Selected entity exists in Home Assistant',
    run: async ({ hass, entityId }) => {
      if (!entityId) return { status: 'skip' };
      if (!hass?.states) return { status: 'skip', detail: 'Home Assistant state cache is not ready yet.' };
      if (hass.states[entityId]) return { status: 'pass' };
      return {
        status: 'fail',
        detail: `Entity ${entityId} is not present in Home Assistant.`,
        remediation: 'Add the device in Settings → Devices & Services → Voice Satellite, then re-select it here.',
      };
    },
  },
  {
    // Conditional check: only runs when the satellite is set to On Device
    // (openWakeWord).  OWW's mel + embedding stages are dispatched as
    // WebGPU compute shaders; on a device without `navigator.gpu` the
    // engine refuses to start at all and the satellite shows an error
    // toast instead of detecting wake words.  Surface that here so users
    // running diagnostics can see the cause before they hit it live.
    id: 'sat.openwakeword-webgpu',
    category: CATEGORY.SATELLITE,
    title: 'openWakeWord can use WebGPU on this device',
    run: async ({ hass, entityId }) => {
      if (!entityId) return { status: 'skip' };
      const mode = getSelectState(hass, entityId, 'wake_word_detection', '');
      if (mode !== WAKE_WORD_DETECTION_OWW) {
        return { status: 'skip', detail: `This check only applies when wake word detection is "${WAKE_WORD_DETECTION_OWW}". Active mode is "${mode || 'unknown'}".` };
      }
      const probe = await probeWebGpu();
      if (probe.ok) return { status: 'pass', detail: `WebGPU adapter present (${probe.desc}).` };
      if (probe.reason === 'missing') {
        return {
          status: 'fail',
          detail: 'navigator.gpu is not exposed on this device. openWakeWord cannot start without WebGPU.',
          remediation: 'Switch "Wake word detection" to "On Device (microWakeWord)" on the satellite\'s device page. microWakeWord runs on CPU and works without WebGPU.',
        };
      }
      if (probe.reason === 'no-adapter') {
        return {
          status: 'fail',
          detail: 'navigator.gpu is exposed but requestAdapter() returned null for both the core and compatibility tiers — the system has no usable GPU adapter for WebGPU.',
          remediation: 'Switch "Wake word detection" to "On Device (microWakeWord)". On Android, ensure the WebView is up to date; on Linux, WebGPU requires a recent Chromium build with hardware acceleration enabled.',
        };
      }
      return {
        status: 'warn',
        detail: `WebGPU adapter probe failed: ${probe.error?.message || probe.error}. openWakeWord may fail to start.`,
        remediation: 'Switch to "On Device (microWakeWord)" if openWakeWord does not start when the satellite is loaded.',
      };
    },
  },
  {
    // Conditional check: only runs when the satellite is set to On Device
    // (vsWakeWord).  VWW's phoneme decoder runs as a WebGPU CNN; same
    // hard requirement as OWW - on a device without `navigator.gpu` the
    // engine refuses to start.  Surface it in diagnostics so users running
    // VWW (the recommended engine on WebGPU-capable tablets) can see the
    // cause before hitting it live.
    id: 'sat.vswakeword-webgpu',
    category: CATEGORY.SATELLITE,
    title: 'vsWakeWord can use WebGPU on this device',
    run: async ({ hass, entityId }) => {
      if (!entityId) return { status: 'skip' };
      const mode = getSelectState(hass, entityId, 'wake_word_detection', '');
      if (mode !== WAKE_WORD_DETECTION_VWW) {
        return { status: 'skip', detail: `This check only applies when wake word detection is "${WAKE_WORD_DETECTION_VWW}". Active mode is "${mode || 'unknown'}".` };
      }
      const probe = await probeWebGpu();
      if (probe.ok) {
        // VWW's conv path is int8-only (dot4I8Packed); the engine HARD-requires
        // the packed_4x8_integer_dot_product WGSL feature and refuses to start
        // without it (device.js throws on acquire). Surface it here so a device
        // that HAS WebGPU but lacks native int8 dot is diagnosable up front.
        const int8 = !!(navigator.gpu?.wgslLanguageFeatures?.has?.('packed_4x8_integer_dot_product'));
        if (!int8) {
          return {
            status: 'fail',
            detail: `WebGPU adapter present (${probe.desc}), but the GPU lacks the packed_4x8_integer_dot_product WGSL feature (native int8 dot product). vsWakeWord's conv path is int8-only and refuses to start on this device.`,
            remediation: 'Switch "Wake word detection" to "On Device (microWakeWord)". This device\'s GPU is too limited for vsWakeWord; microWakeWord runs on CPU.',
          };
        }
        return { status: 'pass', detail: `WebGPU adapter present (${probe.desc}); packed_4x8_integer_dot_product (int8) supported.` };
      }
      if (probe.reason === 'missing') {
        return {
          status: 'fail',
          detail: 'navigator.gpu is not exposed on this device. vsWakeWord cannot start without WebGPU.',
          remediation: 'Switch "Wake word detection" to "On Device (microWakeWord)" on the satellite\'s device page. microWakeWord runs on CPU and works without WebGPU.',
        };
      }
      if (probe.reason === 'no-adapter') {
        return {
          status: 'fail',
          detail: 'navigator.gpu is exposed but requestAdapter() returned null for both the core and compatibility tiers — the system has no usable GPU adapter for WebGPU.',
          remediation: 'Switch "Wake word detection" to "On Device (microWakeWord)". On Android, ensure the WebView is up to date; on Linux, WebGPU requires a recent Chromium build with hardware acceleration enabled.',
        };
      }
      return {
        status: 'warn',
        detail: `WebGPU adapter probe failed: ${probe.error?.message || probe.error}. vsWakeWord may fail to start.`,
        remediation: 'Switch to "On Device (microWakeWord)" if vsWakeWord does not start when the satellite is loaded.',
      };
    },
  },

  // ── Audio ──────────────────────────────────────────────────────────
  {
    id: 'sat.vswakeword-last-startup',
    category: CATEGORY.SATELLITE,
    title: 'Previous vsWakeWord startup completed',
    run: async () => {
      let raw = null;
      try { raw = localStorage.getItem('__vs_vww_startup_breadcrumb__'); } catch (_) {}
      if (!raw) return { status: 'pass', detail: 'No incomplete vsWakeWord startup checkpoint is stored.' };
      try {
        const b = JSON.parse(raw);
        const d = b?.detail || {};
        const parts = [`phase=${b?.phase || 'unknown'}`];
        if (d.model) parts.push(`model=${d.model}`);
        if (d.opIndex !== undefined) parts.push(`op=${d.opIndex}:${d.opName || '?'}`);
        if (d.label) parts.push(`label=${d.label}`);
        if (d.method) parts.push(`method=${d.method}`);
        return {
          status: 'warn',
          detail: `The previous vsWakeWord startup did not clear its checkpoint (${parts.join(' ')}). If Fully Kiosk crashed, this is the last recorded step before the crash.`,
        };
      } catch (_) {
        return {
          status: 'warn',
          detail: `The previous vsWakeWord startup left an unreadable checkpoint: ${raw}`,
        };
      }
    },
  },
  {
    id: 'audio.autoplay-policy',
    category: CATEGORY.AUDIO,
    title: 'Audio can play without a user tap',
    run: async () => {
      // Read the page-load probe (autoplay-probe.js). It tested
      // HTMLAudioElement playback with a real `play()` call, which is
      // the only path actually subject to the browser's autoplay policy
      // for sound output (TTS responses + chimes).
      //
      // Wake-word capture is NOT probed because it runs through
      // MediaStreamSourceNode + AudioWorkletNode with no connection to
      // ctx.destination, so it's not subject to autoplay restrictions
      // and works at page load when mic permission is granted.
      //
      // The probe MUST come from page-load — the question is whether
      // audio works without a gesture, so re-probing here would be
      // self-defeating (the diagnostics click is itself a gesture).
      const probe = window.__vsAutoplayProbe;
      const allowedDetail = 'TTS and chimes start immediately. Users do not need to tap on each page load.';
      const remediation = fixFor('audio');

      const resolved = await _awaitProbe(probe);

      if (!resolved || resolved.result === 'probing') {
        return { status: 'skip', detail: 'Autoplay probe did not complete.' };
      }

      if (resolved.mediaElement === 'allowed') {
        return { status: 'pass', detail: allowedDetail };
      }

      if (resolved.mediaElement === 'disallowed') {
        return {
          status: 'warn',
          detail: 'At page load, TTS and chime playback was blocked by the browser autoplay policy. Users must tap the start button once per page load for chimes and TTS responses to play.',
          remediation,
        };
      }

      if (resolved.mediaElement === 'error') {
        return {
          status: 'fail',
          detail: 'The browser could not create an Audio element. TTS playback will not work here.',
        };
      }

      return { status: 'skip', detail: 'Autoplay state could not be determined in this browser.' };
    },
  },

  // ── Platform-specific ──────────────────────────────────────────────
  {
    id: 'platform.detected',
    category: CATEGORY.PLATFORM,
    title: 'Display environment',
    run: async () => {
      const ua = navigator.userAgent || '';
      const flags = [];
      const kioskName = kiosk.name();
      if (kioskName) flags.push(kioskName);
      if (/Home Assistant\//.test(ua) || /HomeAssistant\//.test(ua)) flags.push('Companion App');
      if (/CrOS/.test(ua)) flags.push('ChromeOS');
      if (/iPhone|iPad|iPod/.test(ua)) flags.push('iOS');
      if (/SM-X11|SM-X21|Galaxy Tab A9/.test(ua)) flags.push('Samsung Galaxy Tab A9');
      const label = flags.length ? flags.join(', ') : 'Standard desktop/mobile browser';
      return { status: 'info', detail: label };
    },
  },
  {
    id: 'platform.fully-kiosk-js-interface',
    category: CATEGORY.PLATFORM,
    title: 'Fully Kiosk JavaScript Interface',
    run: async () => {
      if (typeof window.fully === 'undefined') {
        return { status: 'skip', detail: 'Not running inside Fully Kiosk Browser.' };
      }
      try {
        if (typeof window.fully.getScreenBrightness === 'function') {
          window.fully.getScreenBrightness();
          return { status: 'pass', detail: 'Fully Kiosk JS Interface responds.' };
        }
      } catch (_) { /* fall through */ }
      return {
        status: 'warn',
        detail: 'Fully Kiosk detected but the JavaScript Interface is not enabled.',
        remediation: 'Fully Kiosk → Settings → Advanced Web Settings → Enable JavaScript Interface.',
      };
    },
  },
  {
    id: 'platform.kiosker-js-interface',
    category: CATEGORY.PLATFORM,
    title: 'Kiosker JavaScript Integration',
    run: async () => {
      if (detectPlatform() !== 'kiosker') {
        return { status: 'skip', detail: 'Not running inside Kiosker Pro.' };
      }
      // Kiosker's message handler can't be probed synchronously; a
      // successful getUUID round-trip confirms the integration responds.
      const responds = await kiosk.confirmAvailable();
      if (responds) {
        return { status: 'pass', detail: 'Kiosker JavaScript Integration responds.' };
      }
      return {
        status: 'warn',
        detail: 'Kiosker detected but the JavaScript Integration did not respond.',
        remediation: 'Kiosker → Settings → Allow JavaScript Integration.',
      };
    },
  },
  {
    id: 'platform.companion-autoplay-hint',
    category: CATEGORY.PLATFORM,
    title: 'Home Assistant Companion autoplay',
    run: async () => {
      if (detectPlatform() !== 'companion') return { status: 'skip' };
      return {
        status: 'info',
        detail: 'Running in the Home Assistant Companion App.',
        remediation: 'If chimes or TTS do not play, or the microphone does not activate, enable Settings → Companion App → Autoplay videos.',
      };
    },
  },
];

/**
 * The autoplay probe's media-element test is async (it awaits an actual
 * HTMLAudioElement.play() resolution). At module load the probe seeds
 * window.__vsAutoplayProbe with { result: 'probing' } and later updates
 * it. Give the probe a short window to finalize before falling back.
 */
async function _awaitProbe(initial) {
  if (!initial) return window.__vsAutoplayProbe || null;
  if (initial.result !== 'probing') return initial;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const current = window.__vsAutoplayProbe;
    if (current && current.result !== 'probing') return current;
  }
  return window.__vsAutoplayProbe || initial;
}
