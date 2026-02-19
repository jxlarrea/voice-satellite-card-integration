/**
 * Voice Satellite Card — Pipeline Comms
 *
 * All WebSocket operations for the pipeline: device ID resolution,
 * pipeline listing, run subscription, and reconnect handling.
 *
 * Uses ONLY public accessors on the card instance.
 */

import { Timing } from '../constants.js';

/**
 * Resolve the device_id from the satellite entity for timer support.
 * @param {object} card - Card instance
 * @returns {Promise<string|null>}
 */
export async function resolveDeviceId(card) {
  const { config, connection } = card;
  if (!config.satellite_entity || !connection) return null;

  try {
    card.logger.log('pipeline', `Looking up entity registry for: ${config.satellite_entity}`);
    const entity = await connection.sendMessagePromise({
      type: 'config/entity_registry/get',
      entity_id: config.satellite_entity,
    });
    card.logger.log('pipeline', 'Entity registry response received');
    if (entity?.device_id) {
      card.logger.log('pipeline', `Resolved device_id: ${entity.device_id} from ${config.satellite_entity}`);
      return entity.device_id;
    }
    card.logger.log('pipeline', `Entity found but no device_id: ${JSON.stringify(entity)}`);
  } catch (e) {
    const msg = e?.message || JSON.stringify(e);
    card.logger.error('pipeline', `Failed to resolve device_id from ${config.satellite_entity}: ${msg}`);
  }
  return null;
}

/**
 * Fetch the list of available assist pipelines.
 * @param {object} connection - HA WebSocket connection
 * @returns {Promise<object>}
 */
export async function listPipelines(connection) {
  return connection.sendMessagePromise({
    type: 'assist_pipeline/pipeline/list',
  });
}

/**
 * Subscribe to a pipeline run and start receiving events.
 * @param {object} connection - HA WebSocket connection
 * @param {object} runConfig - Pipeline run configuration
 * @param {(message: object) => void} onMessage - Event callback
 * @returns {Promise<Function>} Unsubscribe function
 */
export async function subscribePipelineRun(connection, runConfig, onMessage) {
  return connection.subscribeMessage(onMessage, runConfig);
}

/**
 * Set up the reconnection listener for the pipeline.
 * On HA reconnect: resets retry state and restarts immediately.
 * @param {object} card - Card instance
 * @param {object} pipeline - PipelineManager instance
 * @param {object} connection - HA WebSocket connection
 * @param {Function} listenerRef - Object with .listener property for storing the handler
 */
export function setupReconnectListener(card, pipeline, connection, listenerRef) {
  if (listenerRef.listener) return;

  listenerRef.listener = () => {
    card.logger.log('pipeline', 'Connection reconnected — resetting retry state');
    pipeline.resetRetryState();
    card.ui.clearErrorBar();
    setTimeout(() => pipeline.restart(0), Timing.RECONNECT_DELAY);
  };
  connection.addEventListener('ready', listenerRef.listener);
}
