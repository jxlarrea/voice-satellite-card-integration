/**
 * Voice Satellite Card — Timer Comms
 *
 * Service calls for timer cancellation.
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * Cancel a timer via the conversation.process service.
 * @param {object} card - Card instance
 * @param {string} [timerName] - Optional timer name for targeted cancel
 */
export function sendCancelTimer(card, timerName) {
  if (!card.hass || !card.config.satellite_entity) return;

  const cancelText = timerName ? `cancel the ${timerName}` : 'cancel the timer';

  card.hass.callService('conversation', 'process', {
    text: cancelText,
    agent_id: 'conversation.home_assistant',
  }).then(() => {
    card.logger.log('timer', 'Cancel service called successfully');
  }).catch((err) => {
    card.logger.error('timer', `Cancel service failed: ${err.message || JSON.stringify(err)}`);
  });
}
