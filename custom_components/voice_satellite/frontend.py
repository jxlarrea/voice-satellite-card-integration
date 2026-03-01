"""Frontend JavaScript module registration for Voice Satellite Card.

Registers the built card JS as a Lovelace resource so users don't need
to manually add it. Static path + Lovelace resources collection API.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import MODE_STORAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

from .const import INTEGRATION_VERSION, URL_BASE, JS_FILENAME

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = str(Path(__file__).parent / "frontend")
MODELS_DIR = str(Path(__file__).parent / "models")
MODELS_URL = f"{URL_BASE}/models"
ORT_DIR = str(Path(__file__).parent / "ort")
ORT_URL = f"{URL_BASE}/ort"


class JSModuleRegistration:
    """Registers the Voice Satellite Card JS module in Home Assistant."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the registrar."""
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")
        # HA 2026.2 renamed lovelace.mode -> lovelace.resource_mode
        self.resource_mode: str = getattr(
            self.lovelace, "resource_mode",
            getattr(self.lovelace, "mode", "yaml"),
        )

    async def async_register(self) -> None:
        """Register static path and Lovelace resource."""
        await self._async_register_path()

        if self.lovelace is None:
            _LOGGER.warning("Lovelace not available - cannot auto-register card resource")
            return

        if self.resource_mode == MODE_STORAGE:
            await self._async_wait_for_lovelace_resources()
        else:
            _LOGGER.info(
                "Lovelace is in YAML mode - add this resource manually: "
                "url: %s/%s, type: module",
                URL_BASE,
                JS_FILENAME,
            )

    async def _async_register_path(self) -> None:
        """Register /voice_satellite as a static HTTP path serving frontend/."""
        try:
            await self.hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, FRONTEND_DIR, False)]
            )
            _LOGGER.debug("Static path registered: %s -> %s", URL_BASE, FRONTEND_DIR)
        except RuntimeError:
            _LOGGER.debug("Static path already registered: %s", URL_BASE)

        # Serve ONNX wake word models from /voice_satellite/models/
        models_path = Path(MODELS_DIR)
        if models_path.is_dir():
            try:
                await self.hass.http.async_register_static_paths(
                    [StaticPathConfig(MODELS_URL, MODELS_DIR, True)]
                )
                _LOGGER.debug("Models path registered: %s -> %s", MODELS_URL, MODELS_DIR)
            except RuntimeError:
                _LOGGER.debug("Models path already registered: %s", MODELS_URL)

        # Serve ONNX Runtime WASM files from /voice_satellite/ort/
        ort_path = Path(ORT_DIR)
        if ort_path.is_dir():
            try:
                await self.hass.http.async_register_static_paths(
                    [StaticPathConfig(ORT_URL, ORT_DIR, True)]
                )
                _LOGGER.debug("ORT path registered: %s -> %s", ORT_URL, ORT_DIR)
            except RuntimeError:
                _LOGGER.debug("ORT path already registered: %s", ORT_URL)

    async def _async_wait_for_lovelace_resources(self) -> None:
        """Wait for Lovelace resources to be loaded, then register."""
        max_retries = 12  # ~60 seconds total

        async def _check_loaded(_now, attempt: int = 0) -> None:
            if self.lovelace.resources.loaded:
                await self._async_register_module()
            elif attempt >= max_retries:
                _LOGGER.warning(
                    "Lovelace resources did not load after %d attempts - "
                    "card resource not auto-registered",
                    max_retries,
                )
            else:
                _LOGGER.debug("Lovelace resources not yet loaded, retrying in 5s (attempt %d/%d)", attempt + 1, max_retries)
                async_call_later(
                    self.hass, 5,
                    lambda now: self.hass.async_create_task(_check_loaded(now, attempt + 1)),
                )

        await _check_loaded(0)

    async def _async_register_module(self) -> None:
        """Register or update the JS module in Lovelace resources."""
        url = f"{URL_BASE}/{JS_FILENAME}"
        versioned_url = f"{url}?v={INTEGRATION_VERSION}"

        # Check if already registered
        existing = [
            r
            for r in self.lovelace.resources.async_items()
            if r["url"].split("?")[0] == url
        ]

        if existing:
            resource = existing[0]
            if resource["url"] != versioned_url:
                _LOGGER.info(
                    "Updating Voice Satellite Card resource to v%s",
                    INTEGRATION_VERSION,
                )
                await self.lovelace.resources.async_update_item(
                    resource["id"],
                    {"res_type": "module", "url": versioned_url},
                )
            else:
                _LOGGER.debug("Voice Satellite Card resource already up to date")
        else:
            _LOGGER.info(
                "Registering Voice Satellite Card resource v%s",
                INTEGRATION_VERSION,
            )
            await self.lovelace.resources.async_create_item(
                {"res_type": "module", "url": versioned_url}
            )

    async def async_unregister(self) -> None:
        """Remove the Lovelace resource entry (called on integration unload)."""
        if self.lovelace is None or self.resource_mode != MODE_STORAGE:
            return

        if not self.lovelace.resources.loaded:
            await self.lovelace.resources.async_load()

        url = f"{URL_BASE}/{JS_FILENAME}"
        for resource in self.lovelace.resources.async_items():
            if resource["url"].split("?")[0] == url:
                await self.lovelace.resources.async_delete_item(resource["id"])
                _LOGGER.info("Removed Voice Satellite Card Lovelace resource")
                break
