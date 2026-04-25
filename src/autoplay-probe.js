/**
 * Autoplay Policy Probe
 *
 * Runs once at bundle load, before any user interaction on this page.
 * Probes the HTMLAudioElement playback path with an actual `play()` call
 * on a silent WAV — only the play() return value tells us the real
 * policy verdict (state-based AudioContext checks misreport in Chrome
 * because a fresh AudioContext is suspended-by-default until the first
 * gesture, even on sites where audio is fully allowed).
 *
 * Wake-word capture is intentionally NOT probed: it runs through
 * `MediaStreamSourceNode → AudioWorkletNode` with no connection to
 * `ctx.destination`, so it's not subject to autoplay restrictions and
 * works fine at page load when mic permission is granted. The original
 * AudioContext probe was conflating "can audio be played" with "can mic
 * be processed" and producing misleading results.
 *
 * Stored on window.__vsAutoplayProbe so the diagnostics panel (separate
 * bundle) can read it after a user click without the click itself
 * biasing the result.
 */

const WINDOW_KEY = '__vsAutoplayProbe';

// 58-byte silent WAV (0 samples). Enough of a payload to exercise the
// media pipeline and get a real play() verdict from the browser.
const SILENT_WAV = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';

export function probeAutoplay() {
  if (window[WINDOW_KEY]) return;

  window[WINDOW_KEY] = {
    mediaElement: 'probing',
    result: 'probing',
    probedAt: Date.now(),
  };

  _probeMediaElement().then((mediaElement) => {
    const record = window[WINDOW_KEY] || {};
    record.mediaElement = mediaElement;
    record.result = mediaElement === 'allowed' ? 'allowed'
      : mediaElement === 'disallowed' ? 'disallowed'
      : mediaElement === 'error' ? 'error'
      : 'unknown';
    window[WINDOW_KEY] = record;
  });
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
