/**
 * Editor: Behavior & Microphone
 */

import { t } from '../i18n/index.js';

export const behaviorSchema = [
  {
    name: 'satellite_entity',
    required: true,
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

export const debugSchema = [
  { name: 'browser_satellite_override', selector: { boolean: {} } },
  { name: 'debug', selector: { boolean: {} } },
];

export const behaviorLabels = {
  satellite_entity: t(null, 'editor.behavior.satellite_entity', 'Satellite entity'),
  browser_satellite_override: t(null, 'editor.behavior.browser_satellite_override', 'Per-device satellite override'),
  debug: t(null, 'editor.behavior.debug', 'Debug logging'),
  noise_suppression: t(null, 'editor.behavior.noise_suppression', 'Noise suppression'),
  echo_cancellation: t(null, 'editor.behavior.echo_cancellation', 'Echo cancellation'),
  auto_gain_control: t(null, 'editor.behavior.auto_gain_control', 'Auto gain control'),
  voice_isolation: t(null, 'editor.behavior.voice_isolation', 'Voice isolation (Chrome only)'),
};

export const behaviorHelpers = {
  satellite_entity: t(null, 'editor.behavior.helper_satellite_entity', 'Required. Install the Voice Satellite Card Integration: https://github.com/jxlarrea/voice-satellite-card-integration'),
  browser_satellite_override: t(null, 'editor.behavior.helper_browser_override', 'For shared dashboards across multiple devices. When enabled, each device selects its own satellite via a browser popup, overriding the entity configured above.'),
  voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
};
