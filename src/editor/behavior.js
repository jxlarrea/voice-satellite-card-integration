/**
 * Voice Satellite Card — Editor: Behavior, Microphone & Timeouts
 */

export const behaviorSchema = [
  { name: 'pipeline_id', selector: { assist_pipeline: {} } },
  {
    name: 'satellite_entity',
    selector: { entity: { filter: { domain: 'assist_satellite', integration: 'voice_satellite' } } },
  },
  {
    name: 'state_entity',
    selector: { entity: { filter: { domain: 'input_text' } } },
  },
  {
    name: 'wake_word_switch',
    selector: { entity: { filter: [{ domain: 'switch' }, { domain: 'input_boolean' }] } },
  },
  { name: 'continue_conversation', selector: { boolean: {} } },
  { name: 'debug', selector: { boolean: {} } },

  // Microphone Processing
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

  // Timeouts
  {
    type: 'expandable', name: '', title: 'Timeouts', flatten: true,
    schema: [{
      type: 'grid', name: '', flatten: true,
      schema: [
        { name: 'pipeline_timeout', selector: { number: { min: 0, max: 300, step: 1, unit_of_measurement: 's', mode: 'box' } } },
        { name: 'pipeline_idle_timeout', selector: { number: { min: 0, max: 3600, step: 1, unit_of_measurement: 's', mode: 'box' } } },
      ],
    }],
  },
];

export const behaviorLabels = {
  pipeline_id: 'Assist Pipeline',
  wake_word_switch: 'Wake word switch entity',
  state_entity: 'State tracking entity',
  satellite_entity: 'Satellite entity',
  continue_conversation: 'Continue conversation mode',
  debug: 'Debug logging',
  noise_suppression: 'Noise suppression',
  echo_cancellation: 'Echo cancellation',
  auto_gain_control: 'Auto gain control',
  voice_isolation: 'Voice isolation (Chrome only)',
  pipeline_timeout: 'Pipeline timeout',
  pipeline_idle_timeout: 'Idle restart timeout',
};

export const behaviorHelpers = {
  wake_word_switch: 'Turn OFF this switch when wake word is detected (e.g., Fully Kiosk screensaver)',
  state_entity: 'Updates with ACTIVE/IDLE for per-device automations',
  satellite_entity: 'Requires Voice Satellite Card Integration. Enables timers and announcements. https://github.com/jxlarrea/voice-satellite-card-integration',
  pipeline_timeout: 'Max seconds to wait for pipeline response (0 = no timeout)',
  pipeline_idle_timeout: 'Seconds before pipeline restarts to keep connection fresh',
  voice_isolation: 'AI-based voice isolation, currently only available in Chrome',
};
