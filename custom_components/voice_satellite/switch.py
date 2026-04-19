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

from homeassistant.helpers import entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Unique-ID suffixes of switch entities removed in past versions.
_STALE_SWITCH_SUFFIXES = {"_fresh_conversation", "_builtin_screensaver"}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up switch entities from a config entry."""
    entities = [
        VoiceSatelliteWakeSoundSwitch(entry),
        VoiceSatelliteMuteSwitch(entry),
        VoiceSatelliteNoiseGateSwitch(entry),
        VoiceSatelliteStopWordSwitch(entry),
    ]
    async_add_entities(entities)

    # Clean up stale switch entities from older integration versions
    registry = er.async_get(hass)
    for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
        if reg_entry.domain != "switch":
            continue
        for suffix in _STALE_SWITCH_SUFFIXES:
            if reg_entry.unique_id == f"{entry.entry_id}{suffix}":
                _LOGGER.info("Removing stale entity: %s", reg_entry.entity_id)
                registry.async_remove(reg_entry.entity_id)


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


class VoiceSatelliteStopWordSwitch(SwitchEntity, RestoreEntity):
    """Switch entity for opt-in stop word interruption."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "stop_word"
    _attr_icon = "mdi:stop-circle-outline"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the stop word switch."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_stop_word"
        self._attr_is_on = False  # Default: disabled to avoid extra CPU/memory use

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
        """Enable the stop word model for interruptible playback."""
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the stop word model for interruptible playback."""
        self._attr_is_on = False
        self.async_write_ha_state()


