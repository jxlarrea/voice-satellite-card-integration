/**
 * openWakeWord sensitivity policy.
 *
 * Unlike VWW (which scales manifest-declared confidence gates by a factor),
 * OWW models ship no manifest at all: the cutoff is entirely the card's, and
 * the Sensitivity select moves it by an absolute offset.  Wake words sit at
 * 0.5 (matching `rhasspy/pyopen-wakeword` and the HA OWW addon); stop is
 * bumped to 0.65 because the community stop classifier produces noisier output
 * and false-positives on low-amplitude speech.  +/-0.15 wake and +/-0.05 stop
 * keep the slider meaningful without saturating the [0.1, 0.99] clamp.
 *
 * Lives in its own module so two consumers can share one source of truth: the
 * in-browser OWW backend, and the Kiosk Satellite handoff, which resolves the
 * number here and reports it to the app. The app never sees the label.
 */

export const OWW_WAKE_BASE = 0.5;
export const OWW_STOP_BASE = 0.65;

export const OWW_WAKE_SENSITIVITY_OFFSETS = {
  'Slightly sensitive': 0.10, // raises cutoff to 0.6 (harder to trigger)
  'Moderately sensitive': 0.00,
  'Very sensitive': -0.10, // lowers cutoff to 0.4 (easier to trigger)
};

export const OWW_STOP_SENSITIVITY_OFFSETS = {
  'Slightly sensitive': 0.05,
  'Moderately sensitive': 0.00,
  'Very sensitive': -0.05,
};

/**
 * The resolved detection cutoff for an OWW model at the given Sensitivity.
 *
 * @param {string} sensitivityLabel
 * @param {{stop?: boolean}} [opts]
 * @returns {number} absolute cutoff in [0.1, 0.99]
 */
export function owwThresholdFor(sensitivityLabel, { stop = false } = {}) {
  const base = stop ? OWW_STOP_BASE : OWW_WAKE_BASE;
  const offsets = stop ? OWW_STOP_SENSITIVITY_OFFSETS : OWW_WAKE_SENSITIVITY_OFFSETS;
  const offset = offsets[sensitivityLabel] ?? 0;
  return Math.max(0.1, Math.min(base + offset, 0.99));
}
