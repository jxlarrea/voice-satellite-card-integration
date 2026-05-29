"""Select entities for Voice Satellite integration.

Pipeline select - choose which Assist pipeline to use.
VAD sensitivity select - configure finished speaking detection.

Pipeline and VAD subclass the framework's built-in select entities from
assist_pipeline so that the device is registered in pipeline_devices
and appears in the Voice Assistants device list.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
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

TTS_OUTPUT_BROWSER = "Browser"



async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up select entities from a config entry."""
    # Discover all three engine catalogs in one executor pass.
    def _discover_all() -> tuple[list[str], list[str], list[str]]:
        return (
            discover_microwakeword_models(),
            discover_openwakeword_models(),
            discover_vswakeword_models(),
        )

    mww_models, oww_models, vww_models = await hass.async_add_executor_job(_discover_all)
    _LOGGER.info(
        "Wake word model catalogs: %d microWakeWord, %d openWakeWord, %d vsWakeWord",
        len(mww_models),
        len(oww_models),
        len(vww_models),
    )

    detection_select = VoiceSatelliteWakeWordDetectionSelect(hass, entry)
    wake_word_2_select = VoiceSatelliteWakeWordModel2Select(
        hass, entry, mww_models, oww_models, vww_models, detection_select,
    )
    entities = [
        VoiceSatellitePipelineSelect(hass, entry),
        VoiceSatellitePipeline2Select(hass, entry, wake_word_2_select),
        VoiceSatelliteVadSensitivitySelect(hass, entry),
        VoiceSatelliteTTSOutputSelect(hass, entry),
        VoiceSatelliteSessionDurationSelect(hass, entry),
        detection_select,
        VoiceSatelliteWakeWordModelSelect(hass, entry, mww_models, oww_models, vww_models, detection_select),
        wake_word_2_select,
        VoiceSatelliteWakeWordSensitivitySelect(hass, entry, detection_select),
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
        """Return device info - same identifiers as the satellite entity."""
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
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }


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
        """Return device info - same identifiers as the satellite entity."""
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
        """Return available options - friendly names of media_player entities."""
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
        """Handle option selection - resolve friendly name to entity_id."""
        if option == TTS_OUTPUT_BROWSER:
            self._selected_entity_id = None
        else:
            _, name_to_eid = self._build_mapping()
            self._selected_entity_id = name_to_eid.get(option)
        self.async_write_ha_state()


SESSION_DURATION_DEFAULT = "persistent"

SESSION_DURATION_OPTIONS = [
    "persistent",
    "5_minutes",
    "10_minutes",
    "15_minutes",
    "30_minutes",
    "1_hour",
    "3_hours",
    "6_hours",
    "isolated",
]

SESSION_DURATION_SECONDS: dict[str, int | None] = {
    "persistent": None,
    "5_minutes": 300,
    "10_minutes": 600,
    "15_minutes": 900,
    "30_minutes": 1800,
    "1_hour": 3600,
    "3_hours": 10800,
    "6_hours": 21600,
    "isolated": 0,
}


class VoiceSatelliteSessionDurationSelect(SelectEntity, RestoreEntity):
    """Select entity for configuring session duration.

    Controls how long conversation context is retained between wake word
    activations. After the selected duration elapses without interaction,
    the next wake word activation starts a fresh conversation. Multi-turn
    exchanges within a single session always share context regardless of
    this setting. Default is "Persistent" (never expire).
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "session_duration"
    _attr_icon = "mdi:timer-sand"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the session duration select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_session_duration"
        self._selected_option: str = SESSION_DURATION_DEFAULT

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return available options."""
        return list(SESSION_DURATION_OPTIONS)

    @property
    def current_option(self) -> str | None:
        """Return the currently selected option."""
        return self._selected_option

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state and last_state.state in SESSION_DURATION_OPTIONS:
            self._selected_option = last_state.state

    async def async_select_option(self, option: str) -> None:
        """Handle option selection."""
        if option in SESSION_DURATION_OPTIONS:
            self._selected_option = option
            self.async_write_ha_state()


WAKE_WORD_DETECTION_HA = "Home Assistant"
# microWakeWord remains the default (smaller, faster).  openWakeWord is
# offered as a higher-end alternative for more capable browsers.
# vsWakeWord is a from-scratch CNN engine targeting wall-mounted tablets
# with off-axis far-field capture (the original training driver).
WAKE_WORD_DETECTION_LOCAL_MWW = "On Device (microWakeWord)"
WAKE_WORD_DETECTION_LOCAL_OWW = "On Device (openWakeWord)"
WAKE_WORD_DETECTION_LOCAL_VWW = "On Device (vsWakeWord)"
WAKE_WORD_DETECTION_DISABLED = "Disabled"
# Legacy value persisted by versions before the engine choice existed -
# silently migrated to the new microWakeWord label on entity restore.
_LEGACY_WAKE_WORD_DETECTION_LOCAL = "On Device"
WAKE_WORD_DETECTION_OPTIONS = [
    WAKE_WORD_DETECTION_LOCAL_MWW,
    WAKE_WORD_DETECTION_LOCAL_OWW,
    WAKE_WORD_DETECTION_LOCAL_VWW,
    WAKE_WORD_DETECTION_HA,
    WAKE_WORD_DETECTION_DISABLED,
]
# Modes where on-device inference runs in the browser - used by the
# *_select.available checks that depend on the detection_select.
_LOCAL_DETECTION_MODES = {
    WAKE_WORD_DETECTION_LOCAL_MWW,
    WAKE_WORD_DETECTION_LOCAL_OWW,
    WAKE_WORD_DETECTION_LOCAL_VWW,
}

# Common infrastructure models (not keyword models).
_COMMON_MODELS = {"stop"}
# openWakeWord ships melspec + embedding models alongside its classifiers
# in the same directory; they're shared infrastructure, not user-selectable
# wake words.
_OWW_RESERVED_MODELS = {"melspectrogram", "embedding_model"}
# vsWakeWord models are self-contained; no shared infrastructure files
# need to be excluded.  Reserved set is empty but kept here for parity
# with the OWW path in case future model variants ship support files.
_VWW_RESERVED_MODELS: set[str] = set()

# Built-in microWakeWord keyword models (TFLite filenames without extension).
_BUILTIN_MODELS = ["ok_nabu", "hey_jarvis", "alexa", "hey_mycroft", "hey_home_assistant", "hey_luna", "okay_computer"]


def discover_microwakeword_models() -> list[str]:
    """Scan models/ for microWakeWord TFLite keyword files.

    Excludes the openwakeword/ subdirectory (those are handled by
    discover_openwakeword_models) and infrastructure models like 'stop'.
    """
    models_dir = Path(__file__).parent / "models"
    if not models_dir.is_dir():
        return list(_BUILTIN_MODELS)

    options: list[str] = []
    for f in sorted(models_dir.glob("*.tflite")):
        # glob is non-recursive, so the openwakeword/ subdir is naturally
        # excluded - this guard is defensive against future refactors.
        if f.parent.name == "openwakeword":
            continue
        stem = f.stem
        if stem in _COMMON_MODELS:
            continue
        if stem not in options:
            options.append(stem)

    return options or list(_BUILTIN_MODELS)


def discover_openwakeword_models() -> list[str]:
    """Scan models/openwakeword/ for openWakeWord ONNX classifier files.

    Excludes the shared melspec + embedding models (they're loaded
    automatically alongside any classifier).  Returns an empty list if
    the openwakeword/ directory is missing or only contains infrastructure
    files; callers should treat empty as "OWW unavailable".
    """
    models_dir = Path(__file__).parent / "models" / "openwakeword"
    if not models_dir.is_dir():
        return []

    options: list[str] = []
    for f in sorted(models_dir.glob("*.onnx")):
        stem = f.stem
        if stem in _OWW_RESERVED_MODELS or stem in _COMMON_MODELS:
            continue
        if stem not in options:
            options.append(stem)

    return options


def discover_vswakeword_models() -> list[str]:
    """Scan models/vswakeword/ for vsWakeWord ONNX classifier files.

    Each VWW model is self-contained (one .onnx + companion .json
    manifest), so we don't filter shared-infrastructure stems the way
    discover_openwakeword_models does.  Returns an empty list if the
    vswakeword/ directory is missing; callers should treat empty as
    "VWW unavailable".
    """
    models_dir = Path(__file__).parent / "models" / "vswakeword"
    if not models_dir.is_dir():
        return []

    options: list[str] = []
    for f in sorted(models_dir.glob("*.onnx")):
        stem = f.stem
        if stem in _VWW_RESERVED_MODELS or stem in _COMMON_MODELS:
            continue
        if stem not in options:
            options.append(stem)

    return options


# Backwards-compat alias kept for any external caller that imported the
# old name.  Returns the microWakeWord list (the original behavior).
def discover_wake_word_models() -> list[str]:
    return discover_microwakeword_models()


class VoiceSatelliteWakeWordDetectionSelect(SelectEntity, RestoreEntity):
    """Select entity for choosing wake word detection mode.

    "Home Assistant" uses the server-side wake word add-on.
    "On Device" runs inference locally in the browser with the built-in
    wake-word runtime.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "wake_word_detection"
    _attr_icon = "mdi:account-voice"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the wake word detection select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_wake_word_detection"
        self._selected_option: str = WAKE_WORD_DETECTION_LOCAL_MWW
        self._dependents: list[SelectEntity] = []

    def register_dependent(self, entity: SelectEntity) -> None:
        """Register an entity that depends on this selection for availability."""
        self._dependents.append(entity)

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return available options."""
        return list(WAKE_WORD_DETECTION_OPTIONS)

    @property
    def current_option(self) -> str | None:
        """Return the currently selected option."""
        return self._selected_option

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            # Silent migration: "On Device" (legacy) → microWakeWord variant.
            if last_state.state == _LEGACY_WAKE_WORD_DETECTION_LOCAL:
                self._selected_option = WAKE_WORD_DETECTION_LOCAL_MWW
            elif last_state.state in WAKE_WORD_DETECTION_OPTIONS:
                self._selected_option = last_state.state
        # Always force a state write so the cached "On Device" attribute
        # from the previous run is overwritten with the migrated value.
        self.async_write_ha_state()
        # Refresh dependents only if they're already attached to hass.
        # During initial setup HA adds entities one at a time, so any
        # dependent registered here may not have its `hass` attribute
        # yet - those entities will write their own state when their
        # own async_added_to_hass runs.  Without this guard the whole
        # detection_select fails to load and shows up as "unavailable"
        # in the frontend.
        for dep in self._dependents:
            if dep.hass is not None:
                dep.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Handle option selection."""
        # Accept the legacy label too so user automations or scripts using
        # the old string keep working - silently route to the new label.
        if option == _LEGACY_WAKE_WORD_DETECTION_LOCAL:
            option = WAKE_WORD_DETECTION_LOCAL_MWW
        if option in WAKE_WORD_DETECTION_OPTIONS:
            self._selected_option = option
            self.async_write_ha_state()
            for dep in self._dependents:
                dep.async_write_ha_state()


class VoiceSatelliteWakeWordModelSelect(SelectEntity, RestoreEntity):
    """Select entity for choosing the primary (slot 1) on-device wake word model."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "wake_word_model"
    _attr_icon = "mdi:microphone-message"

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        mww_models: list[str],
        oww_models: list[str],
        vww_models: list[str],
        detection_select: VoiceSatelliteWakeWordDetectionSelect,
    ) -> None:
        """Initialize the slot 1 wake word model select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_wake_word_model"
        self._mww_models = mww_models
        self._oww_models = oww_models
        self._vww_models = vww_models
        # Track the user's last pick *per engine* so flipping the
        # detection mode doesn't drop their selection.  HA reports
        # current_option/options engine-specifically; without per-engine
        # state a name unique to one catalog (e.g. "hey_baby" in MWW)
        # would render as "unknown" the moment the user switched to OWW.
        self._selected_mww: str = mww_models[0] if mww_models else "ok_nabu"
        self._selected_oww: str = oww_models[0] if oww_models else ""
        self._selected_vww: str = vww_models[0] if vww_models else ""
        self._detection_select = detection_select
        detection_select.register_dependent(self)

    def _models_for_current_engine(self) -> list[str]:
        """Return the list appropriate for the active detection mode."""
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            return self._oww_models
        if mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            return self._vww_models
        # MWW (default) and any unknown / non-on-device mode falls back here.
        return self._mww_models

    def _selected_for_current_engine(self) -> str:
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            return self._selected_oww
        if mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            return self._selected_vww
        return self._selected_mww

    @property
    def available(self) -> bool:
        """Only available when wake word detection is on-device."""
        return self._detection_select.current_option in _LOCAL_DETECTION_MODES

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return options for the active engine (MWW or OWW)."""
        return list(self._models_for_current_engine())

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Surface both engine catalogs and per-engine selections.

        The panel tester reads `mww_models` / `oww_models` so it can
        offer an engine dropdown independent of the active detection
        mode.  The per-engine selections are also persisted via these
        attributes so async_added_to_hass can restore the right value
        on each side after a restart.
        """
        return {
            "mww_models": list(self._mww_models),
            "oww_models": list(self._oww_models),
            "vww_models": list(self._vww_models),
            "mww_selection": self._selected_mww,
            "oww_selection": self._selected_oww,
            "vww_selection": self._selected_vww,
        }

    @property
    def current_option(self) -> str | None:
        """Return the active-engine selection.  Falls back to the first
        catalog entry if the saved name isn't valid for this engine -
        keeps the entity from going to "unknown" when an MWW-only or
        OWW-only model name is the user's stored choice on the other
        engine."""
        models = self._models_for_current_engine()
        chosen = self._selected_for_current_engine()
        if chosen and chosen in models:
            return chosen
        return models[0] if models else None

    async def async_added_to_hass(self) -> None:
        """Restore per-engine selections on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            attrs = last_state.attributes or {}
            # Preferred: explicit per-engine attributes from the new schema.
            mww_attr = attrs.get("mww_selection")
            oww_attr = attrs.get("oww_selection")
            vww_attr = attrs.get("vww_selection")
            if mww_attr in self._mww_models:
                self._selected_mww = mww_attr
            if oww_attr in self._oww_models:
                self._selected_oww = oww_attr
            if vww_attr in self._vww_models:
                self._selected_vww = vww_attr
            # Migration: pre-multi-engine sessions only stored a bare state
            # value.  Route it to whichever catalog it matches.  If the
            # name happens to exist in multiple catalogs (e.g. "ok_nabu")
            # we let it land on every side so the user's choice carries
            # forward whichever engine they pick next.
            if last_state.state and last_state.state not in {"unknown", "unavailable"}:
                if not mww_attr and last_state.state in self._mww_models:
                    self._selected_mww = last_state.state
                if not oww_attr and last_state.state in self._oww_models:
                    self._selected_oww = last_state.state
                if not vww_attr and last_state.state in self._vww_models:
                    self._selected_vww = last_state.state
        # Defensive: if any side is empty/missing pick the first
        # available so current_option always returns a valid value.
        if self._selected_mww not in self._mww_models:
            self._selected_mww = self._mww_models[0] if self._mww_models else "ok_nabu"
        if self._oww_models and self._selected_oww not in self._oww_models:
            self._selected_oww = self._oww_models[0]
        if self._vww_models and self._selected_vww not in self._vww_models:
            self._selected_vww = self._vww_models[0]
        # Force a state write so the options attribute reflects the freshly
        # discovered model list - without this, HA's cached state from the
        # previous run can show stale/removed models in the frontend.
        self.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Handle option selection - routes to the active engine's slot."""
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            if option in self._oww_models:
                self._selected_oww = option
                self.async_write_ha_state()
            return
        if mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            if option in self._vww_models:
                self._selected_vww = option
                self.async_write_ha_state()
            return
        if option in self._mww_models:
            self._selected_mww = option
            self.async_write_ha_state()


WAKE_WORD_SENSITIVITY_OPTIONS = [
    "Slightly sensitive",
    "Moderately sensitive",
    "Very sensitive",
]


class VoiceSatelliteWakeWordSensitivitySelect(SelectEntity, RestoreEntity):
    """Select entity for on-device wake word detection sensitivity."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "wake_word_sensitivity"
    _attr_icon = "mdi:tune-variant"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, detection_select: VoiceSatelliteWakeWordDetectionSelect) -> None:
        """Initialize the wake word sensitivity select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_wake_word_sensitivity"
        self._selected_option: str = WAKE_WORD_SENSITIVITY_OPTIONS[1]  # Moderately sensitive
        self._detection_select = detection_select
        detection_select.register_dependent(self)

    @property
    def available(self) -> bool:
        """Only available when wake word detection is on-device."""
        return self._detection_select.current_option in _LOCAL_DETECTION_MODES

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return available options."""
        return list(WAKE_WORD_SENSITIVITY_OPTIONS)

    @property
    def current_option(self) -> str | None:
        """Return the currently selected option."""
        return self._selected_option

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state and last_state.state in WAKE_WORD_SENSITIVITY_OPTIONS:
            self._selected_option = last_state.state

    async def async_select_option(self, option: str) -> None:
        """Handle option selection."""
        if option in WAKE_WORD_SENSITIVITY_OPTIONS:
            self._selected_option = option
            self.async_write_ha_state()


WAKE_WORD_2_DISABLED = "Disabled"


class VoiceSatelliteWakeWordModel2Select(SelectEntity, RestoreEntity):
    """Select entity for the secondary (slot 2) on-device wake word model.

    Adds a "Disabled" option (the default) so users can opt out of the
    second wake word slot entirely. When this select is "Disabled" the
    paired Pipeline 2 select also reports unavailable.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "wake_word_model_2"
    _attr_icon = "mdi:microphone-message"

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        mww_models: list[str],
        oww_models: list[str],
        vww_models: list[str],
        detection_select: VoiceSatelliteWakeWordDetectionSelect,
    ) -> None:
        """Initialize the slot 2 wake word model select entity."""
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_wake_word_model_2"
        self._mww_models = mww_models
        self._oww_models = oww_models
        self._vww_models = vww_models
        # Per-engine selection - same reasoning as slot 1.  Defaults
        # to Disabled on each side since slot 2 is opt-in.
        self._selected_mww: str = WAKE_WORD_2_DISABLED
        self._selected_oww: str = WAKE_WORD_2_DISABLED
        self._selected_vww: str = WAKE_WORD_2_DISABLED
        self._detection_select = detection_select
        self._dependents: list[SelectEntity] = []
        detection_select.register_dependent(self)

    def register_dependent(self, entity: SelectEntity) -> None:
        """Register an entity that depends on this slot's state."""
        self._dependents.append(entity)

    def _models_for_current_engine(self) -> list[str]:
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            return self._oww_models
        if mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            return self._vww_models
        return self._mww_models

    def _selected_for_current_engine(self) -> str:
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            return self._selected_oww
        if mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            return self._selected_vww
        return self._selected_mww

    @property
    def available(self) -> bool:
        """Only available when wake word detection is on-device."""
        return self._detection_select.current_option in _LOCAL_DETECTION_MODES

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return available options (Disabled + models for the active engine)."""
        return [WAKE_WORD_2_DISABLED, *self._models_for_current_engine()]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Per-engine selections persisted across restarts so flipping
        engines doesn't lose either side's pick."""
        return {
            "mww_selection": self._selected_mww,
            "oww_selection": self._selected_oww,
            "vww_selection": self._selected_vww,
        }

    @property
    def current_option(self) -> str | None:
        """Return active-engine selection, falling back to Disabled if
        the stored name isn't a valid option for this engine."""
        chosen = self._selected_for_current_engine()
        if chosen == WAKE_WORD_2_DISABLED:
            return WAKE_WORD_2_DISABLED
        if chosen in self._models_for_current_engine():
            return chosen
        return WAKE_WORD_2_DISABLED

    @property
    def is_enabled(self) -> bool:
        """True when slot 2 (for the active engine) is configured to a real model."""
        return self.current_option != WAKE_WORD_2_DISABLED

    async def async_added_to_hass(self) -> None:
        """Restore per-engine selections on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            attrs = last_state.attributes or {}
            mww_attr = attrs.get("mww_selection")
            oww_attr = attrs.get("oww_selection")
            vww_attr = attrs.get("vww_selection")
            if mww_attr == WAKE_WORD_2_DISABLED or mww_attr in self._mww_models:
                self._selected_mww = mww_attr
            if oww_attr == WAKE_WORD_2_DISABLED or oww_attr in self._oww_models:
                self._selected_oww = oww_attr
            if vww_attr == WAKE_WORD_2_DISABLED or vww_attr in self._vww_models:
                self._selected_vww = vww_attr
            # Migration from the pre-multi-engine schema: bare state.
            state = last_state.state
            if state and state not in {"unknown", "unavailable"}:
                if not mww_attr:
                    if state == WAKE_WORD_2_DISABLED or state in self._mww_models:
                        self._selected_mww = state
                if not oww_attr:
                    if state == WAKE_WORD_2_DISABLED or state in self._oww_models:
                        self._selected_oww = state
                if not vww_attr:
                    if state == WAKE_WORD_2_DISABLED or state in self._vww_models:
                        self._selected_vww = state
        # Defensive: invalid → Disabled.
        if self._selected_mww != WAKE_WORD_2_DISABLED and self._selected_mww not in self._mww_models:
            self._selected_mww = WAKE_WORD_2_DISABLED
        if self._selected_oww != WAKE_WORD_2_DISABLED and self._selected_oww not in self._oww_models:
            self._selected_oww = WAKE_WORD_2_DISABLED
        if self._selected_vww != WAKE_WORD_2_DISABLED and self._selected_vww not in self._vww_models:
            self._selected_vww = WAKE_WORD_2_DISABLED
        self.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Handle option selection - routes to active engine's slot."""
        if option not in self.options:
            return
        mode = self._detection_select.current_option
        if mode == WAKE_WORD_DETECTION_LOCAL_OWW:
            self._selected_oww = option
        elif mode == WAKE_WORD_DETECTION_LOCAL_VWW:
            self._selected_vww = option
        else:
            self._selected_mww = option
        self.async_write_ha_state()
        # Refresh dependents (e.g. Pipeline 2 select) - these are added
        # after slot 2 in setup_entry so by the time the user can change
        # the option, all dependents have hass set.
        for dep in self._dependents:
            if dep.hass is not None:
                dep.async_write_ha_state()


PIPELINE_2_PREFERRED = "Preferred"


class VoiceSatellitePipeline2Select(SelectEntity, RestoreEntity):
    """Select entity for the pipeline routed to by slot 2 wake word detections.

    Holds a pipeline display name (matching the framework's pipeline select).
    Resolution to a pipeline_id happens at pipeline-start time in
    assist_satellite.py by looking up the name in assist_pipeline's registry.
    "Preferred" falls back to the slot 1 / device-default pipeline.
    """

    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True
    _attr_translation_key = "pipeline_2"
    _attr_icon = "mdi:assistant"

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        wake_word_2_select: VoiceSatelliteWakeWordModel2Select,
    ) -> None:
        """Initialize the slot 2 pipeline select entity."""
        self._hass = hass
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_pipeline_2"
        self._selected_option: str = PIPELINE_2_PREFERRED
        self._wake_word_2_select = wake_word_2_select
        # Pipeline 2 availability depends on both the slot 2 model choice
        # and the detection mode, so register with each so every relevant
        # change redraws us.
        wake_word_2_select.register_dependent(self)
        wake_word_2_select._detection_select.register_dependent(self)

    @property
    def available(self) -> bool:
        """Only available when slot 2 is usable.

        Requires both (a) the detection mode to be On Device (so the slot 2
        select itself is available) and (b) the slot 2 model to not be
        "Disabled".
        """
        return (
            self._wake_word_2_select.available
            and self._wake_word_2_select.is_enabled
        )

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info - same identifiers as the satellite entity."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
        }

    @property
    def options(self) -> list[str]:
        """Return available options (Preferred + pipeline names)."""
        names: list[str] = []
        try:
            from homeassistant.components.assist_pipeline import (
                async_get_pipelines,
            )
            for pipeline in async_get_pipelines(self._hass):
                if pipeline.name and pipeline.name not in names:
                    names.append(pipeline.name)
        except Exception:  # noqa: BLE001
            pass
        names.sort(key=str.casefold)
        return [PIPELINE_2_PREFERRED, *names]

    @property
    def current_option(self) -> str | None:
        """Return the currently selected option."""
        return self._selected_option

    def resolve_pipeline_id(self) -> str | None:
        """Resolve the selected pipeline name to a pipeline_id.

        Returns None when the selection is "Preferred" (caller should fall
        back to the device's slot 1 pipeline) or when the name cannot be
        matched to a known pipeline.
        """
        if self._selected_option == PIPELINE_2_PREFERRED:
            return None
        try:
            from homeassistant.components.assist_pipeline import (
                async_get_pipelines,
            )
            for pipeline in async_get_pipelines(self._hass):
                if pipeline.name == self._selected_option:
                    return pipeline.id
        except Exception:  # noqa: BLE001
            return None
        return None

    async def async_added_to_hass(self) -> None:
        """Restore previous selection on startup."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state and last_state.state and last_state.state not in (
            "unknown", "unavailable",
        ):
            self._selected_option = last_state.state
        # Force a state write so `options` reflects the current pipeline
        # list rather than a cached one from a prior run.
        self.async_write_ha_state()

    async def async_select_option(self, option: str) -> None:
        """Handle option selection."""
        if option in self.options:
            self._selected_option = option
            self.async_write_ha_state()
