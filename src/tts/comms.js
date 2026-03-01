/**
 * TTS Comms
 *
 * Remote media player service calls for TTS playback.
 * Pure comms - no timer scheduling or manager state mutation.
 */

/**
 * Play TTS on a remote media player entity.
 * Uses media-source:// URIs when available so HA resolves/proxies the audio
 * (required for devices like Sonos that can't fetch self-signed HTTPS URLs).
 * @param {object} card - Card instance
 * @param {string} mediaId - media-source:// URI or full media URL
 * @returns {Promise<void>}
 */
export function playRemote(card, mediaId) {
  const entityId = card.ttsTarget;

  card.logger.log('tts', `Playing on remote: ${entityId} media: ${mediaId}`);

  return card.hass.callService('media_player', 'play_media', {
    entity_id: entityId,
    media_content_id: mediaId,
    media_content_type: 'music',
    announce: true,
  }).catch((e) => {
    card.logger.error('tts', `Remote play failed: ${e?.message || JSON.stringify(e)}`);
    throw e;
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
