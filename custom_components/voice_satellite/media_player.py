"""Media Player entity for Voice Satellite Card.

Exposes a media_player entity on the satellite device so HA can target
browser tablets with tts.speak, media_player.play_media, and
media_player.media_announce service calls.

Commands are pushed to the card via the satellite event subscription.
The card reports playback state back via a WS command, and the entity
updates HA state accordingly.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.media_player import (
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
)
from homeassistant.components.media_source import (
    async_browse_media as ms_browse,
    async_resolve_media,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import ExtraStoredData, RestoreEntity

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


class MediaPlayerExtraData(ExtraStoredData):
    """Extra stored data for persisting volume across reboots."""

    def __init__(self, volume_level: float, is_volume_muted: bool) -> None:
        """Initialize extra data."""
        self.volume_level = volume_level
        self.is_volume_muted = is_volume_muted

    def as_dict(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "volume_level": self.volume_level,
            "is_volume_muted": self.is_volume_muted,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MediaPlayerExtraData:
        """Deserialize from dict."""
        return cls(
            volume_level=data.get("volume_level", 1.0),
            is_volume_muted=data.get("is_volume_muted", False),
        )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the media player entity from a config entry."""
    entity = VoiceSatelliteMediaPlayer(entry)
    async_add_entities([entity])

    # Store for WS handler lookup
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][f"{entry.entry_id}_media_player"] = entity


class VoiceSatelliteMediaPlayer(MediaPlayerEntity, RestoreEntity):
    """A media player representing a browser satellite's audio output."""

    _attr_has_entity_name = True
    _attr_translation_key = "media_player"
    _attr_supported_features = (
        MediaPlayerEntityFeature.PLAY_MEDIA
        | MediaPlayerEntityFeature.MEDIA_ANNOUNCE
        | MediaPlayerEntityFeature.BROWSE_MEDIA
        | MediaPlayerEntityFeature.PLAY
        | MediaPlayerEntityFeature.PAUSE
        | MediaPlayerEntityFeature.STOP
        | MediaPlayerEntityFeature.VOLUME_SET
        | MediaPlayerEntityFeature.VOLUME_MUTE
    )

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the media player entity."""
        self._entry = entry
        self._satellite_name: str = entry.data["name"]
        self._attr_unique_id = f"{entry.entry_id}_media_player"

        self._attr_state = MediaPlayerState.IDLE
        self._attr_volume_level = 1.0
        self._attr_is_volume_muted = False
        self._attr_media_content_id: str | None = None
        self._attr_media_content_type: str | None = None

    @property
    def extra_restore_state_data(self) -> MediaPlayerExtraData:
        """Return extra data to persist across reboots."""
        return MediaPlayerExtraData(
            self._attr_volume_level,
            self._attr_is_volume_muted,
        )

    async def async_added_to_hass(self) -> None:
        """Restore volume and mute state on startup."""
        await super().async_added_to_hass()
        extra_data = await self.async_get_last_extra_data()
        if extra_data:
            data = MediaPlayerExtraData.from_dict(extra_data.as_dict())
            self._attr_volume_level = data.volume_level
            self._attr_is_volume_muted = data.is_volume_muted

    @property
    def available(self) -> bool:
        """Available when the satellite has an active card connection."""
        satellite = self._get_satellite_entity()
        if satellite is None:
            return False
        return satellite.available

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info — same device as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    def _get_satellite_entity(self):
        """Lazy-lookup the satellite entity for pushing events."""
        return self.hass.data.get(DOMAIN, {}).get(self._entry.entry_id)

    def _push_command(self, command: str, **kwargs: Any) -> None:
        """Push a media_player command to the card via satellite subscription."""
        satellite = self._get_satellite_entity()
        if satellite is None:
            _LOGGER.warning(
                "Cannot push media_player command — satellite entity not found for '%s'",
                self._satellite_name,
            )
            return

        payload = {"command": command, **kwargs}
        satellite._push_satellite_event("media_player", payload)
        _LOGGER.debug(
            "Media player command pushed for '%s': %s",
            self._satellite_name,
            payload,
        )

    async def async_browse_media(
        self,
        media_content_type: MediaType | str | None = None,
        media_content_id: str | None = None,
    ):
        """Delegate media browsing to media_source, filtered to audio only."""
        return await ms_browse(
            self.hass,
            media_content_id,
            content_filter=lambda item: item.media_content_type.startswith("audio/"),
        )

    async def async_play_media(
        self,
        media_type: MediaType | str,
        media_id: str,
        **kwargs: Any,
    ) -> None:
        """Play media on the browser satellite."""
        # Resolve media-source:// URIs to actual playable URLs
        if media_id.startswith("media-source://"):
            result = await async_resolve_media(
                self.hass, media_id, self.entity_id
            )
            media_id = result.url
            media_type = result.mime_type

        announce = kwargs.get("announce")
        self._push_command(
            "play",
            media_id=media_id,
            media_type=str(media_type),
            announce=announce,
            volume=self._attr_volume_level,
        )

        # Optimistic state update
        self._attr_state = MediaPlayerState.PLAYING
        self._attr_media_content_id = media_id
        self._attr_media_content_type = str(media_type)
        self.async_write_ha_state()

    async def async_media_pause(self) -> None:
        """Pause playback."""
        self._push_command("pause")
        self._attr_state = MediaPlayerState.PAUSED
        self.async_write_ha_state()

    async def async_media_play(self) -> None:
        """Resume playback."""
        self._push_command("resume")
        self._attr_state = MediaPlayerState.PLAYING
        self.async_write_ha_state()

    async def async_media_stop(self) -> None:
        """Stop playback."""
        self._push_command("stop")
        self._attr_state = MediaPlayerState.IDLE
        self._attr_media_content_id = None
        self._attr_media_content_type = None
        self.async_write_ha_state()

    async def async_set_volume_level(self, volume: float) -> None:
        """Set volume level (0–1)."""
        self._push_command("volume_set", volume=volume)
        self._attr_volume_level = volume
        self.async_write_ha_state()

    async def async_mute_volume(self, mute: bool) -> None:
        """Mute or unmute."""
        self._push_command("volume_mute", mute=mute)
        self._attr_is_volume_muted = mute
        self.async_write_ha_state()

    @callback
    def update_playback_state(
        self,
        state: str,
        volume: float | None = None,
        media_id: str | None = None,
    ) -> None:
        """Update state from card's WS report."""
        state_map = {
            "playing": MediaPlayerState.PLAYING,
            "paused": MediaPlayerState.PAUSED,
            "idle": MediaPlayerState.IDLE,
        }
        mapped = state_map.get(state)
        if mapped is not None:
            self._attr_state = mapped

        if volume is not None:
            self._attr_volume_level = volume

        if media_id is not None:
            self._attr_media_content_id = media_id
        elif mapped == MediaPlayerState.IDLE:
            self._attr_media_content_id = None
            self._attr_media_content_type = None

        self.async_write_ha_state()
        _LOGGER.debug(
            "Media player state updated for '%s': %s",
            self._satellite_name,
            state,
        )
