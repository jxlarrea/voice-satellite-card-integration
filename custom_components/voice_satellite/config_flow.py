"""Config flow for Voice Satellite Card integration."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class VoiceSatelliteConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Voice Satellite Card."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, str] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step — user enters a name for the satellite."""
        errors: dict[str, str] = {}

        if user_input is not None:
            name = user_input["name"].strip()

            # Check for duplicate names across existing entries
            await self.async_set_unique_id(name.lower().replace(" ", "_"))
            self._abort_if_unique_id_configured()

            return self.async_create_entry(title=name, data={"name": name})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required("name"): str,
                }
            ),
            errors=errors,
        )
