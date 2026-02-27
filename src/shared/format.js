/**
 * Voice Satellite Card  -  Formatting Utilities
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

/**
 * Format a price value with currency symbol.
 * Prices < $1 get up to 6 decimals; >= $1 get 2.
 * @param {number} value
 * @param {string} currency - ISO 4217 code (default 'USD')
 * @returns {string}
 */
export function formatPrice(value, currency = 'USD') {
  if (value == null) return '';
  const decimals = Math.abs(value) < 1 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format a large number with K/M/B/T suffix.
 * @param {number} value
 * @param {string} currency - ISO 4217 code
 * @returns {string}
 */
export function formatLargeNumber(value, currency = 'USD') {
  if (value == null) return '';
  const symbol = currency === 'USD' ? '$' : '';
  if (value >= 1e12) return `${symbol}${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${symbol}${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${symbol}${(value / 1e6).toFixed(2)}M`;
  return formatPrice(value, currency);
}

/**
 * Format price change with sign, currency, and optional percent.
 * @param {number} change
 * @param {number} percentChange
 * @param {string} currency
 * @returns {string}
 */
export function formatChange(change, percentChange, currency = 'USD') {
  if (change == null) return '';
  const sign = change >= 0 ? '+' : '-';
  const price = formatPrice(Math.abs(change), currency);
  const pct = percentChange != null ? ` (${sign}${Math.abs(percentChange).toFixed(2)}%)` : '';
  return `${sign}${price}${pct}`;
}
