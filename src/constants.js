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
  // Safety net: if the STT stage goes silent (armed at stt-start and
  // re-armed at stt-vad-end - e.g. a crashed Wyoming STT service sends no
  // stt-end / intent / tts / run-end / error), tear the stuck STT
  // interaction down after this long so the UI doesn't linger forever.
  VAD_WATCHDOG: 60000,
  MAX_RETRY_DELAY: 30000,
  RETRY_BASE_DELAY: 5000,
  VISIBILITY_DEBOUNCE: 500,
  DISCONNECT_GRACE: 100,
  IMAGE_LINGER: 30000,
  IDLE_DEBOUNCE: 200,
  AUTH_SIGN_EXPIRES: 3600,
};

export const DEFAULT_CONFIG = {
  // Behavior
  satellite_entity: '',
  auto_start: true,
  microphone_device_id: 'default',
  debug: false,

  // Microphone Processing — Wake Word listening.
  // Only echo cancellation is on by default; noise suppression and auto
  // gain control are off, as they can distort the raw signal the wake-word
  // model expects. Users can re-enable any of these per mode in the panel.
  wake_word_noise_suppression: false,
  wake_word_echo_cancellation: true,
  wake_word_auto_gain_control: false,
  wake_word_voice_isolation: false,

  // Microphone Processing — Speech to Text streaming.
  // Mic is re-acquired with these constraints on the wake-word → STT
  // transition. Only echo cancellation on by default; NS and AGC off.
  stt_noise_suppression: false,
  stt_echo_cancellation: true,
  stt_auto_gain_control: false,
  stt_voice_isolation: false,
  // Extra pause inserted between TTS playback ending and STT starting on
  // continue-conversation follow-up turns.  Default 0 (no delay).  Lets
  // users on hardware where browser AEC under-cancels the TTS engine
  // (e.g. Piper on a small tablet) avoid the speaker tail bleeding into
  // the next STT capture.  See onTTSComplete in session/events.js.
  stt_followup_delay_ms: 0,
  // Play the wake chime to signal the mic is ready on follow-up turns.
  // Off by default (the existing flow continues silently).  Useful as an
  // audible "speak now" cue when paired with a follow-up listen delay.
  stt_followup_chime: false,
  // Skip the wake chime and keep buffering mic audio while the STT pipeline
  // starts, so users can say "hey vesta turn off the lights" in one run.
  seamless_wake_command: false,

  // Conversation display - which chat elements render on screen.
  // Hiding them changes nothing about the pipeline, TTS, or tools;
  // only the on-screen text is suppressed (voice-only immersion).
  chat_show_user_command: true,
  chat_show_assistant_response: true,
  chat_show_tool_usage: true,

  // Timers
  hide_timer_pills: false,
  hide_timer_name_on_alert: false,
  show_timer_name_in_pill: true,
  timer_tts_enabled: false,
  timer_tts_text: 'Your timer is up.',
  timer_named_tts_text: 'Your %%TIMER_NAME%% timer is up.',

  // Skin
  skin: 'default',
  theme_mode: 'auto',
  custom_css: '',
  text_scale: 100,
  reactive_bar: true,
  reactive_bar_update_interval_ms: 33,

  // Screensaver
  // Fallback only: the integration's Screensaver switch entity is
  // authoritative for enable/disable when it exists.
  screensaver_enabled: false,
  screensaver_timer_s: 60,
  screensaver_type: 'black', // 'black' | 'media' | 'website' | 'clock'
  screensaver_media_id: '',
  screensaver_media_interval_s: 10,
  screensaver_media_shuffle: false,
  screensaver_website_url: '',
  // Drift the screensaver content a few pixels every minute so static
  // elements (clock digits especially) don't burn into OLED panels.
  screensaver_pixel_shift: false,
  screensaver_suppress_external: '',
  // Digital clock screensaver options
  screensaver_clock_24h: false,
  screensaver_clock_seconds: false,
  screensaver_clock_show_date: true,
  screensaver_clock_scale: 100, // percent, 50-300
  screensaver_clock_color: [250, 250, 250], // [r,g,b]; date line renders darker

  // Kiosk browser integration — only effective inside Fully Kiosk
  // (Android) or Kiosker Pro (iOS) with the JS integration enabled.
  // Ignored on other browsers.  Motion-dismiss is Fully Kiosk only.
  // `screensaver_dim_percent` is intentionally NOT listed here — an
  // undefined value means "no dimming" (matches the background_opacity
  // pattern).
  screensaver_fk_motion_dismiss: false,
};
