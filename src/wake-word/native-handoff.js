/**
 * Kiosk Satellite native wake-word handoff.
 *
 * When the card runs inside the Kiosk Satellite companion app, wake-word
 * detection can run in native code (the vsWakeWord ONNX engine on the CPU)
 * instead of the in-browser WebGPU/WASM runner — far faster on tablets. This
 * module wires that up on top of the existing "Disabled" wake mode, which is
 * exactly the state native handoff needs: the browser never opens the mic for
 * passive listening, and a wake is delivered on demand and jumps to STT.
 *
 * Flow:
 *   - On startup in Disabled mode, if Kiosk Satellite reports a native runner
 *     for vsWakeWord, push the configured wake words to the app and bind its
 *     `kiosksatellite:wakeword` event to the same manual-wake path the
 *     `voice_satellite.wake` service uses (`session.onWakeAction()`).
 *   - The native engine suspends itself on detection; the card resumes it when
 *     the turn returns to idle (see resumeNativeWake, called from the pipeline
 *     restart's disabled branch).
 *
 * All of this is a no-op when not inside Kiosk Satellite, so the Disabled mode
 * behaves exactly as before on every other host.
 */

import * as kiosk from '../kiosk/index.js';
import { getSelectState } from '../shared/satellite-state.js';
import { withWakeWordAssetVersion } from './versioned-url.js';
import { wakeWordPhraseFor } from './index.js';

let _active = false;

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
 * Try to hand wake-word detection to Kiosk Satellite. Returns true when
 * native detection is now active (and the browser should stay idle).
 */
export async function setupNativeWakeHandoff(session) {
  if (_active) return true;
  if (kiosk.platform() !== 'kiosksatellite' || !kiosk.supportsNativeWakeWord()) {
    return false;
  }
  const models = activeModels(session).map((name) => ({
    id: name,
    wakeWord: wakeWordPhraseFor(name),
    manifestUrl: manifestUrlFor(name),
  }));

  const { available } = await kiosk.configureNativeWakeWord({
    engine: 'vsWakeWord',
    models,
  });
  if (!available) {
    session.logger?.log(
      'wake-word',
      'Kiosk Satellite present but has no native vsWakeWord runner - staying disabled',
    );
    return false;
  }

  kiosk.bindNativeWakeWord((detail) => {
    session.logger?.log(
      'wake-word',
      `Kiosk Satellite native wake: ${detail.phrase || detail.model || '(unknown)'}`,
    );
    // The native engine suspends itself on detection; drive the turn exactly
    // like the wake service does. Resume happens on return to idle.
    session.onWakeAction();
  });
  await kiosk.setNativeWakeWordActive(true);

  _active = true;
  session._nativeWakeActive = true;
  session.logger?.log(
    'wake-word',
    `Native wake handoff active (${models.map((m) => m.id).join(', ')})`,
  );
  return true;
}

/** Resume native listening after a turn (no-op unless handoff is active). */
export async function resumeNativeWake() {
  if (!_active) return;
  await kiosk.setNativeWakeWordActive(true);
}

/** Tear down the handoff (page unload / leaving Disabled mode). */
export function teardownNativeWakeHandoff(session) {
  if (!_active) return;
  kiosk.unbindNativeWakeWord();
  kiosk.setNativeWakeWordActive(false);
  _active = false;
  if (session) session._nativeWakeActive = false;
}
