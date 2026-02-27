/**
 * Voice Satellite Card - Pipeline Comms
 *
 * WebSocket operations for the pipeline: run subscription
 * and reconnect handling.
 */

import { Timing } from '../constants.js';

/**
 * Subscribe to a pipeline run through the integration.
 * @param {object} connection - HA WebSocket connection
 * @param {string} entityId - Satellite entity ID
 * @param {object} runConfig - { start_stage, end_stage, sample_rate, conversation_id? }
 * @param {(message: object) => void} onMessage - Event callback
 * @returns {Promise<Function>} Unsubscribe function
 */
export async function subscribePipelineRun(connection, entityId, runConfig, onMessage) {
  return connection.subscribeMessage(onMessage, {
    type: 'voice_satellite/run_pipeline',
    entity_id: entityId,
    ...runConfig,
  });
}

/**
 * Set up the reconnection listener for the pipeline.
 * On HA reconnect: resets retry state and restarts immediately.
 * @param {object} card - Card instance
 * @param {object} pipeline - PipelineManager instance
 * @param {object} connection - HA WebSocket connection
 * @param {object} listenerRef - Object with .listener property for storing the handler
 */
export function setupReconnectListener(card, pipeline, connection, listenerRef) {
  if (listenerRef.listener) return;

  listenerRef.listener = () => {
    card.logger.log('pipeline', 'Connection reconnected - resetting retry state');
    pipeline.resetRetryState();
    card.ui.clearErrorBar();
    if (card.visibility.isPaused) {
      card.logger.log('pipeline', 'Tab is paused - deferring restart to resume');
      return;
    }
    setTimeout(() => pipeline.restart(0), Timing.RECONNECT_DELAY);
  };
  connection.addEventListener('ready', listenerRef.listener);
}
