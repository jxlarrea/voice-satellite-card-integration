"""Assist Satellite entity for Voice Satellite Card.

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
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

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

from .const import DOMAIN

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
        self._pending_announcement: dict[str, Any] | None = None
        self._announce_event: asyncio.Event | None = None
        self._announce_id: int = 0

        # Ask question state
        self._question_event: asyncio.Event | None = None
        self._question_answer_text: str | None = None
        self._ask_question_pending: bool = False
        self._question_match_event: asyncio.Event | None = None
        self._question_match_result: dict | None = None

    @property
    def device_info(self) -> dict[str, Any]:
        """Return device info to create a device registry entry."""
        return {
            "identifiers": {(DOMAIN, self._entry.entry_id)},
            "name": self._satellite_name,
            "manufacturer": "Voice Satellite Card Integration",
            "model": "Browser Satellite",
            "sw_version": "1.2.1",
        }

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose timer and announcement state for the card to read."""
        attrs: dict[str, Any] = {
            "active_timers": self._active_timers,
            "last_timer_event": self._last_timer_event,
        }
        if self._pending_announcement is not None:
            attrs["announcement"] = self._pending_announcement
        return attrs

    async def async_added_to_hass(self) -> None:
        """Register timer handler when entity is added."""
        await super().async_added_to_hass()

        assert self.device_entry is not None

        # Register this device as a timer handler
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

    async def async_announce(
        self, announcement: AssistSatelliteAnnouncement
    ) -> None:
        """Handle an announcement.

        Stores the announcement in entity attributes for the card to read,
        then blocks until the card signals playback is complete via the
        voice_satellite/announce_finished WebSocket command.
        """
        self._announce_id += 1
        announce_id = self._announce_id

        self._pending_announcement = {
            "id": announce_id,
            "message": announcement.message or "",
            "media_id": announcement.media_id or "",
            "preannounce_media_id": (
                getattr(announcement, "preannounce_media_id", None) or ""
            ),
        }

        # If ask_question is pending, add the flag so the card enters
        # STT-only mode after playing the question TTS
        if self._ask_question_pending:
            self._pending_announcement["ask_question"] = True

        # Create an event to wait for the card to ACK playback
        self._announce_event = asyncio.Event()

        # Push state so the card sees the new announcement
        self.async_write_ha_state()

        _LOGGER.debug(
            "Announcement #%d on '%s': %s (media: %s)",
            announce_id,
            self._satellite_name,
            announcement.message or "(no message)",
            announcement.media_id or "(no media)",
        )

        # Wait for the card to finish playback
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
            self._pending_announcement = None
            self._announce_event = None
            self.async_write_ha_state()

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

    async def async_start_conversation(
        self, announcement: AssistSatelliteAnnouncement
    ) -> None:
        """Handle a start_conversation request.

        Works like an announcement but includes a start_conversation flag
        so the card enters STT mode (skipping wake word) after playback,
        enabling the user to respond to the prompt.
        """
        self._announce_id += 1
        announce_id = self._announce_id

        self._pending_announcement = {
            "id": announce_id,
            "message": announcement.message or "",
            "media_id": announcement.media_id or "",
            "preannounce_media_id": (
                getattr(announcement, "preannounce_media_id", None) or ""
            ),
            "start_conversation": True,
        }

        # Create an event to wait for the card to ACK playback
        self._announce_event = asyncio.Event()

        # Push state so the card sees the new announcement
        self.async_write_ha_state()

        _LOGGER.debug(
            "Start conversation #%d on '%s': %s (media: %s)",
            announce_id,
            self._satellite_name,
            announcement.message or "(no message)",
            announcement.media_id or "(no media)",
        )

        # Wait for the card to finish playback of the announcement
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
            # Card is now entering STT mode — set state to listening
            self.hass.states.async_set(
                self.entity_id,
                "listening",
                self.extra_state_attributes,
            )
        except asyncio.TimeoutError:
            _LOGGER.warning(
                "Start conversation #%d on '%s' timed out after %ds",
                announce_id,
                self._satellite_name,
                ANNOUNCE_TIMEOUT,
            )
        finally:
            self._pending_announcement = None
            self._announce_event = None
            self.async_write_ha_state()

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
        # and playback. The base class will resolve text→media_id and
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

        # Phase 1 complete — card has ACK'd announcement and entered
        # STT-only mode. Now wait for the transcribed answer.

        # Set state to listening (card is now in STT mode)
        self.hass.states.async_set(
            self.entity_id,
            "listening",
            self.extra_state_attributes,
        )

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

            # No answers provided or hassil unavailable — return raw
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
            self._question_match_result = None
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
            "Hassil matched '%s' → id=%s, slots=%s",
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

        current = self.hass.states.get(self.entity_id)
        if current and current.state == mapped:
            return

        # Force state via state machine — the base class doesn't expose
        # a public method to set satellite state externally.
        self.hass.states.async_set(
            self.entity_id,
            mapped,
            current.attributes if current else {},
        )
        _LOGGER.debug(
            "Pipeline state for '%s': %s -> %s",
            self._satellite_name,
            state,
            mapped,
        )

    @callback
    def on_pipeline_event(self, event_type: str, data: dict | None) -> None:
        """Handle pipeline events."""
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
        """Handle timer events from the intent system."""
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
                    "started_at": time.time(),
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
                    timer["started_at"] = time.time()
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