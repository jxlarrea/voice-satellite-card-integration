/**
 * DSP config resolution for mic capture.
 *
 * We maintain TWO sets of Microphone Processing toggles — one for wake-word
 * listening, one for speech-to-text streaming — so users can run raw audio
 * into the wake-word model (matching Voice PE hardware capture, avoiding
 * AGC-induced saturation) while still getting cleaned-up audio for STT.
 *
 * Legacy configs used four shared keys (`noise_suppression`, etc.).  We
 * fall through to those when a mode-specific key is undefined so old
 * saved dashboards keep working.
 */

/** @typedef {'wake_word' | 'stt'} CaptureMode */

/**
 * Resolve four DSP toggles for a given capture mode.  Returns plain bools.
 *
 * @param {object}      config  Panel config object.
 * @param {CaptureMode} mode    Which capture phase we're acquiring mic for.
 * @returns {{ noiseSuppression: boolean, echoCancellation: boolean,
 *             autoGainControl: boolean, voiceIsolation: boolean }}
 */
export function resolveDspForMode(config, mode) {
  const prefix = mode === 'wake_word' ? 'wake_word_' : 'stt_';
  const pick = (key) => {
    // Mode-specific first, then legacy shared key, then undefined (browser
    // default — usually "on" for AGC/NS/EC on Chromium).
    const specific = config[`${prefix}${key}`];
    if (specific === true || specific === false) return specific;
    const shared = config[key];
    if (shared === true || shared === false) return shared;
    return undefined;
  };
  return {
    noiseSuppression: pick('noise_suppression'),
    echoCancellation: pick('echo_cancellation'),
    autoGainControl: pick('auto_gain_control'),
    voiceIsolation: pick('voice_isolation'),
  };
}
