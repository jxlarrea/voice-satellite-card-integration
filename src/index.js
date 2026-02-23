/**
 * Voice Satellite Card
 * Transform your browser into a voice satellite for Home Assistant Assist
 */

import { VERSION } from './constants.js';
import { VoiceSatelliteCard } from './card';

customElements.define('voice-satellite-card', VoiceSatelliteCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Transform your browser into a voice satellite for Home Assistant Assist',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card',
});

console.info(
  `%c VOICE-SATELLITE-CARD %c v${VERSION} `,
  'color: white; background: #03a9f4; font-weight: bold;',
  'color: #03a9f4; background: white; font-weight: bold;',
);
