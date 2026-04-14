/**
 * Constants
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

/** States that indicate an active user interaction */
export const INTERACTING_STATES = [
  State.WAKE_WORD_DETECTED,
  State.STT,
  State.INTENT,
  State.TTS,
];

/** Pipeline errors that are expected and should not show error UI */
export const EXPECTED_ERRORS = [
  'timeout',
  'wake-word-timeout',
  'stt-no-text-recognized',
  'duplicate_wake_up_detected',
];

/** Blur overlay reason identifiers */
export const BlurReason = {
  PIPELINE: 'pipeline',
  TIMER: 'timer',
  ANNOUNCEMENT: 'announcement',
};

/** Timing constants (ms unless noted) */
export const Timing = {
  DOUBLE_TAP_THRESHOLD: 400,
  TIMER_CHIME_INTERVAL: 3000,
  PILL_EXPIRE_ANIMATION: 400,
  PLAYBACK_WATCHDOG: 30000,
  RECONNECT_DELAY: 2000,
  INTENT_ERROR_DISPLAY: 3000,
  TTS_FAILED_LINGER: 5000,
  NO_MEDIA_DISPLAY: 3000,
  ASK_QUESTION_CLEANUP: 2000,
  ASK_QUESTION_STT_SAFETY: 30000,
  TOKEN_REFRESH_INTERVAL: 240_000,
  MAX_RETRY_DELAY: 30000,
  RETRY_BASE_DELAY: 5000,
  VISIBILITY_DEBOUNCE: 500,
  DISCONNECT_GRACE: 100,
  CHIME_SETTLE: 500,
  IMAGE_LINGER: 30000,
  IDLE_DEBOUNCE: 200,
  AUTH_SIGN_EXPIRES: 3600,
};

export const DEFAULT_CONFIG = {
  // Behavior
  satellite_entity: '',
  auto_start: true,
  debug: false,

  // Microphone Processing — Wake Word listening.
  // All DSP off by default.  The microWakeWord models were trained on raw
  // hardware-captured audio (Voice PE, ESPHome, Raspberry Pi boards — no
  // software WebRTC DSP in the signal path).  Running the browser's AGC /
  // NS / EC reshapes the spectrum in ways the model wasn't trained on and
  // measurably increases prefix-match false triggers ("ok google" → ok_nabu,
  // "ok man" → ok_nabu).  EC is also moot in the wake-word phase because
  // the mic is muted through the chime.  Users can opt individual toggles
  // back on per their hardware.
  wake_word_noise_suppression: false,
  wake_word_echo_cancellation: false,
  wake_word_auto_gain_control: false,
  wake_word_voice_isolation: false,

  // Microphone Processing — Speech to Text streaming.
  // STT generally benefits from aggressive DSP (cleaner audio → better
  // transcription). Mic is re-acquired with these constraints on the
  // wake-word → STT transition.
  stt_noise_suppression: true,
  stt_echo_cancellation: true,
  stt_auto_gain_control: true,
  stt_voice_isolation: false,

  // Skin
  skin: 'default',
  theme_mode: 'auto',
  custom_css: '',
  text_scale: 100,
  reactive_bar: true,
  reactive_bar_update_interval_ms: 33,
};
