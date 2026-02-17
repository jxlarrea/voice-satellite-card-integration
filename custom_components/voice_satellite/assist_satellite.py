"""Assist Satellite entity for Voice Satellite Card.

Registers a virtual satellite device that gives browser-based voice
tablets a proper device identity in Home Assistant. This enables:
- Timer support (HassStartTimer exposed to LLM)
- Announcements (future)
- Per-device automations
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components import intent
from homeassistant.components.assist_satellite import (
    AssistSatelliteAnnouncement,
    AssistSatelliteConfiguration,
    AssistSatelliteEntity,
    AssistSatelliteEntityDescription,
    AssistSatelliteEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Voice Satellite entity from a config entry."""
    async_add_entities([VoiceSatelliteEntity(entry)])


class VoiceSatelliteEntity(AssistSatelliteEntity):
    """A virtual Assist Satellite representing a browser tablet."""

    _attr_has_entity_name = True
    _attr_name = None  # Use device name
    _attr_supported_features = AssistSatelliteEntityFeature.ANNOUNCE
    _attr_supported_features = AssistSatelliteEntityFeature.ANNOUNCE

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the satellite entity."""
        self._entry = entry
        self._satellite_name: str = entry.data["name"]

        # Unique ID based on config entry
        self._attr_unique_id = entry.entry_id

        # Active timers stored as extra state attributes for the card to read
        self._active_timers: list[dict[str, Any]] = []
        self._last_timer_event: str | None = None

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info to create a device registry entry."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
            "name": self._satellite_name,
            "manufacturer": "Voice Satellite Card",
            "model": "Browser Satellite",
            "sw_version": "1.0.0",
        }

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose timer state for the card to read."""
        return {
            "active_timers": self._active_timers,
            "last_timer_event": self._last_timer_event,
        }

    async def async_added_to_hass(self) -> None:
        """Register timer handler when entity is added."""
        await super().async_added_to_hass()

        assert self.device_entry is not None

        # Register this device as a timer handler — the key line that
        # tells HA this device supports timers, which:
        # 1. Removes "This device is not able to start timers" from LLM prompt
        # 2. Exposes HassStartTimer tool to the LLM
        # 3. Routes timer events to our _handle_timer_event callback
        self.async_on_remove(
            intent.async_register_timer_handler(
                self.hass,
                self.device_entry.id,
                self._handle_timer_event,
            )
        )

        _LOGGER.info(
            "Voice Satellite '%s' registered (device_id: %s)",
            self._satellite_name,
            self.device_entry.id,
        )

    @callback
    def async_get_configuration(self) -> AssistSatelliteConfiguration:
        """Return satellite configuration.

        Wake words are handled client-side by the card, so we return
        an empty configuration here.
        """
        return AssistSatelliteConfiguration(
            available_wake_words=[],
            active_wake_words=[],
            max_active_wake_words=0,
        )

    async def async_set_configuration(
        self, config: AssistSatelliteConfiguration
    ) -> None:
        """Set satellite configuration.

        No-op for browser satellites — wake words are managed
        client-side by the card.
        """

    async def async_announce(
        self, announcement: AssistSatelliteAnnouncement
    ) -> None:
        """Handle an announcement.

        Stores the announcement details as entity attributes so the
        card can pick them up and play the audio.
        """
        self._last_announcement = {
            "message": announcement.message,
            "media_id": announcement.media_id,
        }
        self.async_write_ha_state()
        _LOGGER.debug(
            "Announcement on '%s': %s",
            self._satellite_name,
            announcement.message or announcement.media_id,
        )

    @callback
    def on_pipeline_event(self, event_type: str, data: dict | None) -> None:
        """Handle pipeline events.

        The card processes pipeline events directly via WebSocket,
        so this is primarily for logging/debugging.
        """
        _LOGGER.debug(
            "Pipeline event for '%s': %s",
            self._satellite_name,
            event_type,
        )

    @callback
    def _handle_timer_event(
        self,
        event_type: intent.TimerEventType,
        timer_info: intent.TimerInfo,
    ) -> None:
        """Handle timer events from the intent system.

        Stores timer state as entity attributes that the Voice Satellite
        Card reads via hass.states to render countdown UI.
        """
        timer_id = timer_info.id
        self._last_timer_event = event_type.value

        if event_type == intent.TimerEventType.STARTED:
            h = timer_info.start_hours or 0
            m = timer_info.start_minutes or 0
            s = timer_info.start_seconds or 0
            total = h * 3600 + m * 60 + s
            self._active_timers.append(
                {
                    "id": timer_id,
                    "name": timer_info.name or "",
                    "total_seconds": total,
                    "start_hours": h,
                    "start_minutes": m,
                    "start_seconds": s,
                }
            )
            _LOGGER.debug(
                "Timer started on '%s': %s (%ds)",
                self._satellite_name,
                timer_info.name or timer_id,
                total,
            )

        elif event_type == intent.TimerEventType.UPDATED:
            for timer in self._active_timers:
                if timer["id"] == timer_id:
                    h = timer_info.start_hours or 0
                    m = timer_info.start_minutes or 0
                    s = timer_info.start_seconds or 0
                    timer["total_seconds"] = h * 3600 + m * 60 + s
                    timer["start_hours"] = h
                    timer["start_minutes"] = m
                    timer["start_seconds"] = s
                    break
            _LOGGER.debug(
                "Timer updated on '%s': %s",
                self._satellite_name,
                timer_info.name or timer_id,
            )

        elif event_type in (
            intent.TimerEventType.CANCELLED,
            intent.TimerEventType.FINISHED,
        ):
            self._active_timers = [
                t for t in self._active_timers if t["id"] != timer_id
            ]
            _LOGGER.debug(
                "Timer %s on '%s': %s",
                event_type.value,
                self._satellite_name,
                timer_info.name or timer_id,
            )

        # Push state update so the card sees the change immediately
        self.async_write_ha_state()