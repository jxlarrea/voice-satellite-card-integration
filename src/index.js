/**
 * Voice Satellite Card
 * Transform your browser into a voice satellite for Home Assistant Assist
 */

import { VERSION } from './constants.js';
import { VoiceSatelliteCard } from './card';
import { VoiceSatelliteMiniCard } from './mini/index.js';

if (!customElements.get('voice-satellite-card')) {
  customElements.define('voice-satellite-card', VoiceSatelliteCard);
}
if (!customElements.get('voice-satellite-mini-card')) {
  customElements.define('voice-satellite-mini-card', VoiceSatelliteMiniCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Transform your browser into a voice satellite for Home Assistant Assist',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card',
});
window.customCards.push({
  type: 'voice-satellite-mini-card',
  name: 'Voice Satellite Mini Card',
  description: 'Text-only in-card voice satellite (compact or tall)',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card',
});

console.info(
  `%c VOICE-SATELLITE-CARD %c v${VERSION} `,
  'color: white; background: #03a9f4; font-weight: bold;',
  'color: #03a9f4; background: white; font-weight: bold;',
);
