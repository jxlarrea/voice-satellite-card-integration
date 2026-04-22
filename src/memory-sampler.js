/**
 * Memory Sampler
 *
 * Periodic sampling of key resource metrics to identify memory leaks.
 * Enable via URL: ?vs_diag=true  (persisted in localStorage)
 * Disable:        ?vs_diag=false
 *
 * Logs [VS][diag] every 60s with JS heap size, DOM node count,
 * and internal pool/queue sizes from the wake word engine and audio pipeline.
 *
 * Unrelated to the user-facing DiagnosticsManager in src/diagnostics/.
 * This module is a debug tool for investigating leaks over long sessions.
 */

const STORAGE_KEY = 'vs-diag-enabled';
const SAMPLE_INTERVAL = 60_000;

let _intervalId = null;
let _startHeap = null;
let _sampleCount = 0;

function isEnabled() {
  try {
    const params = new URLSearchParams(window.location.search);
    const val = params.get('vs_diag');
    if (val === 'true') {
      localStorage.setItem(STORAGE_KEY, 'true');
      return true;
    }
    if (val === 'false') {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * Start periodic diagnostic sampling if enabled.
 * @param {import('./session').VoiceSatelliteSession} session
 */
export function startDiagnostics(session) {
  if (_intervalId || !isEnabled()) return;

  // console.log('[VS][diag] Memory diagnostics enabled -- sampling every 60s');
  // console.log('[VS][diag] Disable with ?vs_diag=false');

  sample(session);
  _intervalId = setInterval(() => sample(session), SAMPLE_INTERVAL);
}

function sample(session) {
  _sampleCount++;
  const parts = [`#${_sampleCount}`];

  // JS Heap (Chromium only -- imprecise without --enable-precise-memory-info)
  const mem = performance.memory;
  if (mem) {
    const used = mem.usedJSHeapSize;
    const total = mem.totalJSHeapSize;
    if (_startHeap === null) _startHeap = used;
    const delta = used - _startHeap;
    parts.push(
      `heap=${mb(used)}/${mb(total)}MB(${delta >= 0 ? '+' : ''}${mb(delta)})`,
    );
  } else {
    parts.push('heap=N/A');
  }

  // DOM nodes
  parts.push(`dom=${document.querySelectorAll('*').length}`);

  // Registered cards
  parts.push(`cards=${session._cards?.size ?? '?'}`);

  // AudioContext state
  const ac = session.audio?._audioContext;
  parts.push(`actx=${ac ? ac.state : 'none'}`);

  // Audio pipeline buffers
  const audioBuf = session.audio?._audioBuffer;
  if (audioBuf) parts.push(`aBuf=${audioBuf.length}`);

  // Wake word engine internals
  const ww = session.wakeWord;
  if (ww) {
    parts.push(`wwPool=${ww._framePool?.length ?? '?'}`);
    parts.push(`wwQ=${ww._frameQueue?.length ?? '?'}`);
    const inf = ww._inference;
    if (inf) {
      const fe = inf._frontend;
      if (fe) parts.push(`featPool=${fe._featurePool?.length ?? '?'}`);
      parts.push(`sleeping=${inf._sleeping ? 'Y' : 'N'}`);
    }
  }

  // Chat DOM element count (should be bounded per interaction)
  const chatMsgs = document.querySelectorAll('.vs-chat-message, .vs-user-msg, .vs-assistant-msg');
  if (chatMsgs.length > 0) parts.push(`chat=${chatMsgs.length}`);

  // Timer pills
  const pills = document.querySelectorAll('.vs-timer-pill');
  if (pills.length > 0) parts.push(`pills=${pills.length}`);

  // console.log(`[VS][diag] ${parts.join(' | ')}`);
}

function mb(bytes) {
  return (bytes / 1_048_576).toFixed(1);
}
