/**
 * Chime Utility
 *
 * Plays pre-rendered sound files from /voice_satellite/sounds/.
 * Each chime is pre-cached as an Audio element on first use for
 * instant playback with no synthesis overhead.
 *
 * When TTS output is routed to a remote media player, chimes are
 * played on that device via media_player.play_media.
 */

import { buildMediaUrl } from './media-playback.js';

const SOUNDS_BASE = '/voice_satellite/sounds';

/** Chime definitions: URL path + duration in seconds */
export const CHIME_WAKE = { url: `${SOUNDS_BASE}/wake.mp3`, duration: 0.25 };
export const CHIME_DONE = { url: `${SOUNDS_BASE}/done.mp3`, duration: 0.25 };
export const CHIME_ERROR = { url: `${SOUNDS_BASE}/error.mp3`, duration: 0.15 };
export const CHIME_ALERT = { url: `${SOUNDS_BASE}/alert.mp3`, duration: 0.6 };
export const CHIME_ANNOUNCE_URL = `${SOUNDS_BASE}/announce.mp3`;

/** Cache of preloaded Audio elements keyed by URL */
const _audioCache = new Map();

/**
 * Get or create a cached Audio element for the given URL.
 * The element is preloaded on first access.
 */
function getCachedAudio(url) {
  const fullUrl = buildMediaUrl(url);
  let audio = _audioCache.get(fullUrl);
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.src = fullUrl;
    _audioCache.set(fullUrl, audio);
  }
  return audio;
}

/**
 * Preload the most latency-sensitive chime sounds (wake + done) so the
 * first play has zero fetch delay. Other chimes (error, alert, announce)
 * are rare or preceded by network calls and load lazily on first use.
 */
export function preloadChimes() {
  getCachedAudio(CHIME_WAKE.url);
  getCachedAudio(CHIME_DONE.url);
}

/**
 * Play a chime on a remote media player via media_player.play_media.
 * Fire-and-forget — errors are logged but don't block.
 */
function playChimeRemote(card, url, log) {
  const entityId = card.ttsTarget;
  if (!entityId || !card.hass) return;
  const fullUrl = buildMediaUrl(url);
  log?.log('chime', `Playing chime on remote: ${entityId}`);
  card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: fullUrl,
    media_content_type: 'music',
    announce: true,
  }).catch((e) => {
    log?.error('chime', `Remote chime failed: ${e?.message || e}`);
  });
}

/**
 * Play a chime sound file. Routes to the remote media player when
 * TTS output is configured.
 *
 * Reuses the cached Audio element directly (no cloneNode) to avoid
 * orphaned HTTP connections that exhaust the browser's connection pool.
 *
 * @param {object} card - Card/session instance
 * @param {object} chime - Chime definition with `url` and `duration`
 * @param {object} [log] - Logger instance
 */
export function playChime(card, chime, log) {
  try {
    if (card.ttsTarget) {
      playChimeRemote(card, chime.url, log);
      return;
    }
    const audio = getCachedAudio(chime.url);
    audio.currentTime = 0;
    audio.volume = card.mediaPlayer.volume;
    audio.play().catch((e) => {
      log?.error('chime', `Chime play error: ${e}`);
    });
  } catch (e) {
    log?.error('chime', `Chime error: ${e}`);
  }
}
