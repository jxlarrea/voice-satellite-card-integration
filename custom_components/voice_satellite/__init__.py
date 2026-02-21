"""Voice Satellite Card integration.

Registers browser tablets as Assist Satellite devices in Home Assistant,
giving the Voice Satellite Card a device identity. This unlocks timers,
announcements, and per-device LLM context.
"""

from __future__ import annotations

import asyncio
import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.ASSIST_SATELLITE, Platform.SELECT, Platform.SWITCH]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Voice Satellite Card from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Register WebSocket commands (idempotent — safe to call multiple times)
    try:
        websocket_api.async_register_command(hass, ws_announce_finished)
    except ValueError:
        pass  # Already registered from another config entry

    try:
        websocket_api.async_register_command(hass, ws_update_state)
    except ValueError:
        pass

    try:
        websocket_api.async_register_command(hass, ws_question_answered)
    except ValueError:
        pass

    try:
        websocket_api.async_register_command(hass, ws_run_pipeline)
    except ValueError:
        pass

    try:
        websocket_api.async_register_command(hass, ws_subscribe_satellite_events)
    except ValueError:
        pass

    try:
        websocket_api.async_register_command(hass, ws_cancel_timer)
    except ValueError:
        pass

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    result = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if result:
        hass.data[DOMAIN].pop(entry.entry_id, None)
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

    # Find the entity by looking through all registered satellites
    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

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

    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    entity.set_pipeline_state(state)
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

    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    # Grab the match event before triggering the answer
    match_event = entity._question_match_event

    entity.question_answered(announce_id, sentence)

    # Wait for hassil matching to complete (with timeout)
    result = {"matched": False, "id": None}
    if match_event is not None:
        try:
            await asyncio.wait_for(match_event.wait(), timeout=10.0)
            # Read result immediately — finally block may clear it
            result = entity._question_match_result or result
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
    }
)
@websocket_api.async_response
async def ws_run_pipeline(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Run a bridged pipeline — stream audio in, relay events back.

    Follows the same binary handler pattern as HA core's assist_pipeline/run.
    """
    entity_id = msg["entity_id"]
    start_stage = msg["start_stage"]
    end_stage = msg["end_stage"]
    conversation_id = msg.get("conversation_id")
    extra_system_prompt = msg.get("extra_system_prompt")

    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

    if entity is None:
        connection.send_error(
            msg["id"], "not_found", f"Entity {entity_id} not found"
        )
        return

    # Stop the old pipeline's audio stream so internal HA tasks (wake word,
    # STT) unblock naturally.  We must NOT cancel immediately — the stop
    # signal and CancelledError would race on `await audio_queue.get()`,
    # and CancelledError always wins, leaving orphaned PipelineInput tasks.
    # Instead: send stop signal → wait for natural exit → cancel only on timeout.
    if entity._pipeline_audio_queue is not None:
        entity._pipeline_audio_queue.put_nowait(b"")

    old_task = entity._pipeline_task
    if old_task and not old_task.done():
        done, _ = await asyncio.wait({old_task}, timeout=3.0)
        if not done:
            old_task.cancel()
            try:
                await old_task
            except (asyncio.CancelledError, Exception):
                pass

    # Audio queue — card sends binary audio frames, empty bytes = stop
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
        ),
        name=f"voice_satellite.{entity._satellite_name}_pipeline",
    )
    entity._pipeline_task = task

    # Cleanup on unsubscribe — send stop signal to end the audio stream
    # naturally.  Do NOT cancel here; CancelledError races with the stop
    # signal and leaves orphaned HA pipeline tasks.  The next ws_run_pipeline
    # call (or async_will_remove_from_hass) handles forced cancellation.
    def unsub() -> None:
        audio_queue.put_nowait(b"")
        unregister()

    connection.subscriptions[msg["id"]] = unsub


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

    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

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

    entity = None
    for entry_id, ent in hass.data.get(DOMAIN, {}).items():
        if ent.entity_id == entity_id:
            entity = ent
            break

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