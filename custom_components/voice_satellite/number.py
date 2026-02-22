"""Number entities for Voice Satellite Card integration.

Announcement display duration — how long to show announcement bubbles.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
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
    """Set up number entities from a config entry."""
    async_add_entities([
        VoiceSatelliteAnnouncementDurationNumber(entry),
    ])


class VoiceSatelliteAnnouncementDurationNumber(NumberEntity, RestoreEntity):
    """Number entity for announcement bubble display duration."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "announcement_display_duration"
    _attr_icon = "mdi:message-text-clock"
    _attr_native_min_value = 1
    _attr_native_max_value = 60
    _attr_native_step = 1
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_mode = NumberMode.SLIDER

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the announcement duration number."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_announcement_display_duration"
        self._attr_native_value = 5  # Default: 5 seconds

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info — same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    async def async_added_to_hass(self) -> None:
        """Restore previous value on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state is not None and last_state.state not in (
            "unknown", "unavailable",
        ):
            try:
                self._attr_native_value = int(float(last_state.state))
            except (ValueError, TypeError):
                pass

    async def async_set_native_value(self, value: float) -> None:
        """Set the announcement duration."""
        self._attr_native_value = int(value)
        self.async_write_ha_state()
