"""Frontend JavaScript module registration for Voice Satellite Card.

Registers the built card JS as a Lovelace resource so users don't need
to manually add it. Static path + Lovelace resources collection API.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import INTEGRATION_VERSION, URL_BASE, JS_FILENAME

_LOGGER = logging.getLogger(__name__)

WWW_DIR = str(Path(__file__).parent / "www")


class JSModuleRegistration:
    """Registers the Voice Satellite Card JS module in Home Assistant."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the registrar."""
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")

    async def async_register(self) -> None:
        """Register static path and Lovelace resource."""
        await self._async_register_path()

        if self.lovelace is None:
            _LOGGER.warning("Lovelace not available — cannot auto-register card resource")
            return

        mode = getattr(self.lovelace, "mode", "yaml")
        if mode == "storage":
            await self._async_register_module()
        else:
            _LOGGER.info(
                "Lovelace is in YAML mode — add this resource manually: "
                "url: %s/%s, type: module",
                URL_BASE,
                JS_FILENAME,
            )

    async def _async_register_path(self) -> None:
        """Register /voice_satellite as a static HTTP path serving www/."""
        try:
            await self.hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, WWW_DIR, False)]
            )
            _LOGGER.debug("Static path registered: %s -> %s", URL_BASE, WWW_DIR)
        except RuntimeError:
            _LOGGER.debug("Static path already registered: %s", URL_BASE)

    async def _async_register_module(self) -> None:
        """Register or update the JS module in Lovelace resources."""
        # Wait for resources to be loaded
        if not self.lovelace.resources.loaded:
            await self.lovelace.resources.async_load()

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
