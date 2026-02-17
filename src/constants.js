/**
 * Voice Satellite Card — Constants
 */

/* global __VERSION__ */
export const VERSION = __VERSION__;

export const State = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  LISTENING: 'LISTENING',
  PAUSED: 'PAUSED',
  WAKE_WORD_DETECTED: 'WAKE_WORD_DETECTED',
  STT: 'STT',
  INTENT: 'INTENT',
  TTS: 'TTS',
  ERROR: 'ERROR',
};

export const DEFAULT_CONFIG = {
  // Behavior
  start_listening_on_load: true,
  wake_word_switch: '',
  state_entity: '',
  satellite_entity: '',
  pipeline_id: '',
  pipeline_timeout: 60,
  pipeline_idle_timeout: 300,
  chime_on_wake_word: true,
  chime_on_request_sent: true,
  chime_volume: 100,
  tts_volume: 100,
  tts_target: '',
  continue_conversation: true,
  double_tap_cancel: true,
  debug: false,

  // Microphone Processing
  noise_suppression: true,
  echo_cancellation: true,
  auto_gain_control: true,
  voice_isolation: false,

  // Timer Pill
  timer_position: 'bottom-right',
  timer_font_size: 20,
  timer_font_family: 'inherit',
  timer_font_color: '#444444',
  timer_font_bold: true,
  timer_font_italic: false,
  timer_background: '#ffffff',
  timer_border_color: 'rgba(100, 200, 150, 0.5)',
  timer_padding: 16,
  timer_rounded: true,
  timer_finished_duration: 60,

  // Announcements
  announcement_display_duration: 5,

  // Rainbow Bar
  bar_position: 'bottom',
  bar_height: 16,
  bar_gradient: '#FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC',
  background_blur: true,
  background_blur_intensity: 5,

  // Transcription Bubble
  show_transcription: true,
  transcription_font_size: 20,
  transcription_font_family: 'inherit',
  transcription_font_color: '#444444',
  transcription_font_bold: true,
  transcription_font_italic: false,
  transcription_background: '#ffffff',
  transcription_border_color: 'rgba(0, 180, 255, 0.5)',
  transcription_padding: 16,
  transcription_rounded: true,

  // Response Bubble
  show_response: true,
  streaming_response: true,
  response_font_size: 20,
  response_font_family: 'inherit',
  response_font_color: '#444444',
  response_font_bold: true,
  response_font_italic: false,
  response_background: '#ffffff',
  response_border_color: 'rgba(100, 200, 150, 0.5)',
  response_padding: 16,
  response_rounded: true,
};

export const EXPECTED_ERRORS = [
  'timeout',
  'wake-word-timeout',
  'stt-no-text-recognized',
  'duplicate_wake_up_detected',
];

/**
 * Build a seamless looping gradient by appending the first color
 * at the end so the animation wraps without a hard edge.
 */
export function seamlessGradient(colorList) {
  var colors = colorList.split(',').map(function (c) { return c.trim(); });
  if (colors.length > 1 && colors[0] !== colors[colors.length - 1]) {
    colors.push(colors[0]);
  }
  return 'linear-gradient(90deg, ' + colors.join(', ') + ')';
}