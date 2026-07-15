/**
 * VWW sensitivity policy.
 *
 * The Sensitivity select scales the CTC confidence gates: the gates are
 * calibrated between the measured forge band and the real-clip confidence
 * floor, which sit ~10-20% apart, so one notch is +/-10%.  'Slightly' raises
 * the gates toward the real floor (fewer FPs, trims only the faintest wakes),
 * 'Very' lowers them toward the forge band (catches fainter single-window
 * wakes, admits marginal forges).  Stop classifiers get a gentler +/-5% notch,
 * mirroring the OWW/MWW stop tables.
 *
 * required_hits, edit distance, anchors, and trail tolerance are deliberately
 * NOT scaled: those are measured cliffs, not dials (hits=2 collapses
 * degraded-audio recall; ed changes admit whole confusable families).
 *
 * Lives in its own module because two very different consumers need the same
 * numbers: the in-browser VWW backend, and the Kiosk Satellite handoff, which
 * reports the resolved factor to the app so the app never carries a
 * sensitivity table of its own.  The backend is lazily chunked and pulls the
 * whole inference stack, so the handoff must not import it just for a lookup.
 */

export const VWW_SENSITIVITY_CONF_FACTORS = {
  'Slightly sensitive': 1.10,
  'Moderately sensitive': 1.00,
  'Very sensitive': 0.90,
};

export const VWW_STOP_SENSITIVITY_CONF_FACTORS = {
  'Slightly sensitive': 1.05,
  'Moderately sensitive': 1.00,
  'Very sensitive': 0.95,
};

/**
 * The factor every confidence gate of a VWW model is multiplied by for the
 * given Sensitivity label.  Applies to `min_matched_confidence`, each
 * `target_min_matched_confidence`, and `runtime.high_confidence_bypass`.
 *
 * @param {string} sensitivityLabel
 * @param {{stop?: boolean}} [opts] stop classifiers use the gentler table
 * @returns {number}
 */
export function vwwConfidenceScaleFor(sensitivityLabel, { stop = false } = {}) {
  const table = stop ? VWW_STOP_SENSITIVITY_CONF_FACTORS : VWW_SENSITIVITY_CONF_FACTORS;
  return table[sensitivityLabel] ?? 1;
}

/**
 * Energy-gate thresholds per Sensitivity label.  The gate skips inference
 * while the room is quiet, which is most of the time on an always-listening
 * tablet.  `sleep` is vestigial: only `wake` is read.
 */
export const ENERGY_THRESHOLDS = {
  'Slightly sensitive': { sleep: 0.10, wake: 0.12 },
  'Moderately sensitive': { sleep: 0.05, wake: 0.06 },
  'Very sensitive': { sleep: 0.02, wake: 0.025 },
};

export const DEFAULT_ENERGY = ENERGY_THRESHOLDS['Moderately sensitive'];

/** Consecutive sub-threshold chunks before inference sleeps (~2.4 s). */
export const SLEEP_CHUNKS = 30;

/**
 * The resolved energy gate for a Sensitivity label: everything a runner needs
 * to reproduce Voice Satellite's gate without knowing what the label means.
 *
 * @param {string} sensitivityLabel
 * @param {boolean} enabled the per-satellite noise_gate switch
 * @returns {{enabled: boolean, wakeRms: number, sleepAfterChunks: number}}
 */
export function vwwEnergyGateFor(sensitivityLabel, enabled) {
  const energy = ENERGY_THRESHOLDS[sensitivityLabel] || DEFAULT_ENERGY;
  return {
    enabled: !!enabled,
    wakeRms: energy.wake,
    sleepAfterChunks: SLEEP_CHUNKS,
  };
}
