"""Switch entities for Voice Satellite integration.

Wake sound switch - enable/disable the wake word chime.
Mute switch - mute/unmute the satellite microphone.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up switch entities from a config entry."""
    async_add_entities([
        VoiceSatelliteWakeSoundSwitch(entry),
        VoiceSatelliteMuteSwitch(entry),
        VoiceSatelliteNoiseGateSwitch(entry),
        VoiceSatelliteFreshConversationSwitch(entry),
        VoiceSatelliteScreensaverSwitch(entry),
    ])


class VoiceSatelliteWakeSoundSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for the wake word chime."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "wake_sound"
    _attr_icon = "mdi:bullhorn"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the wake sound switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_wake_sound"
        self._attr_is_on = True  # Default: wake sound enabled

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous state on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn on the wake sound."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn off the wake sound."""
        self._attr_is_on = False
        self.async_write_ha_state()


class VoiceSatelliteMuteSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for muting the satellite microphone."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "mute"
    _attr_icon = "mdi:microphone-off"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the mute switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_mute"
        self._attr_is_on = False  # Default: not muted

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous state on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Mute the satellite."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Unmute the satellite."""
        self._attr_is_on = False
        self.async_write_ha_state()


class VoiceSatelliteNoiseGateSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for the wake word noise gate.

    When enabled, wake word inference is paused during silence (based on
    RMS energy thresholds) and resumes when audio exceeds the wake level.
    This reduces false positives in quiet environments but may occasionally
    miss soft-spoken wake words.  Disabled by default.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "noise_gate"
    _attr_icon = "mdi:volume-off"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the noise gate switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_noise_gate"
        self._attr_is_on = False  # Default: noise gate disabled

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous state on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable the noise gate."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the noise gate."""
        self._attr_is_on = False
        self.async_write_ha_state()


class VoiceSatelliteFreshConversationSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for fresh conversation on wake word.

    When enabled, each new wake word activation starts a fresh conversation
    with no prior history. Multi-turn exchanges within the same session
    (while the overlay is open) still share context. The conversation ID
    is discarded when the overlay is dismissed.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "fresh_conversation"
    _attr_icon = "mdi:chat-remove"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the fresh conversation switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_fresh_conversation"
        self._attr_is_on = False  # Default: off (preserve conversation history)

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous state on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable fresh conversation on wake word."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable fresh conversation on wake word."""
        self._attr_is_on = False
        self.async_write_ha_state()


class VoiceSatelliteScreensaverSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for the built-in screensaver.

    When enabled, the browser overlay dims to a solid color after an
    idle timeout configured by the companion number entity.  The
    screensaver is dismissed on voice interaction or single tap.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "builtin_screensaver"
    _attr_icon = "mdi:sleep"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the screensaver switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_builtin_screensaver"
        self._attr_is_on = False  # Default: screensaver disabled

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous state on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable the screensaver."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the screensaver."""
        self._attr_is_on = False
        self.async_write_ha_state()
