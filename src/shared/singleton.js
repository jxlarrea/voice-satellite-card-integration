/**
 * Voice Satellite Card — Singleton State
 *
 * Manages the single-instance guarantee. Only one card instance
 * can be active at a time (owns the mic + pipeline).
 *
 * Replaces scattered window._voiceSatellite* globals with a
 * module-scoped state object. Uses window namespace to ensure
 * multiple script loads share the same state.
 */

// Use window namespace so multiple bundles share state
if (!window.__vsSingleton) {
  window.__vsSingleton = {
    instance: null,
    active: false,
    starting: false,
  };
}

const state = window.__vsSingleton;

/** @returns {boolean} Whether the given card is (or can be) the owner */
export function isOwner(card) {
  return !state.instance || state.instance === card;
}

/** @returns {boolean} Whether any instance is active */
export function isActive() {
  return state.active;
}

/** @returns {boolean} Whether a startup is in progress */
export function isStarting() {
  return state.starting;
}

/** Mark startup in progress */
export function setStarting(val) {
  state.starting = !!val;
}

/** Claim ownership — called after successful mic + pipeline start */
export function claim(card) {
  state.instance = card;
  state.active = true;
}

/** Release ownership — called when the card is displaced or torn down */
export function release() {
  state.instance = null;
  state.active = false;
  state.starting = false;
}

/**
 * Propagate config to the active instance (when a secondary card updates config).
 * @param {object} card - The card pushing the config change
 */
export function propagateConfig(card) {
  if (state.instance && state.instance !== card) {
    state.instance.setConfig(card.config);
  }
}