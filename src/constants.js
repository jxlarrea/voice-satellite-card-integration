/**
 * Voice Satellite Card - Constants
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
};

export const DEFAULT_CONFIG = {
  // Behavior
  satellite_entity: '',
  browser_satellite_override: false,
  debug: false,

  // Microphone Processing
  noise_suppression: true,
  echo_cancellation: true,
  auto_gain_control: true,
  voice_isolation: false,

  // Skin
  skin: 'default',
  custom_css: '',
  text_scale: 100,
  reactive_bar: true,
  reactive_bar_update_interval_ms: 33,
};
