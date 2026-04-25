"""Voice Satellite integration.

Registers browser tablets as Assist Satellite devices in Home Assistant,
giving each Voice Satellite a device identity. This unlocks timers,
announcements, and per-device LLM context. Also serves the frontend
JavaScript automatically.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import Context, HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .diagnostics import register as register_diagnostics
from .frontend import (
    async_register_resource,
    async_register_sidebar_panel,
    async_register_static_paths,
    async_unregister_resource,
)

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS = [Platform.ASSIST_SATELLITE, Platform.BINARY_SENSOR, Platform.MEDIA_PLAYER, Platform.NUMBER, Platform.SELECT, Platform.SWITCH]


def _find_entity(hass: HomeAssistant, entity_id: str, predicate=None):
    """Find a registered entity by entity_id, with optional extra filter."""
    for _, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id and (predicate is None or predicate(ent)):
            return ent
    return None


_BUILTIN_MODELS = {"ok_nabu", "hey_jarvis", "alexa", "hey_mycroft", "hey_home_assistant", "hey_luna", "okay_computer", "stop"}
_BUILTIN_SOUNDS = {"announce", "alert", "done", "error", "wake"}


def _sync_custom_models(config_dir: str) -> None:
    """Sync custom .tflite models between persistent storage and integration dir.

    HACS replaces the entire integration directory on update, wiping any
    user-added model files.  We use a persistent directory outside
    custom_components/ to survive updates:

      /config/voice_satellite/models/

    On each startup this function:
      1. Creates the persistent dir if it doesn't exist.
      2. Saves any custom models found in the integration dir → persistent dir
         (catches models placed directly in the integration dir).
      3. Restores custom models from the persistent dir → integration dir
         (restores models lost during a HACS update).

    Built-in models that ship with the integration are never overwritten.
    """
    persistent = Path(config_dir, "voice_satellite", "models")
    persistent.mkdir(parents=True, exist_ok=True)

    integration_models = Path(__file__).parent / "models"
    if not integration_models.is_dir():
        return

    # Save: integration → persistent (backup custom models the user placed directly)
    for src in integration_models.glob("*.tflite"):
        if src.stem in _BUILTIN_MODELS:
            continue
        dest = persistent / src.name
        if not dest.exists():
            shutil.copy2(src, dest)
            _LOGGER.info("Saved custom model to persistent storage: %s", src.name)
        # Also sync companion .json manifest if present
        json_src = src.with_suffix(".json")
        if json_src.exists():
            json_dest = persistent / json_src.name
            if not json_dest.exists():
                shutil.copy2(json_src, json_dest)
                _LOGGER.info("Saved custom model manifest to persistent storage: %s", json_src.name)

    # Restore: persistent → integration (recover after HACS update)
    for src in persistent.glob("*.tflite"):
        if src.stem in _BUILTIN_MODELS:
            continue
        dest = integration_models / src.name
        if not dest.exists():
            shutil.copy2(src, dest)
            _LOGGER.info("Restored custom model from persistent storage: %s", src.name)
        # Also restore companion .json manifest if present
        json_src = src.with_suffix(".json")
        if json_src.exists():
            json_dest = integration_models / json_src.name
            if not json_dest.exists():
                shutil.copy2(json_src, json_dest)
                _LOGGER.info("Restored custom model manifest from persistent storage: %s", json_src.name)


_DURATIONS_FILENAME = "durations.json"


def _write_sound_durations(config_dir: str) -> None:
    """Probe every .mp3 in the integration sounds dir and write a manifest.

    Users can drop their own chime files into /config/voice_satellite/sounds/
    (synced into the integration dir by `_sync_custom_sounds()` just above).
    Those custom files can be any length; the client needs the true duration
    so it can schedule the post-chime mic unmute / STT resume correctly —
    the hardcoded fallbacks in src/audio/chime.js are only safe for the
    shipped defaults.

    Writes `sounds/durations.json` mapping filename → seconds (float).
    The client fetches this at startup and feeds it to
    `setChimeDurationOverrides()`.  Runs after the sync so both built-in
    and user-replaced files are probed identically.
    """
    try:
        # mutagen is listed in manifest.json "requirements" — always present.
        from mutagen.mp3 import MP3
    except ImportError:
        _LOGGER.warning(
            "mutagen not available — skipping chime duration probe; "
            "client will use hardcoded fallbacks"
        )
        return

    sounds_dir = Path(__file__).parent / "sounds"
    if not sounds_dir.is_dir():
        return

    durations: dict[str, float] = {}
    for mp3 in sorted(sounds_dir.glob("*.mp3")):
        try:
            length = MP3(str(mp3)).info.length
        except Exception as e:  # noqa: BLE001 — any probe failure is non-fatal
            _LOGGER.warning("Failed to probe duration of %s: %s", mp3.name, e)
            continue
        if isinstance(length, (int, float)) and length > 0:
            durations[mp3.name] = round(float(length), 4)

    manifest_path = sounds_dir / _DURATIONS_FILENAME
    try:
        manifest_path.write_text(json.dumps(durations, indent=2), encoding="utf-8")
    except OSError as e:
        _LOGGER.warning("Failed to write %s: %s", manifest_path, e)
        return

    # Log each probed duration so operators can confirm the real lengths
    # and spot any surprisingly-long custom chimes that might affect
    # post-chime mute-release timing.
    for name, secs in durations.items():
        _LOGGER.info("Probed chime duration: %s = %.3fs", name, secs)


def _sync_custom_sounds(config_dir: str) -> None:
    """Sync custom .mp3 sounds between persistent storage and integration dir.

    HACS replaces the entire integration directory on update, wiping any
    user-added sound files. We use a persistent directory outside
    custom_components/ to survive updates:

      /config/voice_satellite/sounds/

    On each startup this function:
      1. Creates the persistent dir if it doesn't exist.
      2. Saves any custom sounds found in the integration dir to persistent dir
         (catches sounds placed directly in the integration dir).
      3. Restores sounds from the persistent dir to the integration dir.
         Files in the persistent folder are authoritative and can replace
         built-in sound filenames after a HACS update.

    Built-in sound names are excluded from the backup step so the persistent
    folder only stores user-managed overrides.
    """
    persistent = Path(config_dir, "voice_satellite", "sounds")
    persistent.mkdir(parents=True, exist_ok=True)

    integration_sounds = Path(__file__).parent / "sounds"
    if not integration_sounds.is_dir():
        return

    # Save: integration -> persistent (backup custom sounds the user placed directly)
    for src in integration_sounds.glob("*.mp3"):
        if src.stem in _BUILTIN_SOUNDS:
            continue
        dest = persistent / src.name
        if not dest.exists():
            shutil.copy2(src, dest)
            _LOGGER.info("Saved custom sound to persistent storage: %s", src.name)

    # Restore: persistent -> integration (recover after HACS update)
    for src in persistent.glob("*.mp3"):
        dest = integration_sounds / src.name
        if not dest.exists() or src.read_bytes() != dest.read_bytes():
            shutil.copy2(src, dest)
            _LOGGER.info("Restored sound from persistent storage: %s", src.name)


async def _async_handle_wake_service(call: ServiceCall) -> None:
    """Handle voice_satellite.wake - push a wake event to the matching card(s).

    The card listens for the `wake` satellite event and skips wake-word
    detection, going straight into STT. Lets users drive activation from
    dashboard buttons, automations, or scripts.
    """
    hass = call.hass
    entity_ids = call.data["entity_id"]

    for entity_id in entity_ids:
        entity = _find_entity(hass, entity_id)
        if entity is None:
            _LOGGER.warning("voice_satellite.wake: entity %s not found", entity_id)
            continue
        entity._push_satellite_event("wake", {})


async def _async_handle_start_timer_service(call: ServiceCall) -> None:
    """Handle voice_satellite.start_timer - create a named timer on a satellite.

    Goes through HA's TimerManager so the timer behaves identically to a
    voice-created one: countdown pill on the overlay, alert tone on finish,
    `active_timers` attribute updates, and cancel via the existing card UI
    or `voice_satellite/cancel_timer` WS command.
    """
    from homeassistant.components.intent import TimerManager
    from homeassistant.components.intent.const import TIMER_DATA

    hass = call.hass
    entity_ids = call.data["entity_id"]
    name = call.data["name"]
    hours = call.data.get("hours") or 0
    minutes = call.data.get("minutes") or 0
    seconds = call.data.get("seconds") or 0

    if (hours + minutes + seconds) <= 0:
        raise vol.Invalid(
            "Timer duration must be at least one second "
            "(set hours, minutes, or seconds)"
        )

    timer_manager: TimerManager | None = hass.data.get(TIMER_DATA)
    if timer_manager is None:
        _LOGGER.warning("voice_satellite.start_timer: TimerManager not ready")
        return

    language = hass.config.language or "en"

    for entity_id in entity_ids:
        entity = _find_entity(hass, entity_id)
        if entity is None:
            _LOGGER.warning(
                "voice_satellite.start_timer: entity %s not found", entity_id
            )
            continue
        if entity.device_entry is None:
            _LOGGER.warning(
                "voice_satellite.start_timer: %s has no device entry", entity_id
            )
            continue
        try:
            timer_manager.start_timer(
                device_id=entity.device_entry.id,
                hours=hours or None,
                minutes=minutes or None,
                seconds=seconds or None,
                language=language,
                name=name,
            )
        except Exception as err:  # noqa: BLE001 - surface as a warning
            _LOGGER.warning(
                "voice_satellite.start_timer: failed for %s: %s",
                entity_id,
                err,
            )


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up integration-wide resources: frontend JS + WebSocket commands."""
    # Sync custom wake word models and custom sounds with persistent storage
    await hass.async_add_executor_job(_sync_custom_models, hass.config.config_dir)
    await hass.async_add_executor_job(_sync_custom_sounds, hass.config.config_dir)
    # Probe actual MP3 durations AFTER the sync so user-replaced files are
    # measured correctly, then write a manifest the client fetches at
    # startup to override the hardcoded fallbacks in src/audio/chime.js.
    await hass.async_add_executor_job(_write_sound_durations, hass.config.config_dir)

    # Register WebSocket commands (once, not per-entry)
    websocket_api.async_register_command(hass, ws_announce_finished)
    websocket_api.async_register_command(hass, ws_update_state)
    websocket_api.async_register_command(hass, ws_fire_chat_event)
    websocket_api.async_register_command(hass, ws_question_answered)
    websocket_api.async_register_command(hass, ws_run_pipeline)
    websocket_api.async_register_command(hass, ws_subscribe_satellite_events)
    websocket_api.async_register_command(hass, ws_cancel_timer)
    websocket_api.async_register_command(hass, ws_media_player_event)
    websocket_api.async_register_command(hass, ws_screensaver_state)
    register_diagnostics(hass)

    # Register services
    hass.services.async_register(
        DOMAIN,
        "wake",
        _async_handle_wake_service,
        schema=vol.Schema(
            {
                vol.Required("entity_id"): cv.entity_ids,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        "start_timer",
        _async_handle_start_timer_service,
        schema=vol.Schema(
            {
                vol.Required("entity_id"): cv.entity_ids,
                vol.Required("name"): vol.All(cv.string, vol.Length(min=1)),
                vol.Optional("hours"): vol.All(vol.Coerce(int), vol.Range(min=0, max=24)),
                vol.Optional("minutes"): vol.All(vol.Coerce(int), vol.Range(min=0, max=59)),
                vol.Optional("seconds"): vol.All(vol.Coerce(int), vol.Range(min=0, max=59)),
            }
        ),
    )

    # Register frontend static paths, Lovelace resource, and sidebar panel
    try:
        await async_register_static_paths(hass)
        await async_register_resource(hass)
        await async_register_sidebar_panel(hass)
    except Exception as err:
        _LOGGER.warning("Failed to register frontend resources: %s", err)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Voice Satellite from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Safety net: verify frontend resources exist (covers HACS update edge cases
    # where async_setup registration may have failed or the resource was deleted
    # during the unload/reload cycle)
    try:
        await async_register_resource(hass)
    except Exception as err:
        _LOGGER.warning("Failed to verify frontend resource: %s", err)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    result = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if result:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(f"{entry.entry_id}_media_player", None)
        hass.data[DOMAIN].pop(f"{entry.entry_id}_screensaver_sensor", None)
        # Remove Lovelace resource when last entry is unloaded
        if not hass.data[DOMAIN]:
            await async_unregister_resource(hass)
    return result


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/announce_finished",
        vol.Required("entity_id"): str,
        vol.Required("announce_id"): int,
    }
)
@websocket_api.async_response
async def ws_announce_finished(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle announcement finished ACK from the card."""
    entity_id = msg["entity_id"]
    announce_id = msg["announce_id"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    entity.announce_finished(announce_id)
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/update_state",
        vol.Required("entity_id"): str,
        vol.Required("state"): str,
    }
)
@websocket_api.async_response
async def ws_update_state(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle pipeline state updates from the card."""
    entity_id = msg["entity_id"]
    state = msg["state"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    entity.set_pipeline_state(state)
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/fire_chat_event",
        vol.Required("entity_id"): str,
        vol.Optional("stt_text", default=""): str,
        vol.Optional("tts_text", default=""): str,
        vol.Optional("tool_calls", default=list): [
            {
                vol.Required("name"): str,
                vol.Optional("display_name"): vol.Any(str, None),
            }
        ],
        vol.Optional("conversation_id"): vol.Any(str, None),
        vol.Optional("is_continuation", default=False): bool,
        vol.Optional("continue_conversation", default=False): bool,
        vol.Optional("language"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_fire_chat_event(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Fire a voice_satellite_chat event on the HA bus.

    Called by the card after each pipeline turn (intent-end). Exposes the
    full turn payload (STT text, TTS text, tool calls, conversation context)
    as a bus event so user automations can react to what was said.
    """
    entity_id = msg["entity_id"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    user_id = connection.user.id if connection.user else None
    hass.bus.async_fire(
        "voice_satellite_chat",
        {
            "entity_id": entity_id,
            "stt_text": msg.get("stt_text", ""),
            "tts_text": msg.get("tts_text", ""),
            "tool_calls": msg.get("tool_calls", []),
            "conversation_id": msg.get("conversation_id"),
            "is_continuation": msg.get("is_continuation", False),
            "continue_conversation": msg.get("continue_conversation", False),
            "language": msg.get("language"),
        },
        context=Context(user_id=user_id),
    )
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/question_answered",
        vol.Required("entity_id"): str,
        vol.Required("announce_id"): int,
        vol.Required("sentence"): str,
    }
)
@websocket_api.async_response
async def ws_question_answered(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle question answer from the card (STT transcription)."""
    entity_id = msg["entity_id"]
    announce_id = msg["announce_id"]
    sentence = msg["sentence"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    # Grab the match event before triggering the answer
    match_event = entity.question_match_event

    entity.question_answered(announce_id, sentence)

    # Wait for hassil matching to complete (with timeout)
    result = {"matched": False, "id": None}
    if match_event is not None:
        try:
            await asyncio.wait_for(match_event.wait(), timeout=10.0)
            # Read result immediately - finally block may clear it
            result = entity.question_match_result or result
        except asyncio.TimeoutError:
            pass

    connection.send_result(msg["id"], {
        "success": True,
        "matched": result.get("matched", False),
        "id": result.get("id"),
    })


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/run_pipeline",
        vol.Required("entity_id"): str,
        vol.Required("start_stage"): str,
        vol.Required("end_stage"): str,
        vol.Required("sample_rate"): int,
        vol.Optional("conversation_id"): str,
        vol.Optional("extra_system_prompt"): str,
        vol.Optional("wake_word_phrase"): str,
        vol.Optional("wake_word_slot"): vol.All(int, vol.In([1, 2])),
    }
)
@websocket_api.async_response
async def ws_run_pipeline(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Run a bridged pipeline - stream audio in, relay events back.

    Follows the same binary handler pattern as HA core's assist_pipeline/run.
    """
    entity_id = msg["entity_id"]
    start_stage = msg["start_stage"]
    end_stage = msg["end_stage"]
    conversation_id = msg.get("conversation_id")
    extra_system_prompt = msg.get("extra_system_prompt")
    wake_word_phrase = msg.get("wake_word_phrase")
    wake_word_slot = msg.get("wake_word_slot")

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    # Stop the old pipeline's audio stream so internal HA tasks (wake word,
    # STT) unblock naturally.  We must NOT cancel immediately - the stop
    # signal and CancelledError would race on `await audio_queue.get()`,
    # and CancelledError always wins, leaving orphaned PipelineInput tasks.
    # Instead: send stop signal -> wait for natural exit -> cancel only on timeout.
    if entity.pipeline_audio_queue is not None:
        old_conn = entity.pipeline_connection
        old_msg_id = entity.pipeline_msg_id
        if old_conn is not None and old_conn is not connection:
            _LOGGER.warning(
                "Pipeline for '%s' displaced by a different browser connection "
                " -  the previous browser will stop receiving wake word events. "
                "Each browser must use its own satellite entity.",
                entity.satellite_name,
            )
            try:
                old_conn.send_event(old_msg_id, {"type": "displaced"})
            except Exception:
                pass  # old connection may already be dead
        entity.pipeline_audio_queue.put_nowait(b"")

    old_task = entity.pipeline_task
    if old_task and not old_task.done():
        done, _ = await asyncio.wait({old_task}, timeout=3.0)
        if not done:
            old_task.cancel()
            try:
                await old_task
            except (asyncio.CancelledError, Exception):
                pass

    # Audio queue - card sends binary audio frames, empty bytes = stop
    audio_queue: asyncio.Queue[bytes] = asyncio.Queue()

    # Register binary handler for incoming audio.
    # HA calls binary handlers with (hass, connection, payload).
    def _on_binary(
        _hass: HomeAssistant,
        _connection: websocket_api.ActiveConnection,
        data: bytes,
    ) -> None:
        audio_queue.put_nowait(data)

    handler_id, unregister = connection.async_register_binary_handler(
        _on_binary
    )

    try:
        # Send subscription result (resolves the JS promise)
        connection.send_result(msg["id"])

        # Send synthetic init event with the handler_id the card needs
        connection.send_event(
            msg["id"],
            {"type": "init", "handler_id": handler_id},
        )

        # Run the pipeline as a background task so it doesn't block HA bootstrap.
        # Pipeline tasks are long-running (wake word detection) and must not
        # prevent HA from completing startup.
        task = hass.async_create_background_task(
            entity.async_run_pipeline(
                audio_queue,
                connection,
                msg["id"],
                start_stage,
                end_stage,
                conversation_id=conversation_id,
                extra_system_prompt=extra_system_prompt,
                wake_word_phrase=wake_word_phrase,
                wake_word_slot=wake_word_slot,
            ),
            name=f"voice_satellite.{entity.satellite_name}_pipeline",
        )
        entity.pipeline_task = task

        # Cleanup on unsubscribe - send stop signal to end the audio stream
        # naturally.  Do NOT cancel here; CancelledError races with the stop
        # signal and leaves orphaned HA pipeline tasks.  The next ws_run_pipeline
        # call (or async_will_remove_from_hass) handles forced cancellation.
        def unsub() -> None:
            audio_queue.put_nowait(b"")
            unregister()

        connection.subscriptions[msg["id"]] = unsub
    except Exception:
        unregister()
        raise


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/subscribe_events",
        vol.Required("entity_id"): str,
    }
)
@websocket_api.async_response
async def ws_subscribe_satellite_events(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to satellite events (announcements, start_conversation, ask_question).

    The entity pushes events via send_event() when HA commands arrive,
    matching how Voice PE satellites receive commands via their device connection.
    """
    entity_id = msg["entity_id"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    entity.register_satellite_subscription(connection, msg["id"])
    connection.send_result(msg["id"])

    def unsub() -> None:
        entity.unregister_satellite_subscription(connection, msg["id"])

    connection.subscriptions[msg["id"]] = unsub


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/cancel_timer",
        vol.Required("entity_id"): str,
        vol.Required("timer_id"): str,
    }
)
@websocket_api.async_response
async def ws_cancel_timer(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Cancel a specific timer by ID."""
    from homeassistant.components.intent import TimerManager
    from homeassistant.components.intent.const import TIMER_DATA

    entity_id = msg["entity_id"]
    timer_id = msg["timer_id"]

    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    timer_manager: TimerManager | None = hass.data.get(TIMER_DATA)
    if timer_manager is None:
        connection.send_error(
            msg["id"], "not_ready", "Timer manager not available"
        )
        return

    try:
        timer_manager.cancel_timer(timer_id)
        connection.send_result(msg["id"], {"success": True})
    except Exception as err:
        _LOGGER.warning("Failed to cancel timer %s: %s", timer_id, err)
        connection.send_error(
            msg["id"], "cancel_failed", str(err)
        )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/media_player_event",
        vol.Required("entity_id"): str,
        vol.Required("state"): str,
        vol.Optional("volume"): vol.Coerce(float),
        vol.Optional("media_id"): str,
    }
)
@websocket_api.async_response
async def ws_media_player_event(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle media player state updates from the card."""
    entity_id = msg["entity_id"]
    state = msg["state"]
    volume = msg.get("volume")
    media_id = msg.get("media_id")

    entity = _find_entity(hass, entity_id, lambda e: hasattr(e, "update_playback_state"))
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Media player entity {entity_id} not found"
        )
        return

    entity.update_playback_state(state, volume=volume, media_id=media_id)
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/screensaver_state",
        vol.Required("entity_id"): str,
        vol.Required("active"): bool,
    }
)
@websocket_api.async_response
async def ws_screensaver_state(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle screensaver active state updates from the card."""
    entity_id = msg["entity_id"]
    active = msg["active"]

    # Find the screensaver binary sensor via the satellite entity's config entry
    entity = _find_entity(hass, entity_id)
    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    entry_id = entity._entry.entry_id
    sensor = hass.data.get(DOMAIN, {}).get(f"{entry_id}_screensaver_sensor")
    if sensor is not None:
        sensor.set_active(active)

    connection.send_result(msg["id"], {"success": True})
