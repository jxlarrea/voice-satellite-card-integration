"""Frontend JavaScript module registration for Voice Satellite.

Registers the built JS as a Lovelace resource so users don't need
to manually add it. Static path + Lovelace resources collection API.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace.resources import (
    ResourceStorageCollection,
)
from homeassistant.core import HomeAssistant
from homeassistant.components.frontend import add_extra_js_url

from homeassistant.components.frontend import async_register_built_in_panel

from .const import INTEGRATION_VERSION, URL_BASE, JS_FILENAME

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = str(Path(__file__).parent / "frontend")
MODELS_DIR = str(Path(__file__).parent / "models")
MODELS_URL = f"{URL_BASE}/models"
TFLITE_DIR = str(Path(__file__).parent / "tflite")
TFLITE_URL = f"{URL_BASE}/tflite"
WAKE_WORD_FRONTEND_DIR = str(Path(__file__).parent / "wake-word-frontend")
WAKE_WORD_FRONTEND_URL = f"{URL_BASE}/wake-word-frontend"
BRAND_DIR = str(Path(__file__).parent / "brand")
BRAND_URL = f"{URL_BASE}/brand"
SOUNDS_DIR = str(Path(__file__).parent / "sounds")
SOUNDS_URL = f"{URL_BASE}/sounds"


def _get_resources(hass: HomeAssistant) -> ResourceStorageCollection | None:
    """Get the Lovelace resources collection, handling HA version differences."""
    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        return None
    # Newer HA: lovelace.resources; older HA: lovelace["resources"]
    resources = (
        lovelace.resources
        if hasattr(lovelace, "resources")
        else lovelace.get("resources") if isinstance(lovelace, dict) else None
    )
    if resources is None or not isinstance(resources, ResourceStorageCollection):
        return None
    return resources


async def async_register_static_paths(hass: HomeAssistant) -> None:
    """Register /voice_satellite/* as static HTTP paths."""
    paths: list[StaticPathConfig] = [
        StaticPathConfig(URL_BASE, FRONTEND_DIR, False),
    ]

    if Path(MODELS_DIR).is_dir():
        paths.append(StaticPathConfig(MODELS_URL, MODELS_DIR, True))

    if Path(TFLITE_DIR).is_dir():
        paths.append(StaticPathConfig(TFLITE_URL, TFLITE_DIR, True))

    if Path(WAKE_WORD_FRONTEND_DIR).is_dir():
        paths.append(StaticPathConfig(WAKE_WORD_FRONTEND_URL, WAKE_WORD_FRONTEND_DIR, True))

    if Path(BRAND_DIR).is_dir():
        paths.append(StaticPathConfig(BRAND_URL, BRAND_DIR, True))

    if Path(SOUNDS_DIR).is_dir():
        paths.append(StaticPathConfig(SOUNDS_URL, SOUNDS_DIR, True))

    for cfg in paths:
        try:
            await hass.http.async_register_static_paths([cfg])
            _LOGGER.debug("Static path registered: %s", cfg.url_path)
        except RuntimeError:
            _LOGGER.debug("Static path already registered: %s", cfg.url_path)


# Legacy resource URLs from the old standalone card repo (archived).
# If present, they conflict with the integrated version and must be removed.
_LEGACY_RESOURCE_MARKERS = (
    "/voice-satellite-card/voice-satellite-card.js",
    "/Voice-Satellite-Card-for-Home-Assistant/",
)


async def async_register_resource(hass: HomeAssistant) -> None:
    """Register or update the JS module in Lovelace resources."""
    url = f"{URL_BASE}/{JS_FILENAME}"
    versioned_url = f"{url}?v={INTEGRATION_VERSION}"

    resources = _get_resources(hass)
    if resources is None:
        # Not storage mode or lovelace unavailable — use extra JS fallback
        _LOGGER.debug(
            "Lovelace resources collection not available, "
            "registering via add_extra_js_url"
        )
        add_extra_js_url(hass, versioned_url)
        return

    # Force-load the resources storage (replaces the old polling mechanism)
    await resources.async_get_info()

    # Remove legacy standalone card resources that conflict with this integration
    for item in resources.async_items():
        item_url = item.get("url", "")
        if any(marker in item_url for marker in _LEGACY_RESOURCE_MARKERS):
            _LOGGER.warning(
                "Removing legacy Voice Satellite resource: %s", item_url
            )
            await resources.async_delete_item(item["id"])

    # Check if already registered
    for item in resources.async_items():
        item_url = item.get("url", "")
        if not item_url.split("?")[0] == url:
            continue
        # Found existing entry
        if item_url.endswith(INTEGRATION_VERSION):
            _LOGGER.debug("Voice Satellite resource already up to date")
            return
        # Version mismatch — update
        _LOGGER.info(
            "Updating Voice Satellite resource to v%s",
            INTEGRATION_VERSION,
        )
        await resources.async_update_item(
            item["id"], {"res_type": "module", "url": versioned_url}
        )
        return

    # Not found — create
    _LOGGER.info(
        "Registering Voice Satellite resource v%s", INTEGRATION_VERSION
    )
    await resources.async_create_item({"res_type": "module", "url": versioned_url})


PANEL_FILENAME = "voice-satellite-panel.js"


async def async_register_sidebar_panel(hass: HomeAssistant) -> None:
    """Register the sidebar panel and load the engine JS globally."""
    card_url = f"{URL_BASE}/{JS_FILENAME}?v={INTEGRATION_VERSION}"
    panel_url = f"{URL_BASE}/{PANEL_FILENAME}?v={INTEGRATION_VERSION}"

    # Load the main card JS on every page (engine runs globally)
    add_extra_js_url(hass, card_url)

    # Register the sidebar panel (browser_mod pattern)
    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title="Voice Satellite",
        sidebar_icon="mdi:microphone-message",
        frontend_url_path="voice-satellite",
        require_admin=False,
        config={
            "_panel_custom": {
                "name": "voice-satellite-panel",
                "js_url": panel_url,
            }
        },
    )
    _LOGGER.debug("Voice Satellite sidebar panel registered")


async def async_unregister_resource(hass: HomeAssistant) -> None:
    """Remove the Lovelace resource entry (called on last entry unload)."""
    resources = _get_resources(hass)
    if resources is None:
        return

    if not resources.loaded:
        await resources.async_load()

    url = f"{URL_BASE}/{JS_FILENAME}"
    for item in resources.async_items():
        if item.get("url", "").split("?")[0] == url:
            await resources.async_delete_item(item["id"])
            _LOGGER.info("Removed Voice Satellite Lovelace resource")
            break
