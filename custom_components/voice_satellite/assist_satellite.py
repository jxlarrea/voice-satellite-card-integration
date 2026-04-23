"""Assist Satellite entity for Voice Satellite.

Registers a virtual satellite device that gives browser-based voice
tablets a proper device identity in Home Assistant. This enables:
- Timer support (HassStartTimer exposed to LLM)
- Announcements (assist_satellite.announce)
- Start conversation (assist_satellite.start_conversation)
- Ask question (assist_satellite.ask_question)
- Per-device automations
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from homeassistant.components import intent
from homeassistant.components.assist_satellite import (
    AssistSatelliteAnnouncement,
    AssistSatelliteConfiguration,
    AssistSatelliteEntity,
    AssistSatelliteEntityFeature,
)
from homeassistant.components.assist_pipeline import PipelineStage
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

# Conditional import for ask_question support (HA 2025.7+)
try:
    from homeassistant.components.assist_satellite import AssistSatelliteAnswer
except ImportError:
    AssistSatelliteAnswer = None  # type: ignore[misc,assignment]

# Conditional import for hassil sentence matching
try:
    from hassil.recognize import recognize
    from hassil.intents import Intents

    HAS_HASSIL = True
except ImportError:
    HAS_HASSIL = False


from .const import DOMAIN, INTEGRATION_VERSION

_LOGGER = logging.getLogger(__name__)

# Timeout for waiting for the card to ACK announcement playback
ANNOUNCE_TIMEOUT = 120  # seconds


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Voice Satellite entity from a config entry."""
    entity = VoiceSatelliteEntity(entry)
    async_add_entities([entity])

    # Store entity reference so __init__.py websocket handler can access it
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entity


class VoiceSatelliteEntity(AssistSatelliteEntity):
    """A virtual Assist Satellite representing a browser tablet."""

    _attr_has_entity_name = True
    _attr_name = None  # Use device name
    _attr_supported_features = (
        AssistSatelliteEntityFeature.ANNOUNCE
        | AssistSatelliteEntityFeature.START_CONVERSATION
    )

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the satellite entity."""
        self._entry = entry
        self._satellite_name: str = entry.data["name"]

        # Unique ID based on config entry
        self._attr_unique_id = entry.entry_id

        # Active timers stored as extra state attributes for the card to read
        self._active_timers: list[dict[str, Any]] = []
        self._last_timer_event: str | None = None

        # Announcement state
        self._announce_event: asyncio.Event | None = None
        self._announce_id: int = 0

        # Ask question state
        self._question_event: asyncio.Event | None = None
        self._question_answer_text: str | None = None
        self._ask_question_pending: bool = False
        self._question_match_event: asyncio.Event | None = None
        self._question_match_result: dict | None = None

        # Preannounce state (captured from async_internal_announce)
        self._preannounce_pending: bool = True

        # Extra system prompt (captured from async_internal_start_conversation)
        self._pending_extra_system_prompt: str | None = None
        self._extra_system_prompt: str | None = None

        # Bridged pipeline state
        self._pipeline_connection: Any = None  # ActiveConnection for event relay
        self._pipeline_msg_id: int | None = None  # WS message ID for send_event
        self._pipeline_task: asyncio.Task | None = None  # Current pipeline task
        self._pipeline_audio_queue: asyncio.Queue | None = None
        self._pipeline_gen: int = 0  # Generation counter - filters orphaned events
        self._pipeline_run_started: bool = False  # Gate: block events until run-start
        self._conversation_id: str | None = None
        self._conversation_last_activity: float = 0.0  # monotonic timestamp

        # Satellite event subscription (Phase 2 - direct push to card)
        self._satellite_subscribers: list[tuple[Any, int]] = []

    @property
    def available(self) -> bool:
        """Entity is available only when a card is connected via subscribe_events.

        During HA shutdown, report as available so RestoreEntity saves
        state with full attributes (volume, timers, etc.) instead of
        an empty 'unavailable' state.
        """
        if self.hass.is_stopping:
            return True
        return len(self._satellite_subscribers) > 0

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info to create a device registry entry."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
            "name": self._satellite_name,
            "manufacturer": "Voice Satellite Integration",
            "model": "Browser Satellite",
            "sw_version": INTEGRATION_VERSION,
        }

    @property
    def pipeline_entity_id(self) -> str | None:
        """Entity ID of the pipeline select entity."""
        registry = er.async_get(self.hass)
        return registry.async_get_entity_id(
            "select", DOMAIN, f"{self._entry.entry_id}-pipeline"
        )

    @property
    def vad_sensitivity_entity_id(self) -> str | None:
        """Entity ID of the VAD sensitivity select entity."""
        registry = er.async_get(self.hass)
        return registry.async_get_entity_id(
            "select", DOMAIN, f"{self._entry.entry_id}-vad_sensitivity"
        )

    def _get_child_state(
        self, registry: er.EntityRegistry, platform: str, suffix: str
    ):
        """Look up a child entity state by platform and unique_id suffix."""
        eid = registry.async_get_entity_id(
            platform, DOMAIN, f"{self._entry.entry_id}{suffix}"
        )
        return self.hass.states.get(eid) if eid else None

    def _get_session_duration_seconds(self) -> int | None:
        """Return the configured session duration in seconds, or None for persistent."""
        from .select import SESSION_DURATION_SECONDS

        registry = er.async_get(self.hass)
        s = self._get_child_state(registry, "select", "_session_duration")
        if s is not None and s.state in SESSION_DURATION_SECONDS:
            return SESSION_DURATION_SECONDS[s.state]
        return None  # Default: persistent (never expire)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose timer and config state for the card to read."""
        attrs: dict[str, Any] = {
            "active_timers": self._active_timers,
            "last_timer_event": self._last_timer_event,
        }

        registry = er.async_get(self.hass)

        # Expose mute and wake sound switch states for the card
        s = self._get_child_state(registry, "switch", "_mute")
        if s is not None:
            attrs["muted"] = s.state == "on"

        s = self._get_child_state(registry, "switch", "_wake_sound")
        if s is not None:
            attrs["wake_sound"] = s.state == "on"

        s = self._get_child_state(registry, "switch", "_stop_word")
        if s is not None:
            attrs["stop_word"] = s.state == "on"

        # Expose TTS output select entity_id for the card
        s = self._get_child_state(registry, "select", "_tts_output")
        if s and s.state not in ("Browser", "unknown", "unavailable"):
            attrs["tts_target"] = s.attributes.get("entity_id", "")
        elif s:
            attrs["tts_target"] = ""

        # Expose announcement display duration for the card
        s = self._get_child_state(
            registry, "number", "_announcement_display_duration"
        )
        if s and s.state not in ("unknown", "unavailable"):
            try:
                attrs["announcement_display_duration"] = int(float(s.state))
            except (ValueError, TypeError):
                pass

        # Expose wake word detection mode and model for the card
        for suffix, attr_key in (
            ("_wake_word_detection", "wake_word_detection"),
            ("_wake_word_model", "wake_word_model"),
            ("_wake_word_sensitivity", "wake_word_sensitivity"),
        ):
            s = self._get_child_state(registry, "select", suffix)
            if s and s.state not in ("unknown", "unavailable"):
                attrs[attr_key] = s.state

        # Expose the active pipeline display name. The pipeline select is
        # owned by HA core's assist_satellite base class, so we read it
        # directly by its entity_id rather than via the registry suffix.
        pid = self.pipeline_entity_id
        if pid:
            s = self.hass.states.get(pid)
            if s and s.state not in ("unknown", "unavailable"):
                attrs["pipeline"] = s.state

        # Expose the server-side integration version. The client reads
        # this to detect stale bundles (browser cached an older version)
        # and surface an "update available" notice at runtime.
        attrs["integration_version"] = INTEGRATION_VERSION

        return attrs

    # --- Public accessors for __init__.py WebSocket handlers ---

    @property
    def satellite_name(self) -> str:
        """Return the satellite display name."""
        return self._satellite_name

    @property
    def question_match_event(self) -> asyncio.Event | None:
        """Return the ask_question match event (set when matching completes)."""
        return self._question_match_event

    @property
    def question_match_result(self) -> dict | None:
        """Return the ask_question match result."""
        return self._question_match_result

    @property
    def pipeline_audio_queue(self) -> asyncio.Queue | None:
        """Return the current pipeline audio queue."""
        return self._pipeline_audio_queue

    @property
    def pipeline_connection(self):
        """Return the current pipeline WebSocket connection."""
        return self._pipeline_connection

    @property
    def pipeline_msg_id(self) -> int | None:
        """Return the current pipeline WS message ID."""
        return self._pipeline_msg_id

    @property
    def pipeline_task(self) -> asyncio.Task | None:
        """Return the current pipeline background task."""
        return self._pipeline_task

    @pipeline_task.setter
    def pipeline_task(self, task: asyncio.Task | None) -> None:
        """Set the current pipeline background task."""
        self._pipeline_task = task

    async def async_added_to_hass(self) -> None:
        """Register timer handler when entity is added."""
        await super().async_added_to_hass()

        if self.device_entry is None:
            raise RuntimeError(
                f"device_entry must be set before async_added_to_hass ({self.entity_id})"
            )

        # Register this device as a timer handler
        self.async_on_remove(
            intent.async_register_timer_handler(
                self.hass,
                self.device_entry.id,
                self._handle_timer_event,
            )
        )

        # When sibling entities change, re-write our state so
        # extra_state_attributes are re-evaluated and the card sees updates.
        registry = er.async_get(self.hass)
        tracked_eids = []
        for suffix in ("_mute", "_wake_sound", "_stop_word"):
            eid = registry.async_get_entity_id(
                "switch", DOMAIN, f"{self._entry.entry_id}{suffix}"
            )
            if eid:
                tracked_eids.append(eid)
        tts_eid = registry.async_get_entity_id(
            "select", DOMAIN, f"{self._entry.entry_id}_tts_output"
        )
        if tts_eid:
            tracked_eids.append(tts_eid)
        ann_dur_eid = registry.async_get_entity_id(
            "number", DOMAIN,
            f"{self._entry.entry_id}_announcement_display_duration"
        )
        if ann_dur_eid:
            tracked_eids.append(ann_dur_eid)
        for suffix in ("_wake_word_detection", "_wake_word_model", "_wake_word_sensitivity"):
            eid = registry.async_get_entity_id(
                "select", DOMAIN, f"{self._entry.entry_id}{suffix}"
            )
            if eid:
                tracked_eids.append(eid)
        if tracked_eids:
            self.async_on_remove(
                async_track_state_change_event(
                    self.hass,
                    tracked_eids,
                    self._on_switch_state_change,
                )
            )

        _LOGGER.info(
            "Voice Satellite '%s' registered (device_id: %s)",
            self._satellite_name,
            self.device_entry.id,
        )

    async def async_will_remove_from_hass(self) -> None:
        """Clean up when entity is removed (e.g. integration reload)."""
        # Notify pipeline subscriber that the entity is being torn down
        if self._pipeline_connection and self._pipeline_msg_id:
            try:
                self._pipeline_connection.send_event(
                    self._pipeline_msg_id, {"type": "reload"}
                )
            except Exception:
                pass

        # Signal the audio stream to stop so internal HA pipeline tasks
        # (wake word, STT) unblock and exit naturally.  Wait for natural
        # exit first; only force-cancel as a last resort after timeout.
        if self._pipeline_audio_queue is not None:
            self._pipeline_audio_queue.put_nowait(b"")

        if self._pipeline_task and not self._pipeline_task.done():
            done, _ = await asyncio.wait(
                {self._pipeline_task}, timeout=5.0
            )
            if not done:
                self._pipeline_task.cancel()
                try:
                    await self._pipeline_task
                except (asyncio.CancelledError, Exception):
                    pass

        # Release any pending blocking events
        if self._announce_event is not None:
            self._announce_event.set()
        if self._question_event is not None:
            self._question_event.set()

        # Notify satellite subscribers that the entity is being torn down
        # so the card can re-subscribe after the integration reloads.
        for connection, msg_id in self._satellite_subscribers:
            try:
                connection.send_event(msg_id, {"type": "reload"})
            except Exception:
                pass
        self._satellite_subscribers.clear()

        await super().async_will_remove_from_hass()

    @callback
    def _on_switch_state_change(self, _event) -> None:
        """Re-write state when mute/wake_sound switches change."""
        self.async_write_ha_state()

    @callback
    def async_get_configuration(self) -> AssistSatelliteConfiguration:
        """Return satellite configuration."""
        return AssistSatelliteConfiguration(
            available_wake_words=[],
            active_wake_words=[],
            max_active_wake_words=0,
        )

    async def async_set_configuration(
        self, config: AssistSatelliteConfiguration
    ) -> None:
        """Set satellite configuration (no-op for browser satellites)."""

    async def async_internal_announce(
        self,
        message: str | None = None,
        media_id: str | None = None,
        preannounce: bool = True,
        preannounce_media_id: str | None = None,
    ) -> None:
        """Capture preannounce flag before delegating to base class.

        The base class resolves TTS and calls our async_announce(), but
        the preannounce boolean is consumed internally and not passed
        through to the AssistSatelliteAnnouncement object. We store it
        here so async_announce and async_start_conversation can include
        it in the entity attributes for the card.
        """
        self._preannounce_pending = preannounce
        await super().async_internal_announce(
            message=message,
            media_id=media_id,
            preannounce=preannounce,
            preannounce_media_id=preannounce_media_id,
        )

    async def async_announce(
        self, announcement: AssistSatelliteAnnouncement
    ) -> None:
        """Handle an announcement.

        Pushes the announcement directly to the card via the satellite
        event subscription, then blocks until the card ACKs playback
        via the voice_satellite/announce_finished WebSocket command.
        """
        self._announce_id += 1
        announce_id = self._announce_id

        announcement_data: dict[str, Any] = {
            "id": announce_id,
            "message": announcement.message or "",
            "media_id": announcement.media_id or "",
            "preannounce_media_id": (
                getattr(announcement, "preannounce_media_id", None) or ""
            ),
        }

        if not self._preannounce_pending:
            announcement_data["preannounce"] = False

        if self._ask_question_pending:
            announcement_data["ask_question"] = True

        self._announce_event = asyncio.Event()

        # Push directly to card via satellite subscription
        self._push_satellite_event("announcement", announcement_data)

        # Measure audio duration for remote media players (e.g. Sonos)
        # that don't provide reliable state transitions.
        # media_id can be a full URL or relative path — check with `in`.
        media_url = announcement.media_id or ""
        if media_url and "/api/tts_proxy/" in media_url:
            self.hass.async_create_task(
                self._send_tts_audio_duration(media_url)
            )

        _LOGGER.debug(
            "Announcement #%d on '%s': %s (media: %s)",
            announce_id,
            self._satellite_name,
            announcement.message or "(no message)",
            announcement.media_id or "(no media)",
        )

        try:
            await asyncio.wait_for(
                self._announce_event.wait(),
                timeout=ANNOUNCE_TIMEOUT,
            )
            _LOGGER.debug(
                "Announcement #%d on '%s' completed",
                announce_id,
                self._satellite_name,
            )
        except asyncio.TimeoutError:
            _LOGGER.warning(
                "Announcement #%d on '%s' timed out after %ds",
                announce_id,
                self._satellite_name,
                ANNOUNCE_TIMEOUT,
            )
        finally:
            self._announce_event = None
            self._preannounce_pending = True

    @callback
    def announce_finished(self, announce_id: int) -> None:
        """Called by the WebSocket handler when the card finishes playback."""
        if (
            self._announce_event is not None
            and self._announce_id == announce_id
        ):
            _LOGGER.debug(
                "Announcement #%d ACK received for '%s'",
                announce_id,
                self._satellite_name,
            )
            self._announce_event.set()
        else:
            _LOGGER.debug(
                "Ignoring stale announce ACK #%d (current: #%d) for '%s'",
                announce_id,
                self._announce_id,
                self._satellite_name,
            )

    async def async_internal_start_conversation(
        self,
        start_message: str | None = None,
        start_media_id: str | None = None,
        preannounce: bool = True,
        preannounce_media_id: str | None = None,
        extra_system_prompt: str | None = None,
    ) -> None:
        """Capture preannounce + extra_system_prompt before delegating to base class."""
        self._preannounce_pending = preannounce
        self._pending_extra_system_prompt = extra_system_prompt
        await super().async_internal_start_conversation(
            start_message=start_message,
            start_media_id=start_media_id,
            preannounce=preannounce,
            preannounce_media_id=preannounce_media_id,
            extra_system_prompt=extra_system_prompt,
        )

    async def async_start_conversation(
        self, announcement: AssistSatelliteAnnouncement
    ) -> None:
        """Handle a start_conversation request.

        Pushes a start_conversation event to the card. After playback,
        the card enters STT mode (skipping wake word) so the user can
        respond to the prompt.
        """
        self._announce_id += 1
        announce_id = self._announce_id

        announcement_data: dict[str, Any] = {
            "id": announce_id,
            "message": announcement.message or "",
            "media_id": announcement.media_id or "",
            "preannounce_media_id": (
                getattr(announcement, "preannounce_media_id", None) or ""
            ),
            "start_conversation": True,
        }

        if not self._preannounce_pending:
            announcement_data["preannounce"] = False

        if self._pending_extra_system_prompt:
            announcement_data["extra_system_prompt"] = (
                self._pending_extra_system_prompt
            )

        self._announce_event = asyncio.Event()

        # Push directly to card via satellite subscription
        self._push_satellite_event("start_conversation", announcement_data)

        # Measure audio duration for remote media players (e.g. Sonos)
        media_url = announcement.media_id or ""
        if media_url and "/api/tts_proxy/" in media_url:
            self.hass.async_create_task(
                self._send_tts_audio_duration(media_url)
            )

        _LOGGER.debug(
            "Start conversation #%d on '%s': %s (media: %s)",
            announce_id,
            self._satellite_name,
            announcement.message or "(no message)",
            announcement.media_id or "(no media)",
        )

        try:
            await asyncio.wait_for(
                self._announce_event.wait(),
                timeout=ANNOUNCE_TIMEOUT,
            )
            _LOGGER.debug(
                "Start conversation #%d announcement on '%s' completed",
                announce_id,
                self._satellite_name,
            )
            self._set_satellite_state("listening")
        except asyncio.TimeoutError:
            _LOGGER.warning(
                "Start conversation #%d on '%s' timed out after %ds",
                announce_id,
                self._satellite_name,
                ANNOUNCE_TIMEOUT,
            )
        finally:
            self._announce_event = None
            self._preannounce_pending = True
            self._pending_extra_system_prompt = None

    async def async_internal_ask_question(
        self,
        question: str | None = None,
        question_media_id: str | None = None,
        preannounce: bool = True,
        preannounce_media_id: str | None = None,
        answers: list[dict[str, Any]] | None = None,
    ) -> Any:
        """Handle an ask_question request (HA 2025.7+).

        Delegates TTS playback to async_announce (which gets resolved media
        from the base class), then enters STT-only mode on the card to
        capture the user's response. Matches against provided answers
        using hassil sentence templates.
        """
        if AssistSatelliteAnswer is None:
            raise NotImplementedError(
                "ask_question requires Home Assistant 2025.7 or later"
            )

        # Set the ask_question flag BEFORE calling async_internal_announce.
        # Our async_announce override will include this flag in the
        # announcement attributes so the card knows to enter STT mode
        # after playback.
        self._ask_question_pending = True
        self._question_event = asyncio.Event()
        self._question_answer_text = None
        self._question_match_event = asyncio.Event()
        self._question_match_result = None

        _LOGGER.debug(
            "Ask question on '%s': %s (answers: %d)",
            self._satellite_name,
            question or "(media only)",
            len(answers) if answers else 0,
        )

        # Phase 1: Use the base class announce flow for TTS resolution
        # and playback. The base class will resolve text->media_id and
        # call our async_announce() which includes the ask_question flag.
        try:
            await self.async_internal_announce(
                message=question,
                media_id=question_media_id,
                preannounce=preannounce,
                preannounce_media_id=preannounce_media_id,
            )
        except Exception:
            _LOGGER.warning(
                "Ask question TTS/announce failed on '%s'",
                self._satellite_name,
                exc_info=True,
            )
            self._ask_question_pending = False
            self._question_event = None
            self._question_answer_text = None
            self._question_match_result = {"matched": False, "id": None}
            self._question_match_event.set()
            return None

        # Phase 1 complete - card has ACK'd announcement and entered
        # STT-only mode. Now wait for the transcribed answer.

        # Set state to listening (card is now in STT mode)
        self._set_satellite_state("listening")

        try:
            # Phase 2: Wait for the card to send back transcribed text
            await asyncio.wait_for(
                self._question_event.wait(),
                timeout=ANNOUNCE_TIMEOUT,
            )

            sentence = self._question_answer_text or ""
            _LOGGER.debug(
                "Ask question on '%s' got answer: '%s'",
                self._satellite_name,
                sentence,
            )

            if not sentence:
                self._question_match_result = {
                    "matched": False, "id": None,
                }
                self._question_match_event.set()
                return None

            # Match against provided answers using hassil
            if answers and HAS_HASSIL:
                answer = self._match_answer(sentence, answers)
                self._question_match_result = {
                    "matched": answer.id is not None,
                    "id": answer.id,
                }
                self._question_match_event.set()
                return answer

            # No answers provided or hassil unavailable - return raw
            self._question_match_result = {
                "matched": False, "id": None,
            }
            self._question_match_event.set()
            return AssistSatelliteAnswer(
                id=None,
                sentence=sentence,
                slots={},
            )

        except asyncio.TimeoutError:
            _LOGGER.warning(
                "Ask question on '%s' timed out waiting for answer",
                self._satellite_name,
            )
            self._question_match_result = {
                "matched": False, "id": None,
            }
            self._question_match_event.set()
            return None
        finally:
            self._ask_question_pending = False
            self._question_event = None
            self._question_answer_text = None
            self._question_match_event = None
            # NOTE: _question_match_result is intentionally NOT cleared here.
            # The WebSocket handler may still need to read it after
            # _question_match_event fires but before this finally runs.
            # It will be overwritten on the next ask_question call.
            self.async_write_ha_state()

    def _match_answer(
        self, sentence: str, answers: list[dict[str, Any]]
    ) -> Any:
        """Match a sentence against answer templates using hassil."""
        # Build hassil intent structure from the answer list
        intents_dict: dict[str, Any] = {"language": "en", "intents": {}}
        for answer in answers:
            answer_id = answer["id"]
            sentences = answer.get("sentences", [])
            intents_dict["intents"][answer_id] = {
                "data": [{"sentences": sentences}]
            }

        try:
            intents = Intents.from_dict(intents_dict)
            result = recognize(sentence, intents)
        except Exception:
            _LOGGER.debug(
                "Hassil matching failed for '%s', returning raw sentence",
                sentence,
                exc_info=True,
            )
            return AssistSatelliteAnswer(
                id=None, sentence=sentence, slots={}
            )

        if result is None:
            _LOGGER.debug(
                "No hassil match for '%s' against %d answers",
                sentence,
                len(answers),
            )
            return AssistSatelliteAnswer(
                id=None, sentence=sentence, slots={}
            )

        matched_id = result.intent.name
        slots = {
            name: slot.value
            for name, slot in result.entities.items()
        }

        _LOGGER.debug(
            "Hassil matched '%s' -> id=%s, slots=%s",
            sentence,
            matched_id,
            slots,
        )

        return AssistSatelliteAnswer(
            id=matched_id,
            sentence=sentence,
            slots=slots,
        )

    @callback
    def question_answered(self, announce_id: int, sentence: str) -> None:
        """Called by WebSocket handler when card sends back STT text."""
        if (
            self._question_event is not None
            and self._announce_id == announce_id
        ):
            _LOGGER.debug(
                "Question #%d answer received for '%s': '%s'",
                announce_id,
                self._satellite_name,
                sentence,
            )
            self._question_answer_text = sentence
            self._question_event.set()
        else:
            _LOGGER.debug(
                "Ignoring stale question answer #%d (current: #%d) "
                "for '%s'",
                announce_id,
                self._announce_id,
                self._satellite_name,
            )

    def _set_satellite_state(self, state_value: str) -> None:
        """Set the satellite entity state via the base class internal attribute.

        Uses the name-mangled attribute with a safety check, then writes
        state through the entity framework instead of hass.states.async_set().
        """
        if self.state == state_value:
            return
        # pylint: disable=protected-access
        attr = "_AssistSatelliteEntity__assist_satellite_state"
        if not hasattr(self, attr):
            _LOGGER.warning(
                "Cannot set satellite state for '%s': base class attribute "
                "'%s' not found (HA version may have changed the internal name)",
                self._satellite_name,
                attr,
            )
            return
        setattr(self, attr, state_value)
        self.async_write_ha_state()

    # Map card state strings to HA satellite state values
    _STATE_MAP: dict[str, str] = {
        "IDLE": "idle",
        "CONNECTING": "idle",
        "LISTENING": "idle",
        "PAUSED": "idle",
        "WAKE_WORD_DETECTED": "listening",
        "STT": "listening",
        "INTENT": "processing",
        "TTS": "responding",
        "ERROR": "idle",
    }

    @callback
    def set_pipeline_state(self, state: str) -> None:
        """Update entity state from the card's pipeline state."""
        mapped = self._STATE_MAP.get(state)
        if mapped is None:
            return

        self._set_satellite_state(mapped)
        _LOGGER.debug(
            "Pipeline state for '%s': %s -> %s",
            self._satellite_name,
            state,
            mapped,
        )

    async def async_run_pipeline(
        self,
        audio_queue: asyncio.Queue,
        connection,
        msg_id: int,
        start_stage: str,
        end_stage: str,
        conversation_id: str | None = None,
        extra_system_prompt: str | None = None,
        wake_word_phrase: str | None = None,
    ) -> None:
        """Run a bridged pipeline - relay events back to the card via WS.

        Called by the ws_run_pipeline handler. Audio comes in via the queue,
        pipeline events go back through connection.send_event().
        """
        self._pipeline_gen += 1
        my_gen = self._pipeline_gen
        self._pipeline_connection = connection
        self._pipeline_msg_id = msg_id
        self._pipeline_audio_queue = audio_queue
        self._pipeline_run_started = False

        # Set conversation_id for continue conversation support.
        # When a session duration is configured and the elapsed time exceeds
        # it, clear the stored ID so HA core starts a fresh chat session.
        # Multi-turn exchanges within a single session (conversation_id
        # provided by the card) always continue regardless of duration.
        if conversation_id:
            self._conversation_id = conversation_id
        else:
            duration = self._get_session_duration_seconds()
            if duration is not None:
                elapsed = time.monotonic() - self._conversation_last_activity
                if self._conversation_last_activity == 0.0 or elapsed > duration:
                    _LOGGER.debug(
                        "Session expired for '%s' (duration=%ss, elapsed=%.0fs) "
                        "— starting fresh conversation",
                        self.name, duration, elapsed,
                    )
                    self._conversation_id = None
                else:
                    _LOGGER.debug(
                        "Session still active for '%s' (duration=%ss, elapsed=%.0fs) "
                        "— continuing conversation %s",
                        self.name, duration, elapsed, self._conversation_id,
                    )
            else:
                _LOGGER.debug(
                    "Session duration is Persistent for '%s' "
                    "— continuing conversation %s",
                    self.name, self._conversation_id,
                )
        self._conversation_last_activity = time.monotonic()

        # Set extra_system_prompt right before the pipeline call so the
        # base class's async_accept_pipeline_from_satellite picks it up.
        # This avoids race conditions where an intermediate pipeline
        # restart could consume a value stored earlier.
        if extra_system_prompt:
            self._extra_system_prompt = extra_system_prompt

        stage_map = {
            "wake_word": PipelineStage.WAKE_WORD,
            "stt": PipelineStage.STT,
            "intent": PipelineStage.INTENT,
            "tts": PipelineStage.TTS,
        }

        async def audio_stream():
            while True:
                chunk = await audio_queue.get()
                if not chunk:  # empty bytes = stop signal
                    break
                yield chunk

        _LOGGER.debug(
            "Bridged pipeline starting for '%s' (start=%s, end=%s)",
            self._satellite_name,
            start_stage,
            end_stage,
        )

        try:
            await self.async_accept_pipeline_from_satellite(
                audio_stream(),
                start_stage=stage_map.get(
                    start_stage, PipelineStage.WAKE_WORD
                ),
                end_stage=stage_map.get(end_stage, PipelineStage.TTS),
                wake_word_phrase=wake_word_phrase,
            )
        finally:
            # Only clear if we're still the active generation - a newer
            # run may have already claimed these fields.
            if self._pipeline_gen == my_gen:
                self._pipeline_connection = None
                self._pipeline_msg_id = None
                self._pipeline_audio_queue = None

    @callback
    def on_pipeline_event(self, event) -> None:
        """Handle pipeline events - relay to card if bridged pipeline active."""
        event_type = getattr(event, "type", str(event))
        event_type_str = str(event_type)

        # Gate: run-start is always the first event of a new pipeline run.
        # Any event arriving before run-start is stale (from an old run's
        # orphaned HA internal tasks leaking through this shared callback).
        if event_type_str == "run-start":
            self._pipeline_run_started = True
        elif not self._pipeline_run_started:
            _LOGGER.debug(
                "Filtering stale pre-run-start event for '%s': %s",
                self._satellite_name,
                event_type_str,
            )
            return

        _LOGGER.debug(
            "Pipeline event for '%s': %s",
            self._satellite_name,
            event_type_str,
        )

        if self._pipeline_connection and self._pipeline_msg_id:
            event_data = getattr(event, "data", None) or {}
            self._pipeline_connection.send_event(
                self._pipeline_msg_id,
                {
                    "type": event_type_str,
                    "data": event_data,
                },
            )

            # After forwarding tts-end, measure audio duration and send
            # to card.  Capture connection/msg_id now — the pipeline's
            # finally block clears them almost immediately after run-end.
            if event_type_str == "tts-end":
                tts_url = (event_data.get("tts_output") or {}).get(
                    "url"
                )
                if tts_url:
                    self.hass.async_create_task(
                        self._send_tts_audio_duration(tts_url)
                    )

    async def _send_tts_audio_duration(self, tts_url: str) -> None:
        """Measure TTS audio duration and send to card.

        Fetches the audio from the TTS proxy URL (no auth needed — the
        token in the URL is the secret) and measures duration with mutagen
        or the stdlib wave module. The finally block guarantees the event
        is always sent so the card never hangs.

        Sends the result via the satellite subscription (always alive),
        not the pipeline subscription (cleaned up after run-end).
        """
        duration = 0
        try:
            import io

            from homeassistant.helpers.aiohttp_client import (
                async_get_clientsession,
            )
            from homeassistant.helpers.network import get_url

            # tts_url may be a relative path (/api/tts_proxy/...)
            # or a full URL (https://host/api/tts_proxy/...) from announcements.
            if tts_url.startswith(("http://", "https://")):
                full_url = tts_url
            else:
                try:
                    base_url = get_url(self.hass, prefer_external=False)
                except Exception:
                    base_url = "http://127.0.0.1:8123"
                full_url = f"{base_url}{tts_url}"

            _LOGGER.debug(
                "Measuring TTS duration for '%s': %s",
                self._satellite_name,
                full_url,
            )

            session = async_get_clientsession(self.hass)
            async with session.get(full_url) as resp:
                if resp.status == 200:
                    audio_data = await resp.read()

                    # Try mutagen first (MP3, FLAC, OGG, etc.)
                    try:
                        import mutagen

                        audio_file = mutagen.File(io.BytesIO(audio_data))
                        if audio_file is not None and audio_file.info and audio_file.info.length:
                            duration = round(audio_file.info.length, 2)
                    except Exception:
                        pass

                    # Fallback: stdlib wave module for WAV/PCM
                    if not duration:
                        try:
                            import wave

                            with wave.open(io.BytesIO(audio_data)) as w:
                                duration = round(
                                    w.getnframes() / w.getframerate(), 2
                                )
                        except Exception:
                            pass
                    if duration:
                        _LOGGER.debug(
                            "TTS audio duration for '%s': %.2fs",
                            self._satellite_name,
                            duration,
                        )
                else:
                    _LOGGER.warning(
                        "TTS proxy returned %d for '%s'",
                        resp.status,
                        self._satellite_name,
                    )
        except Exception:
            _LOGGER.warning(
                "Failed to measure TTS audio duration for '%s'",
                self._satellite_name,
                exc_info=True,
            )
        finally:
            self._push_satellite_event(
                "tts-audio-duration",
                {"duration": duration, "tts_url": tts_url},
            )

    # --- Satellite event subscription ---

    @callback
    def register_satellite_subscription(
        self, connection, msg_id: int
    ) -> None:
        """Register a WS subscriber for satellite events."""
        was_empty = not self._satellite_subscribers
        self._satellite_subscribers.append((connection, msg_id))
        _LOGGER.debug(
            "Satellite subscription registered for '%s' (msg_id=%d, total=%d)",
            self._satellite_name,
            msg_id,
            len(self._satellite_subscribers),
        )
        # First subscriber -> entity becomes available
        if was_empty:
            self.async_write_ha_state()
            self._update_media_player_availability()

    @callback
    def unregister_satellite_subscription(
        self, connection, msg_id: int
    ) -> None:
        """Remove a WS subscriber."""
        self._satellite_subscribers = [
            (c, m)
            for c, m in self._satellite_subscribers
            if not (c is connection and m == msg_id)
        ]
        _LOGGER.debug(
            "Satellite subscription removed for '%s' (remaining=%d)",
            self._satellite_name,
            len(self._satellite_subscribers),
        )

        # If no subscribers remain, entity becomes unavailable.
        # Also release any pending blocking events so the entity
        # isn't stuck waiting for a card that disconnected.
        if not self._satellite_subscribers:
            self.async_write_ha_state()
            self._update_media_player_availability()
            if self._announce_event is not None:
                _LOGGER.debug(
                    "No subscribers left - releasing pending announcement for '%s'",
                    self._satellite_name,
                )
                self._announce_event.set()
            if self._question_event is not None:
                _LOGGER.debug(
                    "No subscribers left - releasing pending question for '%s'",
                    self._satellite_name,
                )
                self._question_event.set()

    @callback
    def _push_satellite_event(
        self, event_type: str, data: dict[str, Any]
    ) -> None:
        """Push an event to all satellite subscribers."""
        if not self._satellite_subscribers:
            _LOGGER.warning(
                "No satellite subscribers for '%s' - cannot push %s event",
                self._satellite_name,
                event_type,
            )
            return

        if self.hass.is_stopping:
            return

        dead: list[tuple] = []
        for connection, msg_id in list(self._satellite_subscribers):
            try:
                connection.send_event(
                    msg_id, {"type": event_type, "data": data}
                )
            except Exception:
                dead.append((connection, msg_id))

        if dead:
            self._satellite_subscribers = [
                s for s in self._satellite_subscribers if s not in dead
            ]

    @callback
    def _update_media_player_availability(self) -> None:
        """Notify the media_player entity to re-evaluate its availability."""
        mp = self.hass.data.get(DOMAIN, {}).get(
            f"{self._entry.entry_id}_media_player"
        )
        if mp is not None:
            mp.async_write_ha_state()

    @callback
    def _handle_timer_event(
        self,
        event_type: intent.TimerEventType,
        timer_info: intent.TimerInfo,
    ) -> None:
        """Handle timer events from the intent system."""
        timer_id = timer_info.id
        self._last_timer_event = event_type.value

        if event_type == intent.TimerEventType.STARTED:
            h = timer_info.start_hours or 0
            m = timer_info.start_minutes or 0
            s = timer_info.start_seconds or 0
            total = h * 3600 + m * 60 + s
            # Create a new list (not append) so HA detects the attribute change.
            # In-place mutation would also modify the previously written state's
            # reference to the same list, making old == new and suppressing
            # the state_changed event.
            self._active_timers = [*self._active_timers, {
                "id": timer_id,
                "name": timer_info.name or "",
                "total_seconds": total,
                "started_at": time.time(),
                "start_hours": h,
                "start_minutes": m,
                "start_seconds": s,
            }]
            _LOGGER.debug(
                "Timer started on '%s': %s (%ds)",
                self._satellite_name,
                timer_info.name or timer_id,
                total,
            )

        elif event_type == intent.TimerEventType.UPDATED:
            # Create a new list with updated timer data
            updated = []
            for timer in self._active_timers:
                if timer["id"] == timer_id:
                    h = timer_info.start_hours or 0
                    m = timer_info.start_minutes or 0
                    s = timer_info.start_seconds or 0
                    updated.append({
                        **timer,
                        "total_seconds": h * 3600 + m * 60 + s,
                        "started_at": time.time(),
                        "start_hours": h,
                        "start_minutes": m,
                        "start_seconds": s,
                    })
                else:
                    updated.append(timer)
            self._active_timers = updated
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
