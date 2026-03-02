/**
 * Skin Registry
 *
 * Default skin is bundled; others are lazy-loaded on demand
 * via webpack code splitting to reduce main bundle size.
 */

import { defaultSkin } from './default.js';

/** Metadata for the editor dropdown (no CSS imported). */
const SKIN_META = [
  { value: 'default', label: 'Default' },
  { value: 'alexa', label: 'Alexa' },
  { value: 'google-home', label: 'Google Home' },
  { value: 'home-assistant', label: 'Home Assistant' },
  { value: 'retro-terminal', label: 'Retro Terminal' },
  { value: 'siri', label: 'Siri' },
];

/** Dynamic loaders for non-default skins. */
const SKIN_LOADERS = {
  alexa: () => import(/* webpackChunkName: "skin-alexa" */ './alexa.js'),
  'google-home': () => import(/* webpackChunkName: "skin-google-home" */ './google-home.js'),
  'home-assistant': () => import(/* webpackChunkName: "skin-home-assistant" */ './home-assistant.js'),
  'retro-terminal': () => import(/* webpackChunkName: "skin-retro-terminal" */ './retro-terminal.js'),
  siri: () => import(/* webpackChunkName: "skin-siri" */ './siri.js'),
};

/** Cache of loaded skins. */
const _cache = { default: defaultSkin };

/**
 * Synchronous skin lookup. Returns the cached skin or default as fallback.
 * @param {string} id
 * @returns {object} skin definition
 */
export function getSkin(id) {
  return _cache[id] || defaultSkin;
}

/**
 * Load a skin asynchronously. Returns immediately for default/cached skins.
 * @param {string} id
 * @returns {Promise<object>} skin definition
 */
export async function loadSkin(id) {
  if (_cache[id]) return _cache[id];
  const loader = SKIN_LOADERS[id];
  if (!loader) return defaultSkin;
  try {
    const mod = await loader();
    const skin = Object.values(mod)[0];
    if (!skin || !skin.id || !skin.css) {
      console.warn(`[voice-satellite] Skin "${id}" has invalid structure, using default`);
      return defaultSkin;
    }
    _cache[id] = skin;
    return skin;
  } catch (e) {
    console.warn(`[voice-satellite] Failed to load skin "${id}": ${e.message || e}`);
    return defaultSkin;
  }
}

/**
 * Returns option list for the editor dropdown.
 * @returns {{ value: string, label: string }[]}
 */
export function getSkinOptions() {
  return SKIN_META;
}
