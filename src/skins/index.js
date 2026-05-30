/**
 * Skin Registry
 *
 * All skins are bundled with the main card to avoid stale lazy-loaded
 * chunk URLs after HACS updates.
 */

import { defaultSkin } from './default.js';
import { alexaSkin } from './alexa.js';
import { googleHomeSkin } from './google-home.js';
import { homeAssistantSkin } from './home-assistant.js';
import { ensureLensFlaresSkinRuntime, lensFlaresSkin } from './lens-flares.js';
import { retroTerminalSkin } from './retro-terminal.js';
import { siriSkin } from './siri.js';
import { ensureWaveformSkinRuntime, waveformSkin } from './waveform.js';

/** Metadata for the editor dropdown (no CSS imported). */
const SKIN_META = [
  { value: 'default', label: 'Default' },
  { value: 'alexa', label: 'Alexa' },
  { value: 'google-home', label: 'Google Home' },
  { value: 'home-assistant', label: 'Home Assistant' },
  { value: 'lens-flares', label: 'Lens Flares' },
  { value: 'retro-terminal', label: 'Retro Terminal' },
  { value: 'siri', label: 'Siri' },
  { value: 'waveform', label: 'Waveform' },
];

const SKINS = {
  default: defaultSkin,
  alexa: alexaSkin,
  'google-home': googleHomeSkin,
  'home-assistant': homeAssistantSkin,
  'lens-flares': lensFlaresSkin,
  'retro-terminal': retroTerminalSkin,
  siri: siriSkin,
  waveform: waveformSkin,
};

const SKIN_ACTIVATORS = {
  'lens-flares': ensureLensFlaresSkinRuntime,
  waveform: ensureWaveformSkinRuntime,
};

/**
 * Synchronous skin lookup. Returns the cached skin or default as fallback.
 * @param {string} id
 * @returns {object} skin definition
 */
export function getSkin(id) {
  return SKINS[id] || defaultSkin;
}

/**
 * Load a skin asynchronously. Returns immediately for default/cached skins.
 * @param {string} id
 * @returns {Promise<object>} skin definition
 */
export async function loadSkin(id) {
  SKIN_ACTIVATORS[id]?.();
  return getSkin(id);
}

/**
 * Returns option list for the editor dropdown.
 * @returns {{ value: string, label: string }[]}
 */
export function getSkinOptions() {
  return SKIN_META;
}
