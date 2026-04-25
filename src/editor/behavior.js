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
    schema: [{
      type: 'grid', name: '', flatten: true,
      schema: [
        { name: 'stt_noise_suppression', selector: { boolean: {} } },
        { name: 'stt_echo_cancellation', selector: { boolean: {} } },
        { name: 'stt_auto_gain_control', selector: { boolean: {} } },
        { name: 'stt_voice_isolation', selector: { boolean: {} } },
      ],
    }],
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
];

export const debugSchema = [
  { name: 'debug', selector: { boolean: {} } },
];

export const timersSchema = [
  {
    type: 'expandable',
    name: '',
    title: t(null, 'editor.behavior.timers', 'Timers'),
    flatten: true,
    schema: [
      { name: 'hide_timer_pills', default: false, selector: { boolean: {} } },
      { name: 'hide_timer_name_on_alert', default: false, selector: { boolean: {} } },
    ],
  },
];

export const behaviorLabels = {
  satellite_entity: t(null, 'editor.behavior.satellite_entity', 'Satellite entity'),
  auto_start: t(null, 'editor.behavior.auto_start', 'Auto start'),
  debug: t(null, 'editor.behavior.debug', 'Debug logging'),
  hide_timer_pills: t(null, 'editor.behavior.hide_timer_pills', 'Hide on-screen countdown'),
  hide_timer_name_on_alert: t(null, 'editor.behavior.hide_timer_name_on_alert', 'Hide timer name on alert'),
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
};

export const behaviorHelpers = {
  satellite_entity: t(null, 'editor.behavior.helper_satellite_entity', 'Add a satellite device first via Settings → Devices & Services → Voice Satellite.'),
  auto_start: t(null, 'editor.behavior.helper_auto_start', 'Automatically start the voice engine when the page loads. When off, use the Start button to activate manually.'),
  wake_word_voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
  stt_voice_isolation: t(null, 'editor.behavior.helper_voice_isolation', 'AI-based voice isolation, currently only available in Chrome'),
  hide_timer_pills: t(null, 'editor.behavior.helper_hide_timer_pills', 'Hide the countdown pill on screen. Timers still run and the alert still fires when they finish.'),
  hide_timer_name_on_alert: t(null, 'editor.behavior.helper_hide_timer_name_on_alert', 'When a timer finishes, hide the timer name shown below the alert.'),
};
