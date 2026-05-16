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

export const wakeWordMicrophoneSchema = [
  {
    type: 'expandable',
    name: '',
    title: t(null, 'editor.behavior.microphone_processing_wake_word', 'Microphone Processing — Wake Word'),
    flatten: true,
    schema: [{
      type: 'grid', name: '', flatten: true,
      schema: [
        { name: 'wake_word_noise_suppression', selector: { boolean: {} } },
        { name: 'wake_word_echo_cancellation', selector: { boolean: {} } },
        { name: 'wake_word_auto_gain_control', selector: { boolean: {} } },
        { name: 'wake_word_voice_isolation', selector: { boolean: {} } },
      ],
    }],
  },
];

export const sttMicrophoneSchema = [
  {
    type: 'expandable',
    name: '',
    title: t(null, 'editor.behavior.microphone_processing_stt', 'Microphone Processing — Speech to Text'),
    flatten: true,
    schema: [
      {
        type: 'grid', name: '', flatten: true,
        schema: [
          { name: 'stt_noise_suppression', selector: { boolean: {} } },
          { name: 'stt_echo_cancellation', selector: { boolean: {} } },
          { name: 'stt_auto_gain_control', selector: { boolean: {} } },
          { name: 'stt_voice_isolation', selector: { boolean: {} } },
        ],
      },
      {
        name: 'stt_followup_delay_ms',
        default: 0,
        selector: { number: { min: 0, max: 1000, step: 50, mode: 'slider', unit_of_measurement: 'ms' } },
      },
      { name: 'stt_followup_chime', default: false, selector: { boolean: {} } },
    ],
  },
];

// Kept as combined for call-sites that want the whole mic section at once
// (e.g. the full-card editor, which doesn't render the warning).
export const microphoneSchema = [
  ...wakeWordMicrophoneSchema,
  ...sttMicrophoneSchema,
];

export const autoStartSchema = [
  { name: 'auto_start', default: true, selector: { boolean: {} } },
  {
    name: 'microphone_device_id',
    default: 'default',
    required: true,
    selector: {
      select: {
        options: [{ value: 'default', label: 'Browser default microphone' }],
        mode: 'dropdown',
        custom_value: false,
      },
    },
  },
];

export function buildAutoStartSchema(microphoneOptions = []) {
  const options = microphoneOptions.length
    ? microphoneOptions
    : [{ value: 'default', label: 'Browser default microphone' }];
  return [
    { name: 'auto_start', default: true, selector: { boolean: {} } },
    {
      name: 'microphone_device_id',
      default: 'default',
      required: true,
      selector: {
        select: {
          options,
          mode: 'dropdown',
          custom_value: false,
        },
      },
    },
  ];
}

export const debugSchema = [
  { name: 'debug', selector: { boolean: {} } },
];

export function buildTimersSchema(cfg) {
  const timerTtsEnabled = cfg?.timer_tts_enabled === true;
  const schema = [
    { name: 'hide_timer_pills', default: false, selector: { boolean: {} } },
    { name: 'show_timer_name_in_pill', default: true, selector: { boolean: {} } },
    { name: 'hide_timer_name_on_alert', default: false, selector: { boolean: {} } },
    { name: 'timer_tts_enabled', default: false, selector: { boolean: {} } },
  ];

  if (timerTtsEnabled) {
    schema.push(
      { name: 'timer_tts_text', default: 'Your timer is up.', selector: { text: {} } },
      { name: 'timer_named_tts_text', default: 'Your %%TIMER_NAME%% timer is up.', selector: { text: {} } },
    );
  }

  return [
    {
      type: 'expandable',
      name: '',
      title: t(null, 'editor.behavior.timers', 'Timers'),
      flatten: true,
      schema,
    },
  ];
}

export const timersSchema = buildTimersSchema();

export const behaviorLabels = {
  satellite_entity: t(null, 'editor.behavior.satellite_entity', 'Satellite entity'),
  auto_start: t(null, 'editor.behavior.auto_start', 'Auto start'),
  microphone_device_id: t(null, 'editor.behavior.microphone_device_id', 'Microphone'),
  debug: t(null, 'editor.behavior.debug', 'Debug logging'),
  hide_timer_pills: t(null, 'editor.behavior.hide_timer_pills', 'Hide on-screen countdown'),
  show_timer_name_in_pill: t(null, 'editor.behavior.show_timer_name_in_pill', 'Show timer name inside pill'),
  hide_timer_name_on_alert: t(null, 'editor.behavior.hide_timer_name_on_alert', 'Hide timer name on alert'),
  timer_tts_enabled: t(null, 'editor.behavior.timer_tts_enabled', 'Speak timer alert phrase'),
  timer_tts_text: t(null, 'editor.behavior.timer_tts_text', 'Timer alert phrase'),
  timer_named_tts_text: t(null, 'editor.behavior.timer_named_tts_text', 'Named timer alert phrase'),
  // Wake-word group
  wake_word_noise_suppression: t(null, 'editor.behavior.noise_suppression', 'Noise suppression'),
  wake_word_echo_cancellation: t(null, 'editor.behavior.echo_cancellation', 'Echo cancellation'),
  wake_word_auto_gain_control: t(null, 'editor.behavior.auto_gain_control', 'Auto gain control'),
  wake_word_voice_isolation: t(null, 'editor.behavior.voice_isolation', 'Voice isolation (Chrome only)'),
  // STT group
  stt_noise_suppression: t(null, 'editor.behavior.noise_suppression', 'Noise suppression'),
  stt_echo_cancellation: t(null, 'editor.behavior.echo_cancellation', 'Echo cancellation'),
  stt_auto_gain_control: t(null, 'editor.behavior.auto_gain_control', 'Auto gain control'),
  stt_voice_isolation: t(null, 'editor.behavior.voice_isolation', 'Voice isolation (Chrome only)'),
  stt_followup_delay_ms: t(null, 'editor.behavior.stt_followup_delay_ms', 'Follow-up listen delay'),
  stt_followup_chime: t(null, 'editor.behavior.stt_followup_chime', 'Follow-up ready chime'),
};

export const behaviorHelpers = {
  satellite_entity: t(null, 'editor.behavior.helper_satellite_entity', 'Add a satellite device first via Settings → Devices & Services → Voice Satellite.'),
  auto_start: t(null, 'editor.behavior.helper_auto_start', 'Automatically start the voice engine when the page loads. When off, use the Start button to activate manually.'),
  microphone_device_id: t(null, 'editor.behavior.helper_microphone_device_id', 'Use the browser default microphone, or select a specific input if the default device is silent or wrong.'),
  wake_word_voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
  stt_voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
  hide_timer_pills: t(null, 'editor.behavior.helper_hide_timer_pills', 'Hide the countdown pill on screen. Timers still run and the alert still fires when they finish.'),
  show_timer_name_in_pill: t(null, 'editor.behavior.helper_show_timer_name_in_pill', 'Display the timer name alongside the countdown in the pill (e.g. "Stir the sauce | 15:30"). Names longer than 25 characters are truncated.'),
  hide_timer_name_on_alert: t(null, 'editor.behavior.helper_hide_timer_name_on_alert', 'When a timer finishes, hide the timer name shown below the alert.'),
  timer_tts_enabled: t(null, 'editor.behavior.helper_timer_tts_enabled', 'Speak a configurable phrase between timer alert chimes. The phrase is synthesized with the Assist pipeline that created the timer.'),
  timer_tts_text: t(null, 'editor.behavior.helper_timer_tts_text', 'Phrase for unnamed timers. Translate this for the language you use with this satellite.'),
  timer_named_tts_text: t(null, 'editor.behavior.helper_timer_named_tts_text', 'Phrase for named timers. Use %%TIMER_NAME%% where the timer name should be inserted.'),
  stt_followup_delay_ms: t(null, 'editor.behavior.helper_stt_followup_delay_ms', 'Pause between the assistant finishing speaking and the mic listening again on follow-up turns. Use this if the tail of the response (last word or two) is being captured into your next reply. Common on tablets without hardware echo cancellation, especially with synthesized voices like Piper. Try 300-500 ms; leave at 0 if follow-ups already work cleanly.'),
  stt_followup_chime: t(null, 'editor.behavior.helper_stt_followup_chime', 'Play the wake chime when the mic starts listening for a follow-up turn, so you have an audible "speak now" cue. Pairs naturally with a non-zero follow-up listen delay.'),
};
