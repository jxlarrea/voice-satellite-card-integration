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
  if (typeof window !== 'undefined' && typeof window.fully !== 'undefined') {
    return 'fullykiosk';
  }
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

  // ── Audio ──────────────────────────────────────────────────────────
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
      if (typeof window.fully !== 'undefined') flags.push('Fully Kiosk');
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
