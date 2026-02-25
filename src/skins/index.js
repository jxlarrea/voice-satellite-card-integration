/**
 * Voice Satellite Card — Skin Registry
 */

import { defaultSkin } from './default.js';
import { alexaSkin } from './alexa.js';
import { googleHomeSkin } from './google-home.js';
import { retroTerminalSkin } from './retro-terminal.js';
import { siriSkin } from './siri.js';
/** All registered skins keyed by id */
const SKINS = {
  [defaultSkin.id]: defaultSkin,
  [alexaSkin.id]: alexaSkin,
  [googleHomeSkin.id]: googleHomeSkin,
  [retroTerminalSkin.id]: retroTerminalSkin,
  [siriSkin.id]: siriSkin,
};

/**
 * Look up a skin by id. Falls back to default if not found.
 * @param {string} id
 * @returns {object} skin definition
 */
export function getSkin(id) {
  return SKINS[id] || SKINS['default'];
}

/**
 * Returns option list for the editor dropdown.
 * @returns {{ value: string, label: string }[]}
 */
export function getSkinOptions() {
  return Object.values(SKINS).map((s) => ({ value: s.id, label: s.name }));
}
