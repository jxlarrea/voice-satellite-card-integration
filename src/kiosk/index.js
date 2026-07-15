/**
 * Kiosk browser integration
 *
 * Unified wrapper over the two kiosk browsers we integrate with so the
 * rest of the card never has to branch on which one is hosting it:
 *
 *   - Fully Kiosk (Android) exposes a *synchronous* `window.fully`
 *     JavaScript Interface: `window.fully.getScreenBrightness()` returns
 *     a value directly, `window.fully.setScreenBrightness(0..255)` etc.
 *
 *   - Kiosker Pro (iOS) exposes an *asynchronous* message-passing API.
 *     You send a JSON-stringified `{event, data}` to
 *     `window.webkit.messageHandlers.callback.postMessage(...)` and, if
 *     the event produces a reply, Kiosker invokes the global
 *     `kioskerCallback(data)` with the response.  There is no request id,
 *     so replies are matched to senders FIFO per event name.
 *     See https://docs.kiosker.io/#/javascript
 *
 * Differences worth knowing:
 *   - Brightness is normalised to 0..1 here.  Fully Kiosk works in
 *     0..255 internally (we scale); Kiosker is already 0..1.
 *   - "Dismiss the external screensaver" maps to FK's one-shot
 *     `stopScreensaver()`.  Kiosker has no one-shot dismiss, only a
 *     pause/resume toggle (`pauseScreenSaver {state}`), so we pause it
 *     while busy and `releaseScreensaver()` re-enables it afterwards.
 *   - Motion detection is Fully-Kiosk-only.  Kiosker has no motion event
 *     (its camera only reports an ambient-light reading), so the
 *     motion-dismiss feature simply does not apply there.
 */

// ── Detection ──────────────────────────────────────────────────────────

function fkPresent() {
  return typeof window !== 'undefined' && typeof window.fully !== 'undefined' && !!window.fully;
}

/**
 * Synchronous best-effort heuristic for "we are inside Kiosker".  Kiosker
 * registers a WKWebView message handler named `callback`; the presence of
 * that handler is the only thing we can check without a round-trip.  Use
 * `confirmAvailable()` for an authoritative answer.
 */
function kioskerPresent() {
  return typeof window !== 'undefined'
    && !!window.webkit
    && !!window.webkit.messageHandlers
    && !!window.webkit.messageHandlers.callback
    && typeof window.webkit.messageHandlers.callback.postMessage === 'function';
}

/**
 * Kiosk Satellite (Android/iOS) — our own companion app.  It injects a
 * synchronous-to-detect but *promise-based* `window.kioskSatellite` object
 * (see its docs/js-api.md).  Unlike Fully Kiosk (sync) and Kiosker (async
 * FIFO postMessage), every method returns a real promise with per-call
 * correlation, so the wrappers below are thin `await`s.  It also exposes a
 * native wake-word engine that this card can hand detection off to.
 */
function ksPresent() {
  return typeof window !== 'undefined'
    && !!window.kioskSatellite
    && window.kioskSatellite.platform === 'kiosksatellite';
}

// ── Kiosker transport ──────────────────────────────────────────────────

// event name -> queue of pending resolvers (FIFO; Kiosker replies carry
// no correlation id so the oldest waiter for an event wins its response).
const _kioskerPending = Object.create(null);

function _installKioskerCallback() {
  if (typeof window === 'undefined' || window.__vsKioskerCallbackInstalled) return;
  const prev = typeof window.kioskerCallback === 'function' ? window.kioskerCallback : null;
  window.kioskerCallback = (data) => {
    let parsed = data;
    if (typeof data === 'string') {
      try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
    }
    const ev = parsed && parsed.event;
    const queue = ev && _kioskerPending[ev];
    if (queue && queue.length) {
      const resolve = queue.shift();
      try { resolve(parsed.data); } catch (_) { /* ignore */ }
    }
    // Preserve any callback a host page (or another integration) installed.
    if (prev) { try { prev(data); } catch (_) { /* ignore */ } }
  };
  window.__vsKioskerCallbackInstalled = true;
}

/** Fire-and-forget message to Kiosker.  Returns true if it was posted. */
function _kioskerSend(event, data = {}) {
  if (!kioskerPresent()) return false;
  try {
    window.webkit.messageHandlers.callback.postMessage(JSON.stringify({ event, data }));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Send an event and resolve with the reply's `data` payload (or null on
 * timeout / failure).  Resolvers are tracked per event name and settled
 * FIFO by `kioskerCallback`.
 */
function _kioskerRequest(event, data = {}, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!kioskerPresent()) { resolve(null); return; }
    _installKioskerCallback();
    if (!_kioskerPending[event]) _kioskerPending[event] = [];

    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const resolver = (d) => settle(d);
    _kioskerPending[event].push(resolver);

    if (!_kioskerSend(event, data)) {
      // Failed to post — drop our resolver and give up.
      const i = _kioskerPending[event].indexOf(resolver);
      if (i !== -1) _kioskerPending[event].splice(i, 1);
      settle(null);
      return;
    }

    setTimeout(() => {
      const i = _kioskerPending[event].indexOf(resolver);
      if (i !== -1) _kioskerPending[event].splice(i, 1);
      settle(null);
    }, timeoutMs);
  });
}

// Kiosker's screensaver is a pause/resume toggle, not a one-shot dismiss,
// so we track whether we've paused it to avoid spamming and to know when
// to resume.
let _kioskerScreensaverPaused = false;

// Kiosk Satellite exposes both a one-shot stopScreensaver() and a
// suppress/release pauseScreensaver(paused).  We use the pause model (like
// Kiosker) so the screensaver stays off for the whole voice interaction,
// and track it to pair stop/release cleanly.
let _ksScreensaverPaused = false;
let _ksMotionHandler = null;

// ── Public API ─────────────────────────────────────────────────────────

/** True when running inside any supported kiosk browser. */
export function isAvailable() {
  return fkPresent() || kioskerPresent() || ksPresent();
}

/** 'fullykiosk' | 'kiosker' | 'kiosksatellite' | null */
export function platform() {
  if (fkPresent()) return 'fullykiosk';
  if (kioskerPresent()) return 'kiosker';
  if (ksPresent()) return 'kiosksatellite';
  return null;
}

/** Human-readable name of the detected kiosk, or null. */
export function name() {
  if (fkPresent()) return 'Fully Kiosk';
  if (kioskerPresent()) return 'Kiosker Pro';
  if (ksPresent()) return 'Kiosk Satellite';
  return null;
}

/**
 * Whether the host supports camera motion-dismiss.  Fully Kiosk (via
 * onMotion) and Kiosk Satellite (via the `kiosksatellite:motion` event);
 * Kiosker exposes no motion event.
 */
export function supportsMotion() {
  return fkPresent() || ksPresent();
}

/**
 * Authoritatively confirm the host responds to its JS interface.  Fully
 * Kiosk is synchronous (we just ping a getter).  Kiosker requires a
 * round-trip (`getUUID`) since its message handler can't be probed
 * synchronously.  Resolves true/false.
 */
export async function confirmAvailable() {
  if (fkPresent()) {
    try {
      return typeof window.fully.getScreenBrightness === 'function';
    } catch (_) {
      return false;
    }
  }
  if (kioskerPresent()) {
    const data = await _kioskerRequest('getUUID', {});
    return !!(data && data.uuid);
  }
  if (ksPresent()) {
    try {
      return !!(await window.kioskSatellite.getDeviceInfo());
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * Read the current hardware backlight level, normalised to 0..1.
 * Resolves null when unavailable.
 */
export async function getBrightness() {
  if (fkPresent()) {
    try {
      const raw = Number(window.fully.getScreenBrightness());
      if (!Number.isFinite(raw)) return null;
      return Math.min(1, Math.max(0, raw / 255));
    } catch (_) {
      return null;
    }
  }
  if (kioskerPresent()) {
    const data = await _kioskerRequest('getBrightness', {});
    const level = data && Number(data.level);
    if (!Number.isFinite(level)) return null;
    return Math.min(1, Math.max(0, level));
  }
  if (ksPresent()) {
    try {
      const level = Number(await window.kioskSatellite.getBrightness());
      if (!Number.isFinite(level)) return null;
      return Math.min(1, Math.max(0, level)); // already normalised 0..1
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Set the hardware backlight level from a normalised 0..1 value.
 * Fire-and-forget on both platforms; returns true if a command was sent.
 */
export function setBrightness(level) {
  const n = Math.min(1, Math.max(0, Number(level)));
  if (!Number.isFinite(n)) return false;
  if (fkPresent()) {
    try {
      window.fully.setScreenBrightness(Math.round(n * 255));
      return true;
    } catch (_) {
      return false;
    }
  }
  if (kioskerPresent()) {
    return _kioskerSend('setBrightness', { level: n });
  }
  if (ksPresent()) {
    try {
      window.kioskSatellite.setBrightness(n); // fire-and-forget (0..1)
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * Dismiss / suppress the kiosk's own (external) screensaver so it can't
 * cover the voice UI.  Fully Kiosk gets a one-shot stop; Kiosker gets
 * paused (and stays paused until `releaseScreensaver()`).
 */
export function stopScreensaver() {
  if (fkPresent()) {
    try {
      if (typeof window.fully.stopScreensaver === 'function') window.fully.stopScreensaver();
      return true;
    } catch (_) {
      return false;
    }
  }
  if (kioskerPresent()) {
    if (_kioskerScreensaverPaused) return true; // already paused; don't spam
    const ok = _kioskerSend('pauseScreenSaver', { state: true });
    if (ok) _kioskerScreensaverPaused = true;
    return ok;
  }
  if (ksPresent()) {
    if (_ksScreensaverPaused) return true;
    try {
      window.kioskSatellite.pauseScreensaver(true);
      _ksScreensaverPaused = true;
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * Release a previously-suppressed screensaver.  No-op on Fully Kiosk
 * (its one-shot stop has nothing to undo — FK resumes on its own idle
 * schedule); on Kiosker this re-enables the paused screensaver.
 */
export function releaseScreensaver() {
  if (kioskerPresent() && _kioskerScreensaverPaused) {
    const ok = _kioskerSend('pauseScreenSaver', { state: false });
    if (ok) _kioskerScreensaverPaused = false;
    return ok;
  }
  if (ksPresent() && _ksScreensaverPaused) {
    try {
      window.kioskSatellite.pauseScreensaver(false);
      _ksScreensaverPaused = false;
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * Bind a motion-detection callback.  Fully Kiosk only — Kiosker exposes
 * no motion event.  Returns true if bound.
 */
export function bindMotion(handlerName) {
  if (fkPresent()) {
    try {
      window.fully.bind('onMotion', `${handlerName}()`);
      return true;
    } catch (_) {
      return false;
    }
  }
  if (ksPresent()) {
    // Kiosk Satellite dispatches a DOM CustomEvent rather than string-eval
    // binding.  Bridge it to the same global-handler convention.
    try {
      if (_ksMotionHandler) {
        window.removeEventListener('kiosksatellite:motion', _ksMotionHandler);
      }
      _ksMotionHandler = () => {
        try {
          if (typeof window[handlerName] === 'function') window[handlerName]();
        } catch (_) { /* ignore */ }
      };
      window.addEventListener('kiosksatellite:motion', _ksMotionHandler);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

/** Unbind the motion-detection callback. */
export function unbindMotion() {
  if (ksPresent() && _ksMotionHandler) {
    window.removeEventListener('kiosksatellite:motion', _ksMotionHandler);
    _ksMotionHandler = null;
    return true;
  }
  if (!fkPresent()) return false;
  try {
    window.fully.bind('onMotion', '');
    return true;
  } catch (_) {
    return false;
  }
}

// ── Native wake word (Kiosk Satellite only) ────────────────────────────
//
// Kiosk Satellite runs the vsWakeWord engine natively (ONNX on the CPU)
// instead of the browser WebGPU/WASM runner, then fires a
// `kiosksatellite:wakeword` DOM event on detection.  The card hands its
// wake config to the app and consumes that event so wake-word inference
// runs in native code (dramatically faster on tablets).  These helpers are
// no-ops / null on Fully Kiosk and Kiosker, which have no native engine.

let _ksWakeHandler = null;

/** True when the host can run wake-word detection natively. */
export function supportsNativeWakeWord() {
  return ksPresent()
    && typeof window.kioskSatellite.setWakeWordConfig === 'function';
}

/**
 * Push the wake config to the native engine.  `config` is
 * `{ engine, models: [{ id, wakeWord, manifestUrl }] }`.  Resolves
 * `{ available }` — `available:false` means the app has no native runner
 * for that engine and the card should keep browser detection.
 */
export async function configureNativeWakeWord(config) {
  if (!supportsNativeWakeWord()) return { available: false };
  try {
    const res = await window.kioskSatellite.setWakeWordConfig(config);
    return { available: !!(res && res.available) };
  } catch (_) {
    return { available: false };
  }
}

/**
 * Resume (`true`) or suspend (`false`) native listening.  The card must
 * resume after a voice session returns to idle (the engine suspends itself
 * on detection).  Returns true if the command was sent.
 */
export async function setNativeWakeWordActive(active) {
  if (!ksPresent()) return false;
  try {
    await window.kioskSatellite.setWakeWordActive(!!active);
    return true;
  } catch (_) {
    return false;
  }
}

/** Current native wake-word engine state, or null. */
export async function getNativeWakeWordState() {
  if (!ksPresent()) return null;
  try {
    return await window.kioskSatellite.getWakeWordState();
  } catch (_) {
    return null;
  }
}

/**
 * Bind a handler for native wake-word detections.  `handler(detail)` is
 * called with `{ model, phrase }` when the app detects a wake word.  Only
 * one handler is active at a time.  Returns true if bound.
 */
export function bindNativeWakeWord(handler) {
  if (!ksPresent()) return false;
  unbindNativeWakeWord();
  _ksWakeHandler = (e) => {
    try {
      handler((e && e.detail) || {});
    } catch (_) { /* ignore */ }
  };
  window.addEventListener('kiosksatellite:wakeword', _ksWakeHandler);
  return true;
}

/** Unbind the native wake-word handler. */
export function unbindNativeWakeWord() {
  if (_ksWakeHandler) {
    window.removeEventListener('kiosksatellite:wakeword', _ksWakeHandler);
    _ksWakeHandler = null;
  }
}
