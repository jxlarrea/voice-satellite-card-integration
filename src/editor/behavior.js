/**
 * Voice Satellite Card — Editor: Behavior & Microphone
 */

export const behaviorSchema = [
  {
    name: 'satellite_entity',
    required: true,
    selector: { entity: { filter: { domain: 'assist_satellite', integration: 'voice_satellite' } } },
  },
];

export const microphoneSchema = [
  {
    type: 'expandable', name: '', title: 'Microphone Processing', flatten: true,
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
  { name: 'debug', selector: { boolean: {} } },
];

export const behaviorLabels = {
  satellite_entity: 'Satellite entity',
  debug: 'Debug logging',
  noise_suppression: 'Noise suppression',
  echo_cancellation: 'Echo cancellation',
  auto_gain_control: 'Auto gain control',
  voice_isolation: 'Voice isolation (Chrome only)',
};

export const behaviorHelpers = {
  satellite_entity: 'Required. Install the Voice Satellite Card Integration: https://github.com/jxlarrea/voice-satellite-card-integration',
  voice_isolation: 'AI-based voice isolation, currently only available in Chrome',
};
