"""Voice Satellite Card integration.

Registers browser tablets as Assist Satellite devices in Home Assistant,
giving the Voice Satellite Card a device identity. This unlocks timers,
announcements, and per-device LLM context.
"""

from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.ASSIST_SATELLITE]


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