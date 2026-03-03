"""Frontend JavaScript module registration for Voice Satellite Card.

Registers the built card JS as a Lovelace resource so users don't need
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

from .const import INTEGRATION_VERSION, URL_BASE, JS_FILENAME

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = str(Path(__file__).parent / "frontend")
MODELS_DIR = str(Path(__file__).parent / "models")
MODELS_URL = f"{URL_BASE}/models"
TFLITE_DIR = str(Path(__file__).parent / "tflite")
TFLITE_URL = f"{URL_BASE}/tflite"


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
                "Removing legacy Voice Satellite Card resource: %s", item_url
            )
            await resources.async_delete_item(item["id"])

    # Check if already registered
    for item in resources.async_items():
        item_url = item.get("url", "")
        if not item_url.split("?")[0] == url:
            continue
        # Found existing entry
        if item_url.endswith(INTEGRATION_VERSION):
            _LOGGER.debug("Voice Satellite Card resource already up to date")
            return
        # Version mismatch — update
        _LOGGER.info(
            "Updating Voice Satellite Card resource to v%s",
            INTEGRATION_VERSION,
        )
        await resources.async_update_item(
            item["id"], {"res_type": "module", "url": versioned_url}
        )
        return

    # Not found — create
    _LOGGER.info(
        "Registering Voice Satellite Card resource v%s", INTEGRATION_VERSION
    )
    await resources.async_create_item({"res_type": "module", "url": versioned_url})


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
            _LOGGER.info("Removed Voice Satellite Card Lovelace resource")
            break
