"""Binary sensor entities for Voice Satellite integration.

Screensaver active - indicates whether the built-in screensaver overlay is
currently displayed on the browser.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensor entities from a config entry."""
    entity = VoiceSatelliteScreensaverActiveSensor(entry)
    async_add_entities([entity])
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][f"{entry.entry_id}_screensaver_sensor"] = entity


class VoiceSatelliteScreensaverActiveSensor(BinarySensorEntity):
    """Binary sensor indicating whether the screensaver overlay is active."""

    _attr_has_entity_name = True
    _attr_translation_key = "screensaver_active"
    _attr_icon = "mdi:sleep"

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the screensaver active sensor."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_screensaver_active"
        self._attr_is_on = False

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    def set_active(self, active: bool) -> None:
        """Update the screensaver active state."""
        if self._attr_is_on != active:
            self._attr_is_on = active
            self.async_write_ha_state()
