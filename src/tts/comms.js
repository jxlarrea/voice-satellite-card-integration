/**
 * TTS Comms
 *
 * Remote media player service calls for TTS playback.
 * Pure comms - no timer scheduling or manager state mutation.
 */

/**
 * Play TTS on a remote media player entity.
 * @param {object} card - Card instance
 * @param {string} url - Full media URL
 * @returns {Promise<void>}
 */
export function playRemote(card, url) {
  const entityId = card.ttsTarget;

  card.logger.log('tts', `Playing on remote: ${entityId} URL: ${url}`);

  return card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: url,
    media_content_type: 'music',
  }).catch((e) => {
    card.logger.error('tts', `Remote play failed: ${e}`);
  });
}

/**
 * Stop playback on a remote media player entity.
 * @param {object} card - Card instance
 */
export function stopRemote(card) {
  if (!card.ttsTarget || !card.hass) return;

  card.hass.callService('media_player', 'media_stop', {
    entity_id: card.ttsTarget,
  }).catch((e) => {
    card.logger.error('tts', `Remote stop failed: ${e}`);
  });
}
