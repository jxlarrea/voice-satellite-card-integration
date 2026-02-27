/**
 * Voice Satellite Card  -  MediaPlayerManager
 *
 * Handles media_player commands pushed from the integration via the
 * satellite event subscription.  Plays audio in the browser, reports
 * state back via a WS command so the HA entity stays in sync.
 *
 * Also acts as the unified audio-state reporter: TTS, chimes, and
 * notification playback call notifyAudioStart/End so the HA
 * media_player entity reflects *all* audio output (matching Voice PE).
 */

import { buildMediaUrl, playMediaUrl } from '../audio/media-playback.js';

export class MediaPlayerManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    this._audio = null;
    this._playing = false;
    this._paused = false;
    this._volume = 1.0;
    this._muted = false;
    this._mediaId = null;
    this._volumeSynced = false;

    // Unified audio-state tracking (TTS, chimes, notifications)
    this._activeSources = new Set();
    this._idleDebounce = null;
  }

  get isPlaying() { return this._playing; }

  /**
   * Effective volume with perceptual curve (volume²).
   * Syncs from the HA entity on first access after page load.
   */
  get volume() {
    this._syncInitialVolume();
    return this._muted ? 0 : this._volume * this._volume;
  }

  // --- External audio tracking (TTS, chimes, notifications) ---

  /**
   * Notify that an audio source has started playing.
   * @param {string} source - e.g. 'tts', 'chime', 'notification'
   */
  notifyAudioStart(source) {
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    this._activeSources.add(source);
    this._reportState('playing');
  }

  /**
   * Notify that an audio source has stopped playing.
   * Reports idle (debounced) when no audio remains active.
   * @param {string} source
   */
  notifyAudioEnd(source) {
    this._activeSources.delete(source);
    if (this._activeSources.size === 0 && !this._playing && !this._paused) {
      if (this._idleDebounce) clearTimeout(this._idleDebounce);
      this._idleDebounce = setTimeout(() => {
        this._idleDebounce = null;
        if (this._activeSources.size === 0 && !this._playing && !this._paused) {
          this._reportState('idle');
        }
      }, 200);
    }
  }

  // --- Media player commands (from integration) ---

  /**
   * Handle a command from the integration (via satellite subscription).
   * @param {object} data - {command, ...fields}
   */
  handleCommand(data) {
    const { command } = data;
    this._log.log('media-player', `Command: ${command}`);

    switch (command) {
      case 'play':
        this._play(data);
        break;
      case 'pause':
        this._pause();
        break;
      case 'resume':
        this._resume();
        break;
      case 'stop':
        this._stop();
        break;
      case 'volume_set':
        this._setVolume(data.volume);
        break;
      case 'volume_mute':
        this._setMute(data.mute);
        break;
      default:
        this._log.log('media-player', `Unknown command: ${command}`);
    }
  }

  /**
   * Interrupt own playback (e.g. wake word barge-in, notification).
   * Does NOT affect external audio sources  -  they manage themselves.
   */
  interrupt() {
    if (!this._playing && !this._paused) return;
    this._log.log('media-player', 'Interrupted');
    this._cleanup();
    if (this._activeSources.size === 0) {
      this._reportState('idle');
    }
  }

  // --- Private ---

  /** Apply perceptual curve to raw volume (0-1). */
  _curved(raw) {
    return raw * raw;
  }

  /** Effective volume after mute + curve. */
  _effectiveVolume() {
    return this._muted ? 0 : this._curved(this._volume);
  }

  /**
   * Sync volume and mute state from the HA entity on first access.
   * Runs once per page load so the card picks up the entity's current state.
   */
  _syncInitialVolume() {
    if (this._volumeSynced) return;
    const entityId = this._getEntityId();
    if (!entityId) return;
    const state = this._card.hass?.states?.[entityId];
    if (!state) return;

    const vol = state.attributes?.volume_level;
    if (vol !== undefined && vol !== null) {
      this._volume = vol;
      this._log.log('media-player', `Synced initial volume from entity: ${vol}`);
    }
    const muted = state.attributes?.is_volume_muted;
    if (muted !== undefined) {
      this._muted = muted;
    }
    this._volumeSynced = true;
  }

  async _play(data) {
    // Stop any current playback
    this._cleanup();

    const { media_id, volume } = data;
    if (volume !== undefined && volume !== null) {
      this._volume = volume;
    }

    this._mediaId = media_id;

    // Sign relative URLs  -  HA media endpoints require authentication
    let url;
    if (media_id.startsWith('http://') || media_id.startsWith('https://')) {
      url = media_id;
    } else {
      const conn = this._card.connection;
      if (conn) {
        try {
          const result = await conn.sendMessagePromise({
            type: 'auth/sign_path',
            path: media_id,
            expires: 3600,
          });
          url = buildMediaUrl(result.path);
        } catch (e) {
          this._log.error('media-player', `Failed to sign URL: ${e}`);
          url = buildMediaUrl(media_id);
        }
      } else {
        url = buildMediaUrl(media_id);
      }
    }

    this._playing = true;
    this._paused = false;

    this._audio = playMediaUrl(url, this._effectiveVolume(), {
      onEnd: () => {
        this._log.log('media-player', 'Playback complete');
        this._playing = false;
        this._paused = false;
        this._audio = null;
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onError: (e) => {
        this._log.error('media-player', `Playback error: ${e}`);
        this._playing = false;
        this._paused = false;
        this._audio = null;
        if (this._activeSources.size === 0) {
          this._reportState('idle');
        }
      },
      onStart: () => {
        this._log.log('media-player', `Playing: ${media_id}`);
        this._reportState('playing');
      },
    });
  }

  _pause() {
    if (!this._audio || !this._playing) {
      this._reportState('idle');
      return;
    }
    this._audio.pause();
    this._playing = false;
    this._paused = true;
    this._reportState('paused');
  }

  _resume() {
    if (!this._audio || !this._paused) {
      this._reportState('idle');
      return;
    }
    this._audio.play().catch((e) => {
      this._log.error('media-player', `Resume failed: ${e}`);
      this._cleanup();
      this._reportState('idle');
    });
    this._playing = true;
    this._paused = false;
    this._reportState('playing');
  }

  _stop() {
    if (!this._audio) return;
    this._cleanup();
    if (this._activeSources.size === 0) {
      this._reportState('idle');
    }
  }

  _setVolume(volume) {
    this._volume = volume;
    const effective = this._effectiveVolume();
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
    const state = this._playing || this._activeSources.size > 0
      ? 'playing'
      : this._paused ? 'paused' : 'idle';
    this._reportState(state);
  }

  _setMute(mute) {
    this._muted = mute;
    const effective = this._effectiveVolume();
    if (this._audio) {
      this._audio.volume = effective;
    }
    this._applyVolumeToExternalAudio(effective);
  }

  /** Apply volume to any active TTS or notification Audio elements. */
  _applyVolumeToExternalAudio(vol) {
    const ttsAudio = this._card.tts?._currentAudio;
    if (ttsAudio) ttsAudio.volume = vol;

    // Notification managers share the same currentAudio pattern
    for (const mgr of [this._card.announcement, this._card.askQuestion, this._card.startConversation]) {
      if (mgr?.currentAudio) mgr.currentAudio.volume = vol;
    }
  }

  _cleanup() {
    if (this._idleDebounce) {
      clearTimeout(this._idleDebounce);
      this._idleDebounce = null;
    }
    if (this._audio) {
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
    this._playing = false;
    this._paused = false;
  }

  /**
   * Find the media_player entity ID for this satellite device.
   * Uses the same device lookup pattern as getSwitchState.
   */
  _getEntityId() {
    const hass = this._card.hass;
    const satelliteId = this._card.config.satellite_entity;
    if (!hass?.entities || !satelliteId) return null;

    const satellite = hass.entities[satelliteId];
    if (!satellite?.device_id) return null;

    for (const [eid, entry] of Object.entries(hass.entities)) {
      if (entry.device_id === satellite.device_id &&
          entry.platform === 'voice_satellite' &&
          eid.startsWith('media_player.')) {
        return eid;
      }
    }
    return null;
  }

  /**
   * Report playback state back to the integration via WS.
   */
  _reportState(state) {
    this._syncInitialVolume();
    const entityId = this._getEntityId();
    if (!entityId) {
      this._log.log('media-player', 'No media_player entity found  -  skipping state report');
      return;
    }

    const conn = this._card.connection;
    if (!conn) return;

    const msg = {
      type: 'voice_satellite/media_player_event',
      entity_id: entityId,
      state,
    };

    if (this._volumeSynced && this._volume !== undefined) {
      msg.volume = this._volume;
    }
    if (this._mediaId && state !== 'idle') {
      msg.media_id = this._mediaId;
    }

    conn.sendMessagePromise(msg).catch((err) => {
      this._log.error('media-player', `Failed to report state: ${JSON.stringify(err)}`);
    });
  }
}
