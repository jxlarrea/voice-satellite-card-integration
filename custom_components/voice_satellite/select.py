"""Select entities for Voice Satellite Card integration.

Pipeline select  -  choose which Assist pipeline to use.
VAD sensitivity select  -  configure finished speaking detection.
Screensaver select  -  choose which entity to keep off during interactions.

Pipeline and VAD subclass the framework's built-in select entities from
assist_pipeline so that the device is registered in pipeline_devices
and appears in the Voice Assistants device list.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from homeassistant.components.assist_pipeline import (
    AssistPipelineSelect,
    VadSensitivitySelect,
)
from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SCREENSAVER_DISABLED = "Disabled"
TTS_OUTPUT_BROWSER = "Browser"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up select entities from a config entry."""
    entities = [
        VoiceSatellitePipelineSelect(hass, entry),
        VoiceSatelliteVadSensitivitySelect(hass, entry),
        VoiceSatelliteScreensaverSelect(hass, entry),
        VoiceSatelliteTTSOutputSelect(hass, entry),
    ]
    async_add_entities(entities)

    # Clean up stale select entities from older integration versions
    expected_uids = {e.unique_id for e in entities}
    registry = er.async_get(hass)
    for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
        if reg_entry.domain == "select" and reg_entry.unique_id not in expected_uids:
            _LOGGER.info("Removing stale entity: %s", reg_entry.entity_id)
            registry.async_remove(reg_entry.entity_id)


class VoiceSatellitePipelineSelect(AssistPipelineSelect):
    """Select entity for choosing the Assist pipeline."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:assistant"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the pipeline select entity."""
        super().__init__(hass, DOMAIN, entry.entry_id)
        self._entry = entry

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info  -  same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }


class VoiceSatelliteVadSensitivitySelect(VadSensitivitySelect):
    """Select entity for VAD (finished speaking detection) sensitivity."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:account-voice"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the VAD sensitivity select entity."""
        super().__init__(hass, entry.entry_id)
        self._entry = entry

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info  -  same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }


class VoiceSatelliteScreensaverSelect(SelectEntity, RestoreEntity):
    """Select entity for choosing a screensaver entity to keep off during interactions.

    Displays friendly names in the dropdown but stores the entity_id
    internally and exposes it via extra_state_attributes for service calls.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "screensaver"
    _attr_icon = "mdi:monitor-shimmer"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the screensaver select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_screensaver"
        self._selected_entity_id: str | None = None
        self._mapping_cache: tuple[dict[str, str], dict[str, str]] | None = None
        self._cache_time: float = 0

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info  -  same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    _CACHE_TTL = 30  # seconds

    def _build_mapping(self) -> tuple[dict[str, str], dict[str, str]]:
        """Build display-name <-> entity-id mappings (cached for 30s)."""
        now = time.monotonic()
        # Only cache after HA is fully started (entities still loading during startup)
        if (
            self._mapping_cache is not None
            and self.hass
            and self.hass.is_running
            and (now - self._cache_time) < self._CACHE_TTL
        ):
            return self._mapping_cache
        eid_to_name: dict[str, str] = {}
        name_to_eid: dict[str, str] = {}
        if self.hass:
            registry = er.async_get(self.hass)
            seen: set[str] = set()
            entries: list[tuple[str, str]] = []
            for domain in ("switch", "input_boolean"):
                for eid in self.hass.states.async_entity_ids(domain):
                    # Skip our own integration's entities
                    entry = registry.async_get(eid)
                    if entry and entry.platform == DOMAIN:
                        continue
                    state = self.hass.states.get(eid)
                    friendly = (
                        state.attributes.get("friendly_name", eid)
                        if state
                        else eid
                    )
                    # Prepend integration name for context
                    if entry:
                        label = entry.platform.replace("_", " ").title()
                        name = f"{label}: {friendly}"
                    else:
                        name = friendly
                    entries.append((eid, name))
            # Sort by display name, then deduplicate
            for eid, name in sorted(entries, key=lambda e: e[1].casefold()):
                if name in seen:
                    name = f"{name} ({eid})"
                seen.add(name)
                eid_to_name[eid] = name
                name_to_eid[name] = eid
        self._mapping_cache = (eid_to_name, name_to_eid)
        self._cache_time = now
        return self._mapping_cache

    @property
    def options(self) -> list[str]:
        """Return available options  -  friendly names of switch/input_boolean entities."""
        eid_to_name, _ = self._build_mapping()
        opts: list[str] = [SCREENSAVER_DISABLED]
        opts.extend(eid_to_name.values())
        # Ensure current selection is still in the list
        if self._selected_entity_id and self._selected_entity_id not in eid_to_name:
            opts.append(self._selected_entity_id)
        return opts

    @property
    def current_option(self) -> str | None:
        """Return the friendly name of the selected entity, or SCREENSAVER_DISABLED."""
        if not self._selected_entity_id:
            return SCREENSAVER_DISABLED
        eid_to_name, _ = self._build_mapping()
        return eid_to_name.get(self._selected_entity_id, self._selected_entity_id)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose the selected entity_id for service call lookups."""
        if self._selected_entity_id:
            return {"entity_id": self._selected_entity_id}
        return None

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state and last_state.state not in (
            "unknown", "unavailable", SCREENSAVER_DISABLED,
        ):
            # Restore from entity_id attribute (most reliable)
            entity_id = last_state.attributes.get("entity_id")
            if entity_id:
                self._selected_entity_id = entity_id

    async def async_select_option(self, option: str) -> None:
        """Handle option selection  -  resolve friendly name to entity_id."""
        if option == SCREENSAVER_DISABLED:
            self._selected_entity_id = None
        else:
            _, name_to_eid = self._build_mapping()
            self._selected_entity_id = name_to_eid.get(option)
        self.async_write_ha_state()


class VoiceSatelliteTTSOutputSelect(SelectEntity, RestoreEntity):
    """Select entity for choosing a media player for TTS output.

    Displays friendly names in the dropdown but stores the entity_id
    internally and exposes it via extra_state_attributes for the card.
    Default is "Browser" (card plays audio locally via Web Audio).
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "tts_output"
    _attr_icon = "mdi:speaker"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the TTS output select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_tts_output"
        self._selected_entity_id: str | None = None
        self._mapping_cache: tuple[dict[str, str], dict[str, str]] | None = None
        self._cache_time: float = 0

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info  -  same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    _CACHE_TTL = 30  # seconds

    def _build_mapping(self) -> tuple[dict[str, str], dict[str, str]]:
        """Build display-name <-> entity-id mappings (cached for 30s)."""
        now = time.monotonic()
        if (
            self._mapping_cache is not None
            and self.hass
            and self.hass.is_running
            and (now - self._cache_time) < self._CACHE_TTL
        ):
            return self._mapping_cache
        eid_to_name: dict[str, str] = {}
        name_to_eid: dict[str, str] = {}
        if self.hass:
            registry = er.async_get(self.hass)
            seen: set[str] = set()
            entries: list[tuple[str, str]] = []
            for eid in self.hass.states.async_entity_ids("media_player"):
                # Skip our own integration's media player entity
                entry = registry.async_get(eid)
                if entry and entry.platform == DOMAIN:
                    continue
                state = self.hass.states.get(eid)
                friendly = (
                    state.attributes.get("friendly_name", eid)
                    if state
                    else eid
                )
                if entry:
                    label = entry.platform.replace("_", " ").title()
                    name = f"{label}: {friendly}"
                else:
                    name = friendly
                entries.append((eid, name))
            for eid, name in sorted(entries, key=lambda e: e[1].casefold()):
                if name in seen:
                    name = f"{name} ({eid})"
                seen.add(name)
                eid_to_name[eid] = name
                name_to_eid[name] = eid
        self._mapping_cache = (eid_to_name, name_to_eid)
        self._cache_time = now
        return self._mapping_cache

    @property
    def options(self) -> list[str]:
        """Return available options  -  friendly names of media_player entities."""
        eid_to_name, _ = self._build_mapping()
        opts: list[str] = [TTS_OUTPUT_BROWSER]
        opts.extend(eid_to_name.values())
        if self._selected_entity_id and self._selected_entity_id not in eid_to_name:
            opts.append(self._selected_entity_id)
        return opts

    @property
    def current_option(self) -> str | None:
        """Return the friendly name of the selected entity, or Browser."""
        if not self._selected_entity_id:
            return TTS_OUTPUT_BROWSER
        eid_to_name, _ = self._build_mapping()
        return eid_to_name.get(self._selected_entity_id, self._selected_entity_id)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose the selected entity_id for the card to read."""
        if self._selected_entity_id:
            return {"entity_id": self._selected_entity_id}
        return None

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state and last_state.state not in (
            "unknown", "unavailable", TTS_OUTPUT_BROWSER,
        ):
            entity_id = last_state.attributes.get("entity_id")
            if entity_id:
                self._selected_entity_id = entity_id

    async def async_select_option(self, option: str) -> None:
        """Handle option selection  -  resolve friendly name to entity_id."""
        if option == TTS_OUTPUT_BROWSER:
            self._selected_entity_id = None
        else:
            _, name_to_eid = self._build_mapping()
            self._selected_entity_id = name_to_eid.get(option)
        self.async_write_ha_state()
