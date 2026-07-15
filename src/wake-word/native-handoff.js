/**
 * Kiosk Satellite native wake-word handoff.
 *
 * When the card runs inside the Kiosk Satellite companion app, wake-word
 * detection can run in native code (the vsWakeWord ONNX engine on the CPU)
 * instead of the in-browser WebGPU/WASM runner: dramatically faster on
 * tablets, and it keeps working with the screen off.
 *
 * The handoff is **transparent**: the user changes nothing in Voice
 * Satellite. They pick their engine as usual (`On Device (vsWakeWord)`);
 * if the card detects it is hosted in Kiosk Satellite AND the app reports
 * it can run that engine natively AND wake-word detection is enabled in
 * the app's own settings, the card hands detection over. Otherwise it
 * silently keeps using its own browser engine.
 *
 * Once handed off, the browser side behaves exactly as if detection were
 * "Disabled" (no passive mic, no local engine) because the app owns
 * detection. Wake arrives as a `kiosksatellite:wakeword` event and is
 * routed into the same path `voice_satellite.wake` uses, which brings the
 * mic up for STT. `session._nativeWakeActive` is the flag the rest of the
 * card keys off (see getWakeWordMode / _isDetectionDisabled / getEngine).
 *
 * Everything here is a no-op on every other host.
 */

import * as kiosk from '../kiosk/index.js';
import { getSelectState, getSwitchState } from '../shared/satellite-state.js';
import { withWakeWordAssetVersion } from './versioned-url.js';
import { wakeWordPhraseFor } from './index.js';
import { vwwConfidenceScaleFor, vwwEnergyGateFor } from './vww/sensitivity.js';
import { owwThresholdFor } from './oww/sensitivity.js';

let _active = false;
let _stopActive = false;

/** vsWakeWord's stop classifier, mirroring VWW_STOP_NAME in ./index.js. */
const VWW_STOP_NAME = 'ok_stop';

/**
 * Map the selected detection mode to an engine Kiosk Satellite can run
 * natively. Returns null when the browser should keep detection: either a
 * non-on-device mode, or an engine the app has no native runner for
 * (openWakeWord today; it stays in the browser until the app implements it, at
 * which point it just starts working).
 *
 * Naming this here is only half the negotiation: the app still answers
 * `available:false` if it cannot actually run the engine, so an older app that
 * predates its microWakeWord runner keeps browser detection by itself.
 */
export function nativeEngineFor(session) {
  const raw = getSelectState(
    session.hass, session.config.satellite_entity,
    'wake_word_detection', 'Home Assistant',
  );
  if (raw === 'On Device (vsWakeWord)') return 'vsWakeWord';
  if (raw === 'On Device (microWakeWord)') return 'microWakeWord';
  if (raw === 'On Device (openWakeWord)') return 'openWakeWord';
  return null;
}

/**
 * Where each engine's models live. vsWakeWord has its own subdirectory;
 * microWakeWord sits at the root of the models path (see micro-models.js).
 */
function modelsBase(engine) {
  if (engine === 'microWakeWord') return '/voice_satellite/models';
  if (engine === 'openWakeWord') {
    return globalThis.__VS_OWW_MODELS_BASE || '/voice_satellite/models/openwakeword';
  }
  return globalThis.__VS_VWW_MODELS_BASE || '/voice_satellite/models/vswakeword';
}

/** The stop classifier's model name for an engine. Mirrors getStopName(). */
function stopNameFor(engine) {
  return engine === 'vsWakeWord' ? VWW_STOP_NAME : 'stop';
}

/**
 * Absolute URL identifying a model (what the app downloads).
 *
 * microWakeWord and vsWakeWord ship a `.json` manifest next to their weights,
 * and the app derives the weights URL from it. openWakeWord ships no manifest
 * at all - its cutoff is the card's policy, sent as `cutoff` below - so the
 * URL points straight at the classifier, and the app reads the two shared
 * models (melspectrogram, embedding) out of the same directory.
 */
function manifestUrlFor(name, engine) {
  const ext = engine === 'openWakeWord' ? 'onnx' : 'json';
  const rel = withWakeWordAssetVersion(`${modelsBase(engine)}/${name}.${ext}`);
  try {
    return new URL(rel, window.location.origin).href;
  } catch (_) {
    return rel;
  }
}

/** Selected wake-word model names (slot 1 always, slot 2 when distinct). */
function activeModels(session) {
  const ent = session.config.satellite_entity;
  const primary = getSelectState(session.hass, ent, 'wake_word_model', 'ok_nabu');
  const raw2 = getSelectState(session.hass, ent, 'wake_word_model_2', 'Disabled');
  const secondary = !raw2 || raw2 === 'Disabled' || raw2 === primary ? null : raw2;
  return secondary ? [primary, secondary] : [primary];
}

/** Whether the native handoff is currently driving wake detection. */
export function isNativeWakeActive() {
  return _active;
}

/** Whether the app is running the stop classifier natively too. */
export function isNativeStopActive() {
  return _stopActive;
}

/**
 * The stop classifier to hand over, or null when the stop-word switch is off.
 * vsWakeWord ships it as a self-contained ONNX named after its phrase, so it
 * loads exactly like a wake word: same manifest shape, same URL layout.
 */
function stopModelFor(session, engine) {
  const on = getSwitchState(
    session.hass, session.config.satellite_entity, 'stop_word',
  ) === true;
  if (!on) return null;
  const name = stopNameFor(engine);
  return {
    id: name,
    wakeWord: wakeWordPhraseFor(name),
    manifestUrl: manifestUrlFor(name, engine),
    confidenceScale: confidenceScaleFor(session, { stop: true }),
    ...cutoffFor(session, engine, { stop: true }),
  };
}

/** The Sensitivity select, which the app never reads for itself. */
function sensitivityLabel(session) {
  return getSelectState(
    session.hass, session.config.satellite_entity,
    'wake_word_sensitivity', 'Moderately sensitive',
  );
}

/**
 * The confidence-gate scale for the current Sensitivity setting.
 *
 * Resolved here and reported to the app rather than sending it the label:
 * sensitivity is Voice Satellite's policy, and the mapping from a label to a
 * factor must exist in exactly one place. The app just multiplies the gates in
 * its manifests by what we hand it, so a change to the tables ships with the
 * card and needs no app update.
 */
function confidenceScaleFor(session, { stop = false } = {}) {
  return vwwConfidenceScaleFor(sensitivityLabel(session), { stop });
}

/**
 * The resolved energy gate to hand the app: skip inference while the room is
 * quiet. Same reasoning as the confidence scale - the app is told the numbers,
 * never the Sensitivity label or the noise_gate switch, so the policy stays
 * here. Worth more on the app side than in the browser: it is listening around
 * the clock on battery.
 */
/**
 * openWakeWord's absolute cutoff, already moved by the Sensitivity setting.
 *
 * Sent only for openWakeWord, and for the same reason the VWW scale is sent:
 * the policy is the card's. The difference is that OWW has no manifest for the
 * app to scale, so we hand it the finished number instead of a multiplier.
 */
function cutoffFor(session, engine, { stop = false } = {}) {
  if (engine !== 'openWakeWord') return {};
  return { cutoff: owwThresholdFor(sensitivityLabel(session), { stop }) };
}

function energyGateFor(session) {
  const enabled = getSwitchState(
    session.hass, session.config.satellite_entity, 'noise_gate',
  ) === true;
  return vwwEnergyGateFor(sensitivityLabel(session), enabled);
}

/**
 * Try to hand wake-word detection to Kiosk Satellite. Returns true when the
 * app has taken over (and the browser should stay idle). Safe to call on any
 * host; returns false unless the handoff actually engaged.
 */
export async function setupNativeWakeHandoff(session, { force = false } = {}) {
  // Already handed off: re-pushing on every startListening would restart the
  // app's engine for nothing. `force` is for a real config change (a new wake
  // word, the engine select, the stop-word switch), where the app does need to
  // hear about it - and where the answer may now be "not natively runnable",
  // in which case we hand the mic back below.
  if (_active && !force) return true;
  if (kiosk.platform() !== 'kiosksatellite' || !kiosk.supportsNativeWakeWord()) {
    return false;
  }

  // Muted is a hard mic-off, and an engine we can't run natively means the
  // browser is taking detection back. Either way the app must stop capturing:
  // pausing is not enough, since that deliberately keeps its mic open.
  const muted = getSwitchState(
    session.hass, session.config.satellite_entity, 'mute',
  ) === true;
  const engine = muted ? null : nativeEngineFor(session);
  if (!engine) {
    if (_active) {
      session.logger?.log(
        'wake-word',
        muted
          ? 'Muted - releasing the microphone on Kiosk Satellite'
          : 'Wake word engine is no longer one Kiosk Satellite runs - taking detection back',
      );
      teardownNativeWakeHandoff(session, muted ? 'muted' : 'browser');
    }
    return false;
  }

  const scale = confidenceScaleFor(session);
  const models = activeModels(session).map((name) => ({
    id: name,
    wakeWord: wakeWordPhraseFor(name),
    manifestUrl: manifestUrlFor(name, engine),
    confidenceScale: scale,
    ...cutoffFor(session, engine),
  }));

  // The app answers false when wake word detection is turned off in its own
  // settings, or it has no native runner for this engine. Either way the
  // browser transparently keeps doing detection itself.
  const stopModel = stopModelFor(session, engine);
  const energyGate = energyGateFor(session);
  const { available, stopWordAvailable } = await kiosk.configureNativeWakeWord({
    engine,
    models,
    energyGate,
    ...(stopModel ? { stopModel } : {}),
  });
  if (!available) {
    session.logger?.log(
      'wake-word',
      `Kiosk Satellite cannot run ${engine} natively (disabled in the app or unsupported) - using browser detection`,
    );
    return false;
  }

  kiosk.bindNativeWakeWord((detail) => {
    // Engine-agnostic, exactly like the browser path: the app guarantees the
    // stream opens after the wake word, whatever engine detected it. Engines
    // that can locate the wake word's end (vsWakeWord) simply lose less of the
    // command than ones that can only trim to the detection instant, which is
    // the same trade the browser makes.
    const seamless = session.config.seamless_wake_command === true;
    session.logger?.log(
      'wake-word',
      `Kiosk Satellite native wake: ${detail.phrase || detail.model || '(unknown)'}${seamless ? ' (seamless)' : ''}`,
    );
    // The app suspends its engine on detection; drive the turn exactly like
    // the wake service does. Resume happens on the return to idle.
    //
    // Seamless one-shot phrases work better here than in the browser: the app
    // starts the stream at the exact sample the wake word ended, so the
    // command that followed it is complete rather than clipped by however long
    // detection took to settle.
    session.onWakeAction({
      // A real wake word, not the wake service: the turn gets the chime
      // deferral and cross-tablet dedupe the browser path uses.
      detected: true,
      seamless,
      wakeWordPhrase: detail.phrase || wakeWordPhraseFor(detail.model),
      wakeWordSlot: session.wakeWord?.getSlotForModel?.(detail.model),
    });
  });
  // Stop word is negotiated separately: the app may run the wake engine but
  // not the stop classifier (older build, download failed). When it does run
  // it, the browser loads no stop model at all - which is the point, since
  // under the handoff the browser has no mic to feed one.
  _stopActive = !!stopModel && !!stopWordAvailable;
  session._nativeStopActive = _stopActive;
  if (_stopActive) {
    kiosk.bindNativeStopWord(() => {
      session.logger?.log('stop-word', 'Kiosk Satellite native stop word');
      session.wakeWord?.onNativeStopDetection?.();
    });
  } else if (stopModel) {
    session.logger?.log(
      'stop-word',
      'Kiosk Satellite cannot run the stop word natively - using browser detection',
    );
  }

  await kiosk.setNativeWakeWordActive(true);

  _active = true;
  session._nativeWakeActive = true;
  session.logger?.log(
    'wake-word',
    `Wake word detection handed off to Kiosk Satellite (${engine}: ${models.map((m) => m.id).join(', ')}`
    + `${_stopActive ? ' + stop word' : ''}, ${sensitivityLabel(session)}, conf gate scale x${scale.toFixed(2)}`
    + `, energy gate ${energyGate.enabled ? `on (wake rms ${energyGate.wakeRms})` : 'off'})`,
  );
  return true;
}

/**
 * Resume native listening after a turn (no-op unless handoff is active).
 *
 * The pipeline goes idle the moment TTS *starts* playing, not when it
 * finishes, so this must not re-arm while playback holds the suspend: doing so
 * would leave the wake word live for the whole spoken answer, listening to our
 * own speaker. resumeFromPlayback() re-arms when playback actually ends.
 */
export async function resumeNativeWake(session) {
  if (!_active) return;
  if (session?.wakeWord?.isNativeWakeSuspended) return;
  await kiosk.setNativeWakeWordActive(true);
}

/**
 * Tear down the handoff (page unload / host change).
 *
 * `reason` reaches the app and is shown to whoever looks at its wake-word
 * state: 'muted' when the satellite is muted, 'browser' when detection is
 * coming back here. We are the only ones who know which, so passing it is not
 * a nicety - without it the app can only say "the microphone was released",
 * and its UI has to guess (it guessed "no native runner", which was a lie).
 */
export function teardownNativeWakeHandoff(session, reason = null) {
  if (!_active) return;
  kiosk.unbindNativeWakeWord();
  // Release, not just suspend: whoever ends the handoff wants the mic closed
  // (muted, or the browser is about to open its own capture for detection).
  kiosk.releaseNativeWakeWord(reason);
  if (_stopActive) {
    kiosk.setNativeStopWordActive(false);
    kiosk.unbindNativeStopWord();
    _stopActive = false;
  }
  _active = false;
  if (session) {
    session._nativeWakeActive = false;
    session._nativeStopActive = false;
  }
}
