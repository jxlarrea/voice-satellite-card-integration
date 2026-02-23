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
export function buildMediaUrl(urlPath) {
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
export function playMediaUrl(url, volume, { onEnd, onError, onStart }) {
  const audio = new Audio();
  audio.volume = volume;

  audio.onended = () => {
    onEnd();
  };

  audio.onerror = (e) => {
    onError(e);
  };

  audio.src = url;
  audio.play().then(() => {
    onStart?.();
  }).catch((e) => {
    onError(e);
  });

  return audio;
}
