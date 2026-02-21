/**
 * Voice Satellite Card — Timer Comms
 *
 * Cancel timers via the integration's WS command.
 *
 * Uses ONLY public accessors on the card instance.
 */

/**
 * Cancel a timer via the voice_satellite/cancel_timer WS command.
 * @param {object} card - Card instance
 * @param {string} timerId - Timer ID to cancel
 */
export function sendCancelTimer(card, timerId) {
  if (!card.connection || !card.config.satellite_entity || !timerId) return;

  card.connection.sendMessagePromise({
    type: 'voice_satellite/cancel_timer',
    entity_id: card.config.satellite_entity,
    timer_id: timerId,
  }).then(() => {
    card.logger.log('timer', `Cancel timer ${timerId} succeeded`);
  }).catch((err) => {
    card.logger.error('timer', `Cancel timer failed: ${err.message || JSON.stringify(err)}`);
  });
}
