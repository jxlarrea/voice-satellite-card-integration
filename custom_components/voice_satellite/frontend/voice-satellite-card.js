/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/announcement/index.js"
/*!***********************************!*\
  !*** ./src/announcement/index.js ***!
  \***********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AnnouncementManager: () => (/* binding */ AnnouncementManager)
/* harmony export */ });
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/notification-comms.js */ "./src/shared/notification-comms.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/**
 * Voice Satellite Card — AnnouncementManager
 *
 * Simple announcements: plays chime + media, shows message bubble,
 * ACKs the integration, then auto-clears after configured duration.
 */




const LOG = 'announce';
class AnnouncementManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.initNotificationState)(this);
  }
  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }
  playQueued() {
    const ann = (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.dequeueNotification)(this);
    if (!ann) return;
    this._log.log(LOG, `Playing queued announcement #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _play(ann) {
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.playNotification)(this, ann, a => this._onComplete(a), LOG);
  }
  _onComplete(ann) {
    this.currentAudio = null;
    this._log.log(LOG, `Announcement #${ann.id} playback complete`);
    (0,_shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__.sendAck)(this._card, ann.id, LOG);

    // HA's base class cancels the active pipeline when triggering an
    // announcement (async_internal_announce → _cancel_running_pipeline).
    // Restart immediately so wake word detection resumes.
    this._card.pipeline.restart(0);
    const clearDelay = (this._card.announcementDisplayDuration || 3.5) * 1000;
    this.clearTimeoutId = setTimeout(() => {
      (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.clearNotificationUI)(this);
      this.playing = false;

      // Skip done chime when a queued notification is waiting — the next
      // notification starts with its own announce chime and overlapping
      // audio from Web Audio + HTML Audio causes distortion in WebView.
      if (this.queued) {
        this.playQueued();
        return;
      }
      const isRemote = !!this._card.ttsTarget;
      if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_2__.getSwitchState)(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
        this._card.tts.playChime('done');
      }
    }, clearDelay);
  }
}

/***/ },

/***/ "./src/ask-question/comms.js"
/*!***********************************!*\
  !*** ./src/ask-question/comms.js ***!
  \***********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   sendAnswer: () => (/* binding */ sendAnswer)
/* harmony export */ });
/**
 * Voice Satellite Card — Ask Question Comms
 *
 * WebSocket service call for submitting question answers.
 */

/**
 * Send a question answer to the integration.
 * @param {object} card - Card instance
 * @param {number} announceId
 * @param {string} sentence
 * @param {string} logPrefix
 * @returns {Promise<object|null>}
 */
function sendAnswer(card, announceId, sentence, logPrefix) {
  const {
    connection,
    config
  } = card;
  const log = card.logger;
  if (!connection || !config.satellite_entity) {
    log.error(logPrefix, 'Cannot send answer — no connection or entity');
    return Promise.resolve(null);
  }
  const payload = {
    type: 'voice_satellite/question_answered',
    entity_id: config.satellite_entity,
    announce_id: announceId,
    sentence: sentence || ''
  };
  return connection.sendMessagePromise(payload).then(result => {
    const matched = result?.matched;
    const matchId = result?.id;
    log.log(logPrefix, `Answer sent for #${announceId}: "${sentence}" — matched: ${matched}${matchId ? ` (id: ${matchId})` : ''}`);
    return result;
  }).catch(err => {
    log.error(logPrefix, `Answer failed: ${err.message || JSON.stringify(err)}`);
    return null;
  });
}

/***/ },

/***/ "./src/ask-question/index.js"
/*!***********************************!*\
  !*** ./src/ask-question/index.js ***!
  \***********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AskQuestionManager: () => (/* binding */ AskQuestionManager)
/* harmony export */ });
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/notification-comms.js */ "./src/shared/notification-comms.js");
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./comms.js */ "./src/ask-question/comms.js");
/**
 * Voice Satellite Card — AskQuestionManager
 *
 * Handles ask_question announcements: plays the question prompt,
 * enters STT-only mode to capture the user's spoken answer,
 * sends it to the integration, and provides audio/visual match feedback.
 */





const LOG = 'ask-question';
class AskQuestionManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.initNotificationState)(this);
  }
  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }

  /**
   * Cancel an in-progress ask_question flow (playback or STT).
   * Clears timers, sends empty answer to release the server,
   * and hides the ANNOUNCEMENT blur that playNotification added.
   */
  cancel() {
    if (this._chimeSettleTimeout) {
      clearTimeout(this._chimeSettleTimeout);
      this._chimeSettleTimeout = null;
    }
    if (this._sttSafetyTimeout) {
      clearTimeout(this._sttSafetyTimeout);
      this._sttSafetyTimeout = null;
    }
    if (this._cleanupTimeout) {
      clearTimeout(this._cleanupTimeout);
      this._cleanupTimeout = null;
    }

    // Release server's _question_event if we haven't sent an answer yet
    if (this.currentAnnounceId && !this._answerSent) {
      this._answerSent = true;
      (0,_comms_js__WEBPACK_IMPORTED_MODULE_3__.sendAnswer)(this._card, this.currentAnnounceId, '', 'double-tap');
    }
    this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.ANNOUNCEMENT);
    this.playing = false;
  }
  playQueued() {
    const ann = (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.dequeueNotification)(this);
    if (!ann) return;
    this._log.log(LOG, `Playing queued ask_question #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _play(ann) {
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.playNotification)(this, ann, a => this._onComplete(a), LOG);
  }
  _onComplete(ann) {
    this.currentAudio = null;
    this._log.log(LOG, `Question #${ann.id} playback complete`);

    // ACK immediately on playback complete — signals the integration that
    // the prompt was played. The integration then waits for question_answered.
    (0,_shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__.sendAck)(this._card, ann.id, LOG);
    this._enterSttMode(ann);
  }

  /**
   * Enter STT-only mode, capture answer, submit to integration.
   */
  _enterSttMode(ann) {
    this._log.log(LOG, 'Entering STT-only mode');

    // Switch from passive announcement centering to interactive mode
    this._card.ui.setAnnouncementMode(false);
    this._card.ui.showBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.PIPELINE);
    const {
      pipeline
    } = this._card;
    if (!pipeline) return;
    const announceId = ann.id;
    const isRemote = !!this._card.ttsTarget;

    // Play wake chime to signal the user should speak.
    // Delay STT pipeline start so the mic doesn't pick up the chime
    // as speech (causes false VAD trigger → stt-no-text-recognized).
    // Reconnect mic to the analyser for reactive bar during STT.
    // attachAudio disconnected it during announcement playback, and
    // updateForState won't run while playing is true.
    this._card.analyser.reconnectMic();
    let chimeDelay = 0;
    if (!isRemote) {
      this._card.tts.playChime('wake');
      chimeDelay = _constants_js__WEBPACK_IMPORTED_MODULE_2__.Timing.CHIME_SETTLE;
    }

    // Track whether an answer was submitted so the cleanup timeout
    // can release the server if STT never produced a result.
    this._answerSent = false;
    this._chimeSettleTimeout = setTimeout(() => {
      pipeline.restartContinue(null, {
        end_stage: 'stt',
        onSttEnd: text => {
          this._log.log(LOG, `STT result: "${text}"`);
          this._answerSent = true;
          this._processAnswer(announceId, text, isRemote);
        }
      });

      // Safety: if STT never produces a result (pipeline timeout, run-end
      // without error, etc.), send an empty answer to release the server
      // and clean up after a generous window.
      this._sttSafetyTimeout = setTimeout(() => {
        if (!this._answerSent) {
          this._log.log(LOG, `No STT result for #${announceId} — sending empty answer to release server`);
          this._answerSent = true;
          this._processAnswer(announceId, '', isRemote);
        }
      }, _constants_js__WEBPACK_IMPORTED_MODULE_2__.Timing.ASK_QUESTION_STT_SAFETY);
    }, chimeDelay);
  }

  /**
   * Send answer to integration and show match feedback.
   * Mirrors the original monolithic implementation: a safety cleanup timeout
   * runs in parallel with the sendAnswer promise. Whichever completes first
   * triggers cleanup; the other is a no-op via the `cleaned` guard.
   */
  _processAnswer(announceId, text, isRemote) {
    // Clear pending timers — we have a result (or explicit empty)
    if (this._chimeSettleTimeout) {
      clearTimeout(this._chimeSettleTimeout);
      this._chimeSettleTimeout = null;
    }
    if (this._sttSafetyTimeout) {
      clearTimeout(this._sttSafetyTimeout);
      this._sttSafetyTimeout = null;
    }
    const {
      pipeline
    } = this._card;
    let cleaned = false;
    let matchedResult = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this._cleanupTimeout = null;
      if (matchedResult !== null && !matchedResult) {
        this._card.ui.clearErrorBar();
      }
      (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.clearNotificationUI)(this);
      this._card.chat.clear();
      this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.PIPELINE);
      this.playing = false;
      if (!this.queued) {
        pipeline.restart(0);
      } else {
        this.playQueued();
      }
    };

    // Safety timeout — if sendAnswer takes too long, clean up anyway
    this._cleanupTimeout = setTimeout(cleanup, _constants_js__WEBPACK_IMPORTED_MODULE_2__.Timing.ASK_QUESTION_CLEANUP);
    (0,_comms_js__WEBPACK_IMPORTED_MODULE_3__.sendAnswer)(this._card, announceId, text, LOG).then(result => {
      const matched = result?.matched;
      matchedResult = matched;
      if (!isRemote) {
        this._card.tts.playChime(matched ? 'done' : 'error');
      }
      if (!matched) {
        this._card.ui.showErrorBar();
        const bar = this._card.ui.element ? this._card.ui.element.querySelector('.vs-rainbow-bar') : null;
        if (bar) {
          bar.classList.add('error-flash');
          bar.addEventListener('animationend', function handler() {
            bar.classList.remove('error-flash');
            bar.removeEventListener('animationend', handler);
          });
        }
      }
    });
  }
}

/***/ },

/***/ "./src/audio/analyser.js"
/*!*******************************!*\
  !*** ./src/audio/analyser.js ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AnalyserManager: () => (/* binding */ AnalyserManager)
/* harmony export */ });
/**
 * Voice Satellite Card — AnalyserManager
 *
 * Provides real-time audio level analysis for reactive bar animations.
 * Uses two separate AnalyserNodes — one for microphone input, one for
 * audio output (TTS / notifications) — so the mic can never be routed
 * to the speakers through the analyser graph.
 *
 * The mic analyser is never connected to AudioContext.destination;
 * the audio analyser routes through to destination for playback.
 * _activeAnalyser points to whichever node _tick() should read from.
 *
 * Skins opt in via `reactiveBar: true` in their definition.
 */

class AnalyserManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    // Mic path: sourceNode → _micAnalyser (no destination)
    this._micAnalyser = null;
    this._micSourceNode = null;

    // Audio path: mediaElementSource → _audioAnalyser → destination
    this._audioAnalyser = null;
    this._mediaSourceNode = null;

    // Which analyser _tick() reads from
    this._activeAnalyser = null;
    this._dataArray = null;
    this._rafId = null;
    this._barEl = null;
    this._visibilityHandler = null;
    this._lastLevel = -1;
  }

  /**
   * Connect analyser as a parallel tap on the mic source node.
   * The mic analyser is never connected to destination — it only
   * provides FFT data for the reactive bar.
   */
  attachMic(sourceNode, audioContext) {
    this._micSourceNode = sourceNode;
    if (!this._micAnalyser) {
      this._micAnalyser = this._createAnalyser(audioContext);
    }
    try {
      sourceNode.connect(this._micAnalyser);
      this._log.log('analyser', 'Mic → micAnalyser connected');
    } catch (e) {
      this._log.log('analyser', `Failed to attach mic: ${e.message}`);
    }
    // Default to mic analyser when no audio is playing
    if (!this._activeAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (initial)');
    }
  }

  /**
   * Disconnect mic tap.
   */
  detachMic(sourceNode) {
    this._micSourceNode = null;
    if (!this._micAnalyser) return;
    try {
      sourceNode.disconnect(this._micAnalyser);
      this._log.log('analyser', 'Mic → micAnalyser disconnected');
    } catch {
      // Already disconnected
    }
    if (this._activeAnalyser === this._micAnalyser) {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active → none (mic detached)');
    }
  }

  /**
   * Route an HTML Audio element through the audio analyser for output
   * analysis. createMediaElementSource reroutes audio through the Web
   * Audio graph, so we connect through to destination for audibility.
   *
   * Uses a separate analyser from the mic — the mic analyser has no
   * path to destination, so feedback is structurally impossible.
   */
  attachAudio(audioEl, audioContext) {
    if (!audioEl || !audioContext) return;
    this._detachAudio();
    try {
      if (!this._audioAnalyser) {
        this._audioAnalyser = this._createAnalyser(audioContext);
      }
      this._mediaSourceNode = audioContext.createMediaElementSource(audioEl);
      this._mediaSourceNode.connect(this._audioAnalyser);
      this._audioAnalyser.connect(audioContext.destination);

      // Switch reactive bar to read from audio analyser during playback
      this._activeAnalyser = this._audioAnalyser;
      this._dataArray = new Uint8Array(this._audioAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Audio → audioAnalyser → destination connected, active → audioAnalyser');
    } catch (e) {
      this._log.log('analyser', `Failed to attach audio: ${e.message}`);
      this._mediaSourceNode = null;
    }
  }

  /**
   * Disconnect audio element routing.
   */
  detachAudio() {
    this._detachAudio();
  }

  /**
   * Switch the reactive bar back to reading from the mic analyser.
   * The mic source stays connected to its analyser at all times —
   * this just changes which analyser _tick() reads FFT data from.
   *
   * No-op while audio is routed through the audio analyser — callers
   * like updateForState fire for all bar-visible states (including TTS),
   * and switching away from the audio analyser mid-playback would make
   * the bar show mic levels instead of TTS levels.
   */
  reconnectMic() {
    if (this._mediaSourceNode) {
      this._log.log('analyser', 'reconnectMic skipped — audio still attached');
      return;
    }
    if (this._micAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (reconnectMic)');
    }
  }

  /**
   * Start the animation frame loop that updates --vs-audio-level.
   */
  start(barEl) {
    this._barEl = barEl;
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.hidden) {
          if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
          }
        } else if (this._barEl && !this._rafId) {
          this._tick();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
    if (this._rafId) return; // Already running
    this._tick();
  }

  /**
   * Stop the animation frame loop and reset the CSS variable.
   */
  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._barEl) {
      this._barEl.style.setProperty('--vs-audio-level', '0');
      this._barEl = null;
      this._log.log('analyser', 'Tick loop stopped');
    }
  }

  // --- Private ---

  _createAnalyser(audioContext) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    return analyser;
  }
  _detachAudio() {
    if (this._mediaSourceNode) {
      try {
        this._mediaSourceNode.disconnect();
      } catch {}
      this._mediaSourceNode = null;
      this._log.log('analyser', 'Audio → audioAnalyser disconnected');
    }
    if (this._audioAnalyser) {
      try {
        this._audioAnalyser.disconnect();
      } catch {}
      this._log.log('analyser', 'audioAnalyser → destination disconnected');
    }
    // Revert to mic analyser if available
    if (this._micAnalyser) {
      this._activeAnalyser = this._micAnalyser;
      this._dataArray = new Uint8Array(this._micAnalyser.frequencyBinCount);
      this._log.log('analyser', 'Active → micAnalyser (audio detached)');
    } else {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active → none (audio detached, no mic)');
    }
  }
  _tick() {
    if (!this._barEl || !this._activeAnalyser) {
      this._rafId = null;
      return;
    }
    this._activeAnalyser.getByteFrequencyData(this._dataArray);

    // Compute RMS volume normalized to 0–1, quantized to 20 steps
    // to skip redundant CSS updates when the level barely changes.
    let sum = 0;
    for (let i = 0; i < this._dataArray.length; i++) {
      const v = this._dataArray[i] / 255;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._dataArray.length);
    const level = Math.min(1, Math.round(Math.min(1, rms * 2) * 20) / 20);
    if (level !== this._lastLevel) {
      this._lastLevel = level;
      this._barEl.style.setProperty('--vs-audio-level', level.toFixed(2));
    }
    this._rafId = requestAnimationFrame(() => this._tick());
  }
}

/***/ },

/***/ "./src/audio/chime.js"
/*!****************************!*\
  !*** ./src/audio/chime.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   CHIME_ALERT: () => (/* binding */ CHIME_ALERT),
/* harmony export */   CHIME_ANNOUNCE_URI: () => (/* binding */ CHIME_ANNOUNCE_URI),
/* harmony export */   CHIME_DONE: () => (/* binding */ CHIME_DONE),
/* harmony export */   CHIME_ERROR: () => (/* binding */ CHIME_ERROR),
/* harmony export */   CHIME_WAKE: () => (/* binding */ CHIME_WAKE),
/* harmony export */   playChime: () => (/* binding */ playChime),
/* harmony export */   playMultiNoteChime: () => (/* binding */ playMultiNoteChime)
/* harmony export */ });
/**
 * Voice Satellite Card — Chime Utility
 *
 * Shared Web Audio API chime synthesis. Supports reusing the card's
 * existing AudioContext (unlocked by user gesture) with automatic
 * fallback to a new context.
 */

/** Predefined chime note patterns */
const CHIME_WAKE = {
  type: 'single',
  wave: 'sine',
  notes: [{
    freq: 523,
    start: 0
  }, {
    freq: 659,
    start: 0.08
  }, {
    freq: 784,
    start: 0.16
  }],
  duration: 0.25
};
const CHIME_ERROR = {
  type: 'single',
  wave: 'square',
  volumeScale: 0.3,
  notes: [{
    freq: 300,
    start: 0
  }, {
    freq: 200,
    start: 0.08
  }],
  duration: 0.15
};
const CHIME_DONE = {
  type: 'single',
  wave: 'sine',
  notes: [{
    freq: 784,
    start: 0
  }, {
    freq: 659,
    start: 0.08
  }],
  duration: 0.25
};
const CHIME_ANNOUNCE_URI = 'data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAAWGluZwAAAA8AAABHAAAJ2wAsNDo6PEJCREdPT1FXV1lfZGRmaWlucXR0dnl5fH6BgYSGhomLi46Rk5OWmZmbnqGho6amqKuurrCzs7a4u7u+wMDDxcXIy83N0NPT1djb293g4OLl6Ojq7e3w8vX1+Pr6/f8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJAJ2AAAAAAAACduXdSMzAAAAAAAAAAAAAAAAAP/zkMQABKACtA1AAAAhIf//////WD7//////+UDBQEFAG8QAAwAA////////4tHrTBwb1nAKAQwAWv4GNQjv/gALnV////////lgLfymat/9gaiyIf/0wgGjEYcAf////////rqE9AlozJOsr////////////Uk5Mol0UiKDADgf/0EwbiN//////////////uLQ4epCADgf/2iAIJ7/////////////1DUUXUCgAcD/+GAlf//////1B6B//dgWCav////////////rTTMQFhiYyognA/2UxiYERBp4DRkFFE2mt////////////1oooFIRghgYkdAKn4ExhoMptbiMZpfCf/zMMTlDsL+0B+AoCQ0KggA4H/9SQDSP//////////////ckC7kabUCgAcD/+JQhb/////////////4gmVMQU0Cgf/zoG0Xgf/UuAxx8P/zIMTrCIKuvAfAkAEd6nQQ///////////+1MwYzXWYJUcJoa0aW/eeGJ2nyIkWlSC8D/r/8xDE8AXyusQWBBeQ1KWbBkEDXKjZ2//////zIMTlBaK2wBYAW4D///////9S0HU0UQCBvOWduMNageQ2nIkcAf/1koCfV///////////8xDE9QN5XtAeAFeA///0E94FTyoMAOB//P/zEMT0BhK2wAYDTZGWE2f///////////////MwxOgM8s6cDgT3kdxwlj0IAOB//dAA5Pf////////////+gHBl1QwA4H/9JATz//////////////MmA4H/8UMKDD/+dBtMQU1FqqoC//MQxPUGOrbUFgNxkIH/8rEFTEFNRVVVVQj/8yDE6QUisuAeAFWAP/5wGKpMQU1FqqqqA4H/8EHVTEFNRVVVVQOB//cJVUxBTUVVVVUD//MQxPgBcVrgGABTgIH/8ME1TEFNRVVVVQL/8yDE/wqSyqgGA3WRgf/ysCFMQU1FMy4xMAw//mwOTEFNRaqqqgKB//KwWkxBTUWqqgOB//MgxPsKMsKoDgU3kf/xwGtVTEFNRVVVVQOB//UJlUxBTUVVVVUDgf/xQYpMQU1FMy4xMP/zEMT5BYqywAYEV5AMP/50J0xBTUUzLjEw//MQxO8FarbUFgBbgAw//k4JTEFNRTMuMTD/8yDE5gWStsAWBA+EMFVVQDVMQU1FMy4xMDBVVYLlTEFNRTMuMTAwVVWEqkxBTUUzLjEw//MQxPYFArLIFgBbgDCqqoaqTEFNRTMuMTD/8xDE7wFZWuQYAE+AMKqqsGJMQU1FMy4xMP/zEMT2AUFa3BAAU4IwqqpgHUxBTUUzLjEw//MQxPgBaVrUGABTgDBVVbGFTEFNRTMuMTD/8xDE+AFJWsgQAFeCMFVVoKpMQU1FMy4xMP/zEMT4AWla0BgAT4AwqqqBqkxBTUUzLjEw//MQxPgBUVrQGABPgDCqqoLVTEFNRTMuMTD/8xDE+AFhWsgYAE+AMFVVg6pMQU1FMy4xMP/zEMT4AXFawBgAU4AwqqpwBUxBTUUzLjEw//MQxPcBOVrEEABNgjBVVWFqTEFNRTMuMTD/8xDE+AFxWrgYAFOAMKqqcGpMQU1FMy4xMP/zEMT5AYletBgAT4AwqqqA1UxBTUUzLjEw//MQxPgBUVq4GABPgDBVVVWKTEFNRTMuMTD/8xDE+AFZWrAYAE+AMFVVVYxMQU1Fqqr////zEMT3AUFarBAAU4L////L1UxBTUVVVf////MQxPcBOVqsEABNgv///8WVTEFNRTMuMTD/8xDE9ABxWqAAAA68MFVVVVVMQU1FMy4xMP/zEMT0AGFaoAAADrwwVVVVVUxBTUUzLjEw//MQxPQAWVqkAAAOvDBVVVVVTEFNRTMuMTD/8xDE9ABRWpwAAA68MFVVVVVMQU1FMy4xMP/zEMT0AHFalAAAErwwVVVVVUxBTUUzLjEw//MQxPQAaVqQAAAMvDBVVVVVTEFNRTMuMTD/8xDE9ABhWogAABK8MFVVVVVMQU1FMy4xMP/zEMT0AGlahAAAErwwVVVVVUxBTUUzLjEw//MQxPQAUVqMAAAKvDBVVVVVTEFNRTMuMTD/8xDE9ABJWowAAAq8MFVVVVVMQU1FMy4xMP/zEMT0AElaiAAACrwwVVVVVUxBTUUzLjEw//MQxPQAaVp8AAAMvDBVVVVVTEFNRTMuMTD/8xDE9ABZWngAAAy8MFVVVVVMQU1FMy4xMP/zEMT0AGFadAAADLwwVVVVVUxBTUUzLjEw//MQxPQASVp8AAAEvDBVVVVVTEFNRTMuMTD/8xDE8wBBWoAAAAS8MFVVVVVMQU1FMy4xMP/zEMTzADlafAAABLwwVVVVVUxBTUUzLjEw//MQxPkBiAKEAAAAADBVVVVVTEFNRTMuMTD/8xDE+QGQAnwAAAAAMFVVVVVMQU1FMy4xMP/zEMTyAAAD/AAAAAAwVVVVVUxBTUUzLjEw//MQxPIAAANIAAAAADBVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDE8gAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMTyAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxPIAAANIAAAAAFVVVVVVVVVVVVVVVVU=';
const CHIME_ALERT = {
  type: 'multi',
  wave: 'sine',
  notes: [{
    freq: 880,
    start: 0,
    end: 0.15
  }, {
    freq: 660,
    start: 0.18,
    end: 0.33
  }, {
    freq: 880,
    start: 0.36,
    end: 0.55
  }]
};

/**
 * Get or create an AudioContext, preferring the card's existing one.
 * @param {object} card - Card instance (uses card.audio.audioContext)
 * @returns {{ ctx: AudioContext, owned: boolean }}
 */
function getOrCreateContext(card) {
  const existing = card.audio?.audioContext;
  if (existing && existing.state !== 'closed') {
    if (existing.state === 'suspended') existing.resume();
    return {
      ctx: existing,
      owned: false
    };
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  return {
    ctx,
    owned: true
  };
}

/**
 * Play a "single oscillator" chime (wake, error, done).
 * Uses one oscillator with frequency steps.
 *
 * @param {object} card - Card instance
 * @param {object} pattern - Chime pattern object
 * @param {object} [log] - Logger instance
 */
function playChime(card, pattern, log) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const volume = card.mediaPlayer.volume * 0.5;
    const vol = volume * (pattern.volumeScale || 1);
    osc.type = pattern.wave;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + pattern.duration);
    for (const note of pattern.notes) {
      osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.start);
    }
    osc.start();
    osc.stop(ctx.currentTime + pattern.duration);
    setTimeout(() => ctx.close(), 500);
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
  }
}

/**
 * Play a "multi-note" chime with separate oscillators per note (announce, alert).
 * Each note has its own envelope with attack/release.
 *
 * @param {object} card - Card instance
 * @param {object} pattern - Chime pattern with individual note envelopes
 * @param {object} [options]
 * @param {Function} [options.onDone] - Callback after chime completes
 * @param {object} [options.log] - Logger instance
 * @returns {void}
 */
function playMultiNoteChime(card, pattern, options = {}) {
  const {
    onDone,
    log
  } = options;
  try {
    const {
      ctx,
      owned
    } = getOrCreateContext(card);
    const volume = card.mediaPlayer.volume * 0.25;
    for (const note of pattern.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = pattern.wave;
      osc.frequency.setValueAtTime(note.freq, ctx.currentTime + note.start);
      gain.gain.setValueAtTime(0, ctx.currentTime + note.start);
      gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + note.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.end);
      osc.start(ctx.currentTime + note.start);
      osc.stop(ctx.currentTime + note.end);
    }
    if (pattern.totalMs || onDone) {
      setTimeout(() => {
        if (owned) ctx.close();
        onDone?.();
      }, pattern.totalMs || 600);
    } else if (owned) {
      setTimeout(() => ctx.close(), 1000);
    }
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
    onDone?.();
  }
}

/***/ },

/***/ "./src/audio/comms.js"
/*!****************************!*\
  !*** ./src/audio/comms.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   sendBinaryAudio: () => (/* binding */ sendBinaryAudio)
/* harmony export */ });
/**
 * Voice Satellite Card — Audio Comms
 *
 * Binary PCM audio transmission via WebSocket.
 */

/**
 * Send binary PCM data via the HA WebSocket connection.
 * @param {object} card - Card instance (for connection access)
 * @param {Int16Array} pcmData - 16-bit PCM audio samples
 * @param {number} binaryHandlerId - Pipeline binary handler ID
 */
function sendBinaryAudio(card, pcmData, binaryHandlerId) {
  const {
    connection
  } = card;
  if (!connection?.socket) return;
  if (connection.socket.readyState !== WebSocket.OPEN) return;
  const message = new Uint8Array(1 + pcmData.byteLength);
  message[0] = binaryHandlerId;
  message.set(new Uint8Array(pcmData.buffer), 1);
  connection.socket.send(message.buffer);
}

/***/ },

/***/ "./src/audio/index.js"
/*!****************************!*\
  !*** ./src/audio/index.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   AudioManager: () => (/* binding */ AudioManager)
/* harmony export */ });
/* harmony import */ var _processing_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./processing.js */ "./src/audio/processing.js");
/**
 * Voice Satellite Card — AudioManager
 *
 * Handles microphone acquisition, AudioContext management,
 * and audio stream send control.
 */


class AudioManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._audioContext = null;
    this._mediaStream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._audioBuffer = [];
    this._sendInterval = null;
    this._actualSampleRate = 16000;
  }

  // --- Public accessors ---

  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }
  get audioContext() {
    return this._audioContext;
  }
  get workletNode() {
    return this._workletNode;
  }
  set workletNode(val) {
    this._workletNode = val;
  }
  get audioBuffer() {
    return this._audioBuffer;
  }
  set audioBuffer(val) {
    this._audioBuffer = val;
  }
  get actualSampleRate() {
    return this._actualSampleRate;
  }

  // --- Public API ---

  async startMicrophone() {
    await this._ensureAudioContextRunning();
    const {
      config
    } = this._card;
    this._log.log('mic', `AudioContext state=${this._audioContext.state} sampleRate=${this._audioContext.sampleRate}`);
    const audioConstraints = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: config.echo_cancellation,
      noiseSuppression: config.noise_suppression,
      autoGainControl: config.auto_gain_control
    };
    if (config.voice_isolation) {
      audioConstraints.advanced = [{
        voiceIsolation: true
      }];
    }
    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });
    if (config.debug) {
      const tracks = this._mediaStream.getAudioTracks();
      this._log.log('mic', `Got media stream with ${tracks.length} audio track(s)`);
      if (tracks.length > 0) {
        this._log.log('mic', `Track settings: ${JSON.stringify(tracks[0].getSettings())}`);
      }
    }
    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._actualSampleRate = this._audioContext.sampleRate;
    this._log.log('mic', `Actual sample rate: ${this._actualSampleRate}`);

    // Tap mic into analyser for reactive bar (parallel connection — doesn't disrupt pipeline)
    if (this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false) {
      this._card.analyser.attachMic(this._sourceNode, this._audioContext);
    }
    await (0,_processing_js__WEBPACK_IMPORTED_MODULE_0__.setupAudioWorklet)(this, this._sourceNode);
    this._log.log('mic', 'Audio capture via AudioWorklet');
  }
  stopMicrophone() {
    this.stopSending();
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._sourceNode) {
      this._card.analyser.detachMic(this._sourceNode);
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => track.stop());
      this._mediaStream = null;
    }
    this._audioBuffer = [];
  }

  /**
   * @param {() => number|null} binaryHandlerIdGetter
   */
  startSending(binaryHandlerIdGetter) {
    this.stopSending();
    let firstSendLogged = false;
    this._sendInterval = setInterval(() => {
      const handlerId = binaryHandlerIdGetter();
      if (!firstSendLogged && this._audioBuffer.length > 0) {
        firstSendLogged = true;
        this._log.log('mic', `First audio send — handlerId=${handlerId} bufferChunks=${this._audioBuffer.length}`);
      }
      (0,_processing_js__WEBPACK_IMPORTED_MODULE_0__.sendAudioBuffer)(this, handlerId);
    }, 100);
  }
  stopSending() {
    if (this._sendInterval) {
      clearInterval(this._sendInterval);
      this._sendInterval = null;
    }
  }
  pause() {
    this.stopSending();
    this._mediaStream?.getAudioTracks().forEach(track => {
      track.enabled = false;
    });
  }
  async resume() {
    // Discard stale audio accumulated during the hidden period — the worklet
    // may have kept running (producing silence) while the tab was in the
    // background.  Sending this to the server would clog the wake word engine.
    this._audioBuffer = [];
    this._mediaStream?.getAudioTracks().forEach(track => {
      track.enabled = true;
    });
    // Browser suspends AudioContext when tab is in background —
    // worklet/processor stops producing audio until we resume it.
    if (this._audioContext?.state === 'suspended') {
      this._log.log('mic', 'Resuming suspended AudioContext');
      await this._audioContext.resume();
    }
  }
  async ensureAudioContextForGesture() {
    try {
      if (!this._audioContext) {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000
        });
      }
      if (this._audioContext.state === 'suspended') {
        await this._audioContext.resume();
      }
    } catch (e) {
      this._log.error('mic', `Failed to resume AudioContext on click: ${e}`);
    }
  }

  // --- Private ---

  async _ensureAudioContextRunning() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
    }
    if (this._audioContext.state === 'suspended') {
      this._log.log('mic', 'Resuming suspended AudioContext');
      await this._audioContext.resume();
    }
    if (this._audioContext.state !== 'running') {
      throw new Error(`AudioContext failed to start: ${this._audioContext.state}`);
    }
  }
}

/***/ },

/***/ "./src/audio/media-playback.js"
/*!*************************************!*\
  !*** ./src/audio/media-playback.js ***!
  \*************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   buildMediaUrl: () => (/* binding */ buildMediaUrl),
/* harmony export */   playMediaUrl: () => (/* binding */ playMediaUrl)
/* harmony export */ });
/**
 * Voice Satellite Card — Media Playback Utility
 *
 * Shared helpers for browser audio playback and URL normalization.
 * Used by TtsManager and AnnouncementManager.
 */

/**
 * Normalize a URL path to an absolute URL.
 * Handles: full URLs (returned as-is), root-relative paths, and bare paths.
 *
 * @param {string} urlPath - URL or path to normalize
 * @returns {string} Absolute URL
 */
function buildMediaUrl(urlPath) {
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return urlPath;
  }
  const base = window.location.origin;
  return urlPath.startsWith('/') ? base + urlPath : `${base}/${urlPath}`;
}

/**
 * Play an audio URL in the browser using an HTML Audio element.
 *
 * @param {string} url - Full URL to play
 * @param {number} volume - Volume 0–1
 * @param {object} callbacks
 * @param {Function} callbacks.onEnd - Called on successful completion
 * @param {Function} callbacks.onError - Called on error (receives error event)
 * @param {Function} [callbacks.onStart] - Called when playback starts
 * @returns {HTMLAudioElement} The audio element (for external stop/cleanup)
 */
function playMediaUrl(url, volume, {
  onEnd,
  onError,
  onStart
}) {
  const audio = new Audio();
  audio.volume = volume;
  audio.onended = () => {
    onEnd();
  };
  audio.onerror = e => {
    onError(e);
  };
  audio.src = url;
  audio.play().then(() => {
    onStart?.();
  }).catch(e => {
    onError(e);
  });
  return audio;
}

/***/ },

/***/ "./src/audio/processing.js"
/*!*********************************!*\
  !*** ./src/audio/processing.js ***!
  \*********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   sendAudioBuffer: () => (/* binding */ sendAudioBuffer),
/* harmony export */   setupAudioWorklet: () => (/* binding */ setupAudioWorklet)
/* harmony export */ });
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./comms.js */ "./src/audio/comms.js");
/**
 * Voice Satellite Card — Audio Processing
 *
 * AudioWorklet/ScriptProcessor setup, resampling, and buffer management.
 */



/**
 * Set up AudioWorklet capture.
 * @param {import('./index.js').AudioManager} mgr
 * @param {MediaStreamAudioSourceNode} sourceNode
 */
async function setupAudioWorklet(mgr, sourceNode) {
  const workletCode = 'class VoiceSatelliteProcessor extends AudioWorkletProcessor {' + 'constructor() { super(); this.buffer = []; }' + 'process(inputs, outputs, parameters) {' + 'var input = inputs[0];' + 'if (input && input[0]) {' + 'var channelData = new Float32Array(input[0]);' + 'this.port.postMessage(channelData);' + '}' + 'return true;' + '}' + '}' + 'registerProcessor("voice-satellite-processor", VoiceSatelliteProcessor);';
  const blob = new Blob([workletCode], {
    type: 'application/javascript'
  });
  const workletUrl = URL.createObjectURL(blob);
  await mgr.audioContext.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);
  mgr.workletNode = new AudioWorkletNode(mgr.audioContext, 'voice-satellite-processor');
  mgr.workletNode.port.onmessage = e => {
    mgr.audioBuffer.push(e.data);
  };
  sourceNode.connect(mgr.workletNode);
  // Connect through a silent gain node — keeps the graph alive for processing
  // without routing mic audio to speakers (which would cause feedback).
  const silentGain = mgr.audioContext.createGain();
  silentGain.gain.value = 0;
  mgr.workletNode.connect(silentGain);
  silentGain.connect(mgr.audioContext.destination);
}

/**
 * Combine buffered audio, resample, and send via WebSocket.
 * @param {import('./index.js').AudioManager} mgr
 * @param {number|null} binaryHandlerId
 */
function sendAudioBuffer(mgr, binaryHandlerId) {
  if (binaryHandlerId === null || binaryHandlerId === undefined) return;
  if (mgr.audioBuffer.length === 0) return;
  let totalLength = 0;
  for (const chunk of mgr.audioBuffer) {
    totalLength += chunk.length;
  }
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of mgr.audioBuffer) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  mgr.audioBuffer = [];
  const resampled = mgr.actualSampleRate !== 16000 ? resample(combined, mgr.actualSampleRate, 16000) : combined;
  const pcmData = floatTo16BitPCM(resampled);
  (0,_comms_js__WEBPACK_IMPORTED_MODULE_0__.sendBinaryAudio)(mgr.card, pcmData, binaryHandlerId);
}

/**
 * Linear interpolation resampler.
 * @param {Float32Array} inputSamples
 * @param {number} fromSampleRate
 * @param {number} toSampleRate
 * @returns {Float32Array}
 */
function resample(inputSamples, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) return inputSamples;
  const ratio = fromSampleRate / toSampleRate;
  const outputLength = Math.round(inputSamples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, inputSamples.length - 1);
    const frac = srcIndex - low;
    output[i] = inputSamples[low] * (1 - frac) + inputSamples[high] * frac;
  }
  return output;
}

/**
 * Convert float audio samples to 16-bit PCM.
 * @param {Float32Array} float32Array
 * @returns {Int16Array}
 */
function floatTo16BitPCM(float32Array) {
  const pcmData = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcmData;
}

/***/ },

/***/ "./src/card/chat.js"
/*!**************************!*\
  !*** ./src/card/chat.js ***!
  \**************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ChatManager: () => (/* binding */ ChatManager)
/* harmony export */ });
/**
 * Voice Satellite Card — ChatManager
 *
 * Manages chat message state, streaming text fade effect,
 * and legacy API wrappers. All DOM ops delegate to UIManager.
 */

const FADE_LEN = 24;
class ChatManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._streamEl = null;
    this._streamedResponse = '';

    // Reusable fade span pool — avoids creating/destroying 24 DOM nodes per update
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;

    // RAF coalescing — multiple rapid stream chunks produce one DOM write per frame
    this._pendingText = null;
    this._rafId = null;
  }
  get streamEl() {
    return this._streamEl;
  }
  set streamEl(el) {
    this._streamEl = el;
  }
  get streamedResponse() {
    return this._streamedResponse;
  }
  set streamedResponse(val) {
    this._streamedResponse = val;
  }
  showTranscription(text) {
    this.addUser(text);
  }
  showResponse(text) {
    if (this._streamEl) {
      this._card.ui.updateChatText(this._streamEl, text);
    } else {
      this.addAssistant(text);
    }
  }
  updateResponse(text) {
    if (!this._streamEl) {
      this.addAssistant(text);
    } else {
      this._scheduleStreaming(text);
    }
  }

  // --- Core Methods ---

  addUser(text) {
    this._card.ui.addChatMessage(text, 'user');
  }
  addAssistant(text) {
    this._streamEl = this._card.ui.addChatMessage(text, 'assistant');
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
  }
  clear() {
    this._card.ui.clearChat();
    this._streamEl = null;
    this._streamedResponse = '';
    this._fadeSpans = null;
    this._solidNode = null;
    this._fadeContainer = null;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._pendingText = null;
    }
  }

  // --- Private ---

  /** Coalesce rapid stream chunks into one DOM write per frame. */
  _scheduleStreaming(text) {
    this._pendingText = text;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        if (this._pendingText !== null) {
          this._updateStreaming(this._pendingText);
          this._pendingText = null;
        }
      });
    }
  }
  _updateStreaming(text) {
    if (!this._streamEl) return;
    if (text.length <= FADE_LEN) {
      this._card.ui.updateChatText(this._streamEl, text);
      return;
    }

    // Lazily create the fade DOM structure once, then reuse it
    if (!this._fadeSpans) {
      this._initFadeNodes();
    }
    const solid = text.slice(0, text.length - FADE_LEN);
    const tail = text.slice(text.length - FADE_LEN);

    // Update text nodes in-place — no innerHTML, no DOM creation/destruction
    this._solidNode.textContent = solid;
    for (let i = 0; i < FADE_LEN; i++) {
      this._fadeSpans[i].textContent = i < tail.length ? tail[i] : '';
    }
  }

  /** Build the fade DOM structure once: a text node for solid text + 24 reusable spans. */
  _initFadeNodes() {
    this._streamEl.textContent = '';
    this._solidNode = document.createTextNode('');
    this._streamEl.appendChild(this._solidNode);
    this._fadeSpans = [];
    for (let i = 0; i < FADE_LEN; i++) {
      const span = document.createElement('span');
      span.style.opacity = ((FADE_LEN - i) / FADE_LEN).toFixed(2);
      this._fadeSpans.push(span);
      this._streamEl.appendChild(span);
    }
  }
}

/***/ },

/***/ "./src/card/comms.js"
/*!***************************!*\
  !*** ./src/card/comms.js ***!
  \***************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   syncSatelliteState: () => (/* binding */ syncSatelliteState)
/* harmony export */ });
/**
 * Voice Satellite Card — Card Comms
 *
 * WebSocket state sync from the card.
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * Sync pipeline state to the integration entity.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {string} state
 */
function syncSatelliteState(card, state) {
  const entityId = card.config.satellite_entity;
  if (!entityId || !card.hass?.connection) return;
  if (state === card.lastSyncedSatelliteState) return;
  card.lastSyncedSatelliteState = state;
  card.hass.connection.sendMessagePromise({
    type: 'voice_satellite/update_state',
    entity_id: entityId,
    state
  }).catch(() => {/* fire-and-forget */});
}

/***/ },

/***/ "./src/card/double-tap.js"
/*!********************************!*\
  !*** ./src/card/double-tap.js ***!
  \********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DoubleTapHandler: () => (/* binding */ DoubleTapHandler)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/notification-comms.js */ "./src/shared/notification-comms.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/**
 * Voice Satellite Card — DoubleTapHandler
 *
 * Detects double-taps on the document to cancel active interactions.
 * Includes touch/click deduplication for touch devices.
 */





class DoubleTapHandler {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._lastTapTime = 0;
    this._lastTapWasTouch = false;
    this._handler = null;
  }
  setup() {
    this._handler = e => {
      const isActive = _constants_js__WEBPACK_IMPORTED_MODULE_0__.INTERACTING_STATES.includes(this._card.currentState) || this._card.tts.isPlaying;
      const isTimerAlert = this._card.timer.alertActive;
      const isNotification = this._card.announcement.playing || this._card.askQuestion.playing || this._card.startConversation.playing || this._card.announcement.clearTimeoutId || this._card.startConversation.clearTimeoutId;
      if (!isActive && !isTimerAlert && !isNotification) return;

      // Touch/click deduplication
      if (e.type === 'click' && this._lastTapWasTouch) return;
      this._lastTapWasTouch = e.type === 'touchstart';
      const now = Date.now();
      const timeSinceLastTap = now - this._lastTapTime;
      this._lastTapTime = now;
      if (timeSinceLastTap < _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.DOUBLE_TAP_THRESHOLD && timeSinceLastTap > 0) {
        e.preventDefault();
        if (this._card.timer.alertActive) {
          this._log.log('ui', 'Double-tap detected — dismissing timer alert');
          this._card.timer.dismissAlert();
          return;
        }
        if (isNotification) {
          this._log.log('ui', 'Double-tap detected — dismissing notification');
          for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
            if (!mgr.playing && !mgr.clearTimeoutId) continue;
            if (mgr.currentAnnounceId) {
              (0,_shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_2__.sendAck)(this._card, mgr.currentAnnounceId, 'double-tap');
            }
            if (mgr.currentAudio) {
              mgr.currentAudio.pause();
              mgr.currentAudio = null;
            }
            mgr.playing = false;
            mgr.currentAnnounceId = null;
            (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_1__.clearNotificationUI)(mgr);
          }
          // Release server-side _question_event if ask_question was playing
          this._card.askQuestion.cancel();
          this._card.pipeline.restart(0);
          return;
        }
        this._log.log('ui', 'Double-tap detected — cancelling interaction');
        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }

        // Clean up ask_question STT mode (timers, server release, ANNOUNCEMENT blur)
        this._card.askQuestion.cancel();
        this._card.pipeline.clearContinueState();
        this._card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE);
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
        const isRemote = !!this._card.ttsTarget;
        if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_3__.getSwitchState)(this._card.hass, this._card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
          this._card.tts.playChime('done');
        }
        this._card.pipeline.restart(0);
      }
    };
    document.addEventListener('touchstart', this._handler, {
      passive: false
    });
    document.addEventListener('click', this._handler);
  }
}

/***/ },

/***/ "./src/card/events.js"
/*!****************************!*\
  !*** ./src/card/events.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   handlePipelineMessage: () => (/* binding */ handlePipelineMessage),
/* harmony export */   handleStartClick: () => (/* binding */ handleStartClick),
/* harmony export */   onTTSComplete: () => (/* binding */ onTTSComplete),
/* harmony export */   setState: () => (/* binding */ setState),
/* harmony export */   startListening: () => (/* binding */ startListening)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./comms.js */ "./src/card/comms.js");
/* harmony import */ var _shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/singleton.js */ "./src/shared/singleton.js");
/* harmony import */ var _shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../shared/satellite-subscription.js */ "./src/shared/satellite-subscription.js");
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/**
 * Voice Satellite Card — Card Events
 *
 * State transitions, user interactions, pipeline message dispatch,
 * and TTS completion handling.
 *
 * Uses ONLY public accessors on the card instance.
 */








/**
 * Set card state and update UI.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {string} newState
 */
function setState(card, newState) {
  const oldState = card.currentState;
  card.currentState = newState;
  card.logger.log('state', `${oldState} → ${newState}`);
  card.ui.updateForState(newState, card.pipeline.serviceUnavailable, card.tts.isPlaying);

  // Don't sync back to idle/listening while TTS is still playing (barge-in restart)
  if (card.tts.isPlaying && (newState === _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.LISTENING || newState === _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE)) return;
  (0,_comms_js__WEBPACK_IMPORTED_MODULE_1__.syncSatelliteState)(card, newState);
}

/**
 * Handle start button click.
 * @param {import('./index.js').VoiceSatelliteCard} card
 */
async function handleStartClick(card) {
  await card.audio.ensureAudioContextForGesture();
  await startListening(card);
}

/**
 * Start the voice pipeline (mic + pipeline).
 * @param {import('./index.js').VoiceSatelliteCard} card
 */
async function startListening(card) {
  if (_shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.isActive() && !_shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.isOwner(card)) {
    card.logger.log('lifecycle', 'Another instance is active, skipping');
    return;
  }
  if (_shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.isStarting()) {
    card.logger.log('lifecycle', 'Pipeline already starting globally, skipping');
    return;
  }
  _shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.setStarting(true);
  try {
    setState(card, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.CONNECTING);
    await card.audio.startMicrophone();
    await card.pipeline.start();
    _shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.claim(card);
    card.ui.hideStartButton();

    // Ensure visibility handler is on the owner — connectedCallback may
    // not have fired for this instance (e.g. card-mod creates an extra
    // element that gets config+hass but is never attached to the DOM).
    card.visibility.setup();

    // Subscribe notification managers now that we're the active owner
    card.timer.update();
    (0,_shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_3__.subscribeSatelliteEvents)(card, event => (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_4__.dispatchSatelliteEvent)(card, event));

    // Setup double-tap after first successful start
    card.doubleTap.setup();
  } catch (e) {
    const msg = e?.message || JSON.stringify(e);
    card.logger.error('pipeline', `Failed to start: ${msg}`);
    let reason = 'error';
    if (e.name === 'NotAllowedError') {
      reason = 'not-allowed';
      card.logger.log('mic', 'Access denied — browser requires user gesture');
    } else if (e.name === 'NotFoundError') {
      reason = 'not-found';
      card.logger.error('mic', 'No microphone found');
    } else if (e.name === 'NotReadableError' || e.name === 'AbortError') {
      reason = 'not-readable';
      card.logger.error('mic', 'Microphone in use or not readable');
    }
    setState(card, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE);
    if (reason !== 'error') {
      card.ui.showStartButton(reason);
    } else {
      card.pipeline.restart(card.pipeline.calculateRetryDelay());
    }
  } finally {
    _shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.setStarting(false);
  }
}

/**
 * Handle TTS playback completion.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {boolean} [playbackFailed]
 */
function onTTSComplete(card, playbackFailed) {
  // If a NEW interaction started during TTS, don't clean up
  const newInteractionStates = [_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.WAKE_WORD_DETECTED, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.STT, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.INTENT];
  if (newInteractionStates.includes(card.currentState)) {
    card.logger.log('tts', 'New interaction in progress — skipping cleanup');
    return;
  }

  // Continue conversation (only if TTS played successfully)
  if (!playbackFailed && card.pipeline.shouldContinue && card.pipeline.continueConversationId) {
    card.logger.log('pipeline', 'Continuing conversation — skipping wake word');
    const conversationId = card.pipeline.continueConversationId;
    card.pipeline.clearContinueState();
    card.chat.streamEl = null;

    // Keep blur, bar, and chat visible
    card.pipeline.restartContinue(conversationId);
    return;
  }

  // Normal completion
  const isRemote = !!card.ttsTarget;
  if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_5__.getSwitchState)(card.hass, card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
    card.tts.playChime('done');
  }
  card.chat.clear();
  card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
  card.ui.updateForState(card.currentState, card.pipeline.serviceUnavailable, false);
  (0,_comms_js__WEBPACK_IMPORTED_MODULE_1__.syncSatelliteState)(card, 'IDLE');

  // Play any queued notifications
  card.announcement.playQueued();
  card.askQuestion.playQueued();
  card.startConversation.playQueued();
}

/**
 * Dispatch a pipeline event message to the appropriate handler.
 * @param {import('./index.js').VoiceSatelliteCard} card
 * @param {object} message
 */
function handlePipelineMessage(card, message) {
  if (card.visibility.isPaused) {
    card.logger.log('event', `Ignoring event while paused: ${message.type}`);
    return;
  }
  if (card.pipeline.isRestarting) {
    card.logger.log('event', `Ignoring event while restarting: ${message.type}`);
    return;
  }
  const eventType = message.type;
  const eventData = message.data || {};
  if (card.config.debug) {
    const timestamp = message.timestamp ? message.timestamp.split('T')[1].split('.')[0] : '';
    card.logger.log('event', `${timestamp} ${eventType} ${JSON.stringify(eventData).substring(0, 500)}`);
  }
  switch (eventType) {
    case 'run-start':
      card.pipeline.handleRunStart(eventData);
      break;
    case 'wake_word-start':
      card.pipeline.handleWakeWordStart();
      break;
    case 'wake_word-end':
      card.pipeline.handleWakeWordEnd(eventData);
      break;
    case 'stt-start':
      setState(card, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.STT);
      break;
    case 'stt-vad-start':
      card.logger.log('event', 'VAD: speech started');
      break;
    case 'stt-vad-end':
      card.logger.log('event', 'VAD: speech ended');
      break;
    case 'stt-end':
      card.pipeline.handleSttEnd(eventData);
      break;
    case 'intent-start':
      setState(card, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.INTENT);
      break;
    case 'intent-progress':
      card.pipeline.handleIntentProgress(eventData);
      break;
    case 'intent-end':
      card.pipeline.handleIntentEnd(eventData);
      break;
    case 'tts-start':
      setState(card, _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.TTS);
      break;
    case 'tts-end':
      card.pipeline.handleTtsEnd(eventData);
      break;
    case 'run-end':
      card.pipeline.handleRunEnd();
      break;
    case 'error':
      card.pipeline.handleError(eventData);
      break;
    case 'displaced':
      card.logger.error('pipeline', 'Pipeline displaced — another browser is using this satellite entity');
      card.pipeline.stop();
      card.audio.stopMicrophone();
      card.tts.stop();
      card.timer.destroy();
      (0,_shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_3__.teardownSatelliteSubscription)();
      card.chat.clear();
      card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
      card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.ANNOUNCEMENT);
      _shared_singleton_js__WEBPACK_IMPORTED_MODULE_2__.release();
      card.currentState = _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE;
      card.ui.showStartButton();
      break;
  }
}

/***/ },

/***/ "./src/card/index.js"
/*!***************************!*\
  !*** ./src/card/index.js ***!
  \***************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   VoiceSatelliteCard: () => (/* binding */ VoiceSatelliteCard)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _skins_index_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../skins/index.js */ "./src/skins/index.js");
/* harmony import */ var _logger_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../logger.js */ "./src/logger.js");
/* harmony import */ var _audio__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../audio */ "./src/audio/index.js");
/* harmony import */ var _audio_analyser_js__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../audio/analyser.js */ "./src/audio/analyser.js");
/* harmony import */ var _tts__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ../tts */ "./src/tts/index.js");
/* harmony import */ var _pipeline__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ../pipeline */ "./src/pipeline/index.js");
/* harmony import */ var _ui_js__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! ./ui.js */ "./src/card/ui.js");
/* harmony import */ var _chat_js__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(/*! ./chat.js */ "./src/card/chat.js");
/* harmony import */ var _double_tap_js__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(/*! ./double-tap.js */ "./src/card/double-tap.js");
/* harmony import */ var _visibility_js__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(/*! ./visibility.js */ "./src/card/visibility.js");
/* harmony import */ var _timer__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(/*! ../timer */ "./src/timer/index.js");
/* harmony import */ var _announcement__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(/*! ../announcement */ "./src/announcement/index.js");
/* harmony import */ var _ask_question__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(/*! ../ask-question */ "./src/ask-question/index.js");
/* harmony import */ var _start_conversation__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(/*! ../start-conversation */ "./src/start-conversation/index.js");
/* harmony import */ var _media_player__WEBPACK_IMPORTED_MODULE_15__ = __webpack_require__(/*! ../media-player */ "./src/media-player/index.js");
/* harmony import */ var _editor__WEBPACK_IMPORTED_MODULE_16__ = __webpack_require__(/*! ../editor */ "./src/editor/index.js");
/* harmony import */ var _editor_preview_js__WEBPACK_IMPORTED_MODULE_17__ = __webpack_require__(/*! ../editor/preview.js */ "./src/editor/preview.js");
/* harmony import */ var _shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__ = __webpack_require__(/*! ../shared/singleton.js */ "./src/shared/singleton.js");
/* harmony import */ var _events_js__WEBPACK_IMPORTED_MODULE_19__ = __webpack_require__(/*! ./events.js */ "./src/card/events.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_20__ = __webpack_require__(/*! ./comms.js */ "./src/card/comms.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_21__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/* harmony import */ var _shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_22__ = __webpack_require__(/*! ../shared/satellite-subscription.js */ "./src/shared/satellite-subscription.js");
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_23__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/**
 * Voice Satellite Card — Main Card Class
 *
 * Thin orchestrator that owns the managers and wires them together.
 * All real work is delegated to composition-based managers.
 */

























class VoiceSatelliteCard extends HTMLElement {
  constructor() {
    super();

    // Core state
    this._state = _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE;
    this._lastSyncedSatelliteState = null;
    this._config = Object.assign({}, _constants_js__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_CONFIG);
    this._hass = null;
    this._connection = null;
    this._hasStarted = false;
    this._disconnectTimeout = null;

    // Logger (shared by all managers)
    this._logger = new _logger_js__WEBPACK_IMPORTED_MODULE_2__.Logger();

    // Composition — managers
    this._audio = new _audio__WEBPACK_IMPORTED_MODULE_3__.AudioManager(this);
    this._analyser = new _audio_analyser_js__WEBPACK_IMPORTED_MODULE_4__.AnalyserManager(this);
    this._tts = new _tts__WEBPACK_IMPORTED_MODULE_5__.TtsManager(this);
    this._pipeline = new _pipeline__WEBPACK_IMPORTED_MODULE_6__.PipelineManager(this);
    this._ui = new _ui_js__WEBPACK_IMPORTED_MODULE_7__.UIManager(this);
    this._chat = new _chat_js__WEBPACK_IMPORTED_MODULE_8__.ChatManager(this);
    this._doubleTap = new _double_tap_js__WEBPACK_IMPORTED_MODULE_9__.DoubleTapHandler(this);
    this._visibility = new _visibility_js__WEBPACK_IMPORTED_MODULE_10__.VisibilityManager(this);
    this._timer = new _timer__WEBPACK_IMPORTED_MODULE_11__.TimerManager(this);
    this._announcement = new _announcement__WEBPACK_IMPORTED_MODULE_12__.AnnouncementManager(this);
    this._askQuestion = new _ask_question__WEBPACK_IMPORTED_MODULE_13__.AskQuestionManager(this);
    this._startConversation = new _start_conversation__WEBPACK_IMPORTED_MODULE_14__.StartConversationManager(this);
    this._mediaPlayer = new _media_player__WEBPACK_IMPORTED_MODULE_15__.MediaPlayerManager(this);
  }

  // --- Public accessors ---

  get logger() {
    return this._logger;
  }
  get audio() {
    return this._audio;
  }
  get analyser() {
    return this._analyser;
  }
  get tts() {
    return this._tts;
  }
  get pipeline() {
    return this._pipeline;
  }
  get ui() {
    return this._ui;
  }
  get chat() {
    return this._chat;
  }
  get doubleTap() {
    return this._doubleTap;
  }
  get visibility() {
    return this._visibility;
  }
  get config() {
    return this._config;
  }
  get timer() {
    return this._timer;
  }
  get announcement() {
    return this._announcement;
  }
  get askQuestion() {
    return this._askQuestion;
  }
  get startConversation() {
    return this._startConversation;
  }
  get mediaPlayer() {
    return this._mediaPlayer;
  }
  get currentState() {
    return this._state;
  }
  set currentState(val) {
    this._state = val;
  }
  get lastSyncedSatelliteState() {
    return this._lastSyncedSatelliteState;
  }
  set lastSyncedSatelliteState(val) {
    this._lastSyncedSatelliteState = val;
  }
  get isOwner() {
    return _shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isOwner(this);
  }
  get connection() {
    if (!this._connection && this._hass?.connection) {
      this._connection = this._hass.connection;
    }
    return this._connection;
  }
  get hass() {
    return this._hass;
  }
  get ttsTarget() {
    return (0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_21__.getSelectEntityId)(this._hass, this._config.satellite_entity, 'tts_output') || '';
  }
  get announcementDisplayDuration() {
    return (0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_21__.getNumberState)(this._hass, this._config.satellite_entity, 'announcement_display_duration', 3.5);
  }

  // --- HTMLElement Lifecycle ---

  connectedCallback() {
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._render();
    requestAnimationFrame(() => {
      if ((0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.isEditorPreview)(this) && this.shadowRoot) {
        (0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.renderPreview)(this.shadowRoot, this._config);
        return;
      }
      if (!this._config.satellite_entity) return;
      this._ui.ensureGlobalUI();
      this._visibility.setup();
      if (!_shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isActive() && this._hass?.connection) {
        (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.startListening)(this);
      }
    });
  }
  disconnectedCallback() {
    this._disconnectTimeout = setTimeout(() => {
      // Still active instance but truly disconnected — keep running via global UI
    }, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.DISCONNECT_GRACE);
  }
  setConfig(config) {
    const hadEntity = !!this._config.satellite_entity;
    const skin = (0,_skins_index_js__WEBPACK_IMPORTED_MODULE_1__.getSkin)(config.skin || 'default');
    this._config = Object.assign({}, _constants_js__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_CONFIG, config);
    this._activeSkin = skin;
    this._logger.debug = this._config.debug;
    if (this._ui.element) {
      this._ui.applyStyles();

      // If reactive bar was just enabled and mic is already running, attach analyser
      const reactive = skin.reactiveBar && this._config.reactive_bar !== false;
      if (reactive && this._audio._sourceNode && this._audio._audioContext) {
        this._analyser.attachMic(this._audio._sourceNode, this._audio._audioContext);
      } else if (!reactive) {
        if (this._audio._sourceNode) this._analyser.detachMic(this._audio._sourceNode);
        this._analyser.stop();
      }

      // Re-evaluate reactive bar state after config change
      this._ui.updateForState(this._state, this._pipeline?.serviceUnavailable, this._tts?.isPlaying);
    }
    if (this.shadowRoot && (0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.isEditorPreview)(this)) {
      (0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.renderPreview)(this.shadowRoot, this._config);
    }

    // Propagate config to active instance if this is a secondary card
    _shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.propagateConfig(this);

    // If satellite entity was just configured, trigger startup
    if (!hadEntity && this._config.satellite_entity && !this._hasStarted && this._hass?.connection && !(0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.isEditorPreview)(this)) {
      this._connection = this._hass.connection;
      this._ui.ensureGlobalUI();
      this._hasStarted = true;
      (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.startListening)(this);
    }
  }
  set hass(hass) {
    this._hass = hass;

    // Preview cards in the editor should never start or subscribe
    if ((0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.isEditorPreview)(this)) return;

    // Only update subscriptions on the active owner
    if (_shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isActive() && _shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isOwner(this)) {
      this._timer.update();
      this._tts.checkRemotePlayback(hass);
      // Retry satellite subscription if initial attempt in startListening() failed
      (0,_shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_22__.subscribeSatelliteEvents)(this, event => (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_23__.dispatchSatelliteEvent)(this, event));
    }
    if (this._hasStarted) return;
    if (!hass?.connection) return;
    if (!this._config.satellite_entity) return;
    if (_shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isStarting()) return;
    if (_shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isActive() && !_shared_singleton_js__WEBPACK_IMPORTED_MODULE_18__.isOwner(this)) return;
    this._connection = hass.connection;
    this._ui.ensureGlobalUI();
    this._hasStarted = true;
    (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.startListening)(this);
  }
  getCardSize() {
    return 0;
  }
  static getConfigForm() {
    return (0,_editor__WEBPACK_IMPORTED_MODULE_16__.getConfigForm)();
  }
  static getStubConfig() {
    return {
      skin: 'default',
      text_scale: 100
    };
  }

  // --- Delegated methods (public API for managers) ---

  setState(newState) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.setState)(this, newState);
  }
  onStartClick() {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.handleStartClick)(this);
  }
  onPipelineMessage(message) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.handlePipelineMessage)(this, message);
  }
  onTTSComplete(playbackFailed) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_19__.onTTSComplete)(this, playbackFailed);
  }

  // --- Private ---

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({
        mode: 'open'
      });
    }
    if ((0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.isEditorPreview)(this)) {
      (0,_editor_preview_js__WEBPACK_IMPORTED_MODULE_17__.renderPreview)(this.shadowRoot, this._config);
    } else {
      this.shadowRoot.innerHTML = '<div id="voice-satellite-card" style="display:none;"></div>';
    }
  }
}

/***/ },

/***/ "./src/card/ui.js"
/*!************************!*\
  !*** ./src/card/ui.js ***!
  \************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   UIManager: () => (/* binding */ UIManager)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _shared_format_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/format.js */ "./src/shared/format.js");
/**
 * Voice Satellite Card — UIManager
 *
 * Single owner of ALL DOM manipulation in the card.
 * Manages: global overlay, rainbow bar, blur overlay, start button,
 * chat bubbles, timer pills/alerts, notification bubbles,
 * and error flash animations.
 */



class UIManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._globalUI = null;
    this._pendingStartButtonReason = undefined;
    this._blurReasons = {};

    // Timer DOM state
    this._timerContainer = null;
    this._timerAlertEl = null;
  }
  get element() {
    return this._globalUI;
  }

  // ─── Global UI Lifecycle ──────────────────────────────────────────

  ensureGlobalUI() {
    const existing = document.getElementById('voice-satellite-ui');
    if (existing) {
      this._globalUI = existing;
      this.applyStyles();
      this._flushPendingStartButton();
      return;
    }
    const ui = document.createElement('div');
    ui.id = 'voice-satellite-ui';
    ui.innerHTML = '<div class="vs-blur-overlay"></div>' + '<button class="vs-start-btn">' + '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>' + '</button>' + '<div class="vs-chat-container"></div>' + '<div class="vs-rainbow-bar"></div>';
    document.body.appendChild(ui);
    this._globalUI = ui;
    this._injectSkinCSS();
    this._applyCustomCSS();
    this._applyTextScale();
    this._applyBackgroundOpacity();
    ui.querySelector('.vs-start-btn').addEventListener('click', () => {
      this._card.onStartClick();
    });
    const btn = ui.querySelector('.vs-start-btn');
    btn.classList.add('visible');
    btn.title = 'Tap to start voice assistant';
    this._flushPendingStartButton();
  }

  // ─── Global Styles ────────────────────────────────────────────────

  applyStyles() {
    if (!this._globalUI) return;
    this._injectSkinCSS();
    this._applyCustomCSS();
    this._applyTextScale();
    this._applyBackgroundOpacity();
  }

  // ─── State-Driven Bar Updates ─────────────────────────────────────

  updateForState(state, serviceUnavailable, ttsPlaying) {
    if (!this._globalUI) return;

    // Don't touch the bar while a notification is playing — it manages its own bar state
    const notifPlaying = this._card.announcement.playing || this._card.askQuestion.playing || this._card.startConversation.playing;
    if (notifPlaying) return;
    const states = {
      IDLE: {
        barVisible: false
      },
      CONNECTING: {
        barVisible: false
      },
      LISTENING: {
        barVisible: false
      },
      PAUSED: {
        barVisible: false
      },
      WAKE_WORD_DETECTED: {
        barVisible: true,
        animation: 'listening',
        useReactive: true
      },
      STT: {
        barVisible: true,
        animation: 'listening',
        useReactive: true
      },
      INTENT: {
        barVisible: true,
        animation: 'processing'
      },
      TTS: {
        barVisible: true,
        animation: 'speaking',
        useReactive: true
      },
      ERROR: {
        barVisible: false
      }
    };
    const config = states[state];
    if (!config) return;
    if (serviceUnavailable && !config.barVisible) return;
    if (ttsPlaying && !config.barVisible) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    const reactive = this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false;
    if (config.barVisible) {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.add('visible');
      bar.classList.remove('connecting', 'listening', 'processing', 'speaking', 'reactive');
      if (config.animation) {
        bar.classList.add(config.animation);
      }
      if (reactive && config.useReactive) {
        bar.classList.add('reactive');
        this._globalUI.classList.add('reactive-mode');
        this._card.analyser.reconnectMic();
        this._card.analyser.start(bar);
      } else {
        bar.classList.remove('reactive');
        this._globalUI.classList.remove('reactive-mode');
      }
    } else {
      if (bar.classList.contains('error-mode')) this.clearErrorBar();
      bar.classList.remove('visible', 'connecting', 'listening', 'processing', 'speaking', 'reactive');
      this._globalUI.classList.remove('reactive-mode');
      if (reactive) this._card.analyser.stop();
    }
  }

  // ─── Start Button ─────────────────────────────────────────────────

  showStartButton(reason) {
    if (!this._globalUI) {
      this._pendingStartButtonReason = reason;
      return;
    }
    const btn = this._globalUI.querySelector('.vs-start-btn');
    btn.classList.add('visible');
    const titles = {
      'not-allowed': 'Tap to enable microphone',
      'not-found': 'No microphone found',
      'not-readable': 'Microphone unavailable - tap to retry'
    };
    btn.title = titles[reason] || 'Tap to start voice assistant';
  }
  hideStartButton() {
    this._globalUI?.querySelector('.vs-start-btn')?.classList.remove('visible');
  }

  // ─── Blur Overlay (reference-counted) ─────────────────────────────

  showBlurOverlay(reason) {
    if (!this._globalUI) return;
    this._blurReasons[reason || 'default'] = true;
    this._globalUI.querySelector('.vs-blur-overlay').classList.add('visible');
  }
  hideBlurOverlay(reason) {
    if (!this._globalUI) return;
    delete this._blurReasons[reason || 'default'];
    if (Object.keys(this._blurReasons).length === 0) {
      this._globalUI.querySelector('.vs-blur-overlay').classList.remove('visible');
    }
  }

  // ─── Rainbow Bar ──────────────────────────────────────────────────

  showErrorBar() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('connecting', 'listening', 'processing', 'speaking');
    bar.classList.add('visible', 'error-mode');
  }
  clearErrorBar() {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    bar.classList.remove('error-mode');
  }
  hideBar() {
    this._globalUI?.querySelector('.vs-rainbow-bar')?.classList.remove('visible');
  }

  /**
   * Show the bar in speaking mode, returning whether it was already visible.
   * @returns {boolean} Whether bar was previously visible
   */
  showBarSpeaking() {
    if (!this._globalUI) return false;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    if (!bar) return false;
    const wasVisible = bar.classList.contains('visible');
    const reactive = this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false;
    bar.classList.add('visible', 'speaking');
    if (reactive) {
      bar.classList.add('reactive');
      this._globalUI.classList.add('reactive-mode');
      this._card.analyser.start(bar);
    }
    return wasVisible;
  }

  /**
   * Restore bar after notification playback.
   * @param {boolean} wasVisible - Whether bar was visible before notification
   */
  restoreBar(wasVisible) {
    if (!this._globalUI) return;
    const bar = this._globalUI.querySelector('.vs-rainbow-bar');
    if (!bar) return;
    bar.classList.remove('speaking', 'reactive');
    this._globalUI.classList.remove('reactive-mode');
    if (this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false) this._card.analyser.stop();
    if (!wasVisible) {
      bar.classList.remove('visible');
    }
  }

  // ─── Chat Bubbles ─────────────────────────────────────────────────

  /**
   * Add a chat message bubble.
   * @param {string} text
   * @param {'user'|'assistant'|'announcement'} type
   * @returns {HTMLElement|null} The created element
   */
  addChatMessage(text, type) {
    if (!this._globalUI) return null;
    const container = this._globalUI.querySelector('.vs-chat-container');
    container.classList.add('visible');
    const msg = document.createElement('div');
    msg.className = `vs-chat-msg ${type}`;
    msg.textContent = text;
    container.appendChild(msg);
    return msg;
  }

  /**
   * Update text content of an existing chat element.
   * @param {HTMLElement} el
   * @param {string} text
   */
  updateChatText(el, text) {
    if (el) el.textContent = text;
  }

  /**
   * Update inner HTML of an existing chat element (for streaming fade).
   * @param {HTMLElement} el
   * @param {string} html
   */
  updateChatHtml(el, html) {
    if (el) el.innerHTML = html;
  }

  /**
   * Clear all chat messages.
   */
  clearChat() {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    container.classList.remove('visible');
  }

  /**
   * Toggle announcement-mode centering on the chat container.
   * @param {boolean} on
   */
  setAnnouncementMode(on) {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    if (!container) return;
    container.classList.toggle('announcement-mode', on);
  }

  /**
   * Clear only announcement bubbles.
   */
  clearAnnouncementBubbles() {
    if (!this._globalUI) return;
    const container = this._globalUI.querySelector('.vs-chat-container');
    const announcements = container?.querySelectorAll('.vs-chat-msg.announcement') || [];
    for (const el of announcements) el.remove();
    if (container && !container.firstChild) {
      container.classList.remove('visible');
    }
  }

  // ─── Timer Pills ──────────────────────────────────────────────────

  /**
   * Ensure the timer pill container exists in the DOM.
   */
  ensureTimerContainer() {
    if (this._timerContainer && document.body.contains(this._timerContainer)) return;
    const container = document.createElement('div');
    container.id = 'voice-satellite-timers';
    container.className = 'vs-timer-container';
    document.body.appendChild(container);
    this._timerContainer = container;
  }

  /**
   * Remove the timer container from the DOM.
   */
  removeTimerContainer() {
    this._timerContainer?.parentNode?.removeChild(this._timerContainer);
    this._timerContainer = null;
  }

  /**
   * Create a timer pill element.
   * @param {object} timer - Timer data { id, secondsLeft, totalSeconds }
   * @param {Function} onDoubleTap - Callback for double-tap cancel
   * @returns {HTMLElement}
   */
  createTimerPill(timer, onDoubleTap) {
    const pct = timer.totalSeconds > 0 ? Math.max(0, timer.secondsLeft / timer.totalSeconds * 100) : 0;
    const pill = document.createElement('div');
    pill.className = 'vs-timer-pill';
    pill.setAttribute('data-timer-id', timer.id);
    pill.innerHTML = `<div class="vs-timer-progress" style="width:${pct}%"></div>` + '<div class="vs-timer-content">' + '<span class="vs-timer-icon">⏱</span>' + `<span class="vs-timer-time">${(0,_shared_format_js__WEBPACK_IMPORTED_MODULE_1__.formatTime)(timer.secondsLeft)}</span>` + '</div>';

    // Cache child references to avoid querySelector on every tick
    pill._vsTimeEl = pill.querySelector('.vs-timer-time');
    pill._vsProgressEl = pill.querySelector('.vs-timer-progress');
    if (onDoubleTap) {
      _attachDoubleTap(pill, onDoubleTap);
    }
    return pill;
  }

  /**
   * Sync timer pills to match the current timer list.
   * @param {Array} timers - Array of { id, secondsLeft, totalSeconds, el }
   * @param {Function} onDoubleTap - Factory: (timerId) => callback
   */
  syncTimerPills(timers, onDoubleTap) {
    this.ensureTimerContainer();

    // Remove pills for timers that no longer exist
    const existing = this._timerContainer.querySelectorAll('.vs-timer-pill');
    for (const pill of existing) {
      const pillId = pill.getAttribute('data-timer-id');
      if (!timers.some(t => t.id === pillId)) {
        pill.parentNode.removeChild(pill);
      }
    }

    // Create pills for new timers
    for (const t of timers) {
      if (!t.el || !this._timerContainer.contains(t.el)) {
        t.el = this.createTimerPill(t, onDoubleTap(t.id));
        this._timerContainer.appendChild(t.el);
      }
    }
  }

  /**
   * Update a timer pill's display in-place.
   * @param {HTMLElement} el - Pill element
   * @param {number} secondsLeft
   * @param {number} totalSeconds
   */
  updateTimerPill(el, secondsLeft, totalSeconds) {
    if (!el) return;
    const timeEl = el._vsTimeEl;
    if (timeEl) timeEl.textContent = (0,_shared_format_js__WEBPACK_IMPORTED_MODULE_1__.formatTime)(secondsLeft);
    const progressEl = el._vsProgressEl;
    if (progressEl) {
      const pct = totalSeconds > 0 ? Math.max(0, secondsLeft / totalSeconds * 100) : 0;
      progressEl.style.width = `${pct}%`;
    }
  }

  /**
   * Animate a timer pill as expired and remove it.
   * @param {string} timerId
   * @param {number} animationMs
   */
  expireTimerPill(timerId, animationMs) {
    if (!this._timerContainer) return;
    const pill = this._timerContainer.querySelector(`.vs-timer-pill[data-timer-id="${timerId}"]`);
    if (pill) {
      pill.classList.add('vs-timer-expired');
      setTimeout(() => pill.parentNode?.removeChild(pill), animationMs);
    }
  }

  // ─── Timer Alert ──────────────────────────────────────────────────

  /**
   * Show the full-screen timer finished alert.
   * @param {Function} onDoubleTap - Callback to dismiss
   */
  showTimerAlert(onDoubleTap) {
    this._timerAlertEl = document.createElement('div');
    this._timerAlertEl.className = 'vs-timer-alert';
    this._timerAlertEl.innerHTML = '<span class="vs-timer-icon">⏱</span>' + '<span class="vs-timer-time">00:00:00</span>';
    document.body.appendChild(this._timerAlertEl);
    if (onDoubleTap) {
      _attachDoubleTap(this._timerAlertEl, onDoubleTap);
    }
  }

  /**
   * Remove all timer alert elements from the DOM.
   */
  clearTimerAlert() {
    for (const el of document.querySelectorAll('.vs-timer-alert')) {
      el.parentNode?.removeChild(el);
    }
    this._timerAlertEl = null;
  }

  // ─── Private ──────────────────────────────────────────────────────

  _injectSkinCSS() {
    const skin = this._card._activeSkin;
    if (!skin?.css) return;
    let el = document.getElementById('voice-satellite-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'voice-satellite-styles';
      document.head.appendChild(el);
    }
    el.textContent = skin.css;
  }
  _applyTextScale() {
    const scale = (this._card.config.text_scale || 100) / 100;
    document.documentElement.style.setProperty('--vs-text-scale', scale);
  }
  _applyBackgroundOpacity() {
    const overlay = this._globalUI?.querySelector('.vs-blur-overlay');
    if (!overlay) return;
    const skin = this._card._activeSkin;
    const c = skin?.overlayColor;
    if (c) {
      const skinDefault = Math.round((skin.defaultOpacity ?? 1) * 100);
      const alpha = (this._card.config.background_opacity ?? skinDefault) / 100;
      overlay.style.background = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
    }
  }
  _applyCustomCSS() {
    const css = this._card.config.custom_css || '';
    let el = document.getElementById('voice-satellite-custom-css');
    if (!css) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = 'voice-satellite-custom-css';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  _flushPendingStartButton() {
    if (this._pendingStartButtonReason !== undefined) {
      this.showStartButton(this._pendingStartButtonReason);
      this._pendingStartButtonReason = undefined;
    }
  }
}

// ─── Module-level helpers (no DOM, pure logic) ────────────────────

function _attachDoubleTap(el, callback) {
  let lastTap = 0;
  const handler = e => {
    const now = Date.now();
    if (now - lastTap < _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.DOUBLE_TAP_THRESHOLD && now - lastTap > 0) {
      e.preventDefault();
      e.stopPropagation();
      callback();
    }
    lastTap = now;
  };
  el.addEventListener('touchstart', handler, {
    passive: false
  });
  el.addEventListener('click', handler);
}

/***/ },

/***/ "./src/card/visibility.js"
/*!********************************!*\
  !*** ./src/card/visibility.js ***!
  \********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   VisibilityManager: () => (/* binding */ VisibilityManager)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/satellite-subscription.js */ "./src/shared/satellite-subscription.js");
/**
 * Voice Satellite Card — VisibilityManager
 *
 * Handles tab visibility changes: pauses mic and blocks events on hide,
 * resumes and restarts pipeline on show.
 */




class VisibilityManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._isPaused = false;
    this._debounceTimer = null;
    this._handler = null;
  }
  get isPaused() {
    return this._isPaused;
  }
  setup() {
    if (this._handler) return; // already registered
    this._handler = () => this._handleChange();
    document.addEventListener('visibilitychange', this._handler);
  }

  // --- Private ---

  _handleChange() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    // Only the singleton owner should manage visibility — non-owner instances
    // have no mic or pipeline and must not interfere with the active owner.
    if (!this._card.isOwner) return;
    if (document.hidden) {
      this._isPaused = true;

      // Cancel any in-progress ask_question flow — its cleanup timer
      // would otherwise fire after resume and double-restart the pipeline.
      this._card.askQuestion.cancel();
      if (_constants_js__WEBPACK_IMPORTED_MODULE_0__.INTERACTING_STATES.includes(this._card.currentState)) {
        this._log.log('visibility', 'Tab hidden during interaction — cleaning up UI');
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
        this._card.pipeline.clearContinueState();
        if (this._card.tts.isPlaying) {
          this._card.tts.stop();
        }
      }
      this._debounceTimer = setTimeout(() => {
        this._log.log('visibility', 'Tab hidden — pausing mic');
        this._pause();
      }, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.VISIBILITY_DEBOUNCE);
    } else {
      this._log.log('visibility', 'Tab visible — resuming');
      this._resume();
    }
  }
  _pause() {
    this._isPaused = true;
    this._card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.PAUSED);
    this._card.audio.pause();
    // Do NOT call pipeline.stop() here — the unawaited stop() creates a
    // race where the server is still cancelling the old pipeline task when
    // _resume() → restart(0) → start() creates a new subscription, causing
    // async_accept_pipeline_from_satellite() to silently fail.
    // restart(0) in _resume() handles the properly sequenced stop→start.
  }
  async _resume() {
    if (!this._isPaused) return;
    const {
      pipeline,
      audio
    } = this._card;

    // Cancel any pending restart timeout BEFORE yielding to the event loop.
    // Browsers throttle setTimeout in background tabs (≥1s in Chrome).
    // When the tab becomes visible, the throttled timeout can fire during
    // our await below, starting a concurrent pipeline.start() that races
    // with our own restart(0) — two subscriptions clobber each other's
    // binaryHandlerId, sending audio to a dead handler.
    pipeline.resetForResume();

    // Resume AudioContext — browser suspends it in background tabs,
    // and the worklet/processor can't produce audio until it's running.
    // Keep _isPaused = true during this await so stale pipeline events
    // from the still-active subscription are blocked by handlePipelineMessage.
    await this._card.audio.resume();

    // Now unpause and immediately enter restart — the synchronous path from
    // here to restart(0) / hasPendingSatelliteEvent has no awaits, so no
    // stale events can slip through the gap.
    this._isPaused = false;

    // If a satellite event (announcement/ask_question/start_conversation) was
    // queued while the tab was hidden, skip the wake-word pipeline restart.
    // The replayed event's flow will manage the pipeline (e.g. ask_question
    // calls restartContinue after playback).
    if ((0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_1__.hasPendingSatelliteEvent)()) {
      this._log.log('visibility', 'Resuming — satellite event pending, deferring pipeline restart');
      return;
    }

    // Re-establish satellite subscription — the WebSocket may have silently
    // reconnected while the tab was hidden, invalidating the old subscription.
    (0,_shared_satellite_subscription_js__WEBPACK_IMPORTED_MODULE_2__.refreshSatelliteSubscription)();
    this._log.log('visibility', 'Resuming — restarting pipeline');
    pipeline.restart(0);
  }
}

/***/ },

/***/ "./src/constants.js"
/*!**************************!*\
  !*** ./src/constants.js ***!
  \**************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   BlurReason: () => (/* binding */ BlurReason),
/* harmony export */   DEFAULT_CONFIG: () => (/* binding */ DEFAULT_CONFIG),
/* harmony export */   EXPECTED_ERRORS: () => (/* binding */ EXPECTED_ERRORS),
/* harmony export */   INTERACTING_STATES: () => (/* binding */ INTERACTING_STATES),
/* harmony export */   State: () => (/* binding */ State),
/* harmony export */   Timing: () => (/* binding */ Timing),
/* harmony export */   VERSION: () => (/* binding */ VERSION)
/* harmony export */ });
/**
 * Voice Satellite Card — Constants
 */

/* global __VERSION__ */
const VERSION = "5.0.1";
const State = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  LISTENING: 'LISTENING',
  PAUSED: 'PAUSED',
  WAKE_WORD_DETECTED: 'WAKE_WORD_DETECTED',
  STT: 'STT',
  INTENT: 'INTENT',
  TTS: 'TTS',
  ERROR: 'ERROR'
};

/** States that indicate an active user interaction */
const INTERACTING_STATES = [State.WAKE_WORD_DETECTED, State.STT, State.INTENT, State.TTS];

/** Pipeline errors that are expected and should not show error UI */
const EXPECTED_ERRORS = ['timeout', 'wake-word-timeout', 'stt-no-text-recognized', 'duplicate_wake_up_detected'];

/** Blur overlay reason identifiers */
const BlurReason = {
  PIPELINE: 'pipeline',
  TIMER: 'timer',
  ANNOUNCEMENT: 'announcement'
};

/** Timing constants (ms unless noted) */
const Timing = {
  DOUBLE_TAP_THRESHOLD: 400,
  TIMER_CHIME_INTERVAL: 3000,
  PILL_EXPIRE_ANIMATION: 400,
  PLAYBACK_WATCHDOG: 30000,
  RECONNECT_DELAY: 2000,
  INTENT_ERROR_DISPLAY: 3000,
  NO_MEDIA_DISPLAY: 3000,
  ASK_QUESTION_CLEANUP: 2000,
  ASK_QUESTION_STT_SAFETY: 30000,
  TOKEN_REFRESH_INTERVAL: 240_000,
  MAX_RETRY_DELAY: 30000,
  RETRY_BASE_DELAY: 5000,
  VISIBILITY_DEBOUNCE: 500,
  DISCONNECT_GRACE: 100,
  CHIME_SETTLE: 500
};
const DEFAULT_CONFIG = {
  // Behavior
  satellite_entity: '',
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
  reactive_bar: true
};

/***/ },

/***/ "./src/editor/behavior.js"
/*!********************************!*\
  !*** ./src/editor/behavior.js ***!
  \********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   behaviorHelpers: () => (/* binding */ behaviorHelpers),
/* harmony export */   behaviorLabels: () => (/* binding */ behaviorLabels),
/* harmony export */   behaviorSchema: () => (/* binding */ behaviorSchema),
/* harmony export */   debugSchema: () => (/* binding */ debugSchema),
/* harmony export */   microphoneSchema: () => (/* binding */ microphoneSchema)
/* harmony export */ });
/**
 * Voice Satellite Card — Editor: Behavior & Microphone
 */

const behaviorSchema = [{
  name: 'satellite_entity',
  required: true,
  selector: {
    entity: {
      filter: {
        domain: 'assist_satellite',
        integration: 'voice_satellite'
      }
    }
  }
}];
const microphoneSchema = [{
  type: 'expandable',
  name: '',
  title: 'Microphone Processing',
  flatten: true,
  schema: [{
    type: 'grid',
    name: '',
    flatten: true,
    schema: [{
      name: 'noise_suppression',
      selector: {
        boolean: {}
      }
    }, {
      name: 'echo_cancellation',
      selector: {
        boolean: {}
      }
    }, {
      name: 'auto_gain_control',
      selector: {
        boolean: {}
      }
    }, {
      name: 'voice_isolation',
      selector: {
        boolean: {}
      }
    }]
  }]
}];
const debugSchema = [{
  name: 'debug',
  selector: {
    boolean: {}
  }
}];
const behaviorLabels = {
  satellite_entity: 'Satellite entity',
  debug: 'Debug logging',
  noise_suppression: 'Noise suppression',
  echo_cancellation: 'Echo cancellation',
  auto_gain_control: 'Auto gain control',
  voice_isolation: 'Voice isolation (Chrome only)'
};
const behaviorHelpers = {
  satellite_entity: 'Required. Install the Voice Satellite Card Integration: https://github.com/jxlarrea/voice-satellite-card-integration',
  voice_isolation: 'AI-based voice isolation, currently only available in Chrome'
};

/***/ },

/***/ "./src/editor/index.js"
/*!*****************************!*\
  !*** ./src/editor/index.js ***!
  \*****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getConfigForm: () => (/* binding */ getConfigForm)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _behavior_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./behavior.js */ "./src/editor/behavior.js");
/* harmony import */ var _skin_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./skin.js */ "./src/editor/skin.js");
/**
 * Voice Satellite Card — Editor Assembler
 *
 * Combines all editor sections and their labels/helpers
 * into the schema returned by getConfigForm().
 */




const allLabels = Object.assign({}, _behavior_js__WEBPACK_IMPORTED_MODULE_1__.behaviorLabels, _skin_js__WEBPACK_IMPORTED_MODULE_2__.skinLabels);
const allHelpers = Object.assign({}, _behavior_js__WEBPACK_IMPORTED_MODULE_1__.behaviorHelpers, _skin_js__WEBPACK_IMPORTED_MODULE_2__.skinHelpers);
function getConfigForm() {
  return {
    schema: [..._behavior_js__WEBPACK_IMPORTED_MODULE_1__.behaviorSchema, ..._skin_js__WEBPACK_IMPORTED_MODULE_2__.skinSchema, ..._behavior_js__WEBPACK_IMPORTED_MODULE_1__.microphoneSchema, ..._behavior_js__WEBPACK_IMPORTED_MODULE_1__.debugSchema],
    assertConfig(config) {
      const editor = this;
      Promise.resolve().then(() => {
        editor._config = Object.assign({}, _constants_js__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_CONFIG, config);
      });
    },
    computeLabel(schema) {
      return allLabels[schema.name] || undefined;
    },
    computeHelper(schema) {
      return allHelpers[schema.name] || undefined;
    }
  };
}

/***/ },

/***/ "./src/editor/preview.js"
/*!*******************************!*\
  !*** ./src/editor/preview.js ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   isEditorPreview: () => (/* binding */ isEditorPreview),
/* harmony export */   renderPreview: () => (/* binding */ renderPreview)
/* harmony export */ });
/* harmony import */ var _skins_index_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../skins/index.js */ "./src/skins/index.js");
/* harmony import */ var _preview_css__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./preview.css */ "./src/editor/preview.css");
/**
 * Voice Satellite Card — Preview Renderer
 *
 * Renders a static preview of the card inside the HA card editor.
 * Shows the rainbow bar, sample chat bubbles, and a timer pill
 * so users can see the skin's appearance.
 */




/**
 * Detect whether this card element is inside the HA card editor preview.
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isEditorPreview(el) {
  let node = el;
  for (let i = 0; i < 20 && node; i++) {
    const tag = node.tagName;
    // Legacy: <hui-card-preview>
    if (tag === 'HUI-CARD-PREVIEW') return true;
    // Modern: <hui-card preview=""> (attribute or property)
    if (tag === 'HUI-CARD' && (node.hasAttribute('preview') || node.preview)) return true;
    // Sections layout: <hui-dialog-edit-card>
    if (tag === 'HUI-DIALOG-EDIT-CARD') return true;
    // Fallback: any element with 'preview' in tagname
    if (tag && tag.includes('PREVIEW')) return true;
    node = node.parentElement || (node.getRootNode && node.getRootNode()).host;
  }
  return false;
}

/**
 * Render a static preview inside the given shadow root.
 * All visual values are baked into the CSS — no config-driven styling needed.
 * @param {ShadowRoot} shadowRoot
 * @param {object} config
 */
function renderPreview(shadowRoot, config) {
  const skin = (0,_skins_index_js__WEBPACK_IMPORTED_MODULE_0__.getSkin)(config.skin || 'default');
  shadowRoot.innerHTML = `
    <style>
      ${_preview_css__WEBPACK_IMPORTED_MODULE_1__}
      ${skin.previewCSS || ''}
    </style>
    <div class="preview-background"></div>
    <div class="preview-container">
      <div class="preview-label">Preview</div>
      <div class="preview-blur"></div>
      <div class="preview-bar"></div>
      <div class="preview-chat">
        <div class="preview-msg user">What's the temperature outside?</div>
        <div class="preview-msg assistant">It's currently 75\u00B0F and sunny.</div>
      </div>
      <div class="preview-timer">
        <div class="preview-timer-progress"></div>
        <div class="preview-timer-content">
          <span>\u23F1</span>
          <span class="preview-timer-time">00:04:32</span>
        </div>
      </div>
    </div>
  `;
}

/***/ },

/***/ "./src/editor/skin.js"
/*!****************************!*\
  !*** ./src/editor/skin.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   skinHelpers: () => (/* binding */ skinHelpers),
/* harmony export */   skinLabels: () => (/* binding */ skinLabels),
/* harmony export */   skinSchema: () => (/* binding */ skinSchema)
/* harmony export */ });
/* harmony import */ var _skins_index_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../skins/index.js */ "./src/skins/index.js");
/**
 * Voice Satellite Card — Editor: Skin
 */


const skinSchema = [{
  type: 'expandable',
  name: '',
  title: 'Appearance',
  flatten: true,
  schema: [{
    name: 'skin',
    default: 'default',
    selector: {
      select: {
        options: (0,_skins_index_js__WEBPACK_IMPORTED_MODULE_0__.getSkinOptions)(),
        mode: 'dropdown'
      }
    }
  }, {
    name: 'reactive_bar',
    selector: {
      boolean: {}
    }
  }, {
    name: 'text_scale',
    default: 100,
    selector: {
      number: {
        min: 50,
        max: 200,
        step: 5,
        mode: 'slider',
        unit_of_measurement: '%'
      }
    }
  }, {
    name: 'background_opacity',
    default: 100,
    selector: {
      number: {
        min: 0,
        max: 100,
        step: 5,
        mode: 'slider',
        unit_of_measurement: '%'
      }
    }
  }, {
    name: 'custom_css',
    selector: {
      text: {
        multiline: true
      }
    }
  }]
}];
const skinLabels = {
  skin: 'Skin',
  text_scale: 'Text Scale',
  background_opacity: 'Background Opacity',
  reactive_bar: 'Reactive activity bar',
  custom_css: 'Custom CSS'
};
const skinHelpers = {
  background_opacity: 'If not set, the skin\'s default opacity level will be used',
  reactive_bar: 'Activity bar reacts to audio levels. Disable on slow devices to save resources.',
  custom_css: 'Advanced: CSS overrides applied on top of the selected skin'
};

/***/ },

/***/ "./src/logger.js"
/*!***********************!*\
  !*** ./src/logger.js ***!
  \***********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Logger: () => (/* binding */ Logger)
/* harmony export */ });
/**
 * Voice Satellite Card — Logger
 *
 * Centralised logging controlled by config.debug flag.
 * All managers receive a reference to this logger from the card.
 */

class Logger {
  constructor() {
    this._debug = false;
  }
  set debug(val) {
    this._debug = !!val;
  }

  /**
   * @param {string} category - Log tag (e.g. 'pipeline', 'tts')
   * @param {string} msg - Message
   * @param {*} [data] - Optional data to log
   */
  log(category, msg, data) {
    if (!this._debug) return;
    if (data !== undefined) {
      console.log(`[VS][${category}] ${msg}`, data);
    } else {
      console.log(`[VS][${category}] ${msg}`);
    }
  }

  /**
   * @param {string} category
   * @param {string} msg
   * @param {*} [data]
   */
  error(category, msg, data) {
    if (data !== undefined) {
      console.error(`[VS][${category}] ${msg}`, data);
    } else {
      console.error(`[VS][${category}] ${msg}`);
    }
  }
}

/***/ },

/***/ "./src/media-player/index.js"
/*!***********************************!*\
  !*** ./src/media-player/index.js ***!
  \***********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   MediaPlayerManager: () => (/* binding */ MediaPlayerManager)
/* harmony export */ });
/* harmony import */ var _audio_media_playback_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../audio/media-playback.js */ "./src/audio/media-playback.js");
/**
 * Voice Satellite Card — MediaPlayerManager
 *
 * Handles media_player commands pushed from the integration via the
 * satellite event subscription.  Plays audio in the browser, reports
 * state back via a WS command so the HA entity stays in sync.
 *
 * Also acts as the unified audio-state reporter: TTS, chimes, and
 * notification playback call notifyAudioStart/End so the HA
 * media_player entity reflects *all* audio output (matching Voice PE).
 */


class MediaPlayerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._audio = null;
    this._playing = false;
    this._paused = false;
    this._volume = 1.0;
    this._muted = false;
    this._mediaId = null;
    this._volumeSynced = false;

    // Unified audio-state tracking (TTS, chimes, notifications)
    this._activeSources = new Set();
    this._idleDebounce = null;
  }
  get isPlaying() {
    return this._playing;
  }

  /**
   * Effective volume with perceptual curve (volume²).
   * Syncs from the HA entity on first access after page load.
   */
  get volume() {
    this._syncInitialVolume();
    return this._muted ? 0 : this._volume * this._volume;
  }

  // --- External audio tracking (TTS, chimes, notifications) ---

  /**
   * Notify that an audio source has started playing.
   * @param {string} source - e.g. 'tts', 'chime', 'notification'
   */
  notifyAudioStart(source) {
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    this._activeSources.add(source);
    this._reportState('playing');
  }

  /**
   * Notify that an audio source has stopped playing.
   * Reports idle (debounced) when no audio remains active.
   * @param {string} source
   */
  notifyAudioEnd(source) {
    this._activeSources.delete(source);
    if (this._activeSources.size === 0 && !this._playing && !this._paused) {
      if (this._idleDebounce) clearTimeout(this._idleDebounce);
      this._idleDebounce = setTimeout(() => {
        this._idleDebounce = null;
        if (this._activeSources.size === 0 && !this._playing && !this._paused) {
          this._reportState('idle');
        }
      }, 200);
    }
  }

  // --- Media player commands (from integration) ---

  /**
   * Handle a command from the integration (via satellite subscription).
   * @param {object} data - {command, ...fields}
   */
  handleCommand(data) {
    const {
      command
    } = data;
    this._log.log('media-player', `Command: ${command}`);
    switch (command) {
      case 'play':
        this._play(data);
        break;
      case 'pause':
        this._pause();
        break;
      case 'resume':
        this._resume();
        break;
      case 'stop':
        this._stop();
        break;
      case 'volume_set':
        this._setVolume(data.volume);
        break;
      case 'volume_mute':
        this._setMute(data.mute);
        break;
      default:
        this._log.log('media-player', `Unknown command: ${command}`);
    }
  }

  /**
   * Interrupt own playback (e.g. wake word barge-in, notification).
   * Does NOT affect external audio sources — they manage themselves.
   */
  interrupt() {
    if (!this._playing && !this._paused) return;
    this._log.log('media-player', 'Interrupted');
    this._cleanup();
    if (this._activeSources.size === 0) {
      this._reportState('idle');
    }
  }

  // --- Private ---

  /** Apply perceptual curve to raw volume (0–1). */
  _curved(raw) {
    return raw * raw;
  }

  /** Effective volume after mute + curve. */
  _effectiveVolume() {
    return this._muted ? 0 : this._curved(this._volume);
  }

  /**
   * Sync volume and mute state from the HA entity on first access.
   * Runs once per page load so the card picks up the entity's current state.
   */
  _syncInitialVolume() {
    if (this._volumeSynced) return;
    const entityId = this._getEntityId();
    if (!entityId) return;
    const state = this._card.hass?.states?.[entityId];
    if (!state) return;
    const vol = state.attributes?.volume_level;
    if (vol !== undefined && vol !== null) {
      this._volume = vol;
      this._log.log('media-player', `Synced initial volume from entity: ${vol}`);
    }
    const muted = state.attributes?.is_volume_muted;
    if (muted !== undefined) {
      this._muted = muted;
    }
    this._volumeSynced = true;
  }
  async _play(data) {
    // Stop any current playback
    this._cleanup();
    const {
      media_id,
      volume
    } = data;
    if (volume !== undefined && volume !== null) {
      this._volume = volume;
    }
    this._mediaId = media_id;

    // Sign relative URLs — HA media endpoints require authentication
    let url;
    if (media_id.startsWith('http://') || media_id.startsWith('https://')) {
      url = media_id;
    } else {
      const conn = this._card.connection;
      if (conn) {
        try {
          const result = await conn.sendMessagePromise({
            type: 'auth/sign_path',
            path: media_id,
            expires: 3600
          });
          url = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_0__.buildMediaUrl)(result.path);
        } catch (e) {
          this._log.error('media-player', `Failed to sign URL: ${e}`);
          url = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_0__.buildMediaUrl)(media_id);
        }
      } else {
        url = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_0__.buildMediaUrl)(media_id);
      }
    }
    this._playing = true;
    this._paused = false;
    this._audio = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_0__.playMediaUrl)(url, this._effectiveVolume(), {
      onEnd: () => {
        this._log.log('media-player', 'Playback complete');
        this._playing = false;
        this._paused = false;
        this._audio = null;
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onError: e => {
        this._log.error('media-player', `Playback error: ${e}`);
        this._playing = false;
        this._paused = false;
        this._audio = null;
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onStart: () => {
        this._log.log('media-player', `Playing: ${media_id}`);
        this._reportState('playing');
      }
    });
  }
  _pause() {
    if (!this._audio || !this._playing) {
      this._reportState('idle');
      return;
    }
    this._audio.pause();
    this._playing = false;
    this._paused = true;
    this._reportState('paused');
  }
  _resume() {
    if (!this._audio || !this._paused) {
      this._reportState('idle');
      return;
    }
    this._audio.play().catch(e => {
      this._log.error('media-player', `Resume failed: ${e}`);
      this._cleanup();
      this._reportState('idle');
    });
    this._playing = true;
    this._paused = false;
    this._reportState('playing');
  }
  _stop() {
    if (!this._audio) return;
    this._cleanup();
    if (this._activeSources.size === 0) {
      this._reportState('idle');
    }
  }
  _setVolume(volume) {
    this._volume = volume;
    const effective = this._effectiveVolume();
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
    const state = this._playing || this._activeSources.size > 0 ? 'playing' : this._paused ? 'paused' : 'idle';
    this._reportState(state);
  }
  _setMute(mute) {
    this._muted = mute;
    const effective = this._effectiveVolume();
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
  }

  /** Apply volume to any active TTS or notification Audio elements. */
  _applyVolumeToExternalAudio(vol) {
    const ttsAudio = this._card.tts?._currentAudio;
    if (ttsAudio) ttsAudio.volume = vol;

    // Notification managers share the same currentAudio pattern
    for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
      if (mgr?.currentAudio) mgr.currentAudio.volume = vol;
    }
  }
  _cleanup() {
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    if (this._audio) {
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
    this._playing = false;
    this._paused = false;
  }

  /**
   * Find the media_player entity ID for this satellite device.
   * Uses the same device lookup pattern as getSwitchState.
   */
  _getEntityId() {
    const hass = this._card.hass;
    const satelliteId = this._card.config.satellite_entity;
    if (!hass?.entities || !satelliteId) return null;
    const satellite = hass.entities[satelliteId];
    if (!satellite?.device_id) return null;
    for (const [eid, entry] of Object.entries(hass.entities)) {
      if (entry.device_id === satellite.device_id && entry.platform === 'voice_satellite' && eid.startsWith('media_player.')) {
        return eid;
      }
    }
    return null;
  }

  /**
   * Report playback state back to the integration via WS.
   */
  _reportState(state) {
    this._syncInitialVolume();
    const entityId = this._getEntityId();
    if (!entityId) {
      this._log.log('media-player', 'No media_player entity found — skipping state report');
      return;
    }
    const conn = this._card.connection;
    if (!conn) return;
    const msg = {
      type: 'voice_satellite/media_player_event',
      entity_id: entityId,
      state
    };
    if (this._volumeSynced && this._volume !== undefined) {
      msg.volume = this._volume;
    }
    if (this._mediaId && state !== 'idle') {
      msg.media_id = this._mediaId;
    }
    conn.sendMessagePromise(msg).catch(err => {
      this._log.error('media-player', `Failed to report state: ${JSON.stringify(err)}`);
    });
  }
}

/***/ },

/***/ "./src/pipeline/comms.js"
/*!*******************************!*\
  !*** ./src/pipeline/comms.js ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   setupReconnectListener: () => (/* binding */ setupReconnectListener),
/* harmony export */   subscribePipelineRun: () => (/* binding */ subscribePipelineRun)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/**
 * Voice Satellite Card — Pipeline Comms
 *
 * WebSocket operations for the pipeline: run subscription
 * and reconnect handling.
 */



/**
 * Subscribe to a pipeline run through the integration.
 * @param {object} connection - HA WebSocket connection
 * @param {string} entityId - Satellite entity ID
 * @param {object} runConfig - { start_stage, end_stage, sample_rate, conversation_id? }
 * @param {(message: object) => void} onMessage - Event callback
 * @returns {Promise<Function>} Unsubscribe function
 */
async function subscribePipelineRun(connection, entityId, runConfig, onMessage) {
  return connection.subscribeMessage(onMessage, {
    type: 'voice_satellite/run_pipeline',
    entity_id: entityId,
    ...runConfig
  });
}

/**
 * Set up the reconnection listener for the pipeline.
 * On HA reconnect: resets retry state and restarts immediately.
 * @param {object} card - Card instance
 * @param {object} pipeline - PipelineManager instance
 * @param {object} connection - HA WebSocket connection
 * @param {object} listenerRef - Object with .listener property for storing the handler
 */
function setupReconnectListener(card, pipeline, connection, listenerRef) {
  if (listenerRef.listener) return;
  listenerRef.listener = () => {
    card.logger.log('pipeline', 'Connection reconnected — resetting retry state');
    pipeline.resetRetryState();
    card.ui.clearErrorBar();
    if (card.visibility.isPaused) {
      card.logger.log('pipeline', 'Tab is paused — deferring restart to resume');
      return;
    }
    setTimeout(() => pipeline.restart(0), _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.RECONNECT_DELAY);
  };
  connection.addEventListener('ready', listenerRef.listener);
}

/***/ },

/***/ "./src/pipeline/events.js"
/*!********************************!*\
  !*** ./src/pipeline/events.js ***!
  \********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   handleError: () => (/* binding */ handleError),
/* harmony export */   handleIntentEnd: () => (/* binding */ handleIntentEnd),
/* harmony export */   handleIntentProgress: () => (/* binding */ handleIntentProgress),
/* harmony export */   handleRunEnd: () => (/* binding */ handleRunEnd),
/* harmony export */   handleRunStart: () => (/* binding */ handleRunStart),
/* harmony export */   handleSttEnd: () => (/* binding */ handleSttEnd),
/* harmony export */   handleTtsEnd: () => (/* binding */ handleTtsEnd),
/* harmony export */   handleWakeWordEnd: () => (/* binding */ handleWakeWordEnd),
/* harmony export */   handleWakeWordStart: () => (/* binding */ handleWakeWordStart)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/* harmony import */ var _audio_chime_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../audio/chime.js */ "./src/audio/chime.js");
/**
 * Voice Satellite Card — Pipeline Events
 *
 * Handlers for all pipeline event types (run-start through error).
 */





/**
 * Run-start: binaryHandlerId is already set from the init event.
 * Server-side run-start doesn't include runner_data — only pipeline,
 * language, conversation_id, satellite_id, and tts_output.
 * @param {import('./index.js').PipelineManager} mgr
 */
function handleRunStart(mgr, eventData) {
  // Store streaming TTS URL (tts_output is at the top level)
  mgr.card.tts.storeStreamingUrl(eventData);
  if (mgr.continueMode) {
    mgr.continueMode = false;
    mgr.card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.STT);
    mgr.log.log('pipeline', `Running (continue conversation) — binary handler ID: ${mgr.binaryHandlerId}`);
    mgr.log.log('pipeline', 'Listening for speech...');
    return;
  }
  mgr.card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.LISTENING);
  mgr.log.log('pipeline', `Running — binary handler ID: ${mgr.binaryHandlerId}`);
  mgr.log.log('pipeline', 'Listening for wake word...');
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleWakeWordStart(mgr) {
  if (mgr.serviceUnavailable) {
    if (mgr.recoveryTimeout) clearTimeout(mgr.recoveryTimeout);
    mgr.recoveryTimeout = setTimeout(() => {
      if (mgr.serviceUnavailable) {
        mgr.log.log('recovery', 'Wake word service recovered');
        mgr.serviceUnavailable = false;
        mgr.retryCount = 0;
        mgr.card.ui.clearErrorBar();
        mgr.card.ui.hideBar();
      }
    }, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.RECONNECT_DELAY);
  }
}

/**
 * Wake-word-end: respects the integration's wake_sound switch.
 * @param {import('./index.js').PipelineManager} mgr
 */
function handleWakeWordEnd(mgr, eventData) {
  const wakeOutput = eventData.wake_word_output;
  if (!wakeOutput || Object.keys(wakeOutput).length === 0) {
    mgr.log.error('error', 'Wake word service unavailable (empty wake_word_output)');
    if (mgr.recoveryTimeout) {
      clearTimeout(mgr.recoveryTimeout);
      mgr.recoveryTimeout = null;
    }
    mgr.binaryHandlerId = null;
    mgr.card.ui.showErrorBar();
    mgr.serviceUnavailable = true;
    mgr.restart(mgr.calculateRetryDelay());
    return;
  }

  // Valid wake word — service healthy
  if (mgr.recoveryTimeout) {
    clearTimeout(mgr.recoveryTimeout);
    mgr.recoveryTimeout = null;
  }
  mgr.serviceUnavailable = false;
  mgr.retryCount = 0;
  mgr.card.ui.clearErrorBar();
  mgr.card.mediaPlayer.interrupt();
  const {
    tts
  } = mgr.card;
  if (tts.isPlaying) {
    tts.stop();
    mgr.pendingRunEnd = false;
  }
  if (mgr.intentErrorBarTimeout) {
    clearTimeout(mgr.intentErrorBarTimeout);
    mgr.intentErrorBarTimeout = null;
  }
  mgr.card.chat.clear();
  mgr.shouldContinue = false;
  mgr.continueConversationId = null;
  mgr.card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.WAKE_WORD_DETECTED);

  // Check the integration's wake_sound switch (default: on)
  const wakeSound = (0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__.getSwitchState)(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false;
  if (wakeSound) {
    // Stop sending audio during the chime — echo cancellation isn't
    // perfect and the chime can leak into the mic, causing VAD to
    // interpret it as speech and close STT prematurely.
    const audio = mgr.card.audio;
    audio.stopSending();
    tts.playChime('wake');
    const resumeDelay = _audio_chime_js__WEBPACK_IMPORTED_MODULE_2__.CHIME_WAKE.duration * 1000 + 50;
    setTimeout(() => {
      // Discard audio captured during the chime, then resume sending.
      audio.audioBuffer = [];
      if (mgr.binaryHandlerId) {
        audio.startSending(() => mgr.binaryHandlerId);
      }
    }, resumeDelay);
  }
  mgr.card.ui.showBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleSttEnd(mgr, eventData) {
  const text = eventData.stt_output?.text || '';
  if (text) {
    mgr.card.chat.showTranscription(text);
  }

  // If this is an ask_question STT-only pipeline, invoke the callback
  if (mgr.askQuestionCallback) {
    const cb = mgr.askQuestionCallback;
    mgr.askQuestionCallback = null;
    mgr.askQuestionHandled = true;
    mgr.log.log('pipeline', `Ask question STT complete: "${text}"`);
    cb(text);
  }
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleIntentProgress(mgr, eventData) {
  const {
    tts
  } = mgr.card;
  if (eventData.tts_start_streaming && tts.streamingUrl && !tts.isPlaying) {
    mgr.log.log('tts', 'Streaming TTS started — playing early');
    mgr.card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.TTS);
    tts.play(tts.streamingUrl);
    tts.streamingUrl = null;
  }
  if (!eventData.chat_log_delta) return;
  const chunk = eventData.chat_log_delta.content;
  if (typeof chunk !== 'string') return;
  const {
    chat
  } = mgr.card;
  chat.streamedResponse = (chat.streamedResponse || '') + chunk;
  chat.updateResponse(chat.streamedResponse);
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleIntentEnd(mgr, eventData) {
  let responseType = null;
  try {
    responseType = eventData.intent_output.response.response_type;
  } catch (_) {/* ignore */}
  if (responseType === 'error') {
    const errorText = extractResponseText(mgr, eventData) || 'An error occurred';
    mgr.log.error('error', `Intent error: ${errorText}`);
    mgr.card.ui.showErrorBar();
    if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__.getSwitchState)(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
      mgr.card.tts.playChime('error');
    }
    mgr.suppressTTS = true;
    if (mgr.intentErrorBarTimeout) clearTimeout(mgr.intentErrorBarTimeout);
    mgr.intentErrorBarTimeout = setTimeout(() => {
      mgr.intentErrorBarTimeout = null;
      mgr.card.ui.clearErrorBar();
      mgr.card.ui.hideBar();
    }, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.INTENT_ERROR_DISPLAY);
    mgr.card.chat.streamedResponse = '';
    return;
  }
  const responseText = extractResponseText(mgr, eventData);
  if (responseText) {
    mgr.card.chat.showResponse(responseText);
  }
  mgr.shouldContinue = false;
  mgr.continueConversationId = null;
  try {
    if (eventData.intent_output.continue_conversation === true) {
      mgr.shouldContinue = true;
      mgr.continueConversationId = eventData.intent_output.conversation_id || null;
      mgr.log.log('pipeline', `Continue conversation requested — id: ${mgr.continueConversationId}`);
    }
  } catch (_) {/* ignore */}
  mgr.card.chat.streamedResponse = '';
  mgr.card.chat.streamEl = null;
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleTtsEnd(mgr, eventData) {
  if (mgr.suppressTTS) {
    mgr.suppressTTS = false;
    mgr.log.log('tts', 'TTS suppressed (intent error)');
    mgr.restart(0);
    return;
  }
  const {
    tts
  } = mgr.card;
  if (tts.isPlaying) {
    // Store tts-end URL as retry fallback for the in-progress streaming playback
    const endUrl = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
    if (endUrl) tts.storeTtsEndUrl(endUrl);
    mgr.log.log('tts', 'Streaming TTS already playing — skipping duplicate playback');
    mgr.restart(0);
    return;
  }
  const url = eventData.tts_output?.url || eventData.tts_output?.url_path || null;
  if (url) {
    tts.storeTtsEndUrl(url);
    tts.play(url);
  }
  mgr.restart(0);
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleRunEnd(mgr) {
  mgr.log.log('pipeline', 'Run ended');
  mgr.binaryHandlerId = null;
  if (mgr.isRestarting) {
    mgr.log.log('pipeline', 'Restart already in progress — skipping run-end restart');
    return;
  }

  // If ask_question just completed, the announcement manager handles cleanup
  if (mgr.askQuestionHandled) {
    mgr.log.log('pipeline', 'Ask question handled — announcement manager owns cleanup');
    mgr.askQuestionHandled = false;
    return;
  }
  if (mgr.serviceUnavailable) {
    mgr.log.log('ui', 'Error recovery handling restart');
    mgr.card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
    return;
  }
  if (mgr.card.tts.isPlaying) {
    mgr.log.log('ui', 'TTS playing — deferring cleanup');
    mgr.pendingRunEnd = true;
    return;
  }
  mgr.finishRunEnd();
}

/** @param {import('./index.js').PipelineManager} mgr */
function handleError(mgr, errorData) {
  const errorCode = errorData.code || '';
  const errorMessage = errorData.message || '';
  mgr.log.log('error', `${errorCode} — ${errorMessage}`);

  // If an ask_question callback is pending, invoke it with empty string on error
  if (mgr.askQuestionCallback) {
    const cb = mgr.askQuestionCallback;
    mgr.askQuestionCallback = null;
    mgr.log.log('pipeline', `Ask question error (${errorCode}) — sending empty answer`);
    cb('');
    return;
  }
  if (_constants_js__WEBPACK_IMPORTED_MODULE_0__.EXPECTED_ERRORS.includes(errorCode)) {
    mgr.log.log('pipeline', `Expected error: ${errorCode} — restarting`);
    if (_constants_js__WEBPACK_IMPORTED_MODULE_0__.INTERACTING_STATES.includes(mgr.card.currentState)) {
      mgr.log.log('ui', 'Cleaning up interaction UI after expected error');
      mgr.card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE);
      mgr.card.chat.clear();
      mgr.card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
      mgr.shouldContinue = false;
      mgr.continueConversationId = null;
      const isRemote = !!mgr.card.ttsTarget;
      if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__.getSwitchState)(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false && !isRemote) {
        mgr.card.tts.playChime('done');
      }
    }
    mgr.restart(0);
    return;
  }
  mgr.log.error('error', `Unexpected: ${errorCode} — ${errorMessage}`);
  const wasInteracting = _constants_js__WEBPACK_IMPORTED_MODULE_0__.INTERACTING_STATES.includes(mgr.card.currentState);
  mgr.binaryHandlerId = null;
  if (wasInteracting && (0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__.getSwitchState)(mgr.card.hass, mgr.card.config.satellite_entity, 'wake_sound') !== false) {
    mgr.card.tts.playChime('error');
  }
  mgr.card.ui.showErrorBar();
  mgr.serviceUnavailable = true;
  mgr.card.chat.clear();
  mgr.card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
  mgr.restart(mgr.calculateRetryDelay());
}

/**
 * Extract response text from intent_output, trying multiple HA response formats.
 * @param {import('./index.js').PipelineManager} mgr
 * @param {object} eventData
 * @returns {string|null}
 */
function extractResponseText(mgr, eventData) {
  try {
    const text = eventData.intent_output.response.speech.plain.speech;
    if (text) return text;
  } catch (_) {/* ignore */}
  try {
    if (eventData.intent_output.response.speech.speech) return eventData.intent_output.response.speech.speech;
  } catch (_) {/* ignore */}
  try {
    if (eventData.intent_output.response.plain) return eventData.intent_output.response.plain;
  } catch (_) {/* ignore */}
  try {
    if (typeof eventData.intent_output.response === 'string') return eventData.intent_output.response;
  } catch (_) {/* ignore */}
  mgr.log.log('error', 'Could not extract response text');
  return null;
}

/***/ },

/***/ "./src/pipeline/index.js"
/*!*******************************!*\
  !*** ./src/pipeline/index.js ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PipelineManager: () => (/* binding */ PipelineManager)
/* harmony export */ });
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/* harmony import */ var _shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/satellite-state.js */ "./src/shared/satellite-state.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./comms.js */ "./src/pipeline/comms.js");
/* harmony import */ var _events_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./events.js */ "./src/pipeline/events.js");
/**
 * Voice Satellite Card — PipelineManager
 *
 * Manages the HA Assist pipeline lifecycle via the integration's
 * voice_satellite/run_pipeline subscription.
 *
 * Handles starting, stopping, restarting, error recovery with
 * linear backoff, continue conversation, mute state polling,
 * and stale event filtering.
 */





const MUTE_POLL_INTERVAL = 2000;
class PipelineManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._unsubscribe = null;
    this._binaryHandlerId = null;
    this._retryCount = 0;
    this._serviceUnavailable = false;
    this._restartTimeout = null;
    this._isRestarting = false;
    this._pendingRunEnd = false;
    this._recoveryTimeout = null;
    this._suppressTTS = false;
    this._intentErrorBarTimeout = null;
    this._continueConversationId = null;
    this._shouldContinue = false;
    this._continueMode = false;
    this._isStreaming = false;
    this._askQuestionCallback = null;
    this._askQuestionHandled = false;
    this._reconnectRef = {
      listener: null
    };
    this._muteCheckId = null;
    this._runStartReceived = false;
    this._wakeWordPhase = false;
    this._errorReceived = false;

    // Periodic pipeline restart to keep the streaming TTS token fresh.
    // HA's TTS proxy evicts pre-allocated tokens after a server-side TTL,
    // making them unplayable.  Restarting allocates a fresh token.
    this._tokenRefreshTimer = null;

    // Generation counter — incremented by stop() so that a stale start()
    // (e.g. from a throttled background-tab timeout) can detect it was
    // superseded and abort without clobbering the current subscription.
    this._pipelineGen = 0;
    this._cancelInit = null;
  }

  // --- Public accessors ---

  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }
  get binaryHandlerId() {
    return this._binaryHandlerId;
  }
  set binaryHandlerId(val) {
    this._binaryHandlerId = val;
  }
  get isRestarting() {
    return this._isRestarting;
  }
  get serviceUnavailable() {
    return this._serviceUnavailable;
  }
  set serviceUnavailable(val) {
    this._serviceUnavailable = val;
  }
  get shouldContinue() {
    return this._shouldContinue;
  }
  set shouldContinue(val) {
    this._shouldContinue = val;
  }
  get continueConversationId() {
    return this._continueConversationId;
  }
  set continueConversationId(val) {
    this._continueConversationId = val;
  }
  get continueMode() {
    return this._continueMode;
  }
  set continueMode(val) {
    this._continueMode = val;
  }
  get retryCount() {
    return this._retryCount;
  }
  set retryCount(val) {
    this._retryCount = val;
  }
  get pendingRunEnd() {
    return this._pendingRunEnd;
  }
  set pendingRunEnd(val) {
    this._pendingRunEnd = val;
  }
  get suppressTTS() {
    return this._suppressTTS;
  }
  set suppressTTS(val) {
    this._suppressTTS = val;
  }
  get recoveryTimeout() {
    return this._recoveryTimeout;
  }
  set recoveryTimeout(val) {
    this._recoveryTimeout = val;
  }
  get intentErrorBarTimeout() {
    return this._intentErrorBarTimeout;
  }
  set intentErrorBarTimeout(val) {
    this._intentErrorBarTimeout = val;
  }
  get askQuestionCallback() {
    return this._askQuestionCallback;
  }
  set askQuestionCallback(val) {
    this._askQuestionCallback = val;
  }
  get askQuestionHandled() {
    return this._askQuestionHandled;
  }
  set askQuestionHandled(val) {
    this._askQuestionHandled = val;
  }

  // --- Start / Stop / Restart ---

  async start(options) {
    const opts = options || {};
    const {
      connection,
      config
    } = this._card;
    const gen = this._pipelineGen;
    if (!connection) {
      throw new Error('No Home Assistant connection available');
    }
    if (!config.satellite_entity) {
      throw new Error('No satellite_entity configured');
    }

    // Clear any pending mute poll
    if (this._muteCheckId) {
      clearTimeout(this._muteCheckId);
      this._muteCheckId = null;
    }

    // Check mute state — if muted, show visual and poll for unmute
    if ((0,_shared_satellite_state_js__WEBPACK_IMPORTED_MODULE_1__.getSwitchState)(this._card.hass, config.satellite_entity, 'mute') === true) {
      this._log.log('pipeline', 'Satellite muted — pipeline blocked');
      this._card.ui.showErrorBar();
      this._muteCheckId = setTimeout(() => {
        this._muteCheckId = null;
        this.start(opts).catch(() => {});
      }, MUTE_POLL_INTERVAL);
      return;
    }

    // Clear error bar in case we were previously muted
    this._card.ui.clearErrorBar();

    // Defensive cleanup — stop any previous subscription before starting
    if (this._unsubscribe) {
      this._log.log('pipeline', 'Cleaning up previous subscription');
      try {
        await this._unsubscribe();
      } catch (_) {/* cleanup */}
      this._unsubscribe = null;
    }
    this._binaryHandlerId = null;
    (0,_comms_js__WEBPACK_IMPORTED_MODULE_2__.setupReconnectListener)(this._card, this, connection, this._reconnectRef);
    const runConfig = {
      start_stage: opts.start_stage || 'wake_word',
      end_stage: opts.end_stage || 'tts',
      sample_rate: 16000
    };
    if (opts.conversation_id) {
      runConfig.conversation_id = opts.conversation_id;
    }
    if (opts.extra_system_prompt) {
      runConfig.extra_system_prompt = opts.extra_system_prompt;
    }

    // Reset run-start tracking — used to detect stale run-end events
    this._runStartReceived = false;
    this._log.log('pipeline', `Starting pipeline: ${JSON.stringify(runConfig)}`);

    // Wait for the init event (which carries the binary handler ID) before
    // starting audio.  subscribeMessage resolves on the WS "result" message,
    // but the init event arrives as a separate WS frame afterwards.
    let resolveInit;
    const initPromise = new Promise(resolve => {
      resolveInit = resolve;
    });
    this._cancelInit = resolveInit;
    const unsub = await (0,_comms_js__WEBPACK_IMPORTED_MODULE_2__.subscribePipelineRun)(connection, config.satellite_entity, runConfig, message => {
      // Stale subscription — a newer stop()/start() cycle superseded us
      if (this._pipelineGen !== gen) return;

      // Synthetic init event carries the WS binary handler ID
      if (message.type === 'init') {
        this._binaryHandlerId = message.handler_id;
        this._log.log('pipeline', `Init — handler ID: ${message.handler_id}`);
        resolveInit();
        return;
      }
      this._card.onPipelineMessage(message);
    });

    // --- Gen check 1: stop() was called while we were subscribing ---
    if (this._pipelineGen !== gen) {
      this._log.log('pipeline', 'Aborting stale start() after subscribe — pipeline was stopped');
      try {
        unsub();
      } catch (_) {/* cleanup */}
      return;
    }
    this._unsubscribe = unsub;
    this._log.log('pipeline', 'Pipeline subscribed, waiting for init event...');

    // Block until the init event arrives with the binary handler ID
    await initPromise;
    this._cancelInit = null;

    // --- Gen check 2: stop() was called while we were waiting for init ---
    if (this._pipelineGen !== gen) {
      this._log.log('pipeline', 'Aborting stale start() after init — pipeline was stopped');
      if (this._unsubscribe) {
        try {
          this._unsubscribe();
        } catch (_) {/* cleanup */}
        this._unsubscribe = null;
      }
      return;
    }
    this._log.log('pipeline', `Handler ID confirmed: ${this._binaryHandlerId} — starting audio`);

    // Start sending audio now that handler ID is guaranteed to be set.
    // Discard stale audio first — the worklet keeps buffering while the
    // pipeline is down and the buffer may contain chime residue that
    // would trigger a false VAD detection on the server.
    const {
      audio
    } = this._card;
    audio.audioBuffer = [];
    audio.startSending(() => this._binaryHandlerId);
    this._isStreaming = true;
    // No idle timeout — the server manages pipeline lifecycle and sends
    // run-end/error events when the run completes.
    // The reconnect handler covers WebSocket drops.
  }
  async stop() {
    this._clearTokenRefreshTimer();

    // Increment generation first — any in-flight start() will see the
    // mismatch after its next await and abort cleanly.
    this._pipelineGen++;
    this._log.log('pipeline', `stop() — gen=${this._pipelineGen}`);

    // Unblock a start() that is stuck at `await initPromise`
    if (this._cancelInit) {
      this._cancelInit();
      this._cancelInit = null;
    }
    this._card.audio.stopSending();
    this._binaryHandlerId = null;
    this._isStreaming = false;
    if (this._muteCheckId) {
      clearTimeout(this._muteCheckId);
      this._muteCheckId = null;
    }
    if (this._unsubscribe) {
      try {
        await this._unsubscribe();
      } catch (_) {/* cleanup */}
      this._unsubscribe = null;
    }
  }
  restart(delay) {
    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping');
      return;
    }
    this._isRestarting = true;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
    this.stop().then(() => {
      this._restartTimeout = setTimeout(() => {
        this._restartTimeout = null;
        this._isRestarting = false;
        this.start().catch(e => {
          const msg = e?.message || JSON.stringify(e);
          this._log.error('pipeline', `Restart failed: ${msg}`);
          if (!this._serviceUnavailable) {
            this._card.ui.showErrorBar();
            this._serviceUnavailable = true;
          }
          this.restart(this.calculateRetryDelay());
        });
      }, delay || 0);
    });
  }
  restartContinue(conversationId, opts = {}) {
    if (this._isRestarting) {
      this._log.log('pipeline', 'Restart already in progress — skipping continue');
      return;
    }
    this._isRestarting = true;

    // Store ask_question callback if provided
    this._askQuestionCallback = opts.onSttEnd || null;
    this.stop().then(() => {
      this._isRestarting = false;
      this._continueMode = true;
      const startOpts = {
        start_stage: 'stt',
        end_stage: opts.end_stage || 'tts',
        conversation_id: conversationId
      };
      if (opts.extra_system_prompt) {
        startOpts.extra_system_prompt = opts.extra_system_prompt;
      }
      this.start(startOpts).catch(e => {
        this._log.error('pipeline', `Continue conversation failed: ${e?.message || JSON.stringify(e)}`);
        this._askQuestionCallback = null;
        this._card.chat.clear();
        this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
        this.restart(0);
      });
    });
  }

  // --- Event Handlers (with stale event filtering) ---

  handleRunStart(data) {
    this._runStartReceived = true;
    this._wakeWordPhase = false;
    this._errorReceived = false;
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleRunStart)(this, data);
    this._startTokenRefreshTimer();
  }
  handleWakeWordStart() {
    this._wakeWordPhase = true;
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleWakeWordStart)(this);
  }
  handleWakeWordEnd(data) {
    this._clearTokenRefreshTimer();
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale wake_word-end (no run-start received for this subscription)');
      return;
    }
    // Empty wake_word_output means the pipeline's audio stream was stopped
    // (restart/stop signal). This is expected on every pipeline restart —
    // not a real error. Suppress it to avoid entering a retry loop.
    const output = data?.wake_word_output;
    if (!output || !output.wake_word_id) {
      this._log.log('pipeline', 'Ignoring empty wake_word-end (pipeline stopped during restart)');
      return;
    }
    this._wakeWordPhase = false;
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleWakeWordEnd)(this, data);
  }
  handleSttEnd(data) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleSttEnd)(this, data);
  }
  handleIntentProgress(data) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleIntentProgress)(this, data);
  }
  handleIntentEnd(data) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleIntentEnd)(this, data);
  }
  handleTtsEnd(data) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleTtsEnd)(this, data);
  }
  handleRunEnd() {
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale run-end (no run-start received for this subscription)');
      return;
    }
    // A run-end during wake_word phase (before valid wake_word-end) without
    // a preceding error means the server-side pipeline ended unexpectedly
    // (e.g. after HA reconnect).  Restart instead of processing full cleanup.
    if (this._wakeWordPhase && !this._errorReceived) {
      this._log.log('pipeline', 'run-end during wake_word phase — restarting pipeline');
      this.restart(0);
      return;
    }
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleRunEnd)(this);
  }
  handleError(data) {
    if (!this._runStartReceived) {
      this._log.log('pipeline', 'Ignoring stale error (no run-start received for this subscription)');
      return;
    }
    this._errorReceived = true;
    (0,_events_js__WEBPACK_IMPORTED_MODULE_3__.handleError)(this, data);
  }

  // --- Public Helpers ---

  clearContinueState() {
    this._shouldContinue = false;
    this._continueConversationId = null;
  }
  resetForResume() {
    this._isRestarting = false;
    this._continueMode = false;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
  }

  /**
   * Reset all retry/reconnect state. Called on successful reconnection.
   */
  resetRetryState() {
    this._retryCount = 0;
    if (this._restartTimeout) {
      clearTimeout(this._restartTimeout);
      this._restartTimeout = null;
    }
    if (this._isRestarting) {
      this._isRestarting = false;
    }
    this._serviceUnavailable = false;
  }

  // --- Private ---

  finishRunEnd() {
    this._pendingRunEnd = false;
    this._card.chat.clear();
    this._card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_0__.BlurReason.PIPELINE);
    this._card.setState(_constants_js__WEBPACK_IMPORTED_MODULE_0__.State.IDLE);
    if (this._serviceUnavailable) {
      this._log.log('ui', 'Retry already scheduled — skipping restart');
      return;
    }
    this.restart(0);
  }
  calculateRetryDelay() {
    this._retryCount++;
    const delay = Math.min(_constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.RETRY_BASE_DELAY * this._retryCount, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.MAX_RETRY_DELAY);
    this._log.log('pipeline', `Retry in ${delay}ms (attempt #${this._retryCount})`);
    return delay;
  }

  /**
   * Start a timer to restart the pipeline before the streaming TTS token
   * expires on the HA server.  Only fires while idle in wake-word listening.
   */
  _startTokenRefreshTimer() {
    this._clearTokenRefreshTimer();
    if (!this._card.tts._streamingUrl) return;
    this._tokenRefreshTimer = setTimeout(() => {
      this._tokenRefreshTimer = null;
      if (this._card.currentState !== _constants_js__WEBPACK_IMPORTED_MODULE_0__.State.LISTENING) return;
      this._log.log('tts', 'Refreshing streaming token — restarting pipeline');
      this.restart(0);
    }, _constants_js__WEBPACK_IMPORTED_MODULE_0__.Timing.TOKEN_REFRESH_INTERVAL);
  }
  _clearTokenRefreshTimer() {
    if (this._tokenRefreshTimer) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
  }
}

/***/ },

/***/ "./src/shared/entity-subscription.js"
/*!*******************************************!*\
  !*** ./src/shared/entity-subscription.js ***!
  \*******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   subscribeToEntity: () => (/* binding */ subscribeToEntity),
/* harmony export */   unsubscribeEntity: () => (/* binding */ unsubscribeEntity)
/* harmony export */ });
/**
 * Voice Satellite Card — Entity Subscription Utility
 *
 * Shared subscription pattern for watching HA entity state changes.
 * Used by TimerManager and AnnouncementManager.
 *
 * @param {object} manager - Manager instance (must have _log, _card, _unsubscribe, _entityId)
 * @param {object} connection - HA WebSocket connection
 * @param {string} entityId - Entity to watch
 * @param {(attrs: object) => void} onAttrs - Callback receiving new_state.attributes
 * @param {string} logTag - Log category label
 */
function subscribeToEntity(manager, connection, entityId, onAttrs, logTag) {
  manager._subscribed = true;
  manager._entityId = entityId;
  doSubscribe(manager, connection, entityId, onAttrs, logTag);

  // Re-subscribe on HA reconnect (e.g. after restart)
  if (!manager._reconnectListener) {
    manager._reconnectListener = () => {
      if (!manager.card.isOwner) return;
      manager.log.log(logTag, 'Connection reconnected — re-subscribing');
      if (manager._unsubscribe) {
        try {
          manager._unsubscribe();
        } catch (_) {/* cleanup */}
        manager._unsubscribe = null;
      }
      const conn = manager.card.connection;
      if (conn) {
        doSubscribe(manager, conn, manager._entityId, onAttrs, logTag);
      }
    };
    connection.addEventListener('ready', manager._reconnectListener);
  }
}

/**
 * Perform the actual event subscription and immediate state check.
 */
function doSubscribe(manager, connection, entityId, onAttrs, logTag) {
  connection.subscribeEvents(event => {
    const {
      data
    } = event;
    if (!data || !data.new_state) return;
    if (data.entity_id !== entityId) return;
    onAttrs(data.new_state.attributes || {});
  }, 'state_changed').then(unsub => {
    manager._unsubscribe = unsub;
    manager.log.log(logTag, `Subscribed to state changes for ${entityId}`);

    // Immediate check for current state
    const hass = manager.card.hass;
    if (hass?.states?.[entityId]) {
      onAttrs(hass.states[entityId].attributes || {});
    }
  }).catch(err => {
    manager.log.error(logTag, `Failed to subscribe: ${err}`);
    manager._subscribed = false;
  });
}

/**
 * Clean up subscription and reconnect listener.
 */
function unsubscribeEntity(manager) {
  if (manager._unsubscribe) {
    manager._unsubscribe();
    manager._unsubscribe = null;
  }
  if (manager._reconnectListener && manager.card.connection) {
    manager.card.connection.removeEventListener('ready', manager._reconnectListener);
    manager._reconnectListener = null;
  }
  manager._subscribed = false;
}

/***/ },

/***/ "./src/shared/format.js"
/*!******************************!*\
  !*** ./src/shared/format.js ***!
  \******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   formatTime: () => (/* binding */ formatTime)
/* harmony export */ });
/**
 * Voice Satellite Card — Formatting Utilities
 *
 * Pure formatting functions used across modules.
 */

/**
 * Format seconds as HH:MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}

/***/ },

/***/ "./src/shared/notification-comms.js"
/*!******************************************!*\
  !*** ./src/shared/notification-comms.js ***!
  \******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   sendAck: () => (/* binding */ sendAck)
/* harmony export */ });
/**
 * Voice Satellite Card — Notification Comms
 *
 * Shared WebSocket calls for satellite notification features
 * (announcement, ask-question, start-conversation).
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * ACK to the integration so async_announce unblocks.
 * @param {object} card - Card instance
 * @param {number} announceId
 * @param {string} logPrefix
 */
function sendAck(card, announceId, logPrefix) {
  const {
    connection,
    config
  } = card;
  if (!connection || !config.satellite_entity) {
    card.logger.error(logPrefix, 'Cannot ACK — no connection or entity');
    return;
  }
  connection.sendMessagePromise({
    type: 'voice_satellite/announce_finished',
    entity_id: config.satellite_entity,
    announce_id: announceId
  }).then(() => {
    card.logger.log(logPrefix, `ACK sent for #${announceId}`);
  }).catch(err => {
    card.logger.error(logPrefix, `ACK failed: ${err.message || JSON.stringify(err)}`);
  });
}

/***/ },

/***/ "./src/shared/satellite-notification.js"
/*!**********************************************!*\
  !*** ./src/shared/satellite-notification.js ***!
  \**********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clearNotificationUI: () => (/* binding */ clearNotificationUI),
/* harmony export */   dequeueNotification: () => (/* binding */ dequeueNotification),
/* harmony export */   dispatchSatelliteEvent: () => (/* binding */ dispatchSatelliteEvent),
/* harmony export */   hasPendingSatelliteEvent: () => (/* binding */ hasPendingSatelliteEvent),
/* harmony export */   initNotificationState: () => (/* binding */ initNotificationState),
/* harmony export */   playMediaFor: () => (/* binding */ playMediaFor),
/* harmony export */   playNotification: () => (/* binding */ playNotification)
/* harmony export */ });
/* harmony import */ var _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../audio/chime.js */ "./src/audio/chime.js");
/* harmony import */ var _audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../audio/media-playback.js */ "./src/audio/media-playback.js");
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/**
 * Voice Satellite Card — Satellite Notification Base
 *
 * Shared lifecycle for satellite-pushed notification features:
 * event dispatch, pipeline-busy queuing, playback orchestration.
 *
 * DOM operations delegate to UIManager.
 * Audio operations delegate to audio/chime and audio/media-playback.
 *
 * Each manager provides its own onComplete handler.
 */




let _lastAnnounceId = 0;

// ─── Hidden-tab event queue ──────────────────────────────────────

let _pendingEvent = null;
let _pendingCard = null;
let _visibilityListenerAdded = false;

/**
 * Whether a satellite event is queued for replay when the tab becomes visible.
 * Used by VisibilityManager to skip its own pipeline restart — the replayed
 * event's flow will manage the pipeline instead.
 */
function hasPendingSatelliteEvent() {
  return _pendingEvent !== null;
}
function _onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!_pendingEvent || !_pendingCard) return;
  const card = _pendingCard;
  const event = _pendingEvent;
  _pendingEvent = null;
  _pendingCard = null;
  card.logger.log('satellite-notify', `Tab visible — replaying queued event #${event.data.id}`);
  dispatchSatelliteEvent(card, event);
}

// ─── Satellite Event Dispatch ─────────────────────────────────────

/**
 * Dispatch a satellite event to the appropriate notification manager.
 * Called by the single satellite subscription with the raw event payload.
 *
 * @param {object} card - Card instance
 * @param {object} event - {type: "announcement"|"start_conversation", data: {...}}
 */
function dispatchSatelliteEvent(card, event) {
  const {
    type,
    data
  } = event;

  // media_player events don't have an id field — route early
  if (type === 'media_player') {
    card.mediaPlayer.handleCommand(data);
    return;
  }
  if (!data || !data.id) return;

  // Queue events while the tab is hidden — audio can't play and UI state
  // gets corrupted.  Only keep the latest event (newer replaces older).
  // When the tab becomes visible, the queued event is replayed.
  if (document.visibilityState === 'hidden') {
    card.logger.log('satellite-notify', `Event #${data.id} queued — tab hidden`);
    _pendingEvent = event;
    _pendingCard = card;
    if (!_visibilityListenerAdded) {
      _visibilityListenerAdded = true;
      document.addEventListener('visibilitychange', _onVisibilityChange);
    }
    return;
  }
  const ann = {
    ...data
  };

  // Route to the correct manager based on event type / flags
  if (ann.ask_question) {
    _deliverToManager(card.askQuestion, ann, 'ask-question');
  } else if (type === 'start_conversation' || ann.start_conversation) {
    _deliverToManager(card.startConversation, ann, 'start-conversation');
  } else {
    _deliverToManager(card.announcement, ann, 'announce');
  }
}
function _deliverToManager(mgr, ann, logPrefix) {
  // Dedup check (monotonic IDs — safety net for duplicate events)
  if (ann.id <= _lastAnnounceId) return;
  if (mgr.playing) {
    if (!mgr.queued || mgr.queued.id !== ann.id) {
      mgr.queued = ann;
      mgr.log.log(logPrefix, `Notification #${ann.id} queued — still displaying`);
    }
    return;
  }
  const cardState = mgr.card.currentState;
  const pipelineBusy = cardState === 'WAKE_WORD_DETECTED' || cardState === 'STT' || cardState === 'INTENT' || cardState === 'TTS';
  if (pipelineBusy || mgr.card.tts.isPlaying) {
    if (!mgr.queued || mgr.queued.id !== ann.id) {
      mgr.queued = ann;
      mgr.log.log(logPrefix, `Notification #${ann.id} queued — pipeline busy (${cardState})`);
    }
    return;
  }
  mgr.queued = null;
  _lastAnnounceId = ann.id;
  mgr.log.log(logPrefix, `New ${logPrefix} #${ann.id}: message="${ann.message || ''}" media="${ann.media_id || ''}"`);
  playNotification(mgr, ann, a => mgr._onComplete(a), logPrefix);
}

// ─── Dedup & Queuing ─────────────────────────────────────────────

/**
 * Try to play a queued notification.
 * @param {object} mgr
 * @returns {object|null}
 */
function dequeueNotification(mgr) {
  if (!mgr.queued) return null;
  const ann = mgr.queued;
  mgr.queued = null;
  if (ann.id <= (_lastAnnounceId || 0)) return null;
  if (mgr.playing) return null;
  _lastAnnounceId = ann.id;
  return ann;
}

// ─── Playback Orchestration ──────────────────────────────────────

/**
 * Full playback: blur → bar → preannounce → main media → onComplete.
 * DOM delegated to UIManager, audio to chime/media-playback.
 *
 * @param {object} mgr
 * @param {object} ann
 * @param {Function} onComplete - Called with (ann)
 * @param {string} logPrefix
 */
function playNotification(mgr, ann, onComplete, logPrefix) {
  // Cancel any pending UI clear from a previous notification
  if (mgr.clearTimeoutId) {
    clearNotificationUI(mgr);
  }

  // Interrupt media player if it's playing
  mgr.card.mediaPlayer.interrupt();
  mgr.playing = true;
  mgr.currentAnnounceId = ann.id;

  // UI: blur overlay + wake screen + bar
  mgr.card.ui.showBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.ANNOUNCEMENT);
  mgr.barWasVisible = mgr.card.ui.showBarSpeaking();

  // Only center on screen for passive announcements (not ask_question or start_conversation)
  const isPassive = !ann.ask_question && !ann.start_conversation;
  if (isPassive) {
    mgr.card.ui.setAnnouncementMode(true);
  }

  // Pre-announcement
  if (ann.preannounce === false) {
    mgr.log.log(logPrefix, 'Preannounce disabled — skipping chime');
    _playMain(mgr, ann, onComplete, logPrefix);
  } else {
    const hasPreAnnounce = ann.preannounce_media_id && ann.preannounce_media_id !== '';
    if (hasPreAnnounce) {
      mgr.log.log(logPrefix, `Playing pre-announcement media: ${ann.preannounce_media_id}`);
      playMediaFor(mgr, ann.preannounce_media_id, logPrefix, () => {
        _playMain(mgr, ann, onComplete, logPrefix);
      });
    } else {
      const vol = mgr.card.mediaPlayer.volume;
      (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.playMediaUrl)(_audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_ANNOUNCE_URI, vol, {
        onEnd: () => {
          mgr.card.mediaPlayer.notifyAudioEnd('announce-chime');
          _playMain(mgr, ann, onComplete, logPrefix);
        },
        onError: () => {
          mgr.card.mediaPlayer.notifyAudioEnd('announce-chime');
          _playMain(mgr, ann, onComplete, logPrefix);
        },
        onStart: () => {
          mgr.log.log(logPrefix, 'Announcement chime playing');
          mgr.card.mediaPlayer.notifyAudioStart('announce-chime');
        }
      });
    }
  }
}
function _playMain(mgr, ann, onComplete, logPrefix) {
  const mediaUrl = ann.media_id || '';
  if (ann.message) {
    // Passive announcements use centered 'announcement' style;
    // interactive notifications (ask_question, start_conversation)
    // use 'assistant' style so they follow the configured chat layout.
    const isPassive = !ann.ask_question && !ann.start_conversation;
    mgr.card.ui.addChatMessage(ann.message, isPassive ? 'announcement' : 'assistant');
  }
  if (mediaUrl) {
    mgr.log.log(logPrefix, `Playing media: ${mediaUrl}`);
    playMediaFor(mgr, mediaUrl, logPrefix, () => onComplete(ann));
  } else {
    mgr.log.log(logPrefix, 'No media — completing after message display');
    setTimeout(() => onComplete(ann), _constants_js__WEBPACK_IMPORTED_MODULE_2__.Timing.NO_MEDIA_DISPLAY);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────

/**
 * Clear notification UI: bubbles, blur, bar restore.
 * @param {object} mgr
 */
function clearNotificationUI(mgr) {
  if (mgr.clearTimeoutId) {
    clearTimeout(mgr.clearTimeoutId);
    mgr.clearTimeoutId = null;
  }
  mgr.card.ui.setAnnouncementMode(false);
  mgr.card.ui.clearAnnouncementBubbles();
  mgr.card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.ANNOUNCEMENT);
  mgr.card.ui.restoreBar(mgr.barWasVisible);
}

// ─── Audio Helper ────────────────────────────────────────────────

/**
 * Play a media URL with volume from config.
 */
function playMediaFor(mgr, urlPath, logPrefix, onDone) {
  const url = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.buildMediaUrl)(urlPath);
  const volume = mgr.card.mediaPlayer.volume;
  mgr.currentAudio = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.playMediaUrl)(url, volume, {
    onEnd: () => {
      mgr.log.log(logPrefix, 'Media playback complete');
      mgr.currentAudio = null;
      mgr.card.analyser.detachAudio();
      mgr.card.mediaPlayer.notifyAudioEnd('notification');
      onDone?.();
    },
    onError: e => {
      mgr.log.error(logPrefix, `Media playback error: ${e}`);
      mgr.currentAudio = null;
      mgr.card.analyser.detachAudio();
      mgr.card.mediaPlayer.notifyAudioEnd('notification');
      onDone?.();
    },
    onStart: () => {
      mgr.log.log(logPrefix, 'Media playback started');
      mgr.card.mediaPlayer.notifyAudioStart('notification');
      if (mgr.card._activeSkin?.reactiveBar && mgr.card.config.reactive_bar !== false && mgr.currentAudio) {
        mgr.card.analyser.attachAudio(mgr.currentAudio, mgr.card.audio.audioContext);
      }
    }
  });
}

// ─── Common State Init ───────────────────────────────────────────

/**
 * Initialize shared notification state on a manager instance.
 * @param {object} mgr
 */
function initNotificationState(mgr) {
  mgr.playing = false;
  mgr.currentAudio = null;
  mgr.currentAnnounceId = null;
  mgr.clearTimeoutId = null;
  mgr.barWasVisible = false;
  mgr.queued = null;
}

/***/ },

/***/ "./src/shared/satellite-state.js"
/*!***************************************!*\
  !*** ./src/shared/satellite-state.js ***!
  \***************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getNumberState: () => (/* binding */ getNumberState),
/* harmony export */   getSatelliteAttr: () => (/* binding */ getSatelliteAttr),
/* harmony export */   getSelectEntityId: () => (/* binding */ getSelectEntityId),
/* harmony export */   getSwitchState: () => (/* binding */ getSwitchState)
/* harmony export */ });
/**
 * Voice Satellite Card — Satellite State Helpers
 *
 * Read satellite entity attributes and sibling switch states
 * from the HA frontend cache. These are pure lookups with no
 * side-effects, shared across all managers.
 */

/**
 * Read an attribute from the satellite entity's HA state.
 * @param {object} hass - HA frontend object
 * @param {string} entityId - Satellite entity ID
 * @param {string} name - Attribute name
 * @returns {*} Attribute value, or undefined if unavailable
 */
function getSatelliteAttr(hass, entityId, name) {
  if (!hass || !entityId) return undefined;
  const state = hass.states[entityId];
  return state?.attributes?.[name];
}

/**
 * Read a select entity's resolved entity_id attribute from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key (e.g. 'tts_output')
 * @returns {string|undefined} The entity_id attribute value, or undefined if not found
 */
function getSelectEntityId(hass, satelliteId, translationKey) {
  if (!hass?.entities || !satelliteId) return undefined;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return undefined;
  for (const [eid, entry] of Object.entries(hass.entities)) {
    if (entry.device_id === satellite.device_id && entry.platform === 'voice_satellite' && entry.translation_key === translationKey) {
      return hass.states[eid]?.attributes?.entity_id || '';
    }
  }
  return undefined;
}

/**
 * Read a number entity's numeric value from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Number translation_key
 * @param {number} defaultValue - Fallback if not found
 * @returns {number} The numeric value, or defaultValue if not found
 */
function getNumberState(hass, satelliteId, translationKey, defaultValue) {
  if (!hass?.entities || !satelliteId) return defaultValue;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return defaultValue;
  for (const [eid, entry] of Object.entries(hass.entities)) {
    if (entry.device_id === satellite.device_id && entry.platform === 'voice_satellite' && entry.translation_key === translationKey) {
      const val = parseFloat(hass.states[eid]?.state);
      return isNaN(val) ? defaultValue : val;
    }
  }
  return defaultValue;
}

/**
 * Read a switch entity's on/off state directly from the entity registry
 * and state cache, bypassing satellite extra_state_attributes (which can
 * be stale if the state-change listener wasn't set up in time).
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Switch translation_key ('mute' | 'wake_sound')
 * @returns {boolean|undefined} true if switch is on, false if off, undefined if not found
 */
function getSwitchState(hass, satelliteId, translationKey) {
  if (!hass || !satelliteId) return undefined;

  // Find the switch via the frontend entity registry cache (hass.entities)
  if (hass.entities) {
    const satellite = hass.entities[satelliteId];
    if (satellite?.device_id) {
      for (const [eid, entry] of Object.entries(hass.entities)) {
        if (entry.device_id === satellite.device_id && entry.platform === 'voice_satellite' && entry.translation_key === translationKey) {
          return hass.states[eid]?.state === 'on';
        }
      }
    }
  }

  // Fallback: satellite extra_state_attributes (may be stale)
  const attrName = translationKey === 'mute' ? 'muted' : translationKey;
  const val = getSatelliteAttr(hass, satelliteId, attrName);
  return val !== undefined ? val === true : undefined;
}

/***/ },

/***/ "./src/shared/satellite-subscription.js"
/*!**********************************************!*\
  !*** ./src/shared/satellite-subscription.js ***!
  \**********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   refreshSatelliteSubscription: () => (/* binding */ refreshSatelliteSubscription),
/* harmony export */   subscribeSatelliteEvents: () => (/* binding */ subscribeSatelliteEvents),
/* harmony export */   teardownSatelliteSubscription: () => (/* binding */ teardownSatelliteSubscription)
/* harmony export */ });
/* harmony import */ var _singleton_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./singleton.js */ "./src/shared/singleton.js");
/**
 * Voice Satellite Card — Satellite Event Subscription
 *
 * Single WS subscription for satellite-pushed events (announcement,
 * start_conversation, ask_question).  Replaces per-manager entity
 * state subscriptions for notification features.
 *
 * Pattern follows entity-subscription.js: module-level state,
 * reconnect via the connection 'ready' event.
 */


let _unsubscribe = null;
let _subscribed = false;
let _reconnectListener = null;
let _card = null;
let _onEvent = null;
let _retryTimer = null;
const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000];
let _retryCount = 0;

/**
 * Subscribe to satellite events via voice_satellite/subscribe_events.
 * Idempotent — no-op if already subscribed.
 *
 * @param {object} card - Card instance
 * @param {(event: object) => void} onEvent - Called with {type, data}
 */
function subscribeSatelliteEvents(card, onEvent) {
  const {
    config,
    connection
  } = card;
  if (!config.satellite_entity || !connection) return;
  if (!(0,_singleton_js__WEBPACK_IMPORTED_MODULE_0__.isOwner)(card)) return;
  if (_subscribed) return;
  _card = card;
  _onEvent = onEvent;
  _subscribed = true;
  _doSubscribe(card, connection, onEvent);

  // Re-subscribe on HA reconnect
  if (!_reconnectListener) {
    _reconnectListener = () => {
      card.logger.log('satellite-sub', 'Connection reconnected — re-subscribing');
      _cleanup();
      const conn = card.connection;
      if (conn) {
        _subscribed = true;
        _doSubscribe(card, conn, onEvent);
      }
    };
    connection.addEventListener('ready', _reconnectListener);
  }
}
function _doSubscribe(card, connection, onEvent) {
  connection.subscribeMessage(message => onEvent(message), {
    type: 'voice_satellite/subscribe_events',
    entity_id: card.config.satellite_entity
  }).then(unsub => {
    _unsubscribe = unsub;
    _retryCount = 0;
    card.logger.log('satellite-sub', `Subscribed to satellite events for ${card.config.satellite_entity}`);
  }).catch(err => {
    card.logger.error('satellite-sub', `Failed to subscribe: ${err}`);
    _subscribed = false;
    _scheduleRetry(card, connection, onEvent);
  });
}
function _scheduleRetry(card, connection, onEvent) {
  if (_retryTimer) return;
  const delay = RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)];
  _retryCount++;
  card.logger.log('satellite-sub', `Retrying in ${delay / 1000}s (attempt ${_retryCount})`);
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (_subscribed) return; // subscribed while waiting
    const conn = card.connection;
    if (!conn) return;
    _subscribed = true;
    _doSubscribe(card, conn, onEvent);
  }, delay);
}
function _cleanup() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _retryCount = 0;
  if (_unsubscribe) {
    try {
      _unsubscribe();
    } catch (_) {/* cleanup */}
    _unsubscribe = null;
  }
  _subscribed = false;
}

/**
 * Tear down and re-establish the satellite subscription.
 * Called on tab visibility resume to recover from connections that went
 * stale while the tab was hidden (WebSocket may silently drop/reconnect).
 */
function refreshSatelliteSubscription() {
  if (!_card || !_onEvent) return;
  _cleanup();
  subscribeSatelliteEvents(_card, _onEvent);
}

/**
 * Permanently tear down the satellite subscription and reconnect listener.
 * Called when the card is displaced by another browser.
 */
function teardownSatelliteSubscription() {
  _cleanup();
  if (_reconnectListener && _card?.connection) {
    _card.connection.removeEventListener('ready', _reconnectListener);
    _reconnectListener = null;
  }
  _card = null;
  _onEvent = null;
}

/***/ },

/***/ "./src/shared/singleton.js"
/*!*********************************!*\
  !*** ./src/shared/singleton.js ***!
  \*********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   claim: () => (/* binding */ claim),
/* harmony export */   isActive: () => (/* binding */ isActive),
/* harmony export */   isOwner: () => (/* binding */ isOwner),
/* harmony export */   isStarting: () => (/* binding */ isStarting),
/* harmony export */   propagateConfig: () => (/* binding */ propagateConfig),
/* harmony export */   release: () => (/* binding */ release),
/* harmony export */   setStarting: () => (/* binding */ setStarting)
/* harmony export */ });
/**
 * Voice Satellite Card — Singleton State
 *
 * Manages the single-instance guarantee. Only one card instance
 * can be active at a time (owns the mic + pipeline).
 *
 * Replaces scattered window._voiceSatellite* globals with a
 * module-scoped state object. Uses window namespace to ensure
 * multiple script loads share the same state.
 */

// Use window namespace so multiple bundles share state
if (!window.__vsSingleton) {
  window.__vsSingleton = {
    instance: null,
    active: false,
    starting: false
  };
}
const state = window.__vsSingleton;

/** @returns {boolean} Whether the given card is (or can be) the owner */
function isOwner(card) {
  return !state.instance || state.instance === card;
}

/** @returns {boolean} Whether any instance is active */
function isActive() {
  return state.active;
}

/** @returns {boolean} Whether a startup is in progress */
function isStarting() {
  return state.starting;
}

/** Mark startup in progress */
function setStarting(val) {
  state.starting = !!val;
}

/** Claim ownership — called after successful mic + pipeline start */
function claim(card) {
  state.instance = card;
  state.active = true;
}

/** Release ownership — called when the card is displaced or torn down */
function release() {
  state.instance = null;
  state.active = false;
  state.starting = false;
}

/**
 * Propagate config to the active instance (when a secondary card updates config).
 * @param {object} card - The card pushing the config change
 */
function propagateConfig(card) {
  if (state.instance && state.instance !== card) {
    state.instance.setConfig(card.config);
  }
}

/***/ },

/***/ "./src/skins/alexa.js"
/*!****************************!*\
  !*** ./src/skins/alexa.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   alexaSkin: () => (/* binding */ alexaSkin)
/* harmony export */ });
/* harmony import */ var _alexa_css__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./alexa.css */ "./src/skins/alexa.css");
/* harmony import */ var _alexa_preview_css__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./alexa-preview.css */ "./src/skins/alexa-preview.css");
/**
 * Voice Satellite Card — Alexa Skin
 *
 * Dark theme with cyan accent glow, inspired by the Echo Show UI.
 * Uses a bottom edge glow instead of a rainbow bar.
 */



const alexaSkin = {
  id: 'alexa',
  name: 'Alexa',
  css: _alexa_css__WEBPACK_IMPORTED_MODULE_0__,
  reactiveBar: true,
  overlayColor: [0, 8, 20],
  defaultOpacity: 0.7,
  previewCSS: _alexa_preview_css__WEBPACK_IMPORTED_MODULE_1__
};

/***/ },

/***/ "./src/skins/default.js"
/*!******************************!*\
  !*** ./src/skins/default.js ***!
  \******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   defaultSkin: () => (/* binding */ defaultSkin)
/* harmony export */ });
/* harmony import */ var _default_css__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./default.css */ "./src/skins/default.css");
/* harmony import */ var _default_preview_css__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./default-preview.css */ "./src/skins/default-preview.css");
/**
 * Voice Satellite Card — Default Skin
 */



const defaultSkin = {
  id: 'default',
  name: 'Default',
  css: _default_css__WEBPACK_IMPORTED_MODULE_0__,
  reactiveBar: true,
  overlayColor: [0, 0, 0],
  defaultOpacity: 0.3,
  previewCSS: _default_preview_css__WEBPACK_IMPORTED_MODULE_1__
};

/***/ },

/***/ "./src/skins/google-home.js"
/*!**********************************!*\
  !*** ./src/skins/google-home.js ***!
  \**********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   googleHomeSkin: () => (/* binding */ googleHomeSkin)
/* harmony export */ });
/* harmony import */ var _google_home_css__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./google-home.css */ "./src/skins/google-home.css");
/* harmony import */ var _google_home_preview_css__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./google-home-preview.css */ "./src/skins/google-home-preview.css");
/**
 * Voice Satellite Card — Google Home Skin
 *
 * Light theme with Google's 4-color palette (blue, red, yellow, green),
 * Material Design cards, and a clean frosted overlay.
 */



const googleHomeSkin = {
  id: 'google-home',
  name: 'Google Home',
  css: _google_home_css__WEBPACK_IMPORTED_MODULE_0__,
  reactiveBar: true,
  overlayColor: [255, 255, 255],
  defaultOpacity: 0.75,
  previewCSS: _google_home_preview_css__WEBPACK_IMPORTED_MODULE_1__
};

/***/ },

/***/ "./src/skins/index.js"
/*!****************************!*\
  !*** ./src/skins/index.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   getSkin: () => (/* binding */ getSkin),
/* harmony export */   getSkinOptions: () => (/* binding */ getSkinOptions)
/* harmony export */ });
/* harmony import */ var _default_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./default.js */ "./src/skins/default.js");
/* harmony import */ var _alexa_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./alexa.js */ "./src/skins/alexa.js");
/* harmony import */ var _google_home_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./google-home.js */ "./src/skins/google-home.js");
/**
 * Voice Satellite Card — Skin Registry
 */





/** All registered skins keyed by id */
const SKINS = {
  [_default_js__WEBPACK_IMPORTED_MODULE_0__.defaultSkin.id]: _default_js__WEBPACK_IMPORTED_MODULE_0__.defaultSkin,
  [_alexa_js__WEBPACK_IMPORTED_MODULE_1__.alexaSkin.id]: _alexa_js__WEBPACK_IMPORTED_MODULE_1__.alexaSkin,
  [_google_home_js__WEBPACK_IMPORTED_MODULE_2__.googleHomeSkin.id]: _google_home_js__WEBPACK_IMPORTED_MODULE_2__.googleHomeSkin
};

/**
 * Look up a skin by id. Falls back to default if not found.
 * @param {string} id
 * @returns {object} skin definition
 */
function getSkin(id) {
  return SKINS[id] || SKINS['default'];
}

/**
 * Returns option list for the editor dropdown.
 * @returns {{ value: string, label: string }[]}
 */
function getSkinOptions() {
  return Object.values(SKINS).map(s => ({
    value: s.id,
    label: s.name
  }));
}

/***/ },

/***/ "./src/start-conversation/index.js"
/*!*****************************************!*\
  !*** ./src/start-conversation/index.js ***!
  \*****************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   StartConversationManager: () => (/* binding */ StartConversationManager)
/* harmony export */ });
/* harmony import */ var _shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/satellite-notification.js */ "./src/shared/satellite-notification.js");
/* harmony import */ var _shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/notification-comms.js */ "./src/shared/notification-comms.js");
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/**
 * Voice Satellite Card — StartConversationManager
 *
 * Handles start_conversation announcements: plays the prompt,
 * then clears the UI and enters full STT listening mode
 * so the user can begin a voice interaction.
 */




const LOG = 'start-conversation';
class StartConversationManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.initNotificationState)(this);
  }
  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }
  playQueued() {
    const ann = (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.dequeueNotification)(this);
    if (!ann) return;
    this._log.log(LOG, `Playing queued start_conversation #${ann.id}`);
    this._play(ann);
  }

  // --- Private ---

  _play(ann) {
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.playNotification)(this, ann, a => this._onComplete(a), LOG);
  }
  _onComplete(ann) {
    this.currentAudio = null;
    this._log.log(LOG, `Prompt #${ann.id} playback complete`);
    (0,_shared_notification_comms_js__WEBPACK_IMPORTED_MODULE_1__.sendAck)(this._card, ann.id, LOG);

    // Clear announcement UI and enter listening mode
    (0,_shared_satellite_notification_js__WEBPACK_IMPORTED_MODULE_0__.clearNotificationUI)(this);
    this.playing = false;
    this._card.ui.showBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_2__.BlurReason.PIPELINE);
    const {
      pipeline
    } = this._card;
    if (pipeline) {
      pipeline.restartContinue(null, {
        extra_system_prompt: ann.extra_system_prompt || null
      });
    }
  }
}

/***/ },

/***/ "./src/timer/comms.js"
/*!****************************!*\
  !*** ./src/timer/comms.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   sendCancelTimer: () => (/* binding */ sendCancelTimer)
/* harmony export */ });
/**
 * Voice Satellite Card — Timer Comms
 *
 * Cancel timers via the integration's WS command.
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * Cancel a timer via the voice_satellite/cancel_timer WS command.
 * @param {object} card - Card instance
 * @param {string} timerId - Timer ID to cancel
 */
function sendCancelTimer(card, timerId) {
  if (!card.connection || !card.config.satellite_entity || !timerId) return;
  card.connection.sendMessagePromise({
    type: 'voice_satellite/cancel_timer',
    entity_id: card.config.satellite_entity,
    timer_id: timerId
  }).then(() => {
    card.logger.log('timer', `Cancel timer ${timerId} succeeded`);
  }).catch(err => {
    card.logger.error('timer', `Cancel timer failed: ${err.message || JSON.stringify(err)}`);
  });
}

/***/ },

/***/ "./src/timer/events.js"
/*!*****************************!*\
  !*** ./src/timer/events.js ***!
  \*****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   processStateChange: () => (/* binding */ processStateChange),
/* harmony export */   resetTimerDedup: () => (/* binding */ resetTimerDedup)
/* harmony export */ });
/**
 * Voice Satellite Card — Timer Events
 *
 * Processes satellite entity state changes to detect timer additions,
 * removals, and finished alerts.
 */

let _lastTimerJson = '';

/**
 * Reset the dedup state (called on destroy/reconnect).
 */
function resetTimerDedup() {
  _lastTimerJson = '';
}

/**
 * @param {import('./index.js').TimerManager} mgr
 * @param {object} attrs - Entity attributes from state_changed event
 */
function processStateChange(mgr, attrs) {
  let rawTimers = attrs.active_timers;
  const lastEvent = attrs.last_timer_event;
  if (!rawTimers || !Array.isArray(rawTimers)) {
    rawTimers = [];
  }
  const rawJson = JSON.stringify(rawTimers);
  if (rawJson === _lastTimerJson) return;
  mgr.log.log('timer', `State changed: timers=${rawJson} last_event=${lastEvent}`);
  _lastTimerJson = rawJson;

  // Detect which timers were removed
  const newIds = rawTimers.map(t => t.id);
  const removedIds = mgr.knownTimerIds.filter(id => !newIds.includes(id));

  // If timers were removed and the last event was "finished", show alert
  if (removedIds.length > 0 && lastEvent === 'finished') {
    mgr.log.log('timer', `Timer(s) finished: ${removedIds.join(', ')}`);
    if (!mgr.alertActive) {
      mgr.showAlert();
    }
  }

  // Remove pills for removed timers
  for (const id of removedIds) {
    mgr.removePill(id);
  }
  mgr.knownTimerIds = newIds;

  // Sync remaining/new timers
  mgr.syncTimers(rawTimers);
}

/***/ },

/***/ "./src/timer/index.js"
/*!****************************!*\
  !*** ./src/timer/index.js ***!
  \****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TimerManager: () => (/* binding */ TimerManager)
/* harmony export */ });
/* harmony import */ var _shared_entity_subscription_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/entity-subscription.js */ "./src/shared/entity-subscription.js");
/* harmony import */ var _events_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./events.js */ "./src/timer/events.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./comms.js */ "./src/timer/comms.js");
/* harmony import */ var _ui_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./ui.js */ "./src/timer/ui.js");
/**
 * Voice Satellite Card — TimerManager
 *
 * Watches the satellite entity's active_timers attribute and renders
 * countdown pill overlays.
 *
 * Timer lifecycle:
 * 1. HA state_changed → active_timers gets new entry → pill appears
 * 2. Local 1s tick counts down → pill updates in-place
 * 3. HA state_changed → active_timers entry removed + last_timer_event
 *    - "finished" → show alert (blur + chime + 0:00 display)
 *    - "cancelled" → silently remove pill
 * 4. Alert dismissed by double-tap or auto-dismiss timeout
 */





class TimerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    /** @type {Array<object>} Active timer objects */
    this._timers = [];
    this._tickInterval = null;
    this._container = null;
    this._unsubscribe = null;
    this._subscribed = false;
    this._reconnectListener = null;

    /** @type {string[]} Track timer IDs to detect removals */
    this._knownTimerIds = [];

    // Alert state
    this._alertActive = false;
    this._alertEl = null;
  }

  // --- Public API ---

  update() {
    if (this._subscribed) return;
    const {
      config,
      connection
    } = this._card;
    if (!config.satellite_entity || !connection) return;
    (0,_shared_entity_subscription_js__WEBPACK_IMPORTED_MODULE_0__.subscribeToEntity)(this, connection, config.satellite_entity, attrs => this.processStateChange(attrs), 'timer');
  }
  get card() {
    return this._card;
  }
  get log() {
    return this._log;
  }
  get timers() {
    return this._timers;
  }
  set timers(val) {
    this._timers = val;
  }
  get knownTimerIds() {
    return this._knownTimerIds;
  }
  set knownTimerIds(val) {
    this._knownTimerIds = val;
  }
  get alertActive() {
    return this._alertActive;
  }
  set alertActive(val) {
    this._alertActive = val;
  }
  dismissAlert() {
    this.clearAlert();
  }
  destroy() {
    this.stopTick();
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.removeContainer)(this);
    this.clearAlert();
    this._timers = [];
    this._knownTimerIds = [];
    (0,_events_js__WEBPACK_IMPORTED_MODULE_1__.resetTimerDedup)();
    (0,_shared_entity_subscription_js__WEBPACK_IMPORTED_MODULE_0__.unsubscribeEntity)(this);
  }

  // --- State Processing (delegated) ---

  processStateChange(attrs) {
    (0,_events_js__WEBPACK_IMPORTED_MODULE_1__.processStateChange)(this, attrs);
  }

  // --- Timer Sync ---

  /**
   * @param {Array<object>} rawTimers - active_timers array from entity attributes
   */
  syncTimers(rawTimers) {
    if (rawTimers.length === 0) {
      this._timers = [];
      this.stopTick();
      (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.removeContainer)(this);
      return;
    }
    const now = Date.now();
    const newTimers = [];
    for (const raw of rawTimers) {
      const existing = this._timers.find(t => t.id === raw.id);

      // Use server-side started_at (epoch seconds) to compute correct start
      const serverStartedAt = raw.started_at ? raw.started_at * 1000 : now;
      if (existing) {
        if (existing.totalSeconds !== raw.total_seconds) {
          existing.totalSeconds = raw.total_seconds;
          existing.startedAt = serverStartedAt;
          const elapsed = Math.max(0, Math.floor((now - serverStartedAt) / 1000));
          existing.secondsLeft = Math.max(0, raw.total_seconds - elapsed);
          existing.startHours = raw.start_hours || 0;
          existing.startMinutes = raw.start_minutes || 0;
          existing.startSeconds = raw.start_seconds || 0;
        }
        newTimers.push(existing);
      } else {
        const elapsed = Math.max(0, Math.floor((now - serverStartedAt) / 1000));
        newTimers.push({
          id: raw.id,
          name: raw.name || '',
          totalSeconds: raw.total_seconds,
          secondsLeft: Math.max(0, raw.total_seconds - elapsed),
          startedAt: serverStartedAt,
          startHours: raw.start_hours || 0,
          startMinutes: raw.start_minutes || 0,
          startSeconds: raw.start_seconds || 0,
          el: null
        });
      }
    }
    this._timers = newTimers;
    this.startTick();
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.syncDOM)(this);
  }

  // --- Tick Control ---

  startTick() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.tick)(this), 1000);
  }
  stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  // --- UI Delegation ---

  showAlert() {
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.showAlert)(this);
  }
  clearAlert() {
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.clearAlert)(this);
  }
  removePill(timerId) {
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.removePill)(this, timerId);
  }

  // --- Cancel Timer ---

  cancelTimer(timerId) {
    this._log.log('timer', `Cancelling timer: ${timerId}`);
    (0,_comms_js__WEBPACK_IMPORTED_MODULE_2__.sendCancelTimer)(this._card, timerId);

    // Remove pill with animation immediately for responsive UI
    (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.removePill)(this, timerId);

    // Remove from tracked timers
    const timerIdx = this._timers.findIndex(t => t.id === timerId);
    if (timerIdx !== -1) this._timers.splice(timerIdx, 1);

    // Remove from known IDs so we don't trigger alert on next state change
    const knownIdx = this._knownTimerIds.indexOf(timerId);
    if (knownIdx !== -1) this._knownTimerIds.splice(knownIdx, 1);

    // Update raw JSON cache to match
    (0,_events_js__WEBPACK_IMPORTED_MODULE_1__.resetTimerDedup)();
    if (this._timers.length === 0) {
      this.stopTick();
      setTimeout(() => {
        if (this._timers.length === 0) (0,_ui_js__WEBPACK_IMPORTED_MODULE_3__.removeContainer)(this);
      }, 500);
    }
  }
}

/***/ },

/***/ "./src/timer/ui.js"
/*!*************************!*\
  !*** ./src/timer/ui.js ***!
  \*************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   clearAlert: () => (/* binding */ clearAlert),
/* harmony export */   removeContainer: () => (/* binding */ removeContainer),
/* harmony export */   removePill: () => (/* binding */ removePill),
/* harmony export */   showAlert: () => (/* binding */ showAlert),
/* harmony export */   syncDOM: () => (/* binding */ syncDOM),
/* harmony export */   tick: () => (/* binding */ tick)
/* harmony export */ });
/* harmony import */ var _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../audio/chime.js */ "./src/audio/chime.js");
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/**
 * Voice Satellite Card — Timer UI
 *
 * Timer-specific orchestration for pill sync, tick updates,
 * and alert lifecycle. All DOM ops delegate to UIManager,
 * all audio delegates to audio/chime.
 */


let _chimeInterval = null;
let _dismissTimeout = null;


// --- Container ---

/** @param {import('./index.js').TimerManager} mgr */
function removeContainer(mgr) {
  mgr.card.ui.removeTimerContainer();
}

// --- Pill Management ---

/**
 * @param {import('./index.js').TimerManager} mgr
 * @param {string} timerId
 */
function removePill(mgr, timerId) {
  mgr.card.ui.expireTimerPill(timerId, _constants_js__WEBPACK_IMPORTED_MODULE_1__.Timing.PILL_EXPIRE_ANIMATION);
  const timer = mgr.timers.find(t => t.id === timerId);
  if (timer) timer.el = null;
}

/** @param {import('./index.js').TimerManager} mgr */
function syncDOM(mgr) {
  mgr.card.ui.syncTimerPills(mgr.timers, timerId => () => mgr.cancelTimer(timerId));
}

// --- Tick ---

/** @param {import('./index.js').TimerManager} mgr */
function tick(mgr) {
  const now = Date.now();
  for (const t of mgr.timers) {
    const elapsed = Math.max(0, Math.floor((now - t.startedAt) / 1000));
    const left = Math.max(0, t.totalSeconds - elapsed);
    t.secondsLeft = left;
    mgr.card.ui.updateTimerPill(t.el, left, t.totalSeconds);
  }
}

// --- Alert ---

/** @param {import('./index.js').TimerManager} mgr */
function showAlert(mgr) {
  if (mgr.alertActive) {
    mgr.log.log('timer', 'Alert already active, skipping duplicate');
    return;
  }
  mgr.alertActive = true;
  mgr.log.log('timer', 'Showing finished alert');
  mgr.card.ui.showBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_1__.BlurReason.TIMER);
  mgr.card.ui.showTimerAlert(() => mgr.clearAlert());

  // Play chime immediately then loop
  playAlertChime(mgr);
  if (_chimeInterval) clearInterval(_chimeInterval);
  _chimeInterval = setInterval(() => playAlertChime(mgr), _constants_js__WEBPACK_IMPORTED_MODULE_1__.Timing.TIMER_CHIME_INTERVAL);

  // Auto-dismiss after 60 seconds
  const duration = 60;
  if (duration > 0) {
    if (_dismissTimeout) clearTimeout(_dismissTimeout);
    _dismissTimeout = setTimeout(() => mgr.clearAlert(), duration * 1000);
  }
}

/** @param {import('./index.js').TimerManager} mgr */
function clearAlert(mgr) {
  if (!mgr.alertActive) return;
  mgr.alertActive = false;

  // Stop chime loop
  if (_chimeInterval) {
    clearInterval(_chimeInterval);
    _chimeInterval = null;
  }

  // Cancel auto-dismiss
  if (_dismissTimeout) {
    clearTimeout(_dismissTimeout);
    _dismissTimeout = null;
  }
  mgr.card.ui.clearTimerAlert();
  mgr.card.ui.hideBlurOverlay(_constants_js__WEBPACK_IMPORTED_MODULE_1__.BlurReason.TIMER);

  // Only tear down pills/container if no timers remain active
  if (mgr.timers.length === 0) {
    mgr.stopTick();
    removeContainer(mgr);
  }
  mgr.log.log('timer', 'Alert dismissed');
}

/** @param {import('./index.js').TimerManager} mgr */
function playAlertChime(mgr) {
  (0,_audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.playMultiNoteChime)(mgr.card, _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_ALERT, {
    log: mgr.log
  });
  mgr.log.log('timer', 'Alert chime played');
}

/***/ },

/***/ "./src/tts/comms.js"
/*!**************************!*\
  !*** ./src/tts/comms.js ***!
  \**************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   playRemote: () => (/* binding */ playRemote),
/* harmony export */   stopRemote: () => (/* binding */ stopRemote)
/* harmony export */ });
/**
 * Voice Satellite Card — TTS Comms
 *
 * Remote media player service calls for TTS playback.
 * Pure comms — no timer scheduling or manager state mutation.
 */

/**
 * Play TTS on a remote media player entity.
 * @param {object} card - Card instance
 * @param {string} url - Full media URL
 * @returns {Promise<void>}
 */
function playRemote(card, url) {
  const entityId = card.ttsTarget;
  card.logger.log('tts', `Playing on remote: ${entityId} URL: ${url}`);
  return card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: url,
    media_content_type: 'music'
  }).catch(e => {
    card.logger.error('tts', `Remote play failed: ${e}`);
  });
}

/**
 * Stop playback on a remote media player entity.
 * @param {object} card - Card instance
 */
function stopRemote(card) {
  if (!card.ttsTarget || !card.hass) return;
  card.hass.callService('media_player', 'media_stop', {
    entity_id: card.ttsTarget
  }).catch(e => {
    card.logger.error('tts', `Remote stop failed: ${e}`);
  });
}

/***/ },

/***/ "./src/tts/index.js"
/*!**************************!*\
  !*** ./src/tts/index.js ***!
  \**************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TtsManager: () => (/* binding */ TtsManager)
/* harmony export */ });
/* harmony import */ var _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../audio/chime.js */ "./src/audio/chime.js");
/* harmony import */ var _audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../audio/media-playback.js */ "./src/audio/media-playback.js");
/* harmony import */ var _comms_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./comms.js */ "./src/tts/comms.js");
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../constants.js */ "./src/constants.js");
/**
 * Voice Satellite Card — TtsManager
 *
 * Handles TTS playback (browser + remote media player), chimes via Web Audio API,
 * and streaming TTS early-start support.
 */






/** Safety ceiling so the UI never gets stuck if remote state monitoring fails */
const REMOTE_SAFETY_TIMEOUT = 120_000;
const CHIME_MAP = {
  wake: _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_WAKE,
  error: _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_ERROR,
  done: _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_DONE
};
class TtsManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;
    this._currentAudio = null;
    this._playing = false;
    this._endTimer = null;
    this._streamingUrl = null;
    this._playbackWatchdog = null;

    // Retry fallback — tts-end URL stored for retry on playback failure
    this._pendingTtsEndUrl = null;

    // Remote media player state monitoring
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
  }
  get isPlaying() {
    return this._playing;
  }
  get streamingUrl() {
    return this._streamingUrl;
  }
  set streamingUrl(url) {
    this._streamingUrl = url;
  }

  // --- TTS Playback ---

  /**
   * @param {string} urlPath - URL or path to TTS audio
   * @param {boolean} [isRetry] - Whether this is a retry attempt
   */
  play(urlPath, isRetry) {
    const url = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.buildMediaUrl)(urlPath);
    this._playing = true;

    // Remote media player target — monitor entity state for completion
    const ttsTarget = this._card.ttsTarget;
    if (ttsTarget) {
      this._remoteTarget = ttsTarget;
      this._remoteSawPlaying = false;
      (0,_comms_js__WEBPACK_IMPORTED_MODULE_2__.playRemote)(this._card, url);

      // Safety timeout — if state monitoring never fires, clean up after 2 minutes
      this._endTimer = setTimeout(() => {
        this._endTimer = null;
        this._log.log('tts', 'Remote safety timeout — forcing completion');
        this._onComplete();
      }, REMOTE_SAFETY_TIMEOUT);
      return;
    }

    // Browser playback — watchdog checks audio is progressing
    this._lastWatchdogTime = 0;
    this._playbackWatchdog = setInterval(() => {
      if (!this._playing || !this._currentAudio) {
        this._clearWatchdog();
        return;
      }
      const now = this._currentAudio.currentTime;
      if (now > this._lastWatchdogTime) {
        this._lastWatchdogTime = now;
        return; // Audio is progressing — all good
      }
      // Audio stalled — force completion
      this._log.log('tts', 'Playback watchdog: audio stalled — forcing completion');
      this._clearWatchdog();
      this._onComplete();
    }, _constants_js__WEBPACK_IMPORTED_MODULE_3__.Timing.PLAYBACK_WATCHDOG);
    this._currentAudio = (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.playMediaUrl)(url, this._card.mediaPlayer.volume, {
      onEnd: () => {
        this._log.log('tts', 'Playback complete');
        this._clearWatchdog();
        this._onComplete();
      },
      onError: e => {
        this._log.error('tts', `Playback error: ${e}`);
        this._log.error('tts', `URL: ${url}`);
        this._clearWatchdog();

        // Retry once — the TTS proxy token may not have been ready yet
        if (!isRetry && this._pendingTtsEndUrl) {
          const retryUrl = this._pendingTtsEndUrl;
          this._pendingTtsEndUrl = null;
          this._currentAudio = null;
          this._log.log('tts', `Retrying with tts-end URL: ${retryUrl}`);
          this.play(retryUrl, true);
          return;
        }
        this._onComplete(true);
      },
      onStart: () => {
        this._log.log('tts', 'Playback started successfully');
        this._pendingTtsEndUrl = null;
        this._card.mediaPlayer.notifyAudioStart('tts');
        if (this._card._activeSkin?.reactiveBar && this._card.config.reactive_bar !== false && this._currentAudio) {
          this._card.analyser.attachAudio(this._currentAudio, this._card.audio.audioContext);
        }
      }
    });
  }
  stop() {
    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._pendingTtsEndUrl = null;
    this._clearWatchdog();
    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }
    this._card.analyser.detachAudio();
    if (this._currentAudio) {
      this._currentAudio.onended = null;
      this._currentAudio.onerror = null;
      this._currentAudio.pause();
      this._currentAudio.src = '';
      this._currentAudio = null;
    }
    (0,_comms_js__WEBPACK_IMPORTED_MODULE_2__.stopRemote)(this._card);
    this._card.mediaPlayer.notifyAudioEnd('tts');
  }

  /**
   * @param {object} eventData - run-start event data containing tts_output
   */
  storeStreamingUrl(eventData) {
    this._streamingUrl = null;
    if (eventData.tts_output?.url && eventData.tts_output?.stream_response) {
      const url = eventData.tts_output.url;
      this._streamingUrl = url.startsWith('http') ? url : window.location.origin + url;
      this._log.log('tts', `Streaming TTS URL available: ${this._streamingUrl}`);
    }
  }

  /**
   * Store the tts-end URL as a fallback for retry on playback failure.
   * @param {string|null} url
   */
  storeTtsEndUrl(url) {
    this._pendingTtsEndUrl = url ? (0,_audio_media_playback_js__WEBPACK_IMPORTED_MODULE_1__.buildMediaUrl)(url) : null;
  }

  // --- Chimes ---

  /**
   * @param {'wake' | 'error' | 'done'} type
   */
  playChime(type) {
    const pattern = CHIME_MAP[type] || _audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.CHIME_DONE;
    this._card.mediaPlayer.notifyAudioStart('chime');
    (0,_audio_chime_js__WEBPACK_IMPORTED_MODULE_0__.playChime)(this._card, pattern, this._log);
    setTimeout(() => {
      this._card.mediaPlayer.notifyAudioEnd('chime');
    }, (pattern.duration || 0.3) * 1000);
  }

  /**
   * Called from card's set hass() — monitors remote media player entity state
   * to detect when TTS playback finishes.
   * @param {object} hass
   */
  checkRemotePlayback(hass) {
    if (!this._playing || !this._remoteTarget) return;
    const entity = hass.states?.[this._remoteTarget];
    if (!entity) return;
    const state = entity.state;
    if (state === 'playing' || state === 'buffering') {
      this._remoteSawPlaying = true;
      return;
    }

    // Only complete once we've confirmed it was playing first,
    // to avoid false triggers during the brief delay before playback starts
    if (this._remoteSawPlaying) {
      this._log.log('tts', `Remote player stopped (state: ${state}) — completing`);
      this._onComplete();
    }
  }

  // --- Private ---

  _clearWatchdog() {
    if (this._playbackWatchdog) {
      clearInterval(this._playbackWatchdog);
      this._playbackWatchdog = null;
    }
  }

  /**
   * @param {boolean} [playbackFailed]
   */
  _onComplete(playbackFailed) {
    this._log.log('tts', `Complete — cleaning up UI${playbackFailed ? ' (playback failed)' : ''}`);
    this._card.analyser.detachAudio();
    this._currentAudio = null;
    this._playing = false;
    this._remoteTarget = null;
    this._remoteSawPlaying = false;
    this._pendingTtsEndUrl = null;
    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }
    this._card.mediaPlayer.notifyAudioEnd('tts');
    this._card.onTTSComplete(playbackFailed);
  }
}

/***/ },

/***/ "./src/editor/preview.css"
/*!********************************!*\
  !*** ./src/editor/preview.css ***!
  \********************************/
(module) {

module.exports = "/* Editor Preview — Base Layout & Shared Styles */\r\n\r\n:host {\r\n  display: block;\r\n  position: relative;\r\n  overflow: hidden;\r\n  border-radius: var(--ha-card-border-radius, 12px);\r\n  min-height: 380px;\r\n}\r\n\r\n.preview-background {\r\n  position: absolute;\r\n  top: 0; left: 0; right: 0; bottom: 0;\r\n  background-image:\r\n    linear-gradient(45deg, #e0e0e0 25%, transparent 25%),\r\n    linear-gradient(-45deg, #e0e0e0 25%, transparent 25%),\r\n    linear-gradient(45deg, transparent 75%, #e0e0e0 75%),\r\n    linear-gradient(-45deg, transparent 75%, #e0e0e0 75%);\r\n  background-size: 20px 20px;\r\n  background-position: 0 0, 0 10px, 10px -10px, -10px 0;\r\n  background-color: #f5f5f5;\r\n}\r\n\r\n@media (prefers-color-scheme: dark) {\r\n  .preview-background {\r\n    background-image:\r\n      linear-gradient(45deg, #333 25%, transparent 25%),\r\n      linear-gradient(-45deg, #333 25%, transparent 25%),\r\n      linear-gradient(45deg, transparent 75%, #333 75%),\r\n      linear-gradient(-45deg, transparent 75%, #333 75%);\r\n    background-color: #222;\r\n  }\r\n}\r\n\r\n:host-context([data-theme=\"dark\"]) .preview-background,\r\n:host-context(.dark) .preview-background {\r\n  background-image:\r\n    linear-gradient(45deg, #333 25%, transparent 25%),\r\n    linear-gradient(-45deg, #333 25%, transparent 25%),\r\n    linear-gradient(45deg, transparent 75%, #333 75%),\r\n    linear-gradient(-45deg, transparent 75%, #333 75%);\r\n  background-color: #222;\r\n}\r\n\r\n.preview-container {\r\n  position: relative;\r\n  width: 100%;\r\n  min-height: 380px;\r\n  box-sizing: border-box;\r\n  display: flex;\r\n  flex-direction: column;\r\n  justify-content: flex-end;\r\n  padding: 24px 16px;\r\n}\r\n\r\n.preview-blur {\r\n  position: absolute;\r\n  top: 0; left: 0; right: 0; bottom: 0;\r\n  backdrop-filter: blur(4px);\r\n  -webkit-backdrop-filter: blur(4px);\r\n  z-index: 1;\r\n  pointer-events: none;\r\n}\r\n\r\n.preview-bar {\r\n  position: absolute;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  z-index: 2;\r\n  animation: preview-slide 2s linear infinite;\r\n}\r\n\r\n@keyframes preview-slide {\r\n  0% { background-position: 200% 0; }\r\n  100% { background-position: 0% 0; }\r\n}\r\n\r\n.preview-chat {\r\n  position: relative;\r\n  z-index: 3;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  width: 85%;\r\n  margin: 0 auto 24px;\r\n}\r\n\r\n.preview-msg {\r\n  max-width: 85%;\r\n  line-height: 1.2;\r\n  word-wrap: break-word;\r\n  animation: preview-fade-in 0.3s ease;\r\n}\r\n\r\n@keyframes preview-fade-in {\r\n  from { opacity: 0; transform: translateY(8px); }\r\n  to { opacity: 1; transform: translateY(0); }\r\n}\r\n\r\n.preview-timer {\r\n  position: absolute;\r\n  top: 12px;\r\n  right: 12px;\r\n  z-index: 4;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n  overflow: hidden;\r\n  font-size: 30px;\r\n  font-weight: bold;\r\n  padding: 16px;\r\n}\r\n\r\n.preview-timer-progress {\r\n  position: absolute;\r\n  top: 0;\r\n  left: 0;\r\n  width: 65%;\r\n  height: 100%;\r\n  border-radius: inherit;\r\n}\r\n\r\n.preview-timer-content {\r\n  position: relative;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n}\r\n\r\n.preview-label {\r\n  position: absolute;\r\n  top: 12px;\r\n  left: 14px;\r\n  z-index: 5;\r\n  font-size: 11px;\r\n  font-weight: 500;\r\n  letter-spacing: 0.5px;\r\n  text-transform: uppercase;\r\n  pointer-events: none;\r\n}\r\n";

/***/ },

/***/ "./src/skins/alexa-preview.css"
/*!*************************************!*\
  !*** ./src/skins/alexa-preview.css ***!
  \*************************************/
(module) {

module.exports = "/* Alexa Skin — Editor Preview Overrides */\r\n\r\n.preview-container {\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\r\n}\r\n\r\n.preview-label {\r\n  color: rgba(255, 255, 255, 0.3);\r\n}\r\n.preview-blur {\r\n  background: rgba(0, 8, 20, 0.7);\r\n}\r\n.preview-bar {\r\n  height: 6px;\r\n  border-radius: 3px 3px 0 0;\r\n  background: linear-gradient(90deg, #00CAFF, #00E5FF, #00CAFF);\r\n  background-size: 200% 100%;\r\n  box-shadow: 0 0 20px 6px rgba(0, 202, 255, 0.5), 0 0 40px 12px rgba(0, 202, 255, 0.2);\r\n}\r\n.preview-chat {\r\n  align-items: center;\r\n}\r\n.preview-msg {\r\n  box-shadow: none;\r\n  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);\r\n}\r\n.preview-msg.user {\r\n  font-size: 32px;\r\n  color: rgba(255, 255, 255, 0.55);\r\n  font-weight: 300;\r\n  background: none;\r\n  border: none;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n.preview-msg.assistant {\r\n  font-size: 42px;\r\n  color: #FFFFFF;\r\n  font-weight: bold;\r\n  background: none;\r\n  border: none;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n.preview-timer {\r\n  color: #FFFFFF;\r\n  background: rgba(10, 22, 40, 0.9);\r\n  border: 2px solid rgba(0, 202, 255, 0.35);\r\n  border-radius: 16px;\r\n  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);\r\n}\r\n.preview-timer-progress {\r\n  background: rgba(0, 202, 255, 0.25);\r\n  opacity: 1;\r\n}\r\n";

/***/ },

/***/ "./src/skins/alexa.css"
/*!*****************************!*\
  !*** ./src/skins/alexa.css ***!
  \*****************************/
(module) {

module.exports = "/* Alexa Skin */\r\n\r\n/* Font */\r\n#voice-satellite-ui {\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\r\n}\r\n\r\n/* Blur Overlay — darker, heavier blur for Alexa's dark aesthetic */\r\n#voice-satellite-ui .vs-blur-overlay {\r\n  position: fixed;\r\n  top: 0;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  backdrop-filter: blur(6px);\r\n  -webkit-backdrop-filter: blur(6px);\r\n  opacity: 0;\r\n  transition: opacity 0.4s ease;\r\n  z-index: 9999;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-blur-overlay.visible {\r\n  opacity: 1;\r\n}\r\n\r\n/* Start Button — cyan Alexa accent */\r\n#voice-satellite-ui .vs-start-btn {\r\n  position: fixed;\r\n  bottom: 20px;\r\n  right: 20px;\r\n  width: 56px;\r\n  height: 56px;\r\n  border-radius: 50%;\r\n  background: #00CAFF;\r\n  border: none;\r\n  cursor: pointer;\r\n  display: none;\r\n  align-items: center;\r\n  justify-content: center;\r\n  box-shadow: 0 4px 16px rgba(0, 202, 255, 0.4);\r\n  z-index: 10001;\r\n  transition: transform 0.2s, box-shadow 0.2s;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn.visible {\r\n  display: flex;\r\n  animation: alexa-btn-pulse 2.5s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn:hover {\r\n  transform: scale(1.1);\r\n  box-shadow: 0 6px 24px rgba(0, 202, 255, 0.6);\r\n  animation: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn svg {\r\n  width: 28px;\r\n  height: 28px;\r\n  fill: white;\r\n}\r\n\r\n@keyframes alexa-btn-pulse {\r\n  0%, 100% {\r\n    transform: scale(1);\r\n    box-shadow: 0 4px 16px rgba(0, 202, 255, 0.4);\r\n  }\r\n  50% {\r\n    transform: scale(1.06);\r\n    box-shadow: 0 6px 28px rgba(0, 202, 255, 0.7);\r\n  }\r\n}\r\n\r\n/* Bottom Glow — full-width bar with strong glow */\r\n#voice-satellite-ui .vs-rainbow-bar {\r\n  position: fixed;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  height: 10px;\r\n  border-radius: 3px 3px 0 0;\r\n  background: linear-gradient(90deg, #00CAFF, #00E5FF, #00CAFF);\r\n  background-size: 200% 100%;\r\n  filter: drop-shadow(0 0 12px rgba(0, 202, 255, 0.5));\r\n  opacity: 0;\r\n  transition: opacity 0.4s ease;\r\n  z-index: 10000;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.visible {\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.connecting {\r\n  animation: alexa-breathe 2s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.listening {\r\n  animation: alexa-glow 2s ease-in-out infinite, alexa-shimmer 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.processing {\r\n  animation: alexa-glow 0.6s ease-in-out infinite, alexa-shimmer 1s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.speaking {\r\n  animation: alexa-speak 1.5s ease-in-out infinite, alexa-shimmer 4s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-mode {\r\n  background: #FF3B30;\r\n  filter: drop-shadow(0 0 12px rgba(255, 59, 48, 0.5));\r\n  animation: alexa-glow-red 1.5s ease-in-out infinite;\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-flash {\r\n  animation: alexa-error-flash 0.15s ease-in-out 3;\r\n}\r\n\r\n/* Reactive Bar — audio-driven glow, speed varies by state */\r\n#voice-satellite-ui .vs-rainbow-bar.reactive {\r\n  overflow: visible;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive::after {\r\n  content: '';\r\n  position: absolute;\r\n  inset: 0;\r\n  background: linear-gradient(90deg, #00CAFF, #00E5FF, #00CAFF);\r\n  background-size: 200% 100%;\r\n  border-radius: 50%;\r\n  filter: blur(calc(6px + 12px * var(--vs-audio-level, 0)));\r\n  opacity: calc(var(--vs-audio-level, 0) * 2.5);\r\n  transform: scale(1.05, 2);\r\n  z-index: -1;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.listening {\r\n  animation: alexa-shimmer 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.listening::after {\r\n  animation: alexa-shimmer 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.processing {\r\n  animation: alexa-shimmer 1s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.processing::after {\r\n  animation: alexa-shimmer 1s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.speaking {\r\n  animation: alexa-shimmer 4s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.speaking::after {\r\n  animation: alexa-shimmer 4s linear infinite;\r\n}\r\n\r\n@keyframes alexa-breathe {\r\n  0%, 100% {\r\n    opacity: 0.3;\r\n    filter: drop-shadow(0 0 6px rgba(0, 202, 255, 0.3));\r\n  }\r\n  50% {\r\n    opacity: 0.7;\r\n    filter: drop-shadow(0 0 14px rgba(0, 202, 255, 0.6));\r\n  }\r\n}\r\n\r\n@keyframes alexa-glow {\r\n  0%, 100% {\r\n    filter: drop-shadow(0 0 12px rgba(0, 202, 255, 0.5));\r\n  }\r\n  50% {\r\n    filter: drop-shadow(0 0 24px rgba(0, 202, 255, 0.8));\r\n  }\r\n}\r\n\r\n@keyframes alexa-speak {\r\n  0%, 100% {\r\n    filter: drop-shadow(0 0 10px rgba(0, 202, 255, 0.5));\r\n  }\r\n  50% {\r\n    filter: drop-shadow(0 0 18px rgba(0, 202, 255, 0.7));\r\n  }\r\n}\r\n\r\n@keyframes alexa-shimmer {\r\n  0% { background-position: 200% 0; }\r\n  100% { background-position: -200% 0; }\r\n}\r\n\r\n@keyframes alexa-glow-red {\r\n  0%, 100% {\r\n    filter: drop-shadow(0 0 8px rgba(255, 59, 48, 0.4));\r\n  }\r\n  50% {\r\n    filter: drop-shadow(0 0 18px rgba(255, 59, 48, 0.7));\r\n  }\r\n}\r\n\r\n@keyframes alexa-error-flash {\r\n  0%, 100% { opacity: 1; }\r\n  50% { opacity: 0.3; }\r\n}\r\n\r\n/* Chat Container */\r\n#voice-satellite-ui .vs-chat-container {\r\n  position: fixed;\r\n  left: 50%;\r\n  transform: translateX(-50%);\r\n  bottom: 80px;\r\n  display: none;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  gap: 10px;\r\n  max-width: 85%;\r\n  width: 85%;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  overflow: visible;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.visible {\r\n  display: flex;\r\n  pointer-events: auto;\r\n}\r\n\r\n#voice-satellite-ui.reactive-mode .vs-chat-container {\r\n  bottom: 104px;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.announcement-mode {\r\n  top: 50% !important;\r\n  bottom: auto !important;\r\n  transform: translate(-50%, -50%);\r\n}\r\n\r\n/* Chat Messages — clean text on dark background, no bubbles */\r\n#voice-satellite-ui .vs-chat-msg {\r\n  max-width: 85%;\r\n  opacity: 0;\r\n  animation: alexa-fade-in 0.35s ease forwards;\r\n  word-wrap: break-word;\r\n  background: none;\r\n  border: none;\r\n  box-shadow: none;\r\n  font-size: calc(36px * var(--vs-text-scale, 1));\r\n  font-weight: normal;\r\n  font-style: normal;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.user {\r\n  font-size: calc(32px * var(--vs-text-scale, 1));\r\n  color: rgba(255, 255, 255, 0.55);\r\n  font-weight: 300;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.assistant {\r\n  font-size: calc(42px * var(--vs-text-scale, 1));\r\n  color: #FFFFFF;\r\n  font-weight: bold;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.announcement {\r\n  font-size: calc(42px * var(--vs-text-scale, 1));\r\n  color: #FFFFFF;\r\n  font-weight: bold;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n\r\n/* Animations */\r\n@keyframes alexa-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(10px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n/* Timer Container — top-right */\r\n.vs-timer-container {\r\n  position: fixed;\r\n  top: 12px;\r\n  right: 12px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\r\n}\r\n\r\n/* Timer Pills — dark with cyan accent */\r\n.vs-timer-pill {\r\n  position: relative;\r\n  overflow: hidden;\r\n  font-size: calc(34px * var(--vs-text-scale, 1));\r\n  color: #FFFFFF;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: rgba(10, 22, 40, 0.9);\r\n  border: 2px solid rgba(0, 202, 255, 0.35);\r\n  padding: 14px 18px;\r\n  border-radius: 16px;\r\n  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);\r\n  animation: alexa-timer-fade-in 0.3s ease forwards;\r\n  pointer-events: auto;\r\n  cursor: default;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-progress {\r\n  position: absolute;\r\n  top: 0;\r\n  left: 0;\r\n  height: 100%;\r\n  background: rgba(0, 202, 255, 0.25);\r\n  opacity: 1;\r\n  transition: width 1s linear;\r\n  pointer-events: none;\r\n}\r\n\r\n.vs-timer-content {\r\n  position: relative;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n}\r\n\r\n.vs-timer-icon {\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-time {\r\n  font-variant-numeric: tabular-nums;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-pill.vs-timer-expired {\r\n  animation: alexa-timer-fade-out 0.4s ease forwards;\r\n}\r\n\r\n/* Timer Finished Alert — dark with cyan glow */\r\n.vs-timer-alert {\r\n  position: fixed;\r\n  top: 50%;\r\n  left: 50%;\r\n  transform: translate(-50%, -50%);\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 12px;\r\n  font-size: calc(34px * var(--vs-text-scale, 1));\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\r\n  color: #FFFFFF;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: rgba(10, 22, 40, 0.95);\r\n  border: 2px solid rgba(0, 202, 255, 0.4);\r\n  padding: 18px 24px;\r\n  border-radius: 16px;\r\n  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4), 0 0 20px rgba(0, 202, 255, 0.2);\r\n  z-index: 10002;\r\n  animation: alexa-alert-pulse 1.5s ease-in-out infinite;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-icon {\r\n  font-size: 1.5em;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-time {\r\n  font-size: 1.2em;\r\n}\r\n\r\n@keyframes alexa-timer-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n@keyframes alexa-timer-fade-out {\r\n  0% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n  100% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n}\r\n\r\n@keyframes alexa-alert-pulse {\r\n  0%, 100% {\r\n    transform: translate(-50%, -50%) scale(1);\r\n    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4), 0 0 20px rgba(0, 202, 255, 0.2);\r\n  }\r\n  50% {\r\n    transform: translate(-50%, -50%) scale(1.03);\r\n    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4), 0 0 30px rgba(0, 202, 255, 0.4);\r\n  }\r\n}\r\n";

/***/ },

/***/ "./src/skins/default-preview.css"
/*!***************************************!*\
  !*** ./src/skins/default-preview.css ***!
  \***************************************/
(module) {

module.exports = "/* Default Skin — Editor Preview Overrides */\r\n\r\n.preview-container {\r\n  font-family: Roboto, Noto, sans-serif;\r\n}\r\n\r\n.preview-bar {\r\n  height: 16px;\r\n  background: linear-gradient(90deg, #FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC, #FF7777);\r\n  background-size: 200% 100%;\r\n}\r\n\r\n.preview-chat {\r\n  align-items: flex-start;\r\n}\r\n\r\n.preview-msg {\r\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);\r\n}\r\n\r\n.preview-msg.user {\r\n  font-size: 30px;\r\n  color: #444444;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(0, 180, 255, 0.5);\r\n  padding: 16px;\r\n  border-radius: 12px;\r\n  align-self: flex-end;\r\n  text-align: left;\r\n}\r\n\r\n.preview-msg.assistant {\r\n  font-size: 30px;\r\n  color: #444444;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(100, 200, 150, 0.5);\r\n  padding: 16px;\r\n  border-radius: 12px;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n\r\n.preview-timer {\r\n  color: #444444;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(0, 180, 255, 0.5);\r\n  border-radius: 12px;\r\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);\r\n}\r\n\r\n.preview-timer-progress {\r\n  background: rgba(0, 180, 255, 0.5);\r\n  opacity: 0.3;\r\n}\r\n\r\n.preview-label {\r\n  color: rgba(0, 0, 0, 0.35);\r\n}\r\n";

/***/ },

/***/ "./src/skins/default.css"
/*!*******************************!*\
  !*** ./src/skins/default.css ***!
  \*******************************/
(module) {

module.exports = "/* Default Skin */\r\n\r\n/* Animatable custom property for syncing bar + glow gradient position */\r\n@property --vs-gp {\r\n  syntax: '<percentage>';\r\n  inherits: true;\r\n  initial-value: 0%;\r\n}\r\n\r\n/* Font */\r\n#voice-satellite-ui {\r\n  font-family: Roboto, Noto, sans-serif;\r\n}\r\n\r\n/* Blur Overlay */\r\n#voice-satellite-ui .vs-blur-overlay {\r\n  position: fixed;\r\n  top: 0;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  backdrop-filter: blur(4px);\r\n  -webkit-backdrop-filter: blur(4px);\r\n  opacity: 0;\r\n  transition: opacity 0.3s ease;\r\n  z-index: 9999;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-blur-overlay.visible {\r\n  opacity: 1;\r\n}\r\n\r\n/* Start Button */\r\n#voice-satellite-ui .vs-start-btn {\r\n  position: fixed;\r\n  bottom: 20px;\r\n  right: 20px;\r\n  width: 56px;\r\n  height: 56px;\r\n  border-radius: 50%;\r\n  background: var(--primary-color, #03a9f4);\r\n  border: none;\r\n  cursor: pointer;\r\n  display: none;\r\n  align-items: center;\r\n  justify-content: center;\r\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);\r\n  z-index: 10001;\r\n  transition: transform 0.2s, box-shadow 0.2s;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn.visible {\r\n  display: flex;\r\n  animation: vs-btn-pulse 2s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn:hover {\r\n  transform: scale(1.1);\r\n  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);\r\n  animation: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn svg {\r\n  width: 28px;\r\n  height: 28px;\r\n  fill: white;\r\n}\r\n\r\n@keyframes vs-btn-pulse {\r\n  0%, 100% {\r\n    transform: scale(1);\r\n    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);\r\n  }\r\n  50% {\r\n    transform: scale(1.08);\r\n    box-shadow: 0 6px 20px rgba(3, 169, 244, 0.5);\r\n  }\r\n}\r\n\r\n/* Rainbow Bar */\r\n#voice-satellite-ui .vs-rainbow-bar {\r\n  position: fixed;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  height: 16px;\r\n  background: linear-gradient(90deg, #FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC, #FF7777);\r\n  background-size: 200% 100%;\r\n  opacity: 0;\r\n  transition: opacity 0.3s ease;\r\n  z-index: 10000;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.visible {\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.connecting {\r\n  animation: vs-bar-breathe 1.5s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.listening {\r\n  animation: vs-gradient-flow 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.processing {\r\n  animation: vs-gradient-flow 0.5s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.speaking {\r\n  animation: vs-gradient-flow 2s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-mode {\r\n  background: linear-gradient(90deg, #ff4444, #ff6666, #cc2222, #ff4444, #ff6666, #cc2222, #ff4444);\r\n  background-size: 200% 100%;\r\n  animation: vs-gradient-flow 2s linear infinite;\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-flash {\r\n  animation: vs-error-flash 0.15s ease-in-out 3;\r\n}\r\n\r\n/* Reactive Bar — audio-driven scale and glow, speed varies by state.\r\n   Uses @property --vs-gp so the bar and its ::after glow share a single\r\n   animated gradient position — guaranteeing perfect color sync. */\r\n#voice-satellite-ui .vs-rainbow-bar.reactive {\r\n  transition: transform 0.05s linear;\r\n  transform-origin: bottom;\r\n  transform: scaleY(calc(1 + 0.5 * var(--vs-audio-level, 0)));\r\n  overflow: visible;\r\n  background-position: var(--vs-gp) 50%;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive::after {\r\n  content: '';\r\n  position: absolute;\r\n  inset: 0;\r\n  background: linear-gradient(90deg, #FF7777, #FF9977, #FFCC77, #CCFF77, #77FFAA, #77DDFF, #77AAFF, #AA77FF, #FF77CC, #FF7777);\r\n  background-size: 200% 100%;\r\n  background-position: var(--vs-gp) 50%;\r\n  border-radius: 50%;\r\n  filter: blur(calc(6px + 12px * var(--vs-audio-level, 0)));\r\n  opacity: calc(var(--vs-audio-level, 0) * 2.5);\r\n  transform: scale(1.05, 1.5);\r\n  z-index: -1;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.listening {\r\n  animation: vs-gradient-flow-sync 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.processing {\r\n  animation: vs-gradient-flow-sync 0.5s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.speaking {\r\n  animation: vs-gradient-flow-sync 2s linear infinite;\r\n}\r\n\r\n@keyframes vs-error-flash {\r\n  0%, 100% { opacity: 1; }\r\n  50% { opacity: 0.3; }\r\n}\r\n\r\n/* Chat Container */\r\n#voice-satellite-ui .vs-chat-container {\r\n  position: fixed;\r\n  left: 50%;\r\n  transform: translateX(-50%);\r\n  bottom: 56px;\r\n  display: none;\r\n  flex-direction: column;\r\n  align-items: flex-start;\r\n  gap: 14px;\r\n  max-width: 85%;\r\n  width: 85%;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  overflow: visible;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.visible {\r\n  display: flex;\r\n  pointer-events: auto;\r\n}\r\n\r\n#voice-satellite-ui.reactive-mode .vs-chat-container {\r\n  bottom: 100px;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.announcement-mode {\r\n  top: 50% !important;\r\n  bottom: auto !important;\r\n  transform: translate(-50%, -50%);\r\n}\r\n\r\n/* Chat Messages */\r\n#voice-satellite-ui .vs-chat-msg {\r\n  max-width: 85%;\r\n  opacity: 0;\r\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);\r\n  animation: vs-chat-fade-in 0.3s ease forwards;\r\n  word-wrap: break-word;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.user {\r\n  font-size: calc(30px * var(--vs-text-scale, 1));\r\n  color: #444444;\r\n  font-weight: normal;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(0, 180, 255, 0.5);\r\n  padding: 16px 36px 16px 16px;\r\n  border-radius: 12px;\r\n  align-self: flex-end;\r\n  text-align: left;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.assistant {\r\n  font-size: calc(30px * var(--vs-text-scale, 1));\r\n  color: #444444;\r\n  font-weight: normal;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(100, 200, 150, 0.5);\r\n  padding: 16px 36px 16px 16px;\r\n  border-radius: 12px;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.announcement {\r\n  font-size: calc(30px * var(--vs-text-scale, 1));\r\n  color: #444444;\r\n  font-weight: normal;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(100, 200, 150, 0.5);\r\n  padding: 16px;\r\n  border-radius: 12px;\r\n  align-self: center;\r\n  text-align: center;\r\n}\r\n\r\n/* Animations */\r\n@keyframes vs-chat-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n@keyframes vs-gradient-flow {\r\n  0% {\r\n    background-position: 0% 50%;\r\n  }\r\n  100% {\r\n    background-position: 200% 50%;\r\n  }\r\n}\r\n\r\n@keyframes vs-gradient-flow-sync {\r\n  0%   { --vs-gp: 0%; }\r\n  100% { --vs-gp: 200%; }\r\n}\r\n\r\n@keyframes vs-bar-breathe {\r\n  0%, 100% {\r\n    opacity: 0.3;\r\n  }\r\n  50% {\r\n    opacity: 0.7;\r\n  }\r\n}\r\n\r\n/* Timer Container */\r\n.vs-timer-container {\r\n  position: fixed;\r\n  top: 12px;\r\n  right: 12px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  font-family: Roboto, Noto, sans-serif;\r\n}\r\n\r\n/* Timer Pills */\r\n.vs-timer-pill {\r\n  position: relative;\r\n  overflow: hidden;\r\n  font-size: calc(30px * var(--vs-text-scale, 1));\r\n  color: #444444;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(0, 180, 255, 0.5);\r\n  padding: 16px;\r\n  border-radius: 12px;\r\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);\r\n  animation: vs-timer-fade-in 0.3s ease forwards;\r\n  pointer-events: auto;\r\n  cursor: default;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-progress {\r\n  position: absolute;\r\n  top: 0;\r\n  left: 0;\r\n  height: 100%;\r\n  background: rgba(0, 180, 255, 0.5);\r\n  opacity: 0.3;\r\n  transition: width 1s linear;\r\n  pointer-events: none;\r\n}\r\n\r\n.vs-timer-content {\r\n  position: relative;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n}\r\n\r\n.vs-timer-icon {\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-time {\r\n  font-variant-numeric: tabular-nums;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-pill.vs-timer-expired {\r\n  animation: vs-timer-fade-out 0.4s ease forwards;\r\n}\r\n\r\n/* Timer Finished Alert */\r\n.vs-timer-alert {\r\n  position: fixed;\r\n  top: 50%;\r\n  left: 50%;\r\n  transform: translate(-50%, -50%);\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 12px;\r\n  font-size: calc(30px * var(--vs-text-scale, 1));\r\n  font-family: Roboto, Noto, sans-serif;\r\n  color: #444444;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: 3px solid rgba(0, 180, 255, 0.5);\r\n  padding: 16px;\r\n  border-radius: 12px;\r\n  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);\r\n  z-index: 10002;\r\n  animation: vs-timer-alert-pulse 1.5s ease-in-out infinite;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-icon {\r\n  font-size: 1.5em;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-time {\r\n  font-size: 1.2em;\r\n}\r\n\r\n@keyframes vs-timer-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n@keyframes vs-timer-fade-out {\r\n  0% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n  100% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n}\r\n\r\n@keyframes vs-timer-alert-pulse {\r\n  0%, 100% {\r\n    transform: translate(-50%, -50%) scale(1);\r\n  }\r\n  50% {\r\n    transform: translate(-50%, -50%) scale(1.05);\r\n  }\r\n}\r\n";

/***/ },

/***/ "./src/skins/google-home-preview.css"
/*!*******************************************!*\
  !*** ./src/skins/google-home-preview.css ***!
  \*******************************************/
(module) {

module.exports = "/* Google Home Skin — Editor Preview Overrides */\r\n\r\n.preview-container {\r\n  font-family: \"Google Sans\", Roboto, Noto, sans-serif;\r\n}\r\n\r\n.preview-blur {\r\n  background: rgba(255, 255, 255, 0.75);\r\n}\r\n.preview-bar {\r\n  left: 20%;\r\n  right: 20%;\r\n  bottom: 24px;\r\n  height: 4px;\r\n  border-radius: 2px;\r\n  background: linear-gradient(90deg, #4285F4, #4285F4 25%, #EA4335 25%, #EA4335 50%, #FBBC05 50%, #FBBC05 75%, #34A853 75%, #34A853);\r\n  background-size: 200% 100%;\r\n}\r\n.preview-chat {\r\n  align-items: flex-start;\r\n}\r\n.preview-msg {\r\n  box-shadow: none;\r\n}\r\n.preview-msg.user {\r\n  font-size: 32px;\r\n  color: rgba(32, 33, 36, 0.5);\r\n  background: none;\r\n  border: none;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n.preview-msg.assistant {\r\n  font-size: 36px;\r\n  color: #202124;\r\n  font-weight: 400;\r\n  background: none;\r\n  border: none;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n.preview-timer {\r\n  color: #3c4043;\r\n  background: #ffffff;\r\n  border: none;\r\n  border-radius: 18px;\r\n  box-shadow: 0 1px 3px rgba(60, 64, 67, 0.15), 0 4px 8px rgba(60, 64, 67, 0.1);\r\n}\r\n.preview-timer-progress {\r\n  background: rgba(66, 133, 244, 0.15);\r\n  opacity: 1;\r\n}\r\n\r\n.preview-label {\r\n  color: rgba(0, 0, 0, 0.35);\r\n}\r\n";

/***/ },

/***/ "./src/skins/google-home.css"
/*!***********************************!*\
  !*** ./src/skins/google-home.css ***!
  \***********************************/
(module) {

module.exports = "/* Google Home Skin */\r\n\r\n/* Animatable custom property for syncing bar + glow gradient position */\r\n@property --vs-gp {\r\n  syntax: '<percentage>';\r\n  inherits: true;\r\n  initial-value: 0%;\r\n}\r\n\r\n/* Font */\r\n#voice-satellite-ui {\r\n  font-family: \"Google Sans\", Roboto, Noto, sans-serif;\r\n}\r\n\r\n/* Blur Overlay — light, frosted glass */\r\n#voice-satellite-ui .vs-blur-overlay {\r\n  position: fixed;\r\n  top: 0;\r\n  left: 0;\r\n  right: 0;\r\n  bottom: 0;\r\n  backdrop-filter: blur(6px);\r\n  -webkit-backdrop-filter: blur(6px);\r\n  opacity: 0;\r\n  transition: opacity 0.3s ease;\r\n  z-index: 9999;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-blur-overlay.visible {\r\n  opacity: 1;\r\n}\r\n\r\n/* Start Button — Google Blue with material shadow */\r\n#voice-satellite-ui .vs-start-btn {\r\n  position: fixed;\r\n  bottom: 20px;\r\n  right: 20px;\r\n  width: 56px;\r\n  height: 56px;\r\n  border-radius: 50%;\r\n  background: #4285F4;\r\n  border: none;\r\n  cursor: pointer;\r\n  display: none;\r\n  align-items: center;\r\n  justify-content: center;\r\n  box-shadow: 0 2px 8px rgba(66, 133, 244, 0.3), 0 4px 16px rgba(0, 0, 0, 0.15);\r\n  z-index: 10001;\r\n  transition: transform 0.2s, box-shadow 0.2s;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn.visible {\r\n  display: flex;\r\n  animation: google-btn-pulse 2.5s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn:hover {\r\n  transform: scale(1.1);\r\n  box-shadow: 0 4px 12px rgba(66, 133, 244, 0.5), 0 6px 20px rgba(0, 0, 0, 0.2);\r\n  animation: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-start-btn svg {\r\n  width: 28px;\r\n  height: 28px;\r\n  fill: white;\r\n}\r\n\r\n@keyframes google-btn-pulse {\r\n  0%, 100% {\r\n    transform: scale(1);\r\n    box-shadow: 0 2px 8px rgba(66, 133, 244, 0.3), 0 4px 16px rgba(0, 0, 0, 0.15);\r\n  }\r\n  50% {\r\n    transform: scale(1.06);\r\n    box-shadow: 0 4px 16px rgba(66, 133, 244, 0.5), 0 6px 24px rgba(0, 0, 0, 0.2);\r\n  }\r\n}\r\n\r\n/* Google Bar — 4-color gradient, 60% width, floating above bottom */\r\n#voice-satellite-ui .vs-rainbow-bar {\r\n  position: fixed;\r\n  left: 20%;\r\n  right: 20%;\r\n  bottom: 24px;\r\n  height: 4px;\r\n  border-radius: 2px;\r\n  background: linear-gradient(90deg, #4285F4, #4285F4 25%, #EA4335 25%, #EA4335 50%, #FBBC05 50%, #FBBC05 75%, #34A853 75%, #34A853);\r\n  background-size: 200% 100%;\r\n  opacity: 0;\r\n  transition: opacity 0.3s ease;\r\n  z-index: 10000;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.visible {\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.connecting {\r\n  animation: google-breathe 1.5s ease-in-out infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.listening {\r\n  animation: google-flow 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.processing {\r\n  animation: google-flow 0.5s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.speaking {\r\n  animation: google-flow 2s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-mode {\r\n  background: linear-gradient(90deg, #EA4335, #d93025, #EA4335, #d93025);\r\n  background-size: 200% 100%;\r\n  animation: google-flow 2s linear infinite;\r\n  opacity: 1;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.error-flash {\r\n  animation: google-error-flash 0.15s ease-in-out 3;\r\n}\r\n\r\n/* Reactive Bar — audio-driven pulsation, speed varies by state.\r\n   Uses @property --vs-gp so the bar and its ::after glow share a single\r\n   animated gradient position — guaranteeing perfect color sync. */\r\n#voice-satellite-ui .vs-rainbow-bar.reactive {\r\n  transition: transform 0.05s linear;\r\n  transform-origin: bottom;\r\n  transform: scaleY(calc(1 + 3 * var(--vs-audio-level, 0)));\r\n  overflow: visible;\r\n  background-position: var(--vs-gp) 50%;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive::after {\r\n  content: '';\r\n  position: absolute;\r\n  inset: 0;\r\n  background: linear-gradient(90deg, #4285F4, #4285F4 25%, #EA4335 25%, #EA4335 50%, #FBBC05 50%, #FBBC05 75%, #34A853 75%, #34A853);\r\n  background-size: 200% 100%;\r\n  background-position: var(--vs-gp) 50%;\r\n  border-radius: 50%;\r\n  filter: blur(calc(6px + 12px * var(--vs-audio-level, 0)));\r\n  opacity: calc(var(--vs-audio-level, 0) * 2.5);\r\n  transform: scale(1.15, 2);\r\n  z-index: -1;\r\n  pointer-events: none;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.listening {\r\n  animation: google-flow-sync 3s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.processing {\r\n  animation: google-flow-sync 0.5s linear infinite;\r\n}\r\n\r\n#voice-satellite-ui .vs-rainbow-bar.reactive.speaking {\r\n  animation: google-flow-sync 2s linear infinite;\r\n}\r\n\r\n@keyframes google-breathe {\r\n  0%, 100% {\r\n    opacity: 0.3;\r\n  }\r\n  50% {\r\n    opacity: 0.7;\r\n  }\r\n}\r\n\r\n@keyframes google-flow {\r\n  0% {\r\n    background-position: 0% 50%;\r\n  }\r\n  100% {\r\n    background-position: 200% 50%;\r\n  }\r\n}\r\n\r\n@keyframes google-flow-sync {\r\n  0%   { --vs-gp: 0%; }\r\n  100% { --vs-gp: 200%; }\r\n}\r\n\r\n@keyframes google-error-flash {\r\n  0%, 100% { opacity: 1; }\r\n  50% { opacity: 0.3; }\r\n}\r\n\r\n/* Chat Container — left-aligned, Nest Hub style */\r\n#voice-satellite-ui .vs-chat-container {\r\n  position: fixed;\r\n  left: 50%;\r\n  transform: translateX(-50%);\r\n  bottom: 72px;\r\n  display: none;\r\n  flex-direction: column;\r\n  align-items: flex-start;\r\n  gap: 8px;\r\n  max-width: 85%;\r\n  width: 85%;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  overflow: visible;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.visible {\r\n  display: flex;\r\n  pointer-events: auto;\r\n}\r\n\r\n#voice-satellite-ui.reactive-mode .vs-chat-container {\r\n  bottom: 120px;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-container.announcement-mode {\r\n  top: 50% !important;\r\n  bottom: auto !important;\r\n  transform: translate(-50%, -50%);\r\n}\r\n\r\n/* Chat Messages — left-aligned text, no bubbles (Nest Hub style) */\r\n#voice-satellite-ui .vs-chat-msg {\r\n  max-width: 85%;\r\n  opacity: 0;\r\n  animation: google-fade-in 0.3s ease forwards;\r\n  word-wrap: break-word;\r\n  background: none;\r\n  border: none;\r\n  box-shadow: none;\r\n  padding: 4px 0;\r\n  border-radius: 0;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.user {\r\n  font-size: calc(32px * var(--vs-text-scale, 1));\r\n  color: rgba(32, 33, 36, 0.5);\r\n  font-weight: normal;\r\n  font-style: normal;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.assistant {\r\n  font-size: calc(36px * var(--vs-text-scale, 1));\r\n  color: #202124;\r\n  font-weight: 400;\r\n  font-style: normal;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n\r\n#voice-satellite-ui .vs-chat-msg.announcement {\r\n  font-size: calc(36px * var(--vs-text-scale, 1));\r\n  color: #202124;\r\n  font-weight: 400;\r\n  font-style: normal;\r\n  align-self: flex-start;\r\n  text-align: left;\r\n}\r\n\r\n/* Animations */\r\n@keyframes google-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n/* Timer Container */\r\n.vs-timer-container {\r\n  position: fixed;\r\n  top: 12px;\r\n  right: 12px;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 8px;\r\n  z-index: 10001;\r\n  pointer-events: none;\r\n  font-family: \"Google Sans\", Roboto, Noto, sans-serif;\r\n}\r\n\r\n/* Timer Pills — white material cards with Google Blue progress */\r\n.vs-timer-pill {\r\n  position: relative;\r\n  overflow: hidden;\r\n  font-size: calc(28px * var(--vs-text-scale, 1));\r\n  color: #3c4043;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: none;\r\n  padding: 14px 18px;\r\n  border-radius: 18px;\r\n  box-shadow: 0 1px 3px rgba(60, 64, 67, 0.15), 0 4px 8px rgba(60, 64, 67, 0.1);\r\n  animation: google-timer-fade-in 0.3s ease forwards;\r\n  pointer-events: auto;\r\n  cursor: default;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-progress {\r\n  position: absolute;\r\n  top: 0;\r\n  left: 0;\r\n  height: 100%;\r\n  background: rgba(66, 133, 244, 0.15);\r\n  opacity: 1;\r\n  transition: width 1s linear;\r\n  pointer-events: none;\r\n}\r\n\r\n.vs-timer-content {\r\n  position: relative;\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 8px;\r\n}\r\n\r\n.vs-timer-icon {\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-time {\r\n  font-variant-numeric: tabular-nums;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.vs-timer-pill.vs-timer-expired {\r\n  animation: google-timer-fade-out 0.4s ease forwards;\r\n}\r\n\r\n/* Timer Finished Alert — white card with Google Blue accent */\r\n.vs-timer-alert {\r\n  position: fixed;\r\n  top: 50%;\r\n  left: 50%;\r\n  transform: translate(-50%, -50%);\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 12px;\r\n  font-size: calc(28px * var(--vs-text-scale, 1));\r\n  font-family: \"Google Sans\", Roboto, Noto, sans-serif;\r\n  color: #202124;\r\n  font-weight: bold;\r\n  font-style: normal;\r\n  background: #ffffff;\r\n  border: none;\r\n  padding: 18px 24px;\r\n  border-radius: 18px;\r\n  box-shadow: 0 2px 6px rgba(60, 64, 67, 0.15), 0 8px 24px rgba(60, 64, 67, 0.15);\r\n  z-index: 10002;\r\n  animation: google-alert-pulse 1.5s ease-in-out infinite;\r\n  user-select: none;\r\n  -webkit-user-select: none;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-icon {\r\n  font-size: 1.5em;\r\n}\r\n\r\n.vs-timer-alert .vs-timer-time {\r\n  font-size: 1.2em;\r\n}\r\n\r\n@keyframes google-timer-fade-in {\r\n  0% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n  100% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n}\r\n\r\n@keyframes google-timer-fade-out {\r\n  0% {\r\n    opacity: 1;\r\n    transform: translateY(0);\r\n  }\r\n  100% {\r\n    opacity: 0;\r\n    transform: translateY(8px);\r\n  }\r\n}\r\n\r\n@keyframes google-alert-pulse {\r\n  0%, 100% {\r\n    transform: translate(-50%, -50%) scale(1);\r\n  }\r\n  50% {\r\n    transform: translate(-50%, -50%) scale(1.04);\r\n    box-shadow: 0 2px 6px rgba(60, 64, 67, 0.15), 0 12px 32px rgba(66, 133, 244, 0.2);\r\n  }\r\n}\r\n";

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Check if module exists (development only)
/******/ 		if (__webpack_modules__[moduleId] === undefined) {
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*!**********************!*\
  !*** ./src/index.js ***!
  \**********************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _constants_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./constants.js */ "./src/constants.js");
/* harmony import */ var _card__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./card */ "./src/card/index.js");
/**
 * Voice Satellite Card
 * Transform your browser into a voice satellite for Home Assistant Assist
 */



customElements.define('voice-satellite-card', _card__WEBPACK_IMPORTED_MODULE_1__.VoiceSatelliteCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'voice-satellite-card',
  name: 'Voice Satellite Card',
  description: 'Transform your browser into a voice satellite for Home Assistant Assist',
  preview: false,
  documentationURL: 'https://github.com/owner/voice-satellite-card'
});
console.info(`%c VOICE-SATELLITE-CARD %c v${_constants_js__WEBPACK_IMPORTED_MODULE_0__.VERSION} `, 'color: white; background: #03a9f4; font-weight: bold;', 'color: #03a9f4; background: white; font-weight: bold;');
})();

/******/ })()
;
//# sourceMappingURL=voice-satellite-card.js.map