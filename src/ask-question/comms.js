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
export function sendAnswer(card, announceId, sentence, logPrefix) {
  const { connection, config } = card;
  const log = card.logger;

  if (!connection || !config.satellite_entity) {
    log.error(logPrefix, 'Cannot send answer — no connection or entity');
    return Promise.resolve(null);
  }

  const payload = {
    type: 'voice_satellite/question_answered',
    entity_id: config.satellite_entity,
    announce_id: announceId,
    sentence: sentence || '',
  };

  return connection.sendMessagePromise(payload).then((result) => {
    const matched = result?.matched;
    const matchId = result?.id;
    log.log(logPrefix, `Answer sent for #${announceId}: "${sentence}" — matched: ${matched}${matchId ? ` (id: ${matchId})` : ''}`);
    return result;
  }).catch((err) => {
    log.error(logPrefix, `Answer failed: ${err.message || JSON.stringify(err)}`);
    return null;
  });
}