/**
 * Voice Satellite Card - Audio Comms
 *
 * Binary PCM audio transmission via WebSocket.
 */

/**
 * Send binary PCM data via the HA WebSocket connection.
 * @param {object} card - Card instance (for connection access)
 * @param {Int16Array} pcmData - 16-bit PCM audio samples
 * @param {number} binaryHandlerId - Pipeline binary handler ID
 */
export function sendBinaryAudio(card, pcmData, binaryHandlerId) {
  const { connection } = card;
  if (!connection?.socket) return;
  if (connection.socket.readyState !== WebSocket.OPEN) return;

  const message = new Uint8Array(1 + pcmData.byteLength);
  message[0] = binaryHandlerId;
  message.set(new Uint8Array(pcmData.buffer), 1);
  connection.socket.send(message.buffer);
}
