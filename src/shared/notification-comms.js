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
export function sendAck(card, announceId, logPrefix) {
  const { connection, config } = card;
  if (!connection || !config.satellite_entity) {
    card.logger.error(logPrefix, 'Cannot ACK — no connection or entity');
    return;
  }

  connection.sendMessagePromise({
    type: 'voice_satellite/announce_finished',
    entity_id: config.satellite_entity,
    announce_id: announceId,
  }).then(() => {
    card.logger.log(logPrefix, `ACK sent for #${announceId}`);
  }).catch((err) => {
    card.logger.error(logPrefix, `ACK failed: ${err.message || JSON.stringify(err)}`);
  });
}
