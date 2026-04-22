/**
 * Autoplay Policy Probe
 *
 * Runs once at bundle load, before any user interaction on this page.
 * Probes TWO independent autoplay surfaces because they don't always
 * agree:
 *
 *   - AudioContext: used by the wake-word capture path. A 'running'
 *     initial state means the browser lets capture start without a tap.
 *
 *   - HTMLAudioElement: used by the TTS and chime playback path. Some
 *     WebViews (notably the HA Companion App with "Autoplay videos"
 *     disabled) allow AudioContext to start but still block media
 *     element playback, causing silent TTS even though the mic works.
 *     Only an actual play() call tells us the real policy.
 *
 * Overall result is the weaker of the two: if either is blocked, audio
 * output will be broken from the user's perspective.
 *
 * Stored on window.__vsAutoplayProbe so the diagnostics panel (separate
 * bundle) can read it after a user click without the click itself biasing
 * the result.
 */

const WINDOW_KEY = '__vsAutoplayProbe';

// 58-byte silent WAV (0 samples). Enough of a payload to exercise the
// media pipeline and get a real play() verdict from the browser.
const SILENT_WAV = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';

export function probeAutoplay() {
  if (window[WINDOW_KEY]) return;

  const audioContext = _probeAudioContext();
  window[WINDOW_KEY] = {
    audioContext,
    mediaElement: 'probing',
    result: 'probing',
    probedAt: Date.now(),
  };

  // Media element probe is async, kick it off and reconcile once it lands.
  _probeMediaElement().then((mediaElement) => {
    const record = window[WINDOW_KEY] || {};
    record.mediaElement = mediaElement;
    record.result = _combine(audioContext, mediaElement);
    window[WINDOW_KEY] = record;
  });
}

function _probeAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return 'unsupported';
  let ctx;
  try {
    ctx = new Ctor();
  } catch (_) {
    return 'error';
  }
  const result = ctx.state === 'running' ? 'allowed' : 'disallowed';
  try {
    const closeP = ctx.close();
    if (closeP?.catch) closeP.catch(() => { /* best-effort */ });
  } catch (_) { /* best-effort */ }
  return result;
}

async function _probeMediaElement() {
  let audio;
  try {
    audio = new Audio();
  } catch (_) {
    return 'error';
  }
  // Do NOT mute: a muted probe can succeed under 'allowed-muted' policies
  // while real TTS (unmuted) is still blocked. We want the unmuted verdict.
  audio.muted = false;
  audio.volume = 1.0;
  audio.src = SILENT_WAV;
  try {
    const p = audio.play();
    if (!p || typeof p.then !== 'function') return 'unknown';
    await p;
    try { audio.pause(); } catch (_) { /* best-effort */ }
    return 'allowed';
  } catch (_) {
    return 'disallowed';
  }
}

function _combine(ac, me) {
  if (ac === 'error' || me === 'error') return 'error';
  if (ac === 'unsupported') return 'unsupported';
  if (ac === 'disallowed' || me === 'disallowed') return 'disallowed';
  if (me === 'probing') return 'probing';
  return 'allowed';
}
