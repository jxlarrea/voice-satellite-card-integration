/**
 * Kiosk Satellite native wake-word handoff.
 *
 * When the card runs inside the Kiosk Satellite companion app, wake-word
 * detection can run in native code (the vsWakeWord ONNX engine on the CPU)
 * instead of the in-browser WebGPU/WASM runner — dramatically faster on
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
 * "Disabled" — no passive mic, no local engine — because the app owns
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

let _active = false;

/**
 * Map the selected detection mode to an engine Kiosk Satellite can run
 * natively. Returns null when the browser should keep detection — either a
 * non-on-device mode, or an engine the app has no native runner for (today
 * only vsWakeWord; microWakeWord/openWakeWord stay in the browser until the
 * app implements them, at which point they just start working).
 */
function nativeEngineFor(session) {
  const raw = getSelectState(
    session.hass, session.config.satellite_entity,
    'wake_word_detection', 'Home Assistant',
  );
  if (raw === 'On Device (vsWakeWord)') return 'vsWakeWord';
  return null;
}

function modelsBase() {
  return globalThis.__VS_VWW_MODELS_BASE || '/voice_satellite/models/vswakeword';
}

/** Absolute manifest URL for a vsWakeWord model (what the app downloads). */
function manifestUrlFor(name) {
  const rel = withWakeWordAssetVersion(`${modelsBase()}/${name}.json`);
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

/**
 * Try to hand wake-word detection to Kiosk Satellite. Returns true when the
 * app has taken over (and the browser should stay idle). Safe to call on any
 * host; returns false unless the handoff actually engaged.
 */
export async function setupNativeWakeHandoff(session) {
  if (_active) return true;
  if (kiosk.platform() !== 'kiosksatellite' || !kiosk.supportsNativeWakeWord()) {
    return false;
  }
  // Muted is a hard mic-off: don't hand off, the session stays silent.
  const muted = getSwitchState(
    session.hass, session.config.satellite_entity, 'mute',
  ) === true;
  if (muted) return false;

  const engine = nativeEngineFor(session);
  if (!engine) return false;

  const models = activeModels(session).map((name) => ({
    id: name,
    wakeWord: wakeWordPhraseFor(name),
    manifestUrl: manifestUrlFor(name),
  }));

  // The app answers false when wake word detection is turned off in its own
  // settings, or it has no native runner for this engine. Either way the
  // browser transparently keeps doing detection itself.
  const { available } = await kiosk.configureNativeWakeWord({ engine, models });
  if (!available) {
    session.logger?.log(
      'wake-word',
      `Kiosk Satellite cannot run ${engine} natively (disabled in the app or unsupported) - using browser detection`,
    );
    return false;
  }

  kiosk.bindNativeWakeWord((detail) => {
    session.logger?.log(
      'wake-word',
      `Kiosk Satellite native wake: ${detail.phrase || detail.model || '(unknown)'}`,
    );
    // The app suspends its engine on detection; drive the turn exactly like
    // the wake service does. Resume happens on the return to idle.
    session.onWakeAction();
  });
  await kiosk.setNativeWakeWordActive(true);

  _active = true;
  session._nativeWakeActive = true;
  session.logger?.log(
    'wake-word',
    `Wake word detection handed off to Kiosk Satellite (${engine}: ${models.map((m) => m.id).join(', ')})`,
  );
  return true;
}

/** Resume native listening after a turn (no-op unless handoff is active). */
export async function resumeNativeWake() {
  if (!_active) return;
  await kiosk.setNativeWakeWordActive(true);
}

/** Tear down the handoff (page unload / host change). */
export function teardownNativeWakeHandoff(session) {
  if (!_active) return;
  kiosk.unbindNativeWakeWord();
  kiosk.setNativeWakeWordActive(false);
  _active = false;
  if (session) session._nativeWakeActive = false;
}
