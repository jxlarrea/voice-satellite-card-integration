/**
 * Tool Name Humanization
 *
 * Converts raw HA tool names into user-friendly display text.
 *
 * Examples:
 *   "voice-satellite-card-weather-forecast__get_weather_forecast" -> "Get weather forecast"
 *   "HassTurnOn"                                                  -> "Turn on"
 *   "search_images"                                               -> "Search images"
 */

/**
 * @param {string} rawName - Raw tool name from the pipeline
 * @returns {string|null} Human-readable name, or null if input is falsy
 */
export function humanizeToolName(rawName) {
  if (!rawName) return null;

  // Strip integration prefix (everything before __)
  let name = rawName.includes('__') ? rawName.split('__').pop() : rawName;

  // Handle HA built-in intents (HassTurnOn, HassGetState, etc.)
  const hassMatch = name.match(/^Hass([A-Z][a-zA-Z]+)$/);
  if (hassMatch) {
    const words = hassMatch[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // snake_case to words, capitalize first letter
  name = name.replace(/_/g, ' ').trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
