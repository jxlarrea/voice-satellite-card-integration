/**
 * WakeWordManager
 *
 * Orchestrates on-device wake word detection using microWakeWord
 * and a custom in-browser model runner. Processes 16kHz audio through
 * a micro_frontend feature extractor and runs a wake word model with sliding
 * window detection.
 */

import { State, BlurReason, INTERACTING_STATES } from '../constants.js';
import { getSwitchState, getSelectState } from '../shared/satellite-state.js';
import { CHIME_WAKE, getChimeDuration } from '../audio/chime.js';
import { loadTFLite, getMicroModelParams, resetRuntime } from './micro-models.js';
import { getVwwModelParams, loadVwwModelParams } from './vww/manifest-cache.js';
import { WorkerProxyBackend } from './worker/proxy-backend.js';
import { clearNotificationUI } from '../shared/satellite-notification.js';
import { sendAck } from '../shared/notification-comms.js';
import * as kiosk from '../kiosk/index.js';

// Detection-mode select values that need parsing in several places.
// "On Device" (legacy) is treated as microWakeWord for backwards compat.
const DETECTION_MODE_LEGACY_LOCAL = 'On Device';
const DETECTION_MODE_LOCAL_MWW = 'On Device (microWakeWord)';
const DETECTION_MODE_LOCAL_OWW = 'On Device (openWakeWord)';
const DETECTION_MODE_LOCAL_VWW = 'On Device (vsWakeWord)';

const CHUNK_SIZE = 1280; // 80ms @ 16kHz
const MAX_POOL = 20;    // cap recycled frame pool (20 * 5KB = 100KB max)

// Detect constrained WebView (Fully Kiosk, Android WebView) - load
// delay applied at the start of wake-word.start() to avoid OOM during
// dashboard load on memory-tight tablets.  Moved here from
// session/events.js so it applies regardless of which call path invoked
// start() (startListening, _checkWakeWordActivation, settings change).
function isConstrainedWebView() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Fully Kiosk/i.test(ua) || /\bwv\b/i.test(ua);
}

// Per-engine stop-classifier model name.  OWW/MWW use the hardcoded
// name 'stop' (their stop classifier ships under that exact filename).
// VWW uses 'ok_stop' since each VWW model is a self-contained ONNX
// named after its wake phrase; the stop-classifier ONNX is
// vswakeword/ok_stop.onnx and the manifest carries stop_classifier:
// true so the VWW backend gives it the same immediate-fire treatment
// as OWW's 'stop'.
const VWW_STOP_NAME = 'ok_stop';
function getStopName(engine) {
  return engine === 'vww' ? VWW_STOP_NAME : 'stop';
}
// True for any classifier name that the runtime treats as the
// stop-word slot: 'stop' (OWW/MWW) or 'ok_stop' (VWW).  Used for
// per-name special-casing (threshold table, sensitivity factor table,
// detection-result routing) without needing manifest access at those
// sites.  Keep in sync with VWW backend's manifest.stop_classifier
// detection - they're two views of the same concept.
function isStopModelName(name) {
  return name === 'stop' || name === VWW_STOP_NAME;
}

function formatWakeRuntimeStatus(result) {
  const status = result?.runtime?.[result.model];
  if (!status || status.mode !== 'counter') return [];
  const bits = [];
  if (Number.isFinite(status.hits) && Number.isFinite(status.requiredHits)) {
    bits.push(`runtime_hits=${status.hits}/${status.requiredHits}`);
  }
  if (Number.isInteger(status.matchedTargetIndex) && status.matchedTargetIndex >= 0) {
    bits.push(`runtime_target=${status.matchedTargetIndex + 1}`);
  }
  if (Number.isInteger(status.matchedTargetGroupIndex) && status.matchedTargetGroupIndex >= 0) {
    bits.push(`runtime_group=${status.matchedTargetGroupIndex + 1}`);
  }
  if (typeof status.highConfidenceBypass === 'number' && Number.isFinite(status.highConfidenceBypass)) {
    bits.push(`runtime_bypass=${status.highConfidenceBypass.toFixed(2)}`);
  }
  if (
    Number.isFinite(status.highConfidenceBypassMinHits)
    && Number.isFinite(status.hits)
    && status.highConfidence === true
  ) {
    bits.push(`runtime_bypass_hits=${status.hits}/${status.highConfidenceBypassMinHits}`);
  }
  if (status.bypassed === true) bits.push('runtime_bypassed=true');
  if (status.grouped === true) bits.push('runtime_grouped=true');
  if (status.cnnSequenceGate === true) {
    const prefix = Number(status.cnnPrefixScore);
    const completion = Number(status.cnnCompletionScore);
    if (Number.isFinite(prefix)) bits.push(`cnn_prefix=${prefix.toFixed(3)}`);
    if (Number.isFinite(completion)) bits.push(`cnn_completion=${completion.toFixed(3)}`);
    if (status.cnnSequencePassed === false) bits.push('cnn_sequence=blocked');
    else if (status.cnnSequencePassed === true) bits.push('cnn_sequence=passed');
  }
  return bits;
}

// Window between local wake word detection and the wake chime firing.
// We keep the chime pending for this long so HA has a chance to send
// duplicate_wake_up_detected first - if it does, we cancel the chime
// and the losing tablet stays silent. Local HA round trip is typically
// 25-100ms; 250ms gives a comfortable margin without making the chime
// feel laggy on the winning tablet (the user was waiting for the chime
// to finish anyway, so 250ms of "silence then chime" feels equivalent
// to "chime then silence").
const WAKE_DEDUPE_WINDOW_MS = 250;

// ─── Detection thresholds ────────────────────────────────────────────
// microWakeWord models output confidence scores (0-1 via uint8/255).
// Detection uses sliding window mean > cutoff. The base cutoff comes from
// the model's companion JSON manifest (or hardcoded fallback in micro-models.js).
// Sensitivity scales the detection margin (1 - baseCutoff):
//   effective = 1 - (1 - baseCutoff) * factor
//   Slightly sensitive = smaller margin (harder to trigger)
//   Moderately sensitive = base cutoff as-is
//   Very sensitive = larger margin (easier to trigger)
const SENSITIVITY_MARGIN_FACTORS = {
  'Slightly sensitive': 0.5,
  'Moderately sensitive': 1.0,
  'Very sensitive': 2.0,
};
// The stop model has a much lower base cutoff (~0.5) than wake words (~0.95),
// so the wake-word factors produce extreme swings (clamps to 0.1 on Very, jumps
// to 0.75 on Slightly). Use gentler factors for stop to keep variation symmetric
// and meaningful around its base cutoff.
const STOP_SENSITIVITY_FACTORS = {
  'Slightly sensitive': 0.8,
  'Moderately sensitive': 1.0,
  'Very sensitive': 1.2,
};
// openWakeWord uses absolute offsets from the calibrated upstream cutoff
// (0.5 wake / 0.65 stop) instead of the MWW margin-multiplier model.  The
// MWW factors were tuned for cutoffs in the 0.85-0.97 range; reusing them
// for OWW's much lower 0.5 cutoff produces extreme swings (0.1 - 0.75).
// Wake words use ±0.10 - "Very sensitive" stops at 0.4 to avoid firing on
// outputs the OWW classifier is itself uncertain about (sigmoid calibrated
// around 0.5).  Stop uses gentler ±0.05 since its 0.65 base is already a
// noisier band and small swings matter more there.
const OWW_WAKE_SENSITIVITY_OFFSETS = {
  'Slightly sensitive':  0.10,   // raises cutoff to 0.6 (harder to trigger)
  'Moderately sensitive': 0.00,
  'Very sensitive':      -0.10,  // lowers cutoff to 0.4 (easier to trigger)
};
const OWW_STOP_SENSITIVITY_OFFSETS = {
  'Slightly sensitive':  0.05,
  'Moderately sensitive': 0.00,
  'Very sensitive':      -0.05,
};
const DEFAULT_CUTOFF = 0.90;

// Wake word phrases matching microWakeWord conventions.
// DATA_LAST_WAKE_UP in HA core uses these exact strings for dedup.
const WAKE_WORD_PHRASES = {
  ok_nabu: 'Okay Nabu',
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  hey_home_assistant: 'Hey Home Assistant',
  hey_luna: 'Hey Luna',
  okay_computer: 'Okay Computer',
};

/**
 * Module-level wake-word phrase lookup (same table WakeWordManager uses),
 * exported so the Kiosk Satellite native-wake handoff can label the models
 * it pushes to the app without instantiating a manager.
 * @param {string} name
 * @returns {string}
 */
export function wakeWordPhraseFor(name) {
  return WAKE_WORD_PHRASES[name]
    || name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export class WakeWordManager {
  constructor(session) {
    this._session = session;
    this._log = session.logger;

    this._inference = null;
    this._active = false;
    this._sampleBuf = new Float32Array(CHUNK_SIZE * 2);
    this._sampleBufLen = 0;
    this._framePool = []; // recycled Float32Array buffers to avoid allocation
    this._loadedModelsKey = null; // sorted model names string for change detection
    this._processing = false;
    this._frameQueue = [];
    this._streamResetPending = false;

    // Runtime compatibility token (cached)
    this._tfweb = null;

    // Stop word state
    this._stopOnlyMode = false;
    this._stopMicroConfig = null;
    this._suspendedKeywords = null;

    // Playback-suspend state (TTS / chime / notification audio).  When
    // the speaker is producing output, wake-word inference must be
    // halted - AEC scrubs most of it from the mic but enough residual
    // bleeds through to score 0.8+ on the wake classifier.  Persists
    // across pipeline.restart() cycles so the new backend created at
    // tts-end starts suspended and can't self-trigger.
    //
    // Refcounted: each speaker source (TTS, each chime) calls suspend
    // on start and resume on completion.  Overlapping sources (e.g.
    // TTS + done chime, two chimes back-to-back) don't unsuspend
    // prematurely.  Only flips state on the 0↔1 transition.
    this._playbackSuspendCount = 0;
    // Native handoff: we disarmed Kiosk Satellite's wake word for a stop-only
    // state and owe it a re-arm when that state ends.
    this._nativeWakeSuspendedForStopOnly = false;
    this._suspendedActiveBeforePlayback = null;

    // Settings change tracking
    this._cachedEnabled = undefined;
    this._cachedModel = undefined;
    this._cachedThreshold = undefined;
    this._cachedStopWord = undefined;
    this._switching = false;

    // Cross-tablet wake word dedupe state. When the local micro_frontend
    // detects a wake word, we mute the mic and schedule the wake chime
    // for WAKE_DEDUPE_WINDOW_MS later instead of playing it immediately,
    // so the pipeline error handler has time to cancel it on a
    // duplicate_wake_up_detected from HA.
    this._pendingChimeHandle = null;
    this._pendingUnmuteHandle = null;
    this._pendingWakeActivatedAt = 0;

    this._resetting = false;

  }

  /** True when actively listening for wake words. */
  get active() { return this._active; }

  /** True when running stop-only inference (during TTS/notification playback). */
  get stopOnlyMode() { return this._stopOnlyMode; }

  /** True while TTS/chime playback holds detection suspended (refcounted). */
  get isPlaybackSuspended() { return this._playbackSuspendCount > 0; }

  /**
   * True while something is deliberately holding the native wake word
   * disarmed: speaker playback, or a stop-only state (TTS, an announcement)
   * where only the stop classifier should be listening. The single gate every
   * would-be re-armer has to consult, since they fire on their own schedules
   * (the pipeline goes idle when TTS *starts*, not when it ends).
   */
  get isNativeWakeSuspended() {
    return this._playbackSuspendCount > 0
      || this._nativeWakeSuspendedForStopOnly === true;
  }

  /**
   * Re-arm the native wake word, but only once nothing is still holding it
   * disarmed. Playback and stop-only overlap and end in either order (TTS ends
   * the stop state and its own playback at nearly the same instant), so each
   * holder clears its own flag and calls this; whoever is last actually arms.
   */
  _maybeRearmNativeWake() {
    if (!this._session._nativeWakeActive) return;
    if (this.isNativeWakeSuspended) return;
    kiosk.setNativeWakeWordActive(true);
  }

  /**
   * Read the current wake word detection mode select.
   * @returns {string} One of 'Home Assistant', 'Disabled', the new
   *   'On Device (microWakeWord)' / 'On Device (openWakeWord)', or the
   *   legacy 'On Device' (treated as microWakeWord throughout).
   */
  _wakeMode() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_detection',
      'Home Assistant',
    );
  }

  /**
   * Resolve the wake-word engine.  Returns null for HA / Disabled so
   * callers can early-out without engine-specific logic.
   * @returns {'mww'|'oww'|'vww'|null}
   */
  getEngine() {
    // Kiosk Satellite is running wake detection natively - the browser must
    // not load a wake engine of its own (stop-word standby may still run,
    // since needsLocalInference() also checks isStopWordEnabled()).
    if (this._session._nativeWakeActive) return null;
    const mode = this._wakeMode();
    if (mode === DETECTION_MODE_LOCAL_OWW) return 'oww';
    if (mode === DETECTION_MODE_LOCAL_VWW) return 'vww';
    if (mode === DETECTION_MODE_LOCAL_MWW || mode === DETECTION_MODE_LEGACY_LOCAL) return 'mww';
    return null;
  }

  /**
   * True when on-device wake word inference is the primary listening mode.
   * Wake-word models load and run continuously in this mode.
   * @returns {boolean}
   */
  isOnDeviceWakeEnabled() {
    return this.getEngine() !== null;
  }

  /**
   * True whenever the local inference subsystem is needed at all. Covers
   * three cases:
   *  - On-device wake word mode (continuous inference).
   *  - Home Assistant wake word mode + stop-word switch on (runtime sits
   *    idle and only runs during interruptible states like TTS).
   *  - Disabled wake word mode + stop-word switch on (same standby
   *    pattern; the mic is off at idle but comes up during
   *    voice_satellite.wake-triggered turns, and stop-word works during
   *    the TTS playback window of those turns).
   *
   * Returns false in the common stop-off cases so the user pays zero
   * local inference cost.
   * @returns {boolean}
   */
  needsLocalInference() {
    if (this.isOnDeviceWakeEnabled()) return true;
    // Kiosk Satellite is running the stop classifier natively, so there is
    // nothing for a local runtime to do. Loading one anyway would download the
    // model and spin up WASM/WebGPU to score audio that never arrives: under
    // the handoff the app owns the mic and the browser's worklet - the only
    // thing that ever calls feedAudio() - is never in the graph.
    if (this._nativeStopActive()) return false;
    return this.isStopWordEnabled();
  }

  /**
   * Free the browser inference runtime and everything hanging off it, for when
   * the local engine has no reason to exist: the stop word went off with no
   * on-device wake, or Kiosk Satellite just took detection over mid-session.
   *
   * Deliberately does not touch the mic: callers are in different situations
   * about who should hold it (HA wake mode still needs it; a native handoff
   * does not).
   */
  _releaseLocalRuntime(reason) {
    if (!this._inference && !this._tfweb) return;
    this._log.log('wake-word', `Releasing the browser wake-word runtime (${reason})`);
    try { this.stop(); } catch (e) { this._log.log('wake-word', `release: stop: ${e.message || e}`); }
    this._destroyInference(reason);
    this._loadedModelsKey = null;
    this._stopMicroConfig = null;
    resetRuntime().catch(() => { /* best-effort */ });
    this._tfweb = null;
  }

  /** True when the stop classifier is handed off to Kiosk Satellite. */
  _nativeStopActive() {
    return this._session._nativeStopActive === true
      && kiosk.supportsNativeStopWord();
  }

  /**
   * A native stop-word detection from Kiosk Satellite. Routes into the same
   * handler a local detection uses, so every interruption target (TTS, media,
   * timers, notifications) behaves identically whoever heard the word.
   */
  onNativeStopDetection() {
    return this._onStopDetection();
  }

  /**
   * Backwards-compat alias. Older callers expected a single "is on-device
   * wake enabled" gate. Keep returning that semantic so the few external
   * callsites (pipeline/index.js etc.) don't change behavior.
   * @returns {boolean}
   */
  isEnabled() {
    return this.isOnDeviceWakeEnabled();
  }

  /**
   * Get the slot 1 wake word model name.
   * @returns {string}
   */
  getModelName() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_model',
      'ok_nabu',
    );
  }

  /**
   * Get the slot 2 wake word model name, or null when slot 2 is disabled
   * or is set to the same model as slot 1 (silent dedupe).
   * @returns {string|null}
   */
  getModel2Name() {
    const raw = getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_model_2',
      'Disabled',
    );
    if (!raw || raw === 'Disabled') return null;
    if (raw === this.getModelName()) return null;
    return raw;
  }

  /**
   * Map a detected model name back to its slot (1 or 2). Slot 1 wins ties
   * (same model in both slots always routes to Pipeline 1).
   * @param {string} modelName
   * @returns {1|2}
   */
  getSlotForModel(modelName) {
    return modelName === this.getModel2Name() ? 2 : 1;
  }

  /**
   * Get the active model names: slot 1 always, slot 2 when enabled and
   * distinct. The inference engine runs all returned models in parallel.
   * @returns {string[]}
   */
  getActiveModels() {
    const primary = this.getModelName();
    const secondary = this.getModel2Name();
    return secondary ? [primary, secondary] : [primary];
  }

  /**
   * Get the wake word phrase for pipeline dedup (matches microWakeWord format).
   * @param {string} modelName - model name to look up
   * @returns {string}
   */
  getWakeWordPhrase(modelName) {
    return WAKE_WORD_PHRASES[modelName]
      || modelName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Get the sensitivity label from the HA select entity.
   * @returns {string}
   */
  _getSensitivityLabel() {
    return getSelectState(
      this._session.hass,
      this._session.config.satellite_entity,
      'wake_word_sensitivity',
      'Moderately sensitive',
    );
  }

  /**
   * Check if the noise gate switch is enabled.
   * @returns {boolean}
   */
  _isNoiseGateEnabled() {
    return getSwitchState(
      this._session.hass,
      this._session.config.satellite_entity,
      'noise_gate',
    ) === true;
  }

  /**
   * Check if stop word interruption is enabled.
   * @returns {boolean}
   */
  isStopWordEnabled() {
    return getSwitchState(
      this._session.hass,
      this._session.config.satellite_entity,
      'stop_word',
    ) === true;
  }

  /**
   * Get the detection threshold for a specific model. The base cutoff
   * comes from the model's JSON manifest (or hardcoded fallback) and is
   * scaled by the Slightly/Moderately/Very sensitive setting.
   *
   * @param {string} modelName
   * @returns {number}
   */
  getThresholdForModel(modelName) {
    const label = this._getSensitivityLabel();
    const engine = this.getEngine();
    if (engine === 'oww') {
      // OWW: absolute offset from the calibrated upstream cutoff.  Wake
      // words sit at 0.5 (matches `rhasspy/pyopen-wakeword` and the HA
      // OWW addon); stop is bumped to 0.65 because the community stop
      // classifier produces noisier output and FPs on low-amplitude speech.
      // ±0.15 wake / ±0.05 stop keeps the slider meaningful without
      // saturating to the [0.1, 0.99] clamp on the extreme settings.
      const base = modelName === 'stop' ? 0.65 : 0.5;
      const offsets = modelName === 'stop'
        ? OWW_STOP_SENSITIVITY_OFFSETS
        : OWW_WAKE_SENSITIVITY_OFFSETS;
      const offset = offsets[label] ?? 0;
      return Math.max(0.1, Math.min(base + offset, 0.99));
    }
    if (engine === 'vww') {
      // VWW: per-model base cutoff from the .json manifest emitted by
      // wakeword_train.py.  Sensitivity is an absolute offset.  Stop
      // classifier ('ok_stop') uses the OWW_STOP offset table since
      // it shares the "fire fast, tolerate slightly more FP" behavior
      // pattern.  loadVwwModelParams populates the cache asynchronously;
      // until it resolves we fall back to the trainer's 0.6 default.
      const base = getVwwModelParams(modelName).cutoff ?? 0.6;
      const offsets = isStopModelName(modelName)
        ? OWW_STOP_SENSITIVITY_OFFSETS
        : OWW_WAKE_SENSITIVITY_OFFSETS;
      const offset = offsets[label] ?? 0;
      return Math.max(0.1, Math.min(base + offset, 0.99));
    }
    // microWakeWord: per-model cutoff from JSON manifest, modulated by the
    // user-facing sensitivity factor (the tighter the cutoff, the more
    // selective the detector).
    const baseCutoff = getMicroModelParams(modelName).cutoff ?? DEFAULT_CUTOFF;
    const table = modelName === 'stop' ? STOP_SENSITIVITY_FACTORS : SENSITIVITY_MARGIN_FACTORS;
    const factor = table[label] ?? 1.0;
    const effective = 1 - (1 - baseCutoff) * factor;
    return Math.max(0.1, Math.min(effective, 0.99));
  }

  /**
   * Get the detection threshold for the primary model.
   * @returns {number}
   */
  getThreshold() {
    return this.getThresholdForModel(this.getModelName());
  }

  /**
   * Build keywordConfigs array for the inference engine.
   * @param {Record<string, object>} runners - name → runner map
   * @returns {{runner: object, name: string, cutoff: number, slidingWindow: number, stepSize: number}[]}
   */
  _buildKeywordConfigs(runners) {
    return Object.entries(runners).map(([name, runner]) => {
      const params = getMicroModelParams(name);
      const effectiveCutoff = this.getThresholdForModel(name);
      const label = this._getSensitivityLabel();
      this._log.log('wake-word',
        `${name}: baseCutoff=${params.cutoff} effective=${effectiveCutoff.toFixed(3)} (${label}, margin ×${SENSITIVITY_MARGIN_FACTORS[label]}) slidingWindow=${params.slidingWindow} stepSize=${params.stepSize} (${params._source || 'hardcoded'})`
      );
      return {
        runner,
        name,
        cutoff: effectiveCutoff,
        slidingWindow: params.slidingWindow,
        stepSize: params.stepSize,
        inputScale: params.inputScale,
        inputZeroPoint: params.inputZeroPoint,
      };
    });
  }

  // ─── Start / Stop ───────────────────────────────────────────────────

  /**
   * Start wake word detection. Initializes the model runtime on first call.
   *
   * Two distinct startup paths:
   *  - On-device wake mode: load wake-word models and begin continuous
   *    inference (sets _active = true).
   *  - Home Assistant wake mode + stop-word on: load only the runtime and
   *    create an empty inference engine. _active stays false; the engine
   *    sits dormant until enableStopModel(true) fires when an
   *    interruptible state begins (TTS, notification, timer alert), and
   *    is torn down via disableStopModel() when the state ends.
   */
  async start() {
    if (this._active || this._resetting) return;
    // Async re-entrancy guard: if start() is already running, return the
    // existing in-flight promise instead of spawning a second worker.
    // The _active flag is only set at the END of the body (after all
    // awaits), so concurrent callers in the same microtask tick all pass
    // the guard above and race to spawn duplicate workers - one wins
    // _inference, the other becomes an orphaned leak.  Caching the
    // promise lets all callers await the same start.
    if (this._startInflight) return this._startInflight;
    if (!this.needsLocalInference()) {
      this._log.log('wake-word', 'Local inference not needed - skipping start');
      return;
    }
    this._startInflight = this._startBody().finally(() => {
      this._startInflight = null;
    });
    return this._startInflight;
  }

  async _startBody() {
    // Constrained-WebView gate: on Fully Kiosk / Android WebView, the
    // dashboard's HACS cards are still being parsed/registered when this
    // function gets called.  Spawning workers + compiling ONNX/TFLite
    // models in parallel with that competition for the JS thread and
    // GPU memory frequently triggers transient OOM on lower-end Android
    // tablets.  Wait 3 s so the dashboard initial render finishes first.
    // Only the FIRST start() call per session pays the cost; subsequent
    // start() calls (settings change, mode swap, etc.) skip it via
    // _settledOnce.
    if (!this._settledOnce && isConstrainedWebView()) {
      this._log.log('wake-word', 'Constrained WebView detected - delaying initial wake-word startup');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    this._settledOnce = true;

    const onDevice = this.isOnDeviceWakeEnabled();
    const engine = this.getEngine();  // 'mww' | 'oww' | null
    const wakeModels = onDevice ? this.getActiveModels() : [];
    // The cache key is engine-prefixed so flipping engines without
    // changing the model name (e.g. picking ok_nabu in OWW after MWW)
    // still triggers a full reload.
    const modelsKey = `${engine || 'standby'}:${wakeModels.slice().sort().join(',')}`;
    this._log.log(
      'wake-word',
      onDevice
        ? `Starting on-device detection (engine: ${engine}, models: ${wakeModels.join(', ')})`
        : 'Starting stop-word standby (HA wake mode + stop-word on)',
    );

    try {
      if (!this._inference || this._loadedModelsKey !== modelsKey) {
        // Different engine/models than last time - destroy the old
        // worker before spawning a new one so we don't leak the worker
        // process or its compiled-model memory.
        if (this._inference) this._destroyInference('engine/model change');

        if (engine === 'oww') {
          // openWakeWord path: shared mel + embedding load inside the
          // worker, plus one classifier per wake word.  When stop-word
          // is enabled we *load* the stop classifier alongside (it
          // shares the mel+embedding pipeline) but mark it INACTIVE -
          // matches MWW's behavior where the stop runner only runs
          // inference during interruptible states.  enableStopModel()
          // / disableStopModel() flip the active flag without paying
          // model-load cost.
          const stopEnabled = this.isStopWordEnabled();
          const allClassifiers = stopEnabled ? [...wakeModels, 'stop'] : wakeModels;
          const cutoffs = {};
          for (const name of allClassifiers) cutoffs[name] = this.getThresholdForModel(name);
          this._log.log('wake-word', `Spawning OWW worker for: ${allClassifiers.join(', ')}`);
          this._inference = await WorkerProxyBackend.create({
            engine: 'oww',
            models: allClassifiers,
            // Only wake words are active at start.  Stop is loaded but
            // dormant until enableStopModel() flips it on.
            activeKeywords: wakeModels,
            cutoffs,
            energyGateEnabled: this._isNoiseGateEnabled(),
            sensitivityLabel: this._getSensitivityLabel(),
            log: this._log,
          });
          // Track stop classifier presence so enableStopModel() knows
          // it's already loaded (OWW classifiers are baked in at create).
          if (stopEnabled) {
            this._stopMicroConfig = {
              name: 'stop',
              cutoff: this.getThresholdForModel('stop'),
            };
          }
          this._loadedModelsKey = modelsKey;
          this._log.log(
            'wake-word',
            `OWW worker ready - active: ${wakeModels.join(', ')}${stopEnabled ? ' (stop loaded, inactive)' : ''}`,
          );
        } else if (engine === 'vww') {
          // vsWakeWord path: one self-contained ONNX per wake word.
          // Keep startup focused on the primary wake model(s).  The VWW
          // stop classifier (ok_stop.onnx) can be lazily loaded by
          // enableStopModel() when an interruptible state actually begins;
          // staging it this way avoids compiling an optional WebGPU graph
          // during initial page load.
          const stopEnabled = this.isStopWordEnabled();
          const vwwStopName = VWW_STOP_NAME;
          const allClassifiers = wakeModels;
          await Promise.all(allClassifiers.map((name) => loadVwwModelParams(name).catch(() => null)));
          const cutoffs = {};
          for (const name of allClassifiers) cutoffs[name] = this.getThresholdForModel(name);
          this._log.log('wake-word', `Spawning VWW worker for: ${allClassifiers.join(', ')}`);
          this._inference = await WorkerProxyBackend.create({
            engine: 'vww',
            models: allClassifiers,
            // Stop is loaded but dormant; enableStopModel flips it on.
            activeKeywords: wakeModels,
            cutoffs,
            energyGateEnabled: this._isNoiseGateEnabled(),
            sensitivityLabel: this._getSensitivityLabel(),
            log: this._log,
          });
          if (stopEnabled) this._stopMicroConfig = null;
          this._loadedModelsKey = modelsKey;
          this._log.log(
            'wake-word',
            `VWW worker ready - active: ${wakeModels.join(', ')}${stopEnabled ? ` (${vwwStopName} deferred)` : ''}`,
          );
        } else {
          // microWakeWord path (also covers stop-word-only standby).
          // The Worker loads its own TFLite runtime + models; we don't
          // touch them on the main thread. Let the worker compute cutoffs
          // after it has loaded each model's JSON manifest; this matters
          // for custom MWW models that are unknown to the main bundle.
          this._log.log('wake-word', `Spawning MWW worker for: ${wakeModels.join(', ') || '(stop standby only)'}`);
          this._inference = await WorkerProxyBackend.create({
            engine: 'mww',
            models: wakeModels,
            energyGateEnabled: this._isNoiseGateEnabled(),
            sensitivityLabel: this._getSensitivityLabel(),
            log: this._log,
          });
          this._loadedModelsKey = modelsKey;

          if (wakeModels.length > 0) {
            const configs = this._inference._keywords;
            const configSummary = configs.map((kw) => `${kw.name}(c=${kw.cutoff.toFixed(2)})`).join(', ');
            this._log.log('wake-word', `MWW worker ready: ${configSummary}`);
          } else {
            this._log.log('wake-word', 'MWW worker ready (no wake models loaded - stop-word standby)');
          }
        }
      } else if (wakeModels.length > 0) {
        const updates = this.getEngine() === 'mww'
          ? wakeModels.map((name) => ({ name }))
          : wakeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) }));
        this._inference.updateEnergyThresholds(this._getSensitivityLabel());
        this._inference.updateThresholds(updates);
        this._inference.reset();
      }

      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      if (onDevice) {
        this._active = true;
        // pipeline.restart() at tts-end fires while TTS audio is still
        // playing.  If we land here mid-playback, re-apply the suspend
        // so the new backend doesn't process speaker-residual audio.
        if (this._playbackSuspendCount > 0) {
          this._suspendedActiveBeforePlayback = true;
          this._active = false;
          this._log.log('wake-word', 'Started in playback-suspended state');
        }
        this._session.setState(State.LISTENING);
        this._log.log('wake-word', 'On-device wake word detection active');
      } else {
        // HA + stop standby: stay idle. feedAudio() short-circuits when
        // !_active && !_stopOnlyMode, so audio frames are dropped at the
        // door. The runtime only spins up when enableStopModel(true)
        // flips _stopOnlyMode for an interruptible state.
        this._active = false;
        this._log.log('wake-word', 'Stop-word standby ready');
      }

    } catch (e) {
      const msg = e?.message || String(e);
      const isOOM = msg.includes('Out of memory');
      // openWakeWord requires WebGPU.  If the worker reports the
      // device couldn't be acquired, give the user a specific actionable
      // toast instead of the generic "could not start" copy.
      const isNoWebGpu = e?.code === 'webgpu-unavailable'
        || msg.includes('WebGPU');
      if (isOOM) {
        this._log.error('wake-word', 'Wake-word runtime OOM - forcing full runtime reset');
        try {
          await this._recreateRuntime('OOM recovery');
        } catch (_) { /* ignore secondary failure */ }
      }
      this._log.error('wake-word', `Failed to start: ${msg}`);
      // Surface to the user. Dedup id is stable across retries so a
      // runtime reset loop doesn't flood the toast surface.
      let description;
      if (isOOM) {
        description = 'On-device detection ran out of memory. The runtime is restarting; detection may be briefly unavailable.';
      } else if (isNoWebGpu) {
        const engineLabel = this.getEngine() === 'vww' ? 'vsWakeWord' : 'openWakeWord';
        description = `${engineLabel} requires WebGPU, which this device does not support. Switch the wake word engine to "On Device (microWakeWord)" instead - it works on every device without needing a GPU.`;
      } else {
        description = 'On-device wake word detection could not start. Try a different model or switch to Home Assistant wake word detection.';
      }
      this._session.toast?.show({
        id: 'wake-word.load-failed',
        severity: 'error',
        category: 'Wake word',
        description,
        action: { label: 'Open Diagnostics', type: 'diagnostics' },
      });
      throw e;
    }
  }

  /**
   * Stop wake word detection.
   */
  stop() {
    if (!this._active && !this._stopOnlyMode) return;
    this._active = false;
    this._stopOnlyMode = false;
    this._suspendedKeywords = null;
    this._sampleBufLen = 0;
    this._frameQueue.length = 0;
    this._framePool.length = 0;
    this._pendingWakeActivatedAt = 0;
    this._log.log('wake-word', 'Stopped');
  }

  _destroyInference(reason = 'cleanup') {
    if (!this._inference) return;
    try {
      this._inference.destroy();
      this._log.log('wake-word', `${reason}: micro-frontend destroyed`);
    } catch (e) {
      this._log.log('wake-word', `${reason}: inference.destroy failed: ${e.message || e}`);
    }
    this._inference = null;
  }

  async _recreateRuntime(reason = 'runtime reset') {
    this._log.log('wake-word', `${reason}: resetting wake-word runtime`);
    await resetRuntime();
    this._tfweb = await loadTFLite();
  }

  /**
   * Full teardown: stop detection and free the wake-word runtime this
   * manager owns. Called from
   * `session.teardown()` on page unload so V8 can reclaim linear
   * memory and compiled native code before the next page mounts.
   * Synchronous so it runs to completion inside a `pagehide` handler.
   */
  release() {
    this._log.log('wake-word', 'release() - freeing wake-word runtime');
    // Kiosk Satellite is the runtime here, and it holds the microphone. Mute
    // means the mic is off, period, so pausing it is not enough: hand the mic
    // back. startListening() re-establishes the handoff on unmute.
    if (this._session._nativeWakeActive) {
      this._session._teardownNativeWake?.();
      return;
    }
    try { this.stop(); } catch (e) { this._log.log('wake-word', `release: stop failed: ${e.message || e}`); }
    this._destroyInference('release');
    this._loadedModelsKey = null;
    this._stopMicroConfig = null;
    try {
      resetRuntime();
      this._log.log('wake-word', 'release: wake-word runtime reset');
    } catch (e) {
      this._log.log('wake-word', `release: resetRuntime failed: ${e.message || e}`);
    }
  }

  // ─── Audio feed + detection ─────────────────────────────────────────

  /**
   * Feed audio samples from the AudioWorklet.
   * Accumulates to CHUNK_SIZE (1280) then queues for serial inference.
   * @param {Float32Array} chunk - raw audio samples from worklet
   */
  feedAudio(chunk) {
    if ((!this._active && !this._stopOnlyMode) || !this._inference) return;

    // Grow pre-allocated buffer if needed (rare - only if chunk is unusually large)
    const needed = this._sampleBufLen + chunk.length;
    if (needed > this._sampleBuf.length) {
      const newBuf = new Float32Array(needed * 2);
      newBuf.set(this._sampleBuf.subarray(0, this._sampleBufLen));
      this._sampleBuf = newBuf;
    }

    // Append into pre-allocated buffer (no allocation)
    this._sampleBuf.set(chunk, this._sampleBufLen);
    this._sampleBufLen += chunk.length;

    // Queue complete chunks for serial processing.
    // Cap queue depth - if inference can't keep up, drop oldest frames rather
    // than letting memory grow unbounded.  50 frames ≈ 4s of audio at 80ms each.
    const MAX_QUEUE = 50;
    let droppedFrames = 0;
    while (this._sampleBufLen >= CHUNK_SIZE) {
      if (this._frameQueue.length >= MAX_QUEUE) {
        const dropped = this._frameQueue.shift();
        if (this._framePool.length < MAX_POOL) this._framePool.push(dropped.buf);
        droppedFrames++;
      }
      const buf = this._framePool.pop() || new Float32Array(CHUNK_SIZE);
      buf.set(this._sampleBuf.subarray(0, CHUNK_SIZE));
      // Capture timestamp rides along so slow-inference devices can
      // detect frames that aged in this queue and fast-ingest them
      // (see WorkerProxyBackend.processChunk).
      this._frameQueue.push({ buf, t: Date.now() });
      this._sampleBuf.copyWithin(0, CHUNK_SIZE, this._sampleBufLen);
      this._sampleBufLen -= CHUNK_SIZE;
    }
    if (droppedFrames > 0) {
      this._streamResetPending = true;
      this._log.log(
        'wake-word',
        `Inference queue overflow - dropped ${droppedFrames} frame(s), stream state will reset`,
      );
    }

    this._drainQueue();
  }

  /**
   * Process queued frames one at a time (serialized).
   * Prevents concurrent inference from corrupting shared state.
   */
  async _drainQueue() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._frameQueue.length > 0 && (this._active || this._stopOnlyMode)) {
        if (this._streamResetPending) {
          this._streamResetPending = false;
          if (this._inference?.reset) this._inference.reset();
        }
        const frame = this._frameQueue.shift();
        const result = await this._inference.processChunk(frame.buf, frame.t);
        if (this._framePool.length < MAX_POOL) this._framePool.push(frame.buf);
        if (result.detected) {
          const triggerBits = [];
          if (result.triggerType) triggerBits.push(`type=${result.triggerType}`);
          triggerBits.push(...formatWakeRuntimeStatus(result));
          if (typeof result.cutoff === 'number') triggerBits.push(`cutoff=${result.cutoff.toFixed(3)}`);
          if (typeof result.rms === 'number') triggerBits.push(`rms=${result.rms.toFixed(4)}`);
          if (typeof result.windowRms === 'number') triggerBits.push(`window_rms=${result.windowRms.toFixed(4)}`);
          if (typeof result.immediateMargin === 'number') triggerBits.push(`margin=${result.immediateMargin.toFixed(3)}`);
          const triggerMeta = triggerBits.length ? `, ${triggerBits.join(', ')}` : '';
          this._log.log('wake-word', `Detected: ${result.model} (score=${result.score.toFixed(3)}${triggerMeta})`);
          this._frameQueue.length = 0;
          if (isStopModelName(result.model)) {
            await this._onStopDetection();
          } else {
            await this._onDetection(result.model);
          }
          return;
        }
      }
    } catch (e) {
      this._log.error('wake-word', `Inference error: ${e.message || e}`);
    } finally {
      this._processing = false;
    }
  }

  /**
   * Handle wake word detection - mirrors pipeline handleWakeWordEnd behavior.
   * @param {string} modelName - the model that triggered detection
   */
  async _onDetection(modelName) {
    // Stop listening for more wake words
    this._active = false;
    this._pendingWakeActivatedAt = performance.now();

    const session = this._session;

    // If the tab is paused (screen off / background), unpause so pipeline
    // events aren't dropped. This only happens inside the visibility
    // debounce window - once VisibilityManager._pause runs, the mic and
    // wake word are fully released and no detection can fire - but
    // handlePipelineMessage blocks all events when isPaused.
    if (session.visibility.isPaused) {
      this._log.log('wake-word', 'Unpausing - detection while tab paused');

      // Signal visibility manager that we own the resume - prevents the
      // visibilitychange → _resume() path from racing with us (both would
      // resume AudioContext + restart pipeline concurrently).
      session.visibility._wakeWordResuming = true;

      await session.audio.resume();
      session.visibility._isPaused = false;

      // Yield to the browser so it can paint the first frame after the
      // screen wakes up. Without this, the AudioContext resume + TFLite
      // sleep-buffer replay + pipeline start all block the main thread
      // back-to-back and the UI appears frozen.
      await new Promise((r) => requestAnimationFrame(r));
    }

    // If muted, silently ignore the detection and resume listening
    if (getSwitchState(session.hass, session.config.satellite_entity, 'mute') === true) {
      this._log.log('wake-word', 'Muted - ignoring wake word detection');
      this._active = true;
      return;
    }

    // Interrupt media player
    session.mediaPlayer.interrupt();

    // Stop TTS if playing
    if (session.tts.isPlaying) {
      session.tts.stop();
      session.pipeline.pendingRunEnd = false;
    }

    // Cancel a pending follow-up listen delay (user wake-worded over a
    // continue-conversation pause).  Drop the mute the timer set, then
    // fall through to the normal wake flow - the muting below will
    // re-apply for the wake chime path.
    if (session._followupDelayTimer) {
      this._log.log('wake-word', 'Cancelling pending follow-up delay - wake word fired during handoff');
      clearTimeout(session._followupDelayTimer);
      session._followupDelayTimer = null;
      session.audio.setMicTracksMuted(false);
    }

    // Clear previous interaction state
    if (session.pipeline.intentErrorBarTimeout) {
      clearTimeout(session.pipeline.intentErrorBarTimeout);
      session.pipeline.intentErrorBarTimeout = null;
    }
    if (session._imageLingerTimeout) {
      clearTimeout(session._imageLingerTimeout);
      session._imageLingerTimeout = null;
    }

    session.chat.clear();
    session.pipeline.shouldContinue = false;
    session.pipeline.continueConversationId = null;

    const seamlessWakeCommand = session.config.seamless_wake_command === true;
    if (seamlessWakeCommand) {
      session._seamlessWakeActive = true;
      session.audio.startBuffering?.({ reset: true });
    }

    // console.log('[wf-diag] _onDetection -- setState + showBlurOverlay');
    session.setState(State.WAKE_WORD_DETECTED);
    session.ui.showBlurOverlay(BlurReason.PIPELINE);

    const wakeSound = getSwitchState(
      session.hass, session.config.satellite_entity, 'wake_sound',
    ) !== false;
    this._log.log(
      'wake-word',
      `Wake activation settings: seamless_wake_command=${seamlessWakeCommand ? 'enabled' : 'disabled'}, wake_sound=${wakeSound ? 'enabled' : 'disabled'}`,
    );

    // Seamless wake command: do not play a wake chime, and keep the
    // post-detection mic audio buffered until the STT stream is ready.
    if (seamlessWakeCommand) {
      this._log.log(
        'wake-word',
        wakeSound
          ? 'Seamless wake command enabled - skipping wake chime and streaming buffered STT audio'
          : 'Seamless wake command enabled - streaming buffered STT audio',
      );

      session.pipeline
        .start({
          start_stage: 'stt',
          wake_word_phrase: this.getWakeWordPhrase(modelName),
          wake_word_slot: this.getSlotForModel(modelName),
          preserve_audio_buffer: true,
        })
        .catch((e) => {
          this._log.error('wake-word', `Pipeline start failed after seamless detection: ${e.message || e}`);
          session._seamlessWakeActive = false;
          session.audio.stopBuffering?.({ clear: true });
          this._setMicTracksMuted(false);
          try { session.ui.setReactiveSuppressed(false); } catch (_) {}
          session.pipeline.restart(session.pipeline.calculateRetryDelay());
        });
      return;
    }

    // ── Cross-tablet dedupe handling ─────────────────────────────────
    // If multiple satellites can hear the user, more than one of them
    // will trigger a local wake word detection. HA's pipeline picks the
    // first one as authoritative and replies to the others with
    // `duplicate_wake_up_detected`. To prevent the losing tablets from
    // chiming and then immediately cleaning up, we:
    //
    //   1. mute the mic so the chime won't bleed into STT;
    //   2. start the pipeline immediately so HA can dedupe ASAP;
    //   3. schedule the wake chime for WAKE_DEDUPE_WINDOW_MS later;
    //   4. on duplicate_wake_up_detected the pipeline error handler
    //      calls cancelPendingChime() before any audio fires.
    //
    // The mic stays muted until either the chime finishes (winning
    // tablet) or the dedupe handler cancels everything (losing tablet),
    // so the speaker→mic feedback that previously required playing the
    // chime BEFORE starting the pipeline is no longer a concern.

    this._setMicTracksMuted(true);

    // The 'reactive' bar class drives transform/glow off `--vs-audio-level`,
    // which the mic-analyser updates each frame.  Once we mute the tracks
    // the analyser reads silence, the CSS var stays ~0, and the bar
    // renders as a frozen flat rainbow until the chime finishes and we
    // unmute - that's the "stagger" the user sees between wake word and
    // chime.  Just calling stopReactive() here doesn't work: the
    // subsequent state transitions WAKE_WORD_DETECTED → STT both re-run
    // updateForState() which would turn reactive right back on.  A
    // suppression flag survives those state changes and is cleared only
    // once the mic is actually unmuted below.
    session.ui.setReactiveSuppressed(true);

    // Kick off the pipeline immediately. We do NOT await - the chime
    // and STT timing are independent of pipeline.start's resolution,
    // and we need HA to receive the wake_word_detected event right
    // away so it can decide if this tablet won the dedupe race.
    session.pipeline
      .start({
        start_stage: 'stt',
        wake_word_phrase: this.getWakeWordPhrase(modelName),
        wake_word_slot: this.getSlotForModel(modelName),
        defer_audio_start: true,
      })
      .catch((e) => {
        this._log.error('wake-word', `Pipeline start failed after detection: ${e.message || e}`);
        // If the pipeline failed to start, we don't want to play the
        // chime or leave the mic muted forever.
        this._cancelPendingChimeInternal();
        this._setMicTracksMuted(false);
        try { session.ui.setReactiveSuppressed(false); } catch (_) {}
        session.pipeline.restart(session.pipeline.calculateRetryDelay());
      });

    this.scheduleWakeChime(wakeSound);
  }

  /**
   * Hold the wake chime behind the cross-tablet dedupe window, then play it
   * and hand the mic to STT.
   *
   * Shared by the browser detection path and the Kiosk Satellite native one so
   * a multi-tablet house behaves the same whoever heard the wake word: HA gets
   * the wake event immediately and answers duplicate_wake_up_detected to the
   * losers, whose pending chime is cancelled by the pipeline error handler
   * (see cancelPendingChime) before a sound is emitted.
   *
   * The caller must already have muted the mic, suppressed the reactive bar,
   * and started the pipeline with defer_audio_start.
   *
   * @param {boolean} wakeSound the per-satellite wake_sound switch
   */
  scheduleWakeChime(wakeSound) {
    const session = this._session;
    this._log.log(
      'wake-word',
      wakeSound
        ? `STT audio deferred until wake chime completes (${WAKE_DEDUPE_WINDOW_MS}ms dedupe window)`
        : `STT audio deferred for ${WAKE_DEDUPE_WINDOW_MS}ms dedupe window`,
    );
    // Schedule the wake chime (or just an unmute if wake sound is off).
    if (wakeSound) {
      this._pendingChimeHandle = setTimeout(() => {
        this._pendingChimeHandle = null;
        const audio = session.audio;
        // (reactive was already stopped at mute-time above; no-op here)
        // Even though the mic tracks stay muted through the deferred chime,
        // the pipeline is already running in STT mode for cross-tablet dedupe.
        // Pause upstream audio transmission too so the server-side VAD never
        // sees the wake chime window as part of the user's utterance.
        audio.stopSending();
        // Mic is still muted at this point so the chime won't bleed
        // into the STT recording. Unmute after the chime + a small
        // settle window - same total duration the old in-line code used.
        session.tts.playChime('wake');
        // Speaker output buffers + echo-cancellation adapt time mean the
        // chime is still physically emerging from the speakers for a
        // while after the audio file ends.  +50 ms was too tight (mic
        // re-armed mid-tail).  +250 ms covers OS audio-buffer drain
        // with comfortable margin.
        //
        // Read the actual file duration off the cached Audio element
        // (getChimeDuration) rather than trusting the hardcoded
        // `CHIME_WAKE.duration`: users can replace the built-in sound
        // files with their own in /config/voice_satellite/sounds/ (see
        // `_sync_custom_sounds()` in __init__.py) and their files can
        // be any length.
        const SPEAKER_DRAIN_MS = 250;
        const unmuteAfter = (getChimeDuration(CHIME_WAKE) * 1000) + SPEAKER_DRAIN_MS;
        this._pendingUnmuteHandle = setTimeout(() => {
          this._pendingUnmuteHandle = null;
          this._setMicTracksMuted(false);
          // Discard any buffered silence/audio captured during the dedupe
          // window + chime, then resume streaming into the active pipeline.
          audio.audioBuffer = [];
          if (session.pipeline.binaryHandlerId) {
            audio.startSending(() => session.pipeline.binaryHandlerId);
          }
          // Mic is live again - let updateForState() re-enable reactive on
          // the next state change, and flip it on right now for the current
          // state since we're already mid-interaction.
          session.ui.setReactiveSuppressed(false);
          if ([State.WAKE_WORD_DETECTED, State.STT].includes(session.currentState)) {
            // Suppress the first ~200 ms of analyser writes: flipping the
            // mic tracks back on produces a brief activation transient
            // (DC step / driver click) that the speech-band weighting
            // amplifies into a visible "bleep" glow before the real
            // signal settles.  The analyser's RAF still runs so its
            // smoothing warms up against live audio during the window.
            session.ui.startReactive({ warmupMs: 200 });
          }
        }, unmuteAfter);
      }, WAKE_DEDUPE_WINDOW_MS);
    } else {
      // No wake chime configured. Still defer the unmute by the dedupe
      // window so we have a chance to cancel silently if a duplicate
      // arrives, then unmute so STT records.
      this._pendingUnmuteHandle = setTimeout(() => {
        this._pendingUnmuteHandle = null;
        this._setMicTracksMuted(false);
        const audio = session.audio;
        audio.audioBuffer = [];
        if (session.pipeline.binaryHandlerId) {
          audio.startSending(() => session.pipeline.binaryHandlerId);
        }
        session.ui.setReactiveSuppressed(false);
        // Mirror the wake-sound-on path: once the mic is live again, kick
        // the reactive bar over to mic-driven rendering.  Without this,
        // setReactiveSuppressed(false) alone just cancels the synthetic
        // pulse - the analyser tick loop stays stopped because
        // updateForState() already ran (during suppression) and won't
        // re-fire until the next state change, leaving the bar dark
        // even as the user speaks.
        if ([State.WAKE_WORD_DETECTED, State.STT].includes(session.currentState)) {
          session.ui.startReactive();
        }
      }, WAKE_DEDUPE_WINDOW_MS);
    }
  }

  /**
   * Mute or unmute the mic stream's tracks. Used by the deferred
   * wake chime path so the chime audio (played through the speakers)
   * doesn't get captured by the mic and shipped off to STT. While
   * muted the audio worklet still runs but receives silence from the
   * disabled tracks.
   */
  _setMicTracksMuted(muted) {
    // Delegate to AudioManager so the mute state is recorded against the
    // session, not against whichever MediaStream happens to be active
    // right now.  switchMicMode() reads the same flag when bringing up a
    // new stream during the wake-word → STT mic-mode transition, so the
    // mute survives the cross-fade and the chime can't bleed into the
    // freshly-acquired stream.
    this._session?.audio?.setMicTracksMuted?.(muted);
  }

  /**
   * Cancel any timers scheduled by _onDetection without touching the
   * mic mute state. Internal helper - callers usually want
   * cancelPendingChime() which also handles the unmute.
   */
  _cancelPendingChimeInternal() {
    if (this._pendingChimeHandle) {
      clearTimeout(this._pendingChimeHandle);
      this._pendingChimeHandle = null;
    }
    if (this._pendingUnmuteHandle) {
      clearTimeout(this._pendingUnmuteHandle);
      this._pendingUnmuteHandle = null;
    }
  }

  /**
   * Cancel a pending wake chime if one is scheduled (i.e. we're inside
   * the dedupe window after a local detection but the chime hasn't
   * fired yet). Returns true if something was cancelled - the caller
   * (the pipeline error handler) uses this to short-circuit the normal
   * "expected error" cleanup so the losing tablet stays completely
   * silent.
   *
   * If the chime has already played (we're past the dedupe window),
   * returns false and the normal cleanup runs.
   */
  cancelPendingChime() {
    const wasPending = this._pendingChimeHandle !== null
      || this._pendingUnmuteHandle !== null;
    this._cancelPendingChimeInternal();
    if (wasPending) {
      this._setMicTracksMuted(false);
      // Losing-tablet path: clear the reactive suppression so a later
      // interaction doesn't inherit a stuck flag.  The bar will be hidden
      // anyway (state goes back to IDLE/LISTENING), but keep bookkeeping
      // honest.
      try { this._session?.ui?.setReactiveSuppressed(false); } catch (_) {}
    }
    return wasPending;
  }

  /**
   * Milliseconds elapsed since local wake activation started, or null if there
   * is no pending wake activation to measure from.
   * Used for measuring duplicate_wake_up_detected round-trip latency.
   */
  getPendingWakeLatencyMs() {
    if (!this._pendingWakeActivatedAt) return null;
    return Math.max(0, Math.round(performance.now() - this._pendingWakeActivatedAt));
  }

  /**
   * Clear the current wake activation timing marker.
   */
  clearPendingWakeLatency() {
    this._pendingWakeActivatedAt = 0;
  }

  // ─── Stop model management ──────────────────────────────────────────

  /**
   * Whether the inference engine is currently in stop-only mode (only the
   * stop keyword is active, regular wake words suspended). Public getter
   * so notification managers can guard against double-arming, which would
   * clobber `_suspendedKeywords` and orphan the wake words.
   * @returns {boolean}
   */
  isStopOnlyMode() {
    return !!this._stopOnlyMode;
  }

  /**
   * Enable the stop keyword model for interruptible states.
   * @param {boolean} stopOnly - true for stop-only mode (TTS/notifications),
   *   false to add stop alongside regular wake words (timer alerts)
   */
  async enableStopModel(stopOnly = false) {
    if (!this.isStopWordEnabled()) {
      this._log.log('stop-word', 'Not enabled in satellite settings');
      return;
    }

    // Kiosk Satellite owns the stop classifier: it has the mic, so it is the
    // only side that can hear "stop" at all.  Nothing local to enable - just
    // arm it for as long as this interruptible state runs.
    if (this._nativeStopActive()) {
      await kiosk.setNativeStopWordActive(true);
      // stopOnly mirrors what the browser path does by suspending its wake
      // keywords: during TTS and announcements the stop classifier should be
      // the only thing listening, because the sound is coming out of this
      // device.  Media playback and timer alerts pass false and keep the wake
      // word live alongside it.
      if (stopOnly && this._session._nativeWakeActive) {
        this._nativeWakeSuspendedForStopOnly = true;
        await kiosk.setNativeWakeWordActive(false);
      }
      this._log.log(
        'stop-word',
        `Armed on Kiosk Satellite (native${stopOnly ? ', stop-only' : ''})`,
      );
      return;
    }

    if (!this._inference) {
      this._log.log('stop-word', 'Cannot enable - inference not initialized');
      return;
    }

    // When the local runtime is in standby (HA or Disabled wake mode +
    // stop-word on), there are no wake-word models loaded for stop to
    // run "alongside", and _active stays false. Callers like media
    // playback and timer alerts pass stopOnly=false intending to keep
    // wake words active - but with none loaded, that branch leaves the
    // audio gate (_active || _stopOnlyMode) closed and stop never fires.
    // Coerce to stopOnly so _stopOnlyMode flips on and audio flows.
    if (!stopOnly && !this.isOnDeviceWakeEnabled()) {
      stopOnly = true;
    }

    try {
      const isOww = this.getEngine() === 'oww';
      const isVww = this.getEngine() === 'vww';
      const stopName = getStopName(this.getEngine());

      // POLICY: all interruptible interactions force stop-only mode,
      // regardless of what the caller (media-player, timer, tts, etc.)
      // passed.  Reasoning:
      //   - During an interaction the Voice Satellite UI runs heavy
      //     animations; freeing GPU cycles for those is the user's
      //     priority.
      //   - For VWW each wake-word model is a full self-contained ONNX
      //     (~111K-436K params), so running both wake + stop saturates
      //     WebGPU and causes inference queue overflows / dropped
      //     frames - "ok stop" was needing 4-5 retries in production.
      //   - For OWW/MWW dual-run is technically cheap (shared
      //     embedding / lightweight TFLite), but the UX rationale still
      //     holds: the user just initiated an interaction, they're
      //     unlikely to issue a fresh wake-word in the same window, and
      //     the GPU savings benefit the UI either way.
      // Wake-word inference resumes via disableStopModel() when the
      // interruption ends.  _suspendedKeywords tracks them for restore.
      if (!stopOnly) {
        this._log.log(
          'stop-word',
          `Forcing stop-only mode for ${this.getEngine().toUpperCase()} `
          + `(wake-word inference paused during interruption to free GPU)`,
        );
        stopOnly = true;
      }

      if (isVww) {
        // VWW path: the stop classifier (ok_stop.onnx) was loaded at
        // start() into the worker when stop-word was enabled, with
        // activeKeywords excluding it.  Flip it active now by calling
        // addKeyword - the VWW backend re-activates an already-loaded
        // keyword (or lazily loads it if start() ran with stop-word
        // off and the user enabled it mid-session).
        if (!this._stopMicroConfig) {
          await loadVwwModelParams(stopName).catch(() => null);
          this._stopMicroConfig = {
            name: stopName,
            cutoff: this.getThresholdForModel(stopName),
          };
          this._log.log(
            'stop-word',
            `VWW stop classifier registered: ${stopName}(c=${this._stopMicroConfig.cutoff.toFixed(3)})`,
          );
        }
        await this._inference.addKeyword(this._stopMicroConfig);
        this._suspendedKeywords = this._inference._keywords
          .filter((k) => k.name !== stopName)
          .map((k) => ({ name: k.name, cutoff: k.cutoff }));
        for (const kw of this._suspendedKeywords) {
          this._inference.removeKeyword(kw.name);
        }
        this._stopOnlyMode = true;
        this._inference.reset();
        this._sampleBufLen = 0;
        this._frameQueue.length = 0;
        this._processing = false;
        this._log.log('stop-word', 'Enabled (stop-only mode, VWW)');
        return;
      }

      if (!this._stopMicroConfig) {
        if (isOww) {
          // Should already be set by start() when stop-word is enabled,
          // but if a caller flipped stop on after start ran, we'd land
          // here.  The OWW classifier is baked into the OwwInference at
          // construction, so we'd need a full restart to add it; bail
          // out and let the next checkSettingsChanged cycle restart.
          this._log.log('stop-word', 'OWW stop classifier not loaded - restart pending');
          return;
        }
        this._log.log('stop-word', 'Loading stop model...');
        const params = getMicroModelParams('stop');
        const effectiveCutoff = this.getThresholdForModel('stop');
        this._log.log(
          'stop-word',
          `stop: baseCutoff=${params.cutoff} effective=${effectiveCutoff.toFixed(3)} (${this._getSensitivityLabel()}, margin ×${STOP_SENSITIVITY_FACTORS[this._getSensitivityLabel()]}) slidingWindow=${params.slidingWindow} stepSize=${params.stepSize} (${params._source || 'hardcoded'})`,
        );
        this._stopMicroConfig = {
          name: 'stop',
          cutoff: effectiveCutoff,
          slidingWindow: params.slidingWindow,
          stepSize: params.stepSize,
          inputScale: params.inputScale,
          inputZeroPoint: params.inputZeroPoint,
        };
        this._log.log(
          'stop-word',
          `Stop model loaded: stop(c=${this._stopMicroConfig.cutoff},sw=${this._stopMicroConfig.slidingWindow})`,
        );
      } else {
        this._log.log('stop-word', 'Stop model already loaded (cached)');
      }

      await this._inference.addKeyword(this._stopMicroConfig);

      // stopOnly is always true here (forced above for all engines).
      // Suspend every wake-word keyword so only the stop classifier
      // runs during the interruption.  disableStopModel() restores
      // them from _suspendedKeywords when the interruption ends.
      this._suspendedKeywords = this._inference._keywords
        .filter((k) => k.name !== 'stop')
        .map((k) => ({
          runner: k.runner,
          name: k.name,
          cutoff: k.cutoff,
          slidingWindow: k.slidingWindow,
          stepSize: k.stepSize,
          inputScale: k.inputScale,
          inputZeroPoint: k.inputZeroPoint,
        }));
      for (const kw of this._suspendedKeywords) {
        this._inference.removeKeyword(kw.name);
      }
      this._stopOnlyMode = true;
      this._inference.reset();
      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      this._log.log('stop-word', 'Enabled (stop-only mode)');
    } catch (e) {
      this._log.error('stop-word', `Failed to enable: ${e.message || e}`);
    }
  }

  /**
   * Disable the stop keyword model and restore regular keywords if suspended.
   */
  disableStopModel({ log = true } = {}) {
    if (this._nativeStopActive()) {
      kiosk.setNativeStopWordActive(false);
      this._nativeWakeSuspendedForStopOnly = false;
      this._maybeRearmNativeWake();
      if (log) this._log.log('stop-word', 'Disarmed on Kiosk Satellite (native)');
      return;
    }
    if (!this._inference) return;

    // Engine-specific stop classifier name: 'stop' for OWW/MWW (their
    // baked-in convention), 'ok_stop' for VWW (its own ONNX file).
    this._inference.removeKeyword(getStopName(this.getEngine()));

    if (this._stopOnlyMode) {
      this._stopOnlyMode = false;
      if (this._suspendedKeywords) {
        for (const kw of this._suspendedKeywords) {
          this._inference.addKeyword(kw);
        }
        if (log) {
          const restored = this._suspendedKeywords.map((kw) => kw.name).join(', ');
          this._log.log('stop-word', `Restored wake keywords: ${restored}`);
        }
        this._suspendedKeywords = null;
      }
      // Stop-only mode has been consuming TTS/notification audio with a
      // different keyword set. Reset the inference engine before returning
      // to normal wake-word listening so stale stop-model/TTS state doesn't
      // carry into the restored wake-word detectors.
      this._inference.reset();
      // Only resume continuous inference if on-device wake is the active
      // listening mode. In HA + stop standby, returning to _active = true
      // would start running the empty inference engine on every audio
      // frame for no reason - defeats the whole "zero local cost when not
      // interrupting" promise.
      this._active = this.isOnDeviceWakeEnabled();
      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      if (log) {
        this._log.log(
          'stop-word',
          this._active
            ? 'Disabled (stop-only mode off, wake-word inference resumed)'
            : 'Disabled (stop-only mode off, returning to standby)',
        );
      }
    } else if (log) {
      this._log.log('stop-word', 'Disabled');
    }
  }

  /**
   * Halt wake-word inference for the duration of speaker playback (TTS,
   * chimes, notification audio).  Without this, the device's own speaker
   * output bleeds through AEC enough to self-trigger the wake classifier
   * (rms<0.005 mic input scoring 0.8+ on ok_nabu, fires immediately).
   *
   * Called synchronously from tts.play() before audio loading begins, so
   * the suspend is in place before pipeline.restart(0) at tts-end spins
   * up a fresh OWW backend - start() then re-applies the suspend so the
   * new backend doesn't process audio either.
   *
   * Stop-word interruption (when enabled) is handled by the existing
   * enableStopModel(true) path on a separate 250 ms timer; it sets
   * _stopOnlyMode and routes audio to the stop classifier only.
   */
  suspendForPlayback() {
    this._playbackSuspendCount++;
    if (this._playbackSuspendCount > 1) return; // already suspended by another source
    // Kiosk Satellite owns detection: disarm it for exactly the window the
    // browser engine would have sat inactive, so the tablet isn't listening
    // for its wake word while its own speaker is answering. The stop
    // classifier stays armed - it is the only thing that should hear playback.
    if (this._session._nativeWakeActive) {
      kiosk.setNativeWakeWordActive(false);
      this._log.log('wake-word', 'Suspended for playback (Kiosk Satellite)');
      return;
    }
    this._suspendedActiveBeforePlayback = this._active;
    if (this._active) {
      this._active = false;
      this._sampleBufLen = 0;
      this._frameQueue.length = 0;
      this._processing = false;
      if (this._inference?.reset) this._inference.reset();
    }
    this._log.log('wake-word', 'Suspended for playback');
  }

  /**
   * Resume wake-word inference after speaker playback ends.  No-op if
   * stop-only mode took over during playback - disableStopModel handles
   * that path on its own and restores _active correctly.  Refcounted -
   * only takes effect on the 1→0 transition so overlapping sources
   * (TTS + chime, two chimes) don't unsuspend mid-playback.
   */
  resumeFromPlayback() {
    if (this._playbackSuspendCount === 0) return; // unbalanced resume - ignore
    this._playbackSuspendCount--;
    if (this._playbackSuspendCount > 0) return; // still suspended by another source
    if (this._session._nativeWakeActive) {
      this._maybeRearmNativeWake();
      this._log.log('wake-word', 'Resumed after playback (Kiosk Satellite)');
      return;
    }
    if (this._stopOnlyMode) {
      // disableStopModel will set _active based on isOnDeviceWakeEnabled.
      this._suspendedActiveBeforePlayback = null;
      return;
    }
    this._active = !!this._suspendedActiveBeforePlayback;
    this._suspendedActiveBeforePlayback = null;
    this._sampleBufLen = 0;
    this._frameQueue.length = 0;
    this._processing = false;
    if (this._inference?.reset) this._inference.reset();
    this._log.log('wake-word', 'Resumed after playback');
  }

  /**
   * Handle stop word detection - cancel the current interruptible state.
   * Priority chain matches DoubleTapHandler._cancel().
   */
  async _onStopDetection() {
    const session = this._session;
    this._log.log('stop-word', 'Stop detected');

    // Disable stop model first
    this.disableStopModel();

    // 1. Timer alert - highest priority
    if (session.timer.alertActive) {
      this._log.log('stop-word', 'Dismissing timer alert');
      session.timer.dismissAlert();
      // Timer's clearAlert disables the stop model; re-arm it for any
      // media that's still playing in the background.
      session.mediaPlayer.refreshStopWord();
      return;
    }

    // 2a. Show is active (its own dismiss flow - uses PIPELINE blur and the
    //     pipeline-driven assistant bubble, not announcement-style UI).
    if (session.show?.active) {
      this._log.log('stop-word', 'Dismissing show');
      session.show.dismiss();
      session.mediaPlayer.refreshStopWord();
      return;
    }

    // 2b. Notification playing (announcement / ask-question / start-conversation)
    const isNotification = session.announcement.playing
      || session.askQuestion.playing
      || session.startConversation.playing
      || session.announcement.clearTimeoutId
      || session.startConversation.clearTimeoutId;

    if (isNotification) {
      this._log.log('stop-word', 'Dismissing notification');
      for (const mgr of [session.announcement, session.askQuestion, session.startConversation]) {
        if (!mgr.playing && !mgr.clearTimeoutId) continue;
        if (mgr.currentAnnounceId) {
          sendAck(session, mgr.currentAnnounceId, 'stop-word');
        }
        if (mgr.currentAudio) {
          mgr.currentAudio.onended = null;
          mgr.currentAudio.onerror = null;
          mgr.currentAudio.pause();
          mgr.currentAudio.src = '';
          mgr.currentAudio = null;
        }
        mgr.playing = false;
        mgr.currentAnnounceId = null;
        mgr.queued = null;
        clearNotificationUI(mgr);
      }
      session.askQuestion.cancel();
      session.chat.clear();
      session.ui.clearNotificationStatusOverride();
      // Resume media that was paused for the notification.
      session.mediaPlayer.resumeAfterInterrupt();

      if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
        session.tts.playChime('done');
      }
      session.pipeline.restart(0);
      return;
    }

    // 3. Active voice interaction (TTS playing or pipeline interacting)
    const isInteracting = session.tts.isPlaying
      || INTERACTING_STATES.includes(session.currentState);
    if (isInteracting) {
      this._log.log('stop-word', 'Cancelling interaction');

      if (session._imageLingerTimeout) {
        clearTimeout(session._imageLingerTimeout);
        session._imageLingerTimeout = null;
      }

      session.tts.stop();

      session.askQuestion.cancel();
      session.pipeline.clearContinueState();
      session.setState(State.IDLE);
      session.chat.clear();
      session.ui.hideBlurOverlay(BlurReason.PIPELINE);
      session.ui.updateForState(State.IDLE, session.pipeline.serviceUnavailable, false);
      // Resume media that was paused at the start of the interaction.
      session.mediaPlayer.resumeAfterInterrupt();

      if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
        session.tts.playChime('done');
      }
      session.pipeline.restart(0);
      return;
    }

    // 4. Media playback - fallback when nothing else is active.
    if (session.mediaPlayer.isPlaying) {
      this._log.log('stop-word', 'Stopping media playback');
      session.mediaPlayer.stop();
      if (getSwitchState(session.hass, session.config.satellite_entity, 'wake_sound') !== false) {
        session.tts.playChime('done');
      }
      return;
    }

    this._log.log('stop-word', 'Nothing to cancel');
  }

  // ─── Restart / settings ─────────────────────────────────────────────

  /**
   * Restart wake word detection (e.g. after pipeline completes).
   */
  async restart() {
    if (!this.isEnabled() || this._resetting) return;

    // If models changed while paused, do a full start
    const activeModels = this.getActiveModels();
    const modelsKey = activeModels.slice().sort().join(',');
    if (!this._inference || this._loadedModelsKey !== modelsKey) {
      this._log.log('wake-word', 'Restarting with model reload');
      await this.start();
      return;
    }

    this._log.log('wake-word', 'Restarting detection');
    this._sampleBufLen = 0;
    this._frameQueue.length = 0;
    this._processing = false;
    this._inference.updateEnergyThresholds(this._getSensitivityLabel());
    const updates = this.getEngine() === 'mww'
      ? activeModels.map((name) => ({ name }))
      : activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) }));
    this._inference.updateThresholds(updates);
    this._inference.reset();
    this._active = true;
  }

  /**
   * Check for wake word setting changes and react.
   * Called from session.updateHass() on every HA state change.
   */
  checkSettingsChanged() {
    if (!this._session._hasStarted || this._switching) return;

    const enabled = this.isEnabled();
    const engine = this.getEngine();
    // The raw select, not getEngine(): under the Kiosk Satellite handoff
    // getEngine() is pinned to null and isEnabled() to false (the app owns
    // detection), so an engine switch would be invisible to the checks below.
    const mode = this._wakeMode();
    // Likewise the raw Sensitivity select: getThreshold() below resolves it
    // through getEngine(), which the handoff pins to null, so it cannot see a
    // sensitivity change while the app owns detection.
    const sensitivity = this._getSensitivityLabel();
    const model = this.getModelName();
    const model2 = this.getModel2Name();
    const threshold = this.getThreshold();
    const noiseGate = this._isNoiseGateEnabled();
    const stopWord = this.isStopWordEnabled();

    // Initialize cache on first call
    if (this._cachedEnabled === undefined) {
      this._cachedEnabled = enabled;
      this._cachedEngine = engine;
      this._cachedMode = mode;
      this._cachedSensitivity = sensitivity;
      this._cachedModel = model;
      this._cachedModel2 = model2;
      this._cachedThreshold = threshold;
      this._cachedNoiseGate = noiseGate;
      this._cachedStopWord = stopWord;
      return;
    }

    const enabledChanged = enabled !== this._cachedEnabled;
    // Engine flip (MWW ↔ OWW) without changing the enabled bit needs a
    // full inference rebuild - same code path as a model change.
    const engineChanged = engine !== this._cachedEngine;
    const modeChanged = mode !== this._cachedMode;
    const sensitivityChanged = sensitivity !== this._cachedSensitivity;
    const modelChanged = model !== this._cachedModel;
    const model2Changed = model2 !== this._cachedModel2;
    const thresholdChanged = threshold !== this._cachedThreshold;
    const noiseGateChanged = noiseGate !== this._cachedNoiseGate;
    const stopWordChanged = stopWord !== this._cachedStopWord;

    if (!enabledChanged && !engineChanged && !modeChanged && !sensitivityChanged && !modelChanged && !model2Changed && !thresholdChanged && !noiseGateChanged && !stopWordChanged) return;

    // Always update caches
    this._cachedEngine = engine;
    this._cachedMode = mode;
    this._cachedSensitivity = sensitivity;
    this._cachedModel2 = model2;
    this._cachedThreshold = threshold;
    this._cachedNoiseGate = noiseGate;
    this._cachedStopWord = stopWord;

    // Live threshold / noise gate update (no restart needed)
    if ((thresholdChanged || noiseGateChanged) && !modelChanged && this._active && this._inference) {
      if (thresholdChanged) {
        const activeModels = this.getActiveModels();
        this._inference.updateEnergyThresholds(this._getSensitivityLabel());
        const updates = this.getEngine() === 'mww'
          ? activeModels.map((name) => ({ name }))
          : activeModels.map((name) => ({ name, threshold: this.getThresholdForModel(name) }));
        this._inference.updateThresholds(updates);
      }
      if (noiseGateChanged) {
        this._inference.setEnergyGateEnabled(noiseGate);
      }
      this._log.log('wake-word', `Settings updated${noiseGateChanged ? ` (noise gate: ${noiseGate ? 'on' : 'off'})` : ''}`);
    }

    if (stopWordChanged) {
      this._log.log('stop-word', `Setting changed: ${stopWord ? 'enabled' : 'disabled'}`);
    }

    if (stopWordChanged && !stopWord) {
      this.disableStopModel({ log: false });
      this._log.log('stop-word', 'Disabled in satellite settings');
      // When wake mode is HA or Disabled, stop-word was the only reason
      // the local runtime existed. Tear it down so the user pays zero
      // local CPU/RAM cost again, matching the performance contract.
      if (!this.isOnDeviceWakeEnabled()) {
        this._releaseLocalRuntime('stop-word disabled');
      }
    }

    // Kiosk Satellite owns detection and only reads config when it starts, so
    // every setting it was handed has to be re-pushed: a new wake word, the
    // second slot, the stop-word switch, or the engine select itself. If the
    // new engine is not one it runs natively, the re-negotiation hands the mic
    // back and we re-run so the browser paths below see the real engine (they
    // are blind to it while the handoff is up).
    //
    // Hook rather than an import: native-handoff.js already imports this
    // module, and a cycle here would be resolved at load time.
    // Runs whether or not the handoff is currently up: switching *back* to a
    // natively-runnable engine has to re-establish it, not just switching away.
    if ((stopWordChanged || modeChanged || sensitivityChanged || noiseGateChanged
      || modelChanged || model2Changed)
      && (this._session._nativeWakeActive || kiosk.platform() === 'kiosksatellite')) {
      const wasNative = this._session._nativeWakeActive === true;
      // Own the caches _applyModeOrModelChange would normally update: we
      // return before it, and leaving them stale re-fires this branch on every
      // single HA state change.
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      this._log.log('wake-word', 'Settings changed - re-negotiating with Kiosk Satellite');
      Promise.resolve(this._session._setupNativeWake?.({ force: true }))
        .then((isNative) => {
          if (isNative && !wasNative) {
            // The app just took detection over mid-session. Free the browser
            // runtime that was doing it until a moment ago, or both would run,
            // and give up the mic: the app owns it now and the browser must
            // look exactly as it does after a fresh start into the handoff
            // (no local engine, no passive mic, waiting for a wake event).
            this._releaseLocalRuntime('handed off to Kiosk Satellite');
            const session = this._session;
            try { session.pipeline.stop(); } catch (_) { /* ignore */ }
            try { session.audio.stopMicrophone(); } catch (_) { /* ignore */ }
            session.setState(State.IDLE);
            // Adopt the handoff's view of the world. getEngine()/isEnabled()
            // flip to null/false the moment it engages, and the caches were
            // filled a tick earlier when they still read the real engine: left
            // alone, the next HA state change reads that as "the user switched
            // to Home Assistant mode" and starts a server pipeline underneath
            // the app.
            this._cachedEnabled = this.isEnabled();
            this._cachedEngine = this.getEngine();
          } else if (wasNative) {
            // The app handed the mic back (an engine it cannot run, or
            // detection turned off). Run the full start path: the browser now
            // needs its own capture, and it has had none for as long as the
            // app owned detection.
            Promise.resolve(this._session._restartListening?.())
              .then(() => {
                // Adopt what we ended up with, or the next HA state change
                // sees engine null -> 'mww' and restarts it all over again.
                this._cachedEnabled = this.isEnabled();
                this._cachedEngine = this.getEngine();
                this._cachedModel = this.getModelName();
              })
              .catch((e) => {
                this._log.error('wake-word', `Restart after handoff ended failed: ${e.message || e}`);
              });
          }
        })
        .catch((e) => {
          this._log.error('wake-word', `Native re-negotiation failed: ${e.message || e}`);
        });
      return;
    }

    if (stopWordChanged && stopWord && !this.isOnDeviceWakeEnabled() && !this._tfweb) {
      // HA / Disabled wake mode + stop word just turned ON: bring up the
      // runtime in standby so subsequent enableStopModel(true) calls
      // (during TTS, notifications, alerts) have an inference engine to
      // attach to.
      this._log.log('wake-word', 'Stop-word on without on-device wake - loading runtime to standby');
      this.start().catch((e) => {
        this._log.error('wake-word', `Standby start failed: ${e.message || e}`);
      });
    }

    // Mode, engine, or model change requires switching.  Slot-2 swaps
    // count as a model change since the active-models set shifts; engine
    // flips force a full inference rebuild because MWW and OWW share no
    // runtime state.
    if (enabledChanged || engineChanged || modelChanged || model2Changed) {
      this._applyModeOrModelChange(enabled, model, enabledChanged || engineChanged);
    }
  }

  /**
   * Apply a detection mode or model change.
   */
  async _applyModeOrModelChange(enabled, model, enabledChanged) {
    const session = this._session;

    // Only switch while waiting for wake word, not mid-interaction.
    if (![State.LISTENING, State.IDLE, State.PAUSED].includes(session.currentState)) {
      this._log.log('wake-word', 'Settings changed during interaction - will apply on next cycle');
      return;
    }

    this._switching = true;
    try {
      if (enabledChanged) {
        if (enabled) {
          this._log.log('wake-word', `Mode → on-device (${this.getEngine()})`);
          session.pipeline.stop();
          if (session.currentState !== State.PAUSED) {
            await this.start();
          }
        } else {
          // Off can mean either Home Assistant (server pipeline takes over)
          // or Disabled (mic stays off until voice_satellite.wake fires).
          const disabled = getSelectState(
            session.hass, session.config.satellite_entity,
            'wake_word_detection', 'Home Assistant',
          ) === 'Disabled';
          this._log.log(
            'wake-word',
            disabled
              ? 'Mode → Disabled - releasing models and stopping mic'
              : 'Mode → Home Assistant - releasing models',
          );
          this.stop();
          this._destroyInference('mode-switch');
          this._loadedModelsKey = null;
          this._stopMicroConfig = null;
          await resetRuntime();
          this._tfweb = null;
          if (session.currentState !== State.PAUSED) {
            if (disabled) {
              try { session.audio.stopMicrophone(); } catch (_) { /* ignore */ }
              session.setState(State.IDLE);
            } else {
              session.setState(State.CONNECTING);
              await session.pipeline.start();
            }
            // Stop-word standby covers both transitions (On Device → HA
            // and On Device → Disabled): if the user has it enabled, the
            // local runtime returns in standby for TTS / alert windows.
            if (this.isStopWordEnabled()) {
              this.start().catch((e) => {
                this._log.error('wake-word', `Stop-word standby start failed: ${e.message || e}`);
              });
            }
          }
        }
      } else if (this._active || session.currentState === State.PAUSED) {
        // Model changed while actively listening (or paused)
        this._log.log('wake-word', `Model → ${model}`);
        this.stop();
        if (session.currentState !== State.PAUSED) {
          await this.start();
        }
      }

      // Update cache after successful apply
      this._cachedEnabled = enabled;
      this._cachedModel = model;
    } catch (e) {
      this._log.error('wake-word', `Settings change failed: ${e.message || e}`);
      this._cachedEnabled = enabled;
      this._cachedModel = model;
      session.pipeline.restart(session.pipeline.calculateRetryDelay());
    } finally {
      this._switching = false;
    }
  }

  /**
   * Release all resources.
   */
  async teardown() {
    this.stop();
    if (this._stopMicroConfig) {
      this._log.log('stop-word', 'Stop model unloaded');
      this._stopMicroConfig = null;
    }
    this._destroyInference('teardown');
    this._loadedModelsKey = null;
    try {
      await resetRuntime();
      this._tfweb = null;
    } catch (_) { /* ignore */ }
  }
}
