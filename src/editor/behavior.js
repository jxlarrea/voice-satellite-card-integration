/**
 * Editor: Behavior & Microphone
 */

import { t } from '../i18n/index.js';

export const behaviorSchema = [];

export const entitySchema = [
  {
    name: 'satellite_entity',
    selector: { entity: { filter: { domain: 'assist_satellite', integration: 'voice_satellite' } } },
  },
];

export const microphoneSchema = [
  {
    type: 'expandable', name: '', title: t(null, 'editor.behavior.microphone_processing', 'Microphone Processing'), flatten: true,
    schema: [{
      type: 'grid', name: '', flatten: true,
      schema: [
        { name: 'noise_suppression', selector: { boolean: {} } },
        { name: 'echo_cancellation', selector: { boolean: {} } },
        { name: 'auto_gain_control', selector: { boolean: {} } },
        { name: 'voice_isolation', selector: { boolean: {} } },
      ],
    }],
  },
];

export const autoStartSchema = [
  { name: 'auto_start', default: true, selector: { boolean: {} } },
];

export const debugSchema = [
  { name: 'debug', selector: { boolean: {} } },
];

export const behaviorLabels = {
  satellite_entity: t(null, 'editor.behavior.satellite_entity', 'Satellite entity'),
  auto_start: t(null, 'editor.behavior.auto_start', 'Auto start'),
  debug: t(null, 'editor.behavior.debug', 'Debug logging'),
  noise_suppression: t(null, 'editor.behavior.noise_suppression', 'Noise suppression'),
  echo_cancellation: t(null, 'editor.behavior.echo_cancellation', 'Echo cancellation'),
  auto_gain_control: t(null, 'editor.behavior.auto_gain_control', 'Auto gain control'),
  voice_isolation: t(null, 'editor.behavior.voice_isolation', 'Voice isolation (Chrome only)'),
};

export const behaviorHelpers = {
  satellite_entity: t(null, 'editor.behavior.helper_satellite_entity', 'Add a satellite device first via Settings → Devices & Services → Voice Satellite.'),
  auto_start: t(null, 'editor.behavior.helper_auto_start', 'Automatically start the voice engine when the page loads. When off, use the Start button to activate manually.'),
  voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
};
