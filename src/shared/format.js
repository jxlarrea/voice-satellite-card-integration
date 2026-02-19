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
export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}
