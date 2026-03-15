/**
 * Voice Satellite
 * Transform your browser into a voice satellite for Home Assistant Assist
 */

import { VoiceSatelliteCard } from './card';
import { VoiceSatelliteMiniCard } from './mini/index.js';
import { t } from './i18n/index.js';
import { initEngine } from './engine/index.js';


if (!customElements.get('voice-satellite-card')) {
  customElements.define('voice-satellite-card', VoiceSatelliteCard);
}
if (!customElements.get('voice-satellite-mini-card')) {
  customElements.define('voice-satellite-mini-card', VoiceSatelliteMiniCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-mini-card',
  name: t(null, 'cards.mini_name', 'Voice Satellite Mini Card'),
  description: t(null, 'cards.mini_description', 'Text-only in-card voice satellite (compact or tall)'),
  preview: false,
  documentationURL: 'https://github.com/jxlarrea/voice-satellite-card-integration',
});

// Start the global engine (runs on every page, not just dashboards with cards)
initEngine();
