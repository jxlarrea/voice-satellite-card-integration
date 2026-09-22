"""Constants for the Voice Satellite integration."""

from typing import Final

DOMAIN: Final[str] = "voice_satellite"

# Version - synced from package.json by scripts/sync-version.js
INTEGRATION_VERSION: str = "2026.9.12"

# Bus events fired for user automations
EVENT_TIMER: Final[str] = "voice_satellite_timer"

# Frontend serving
URL_BASE: Final[str] = "/voice_satellite"
JS_FILENAME: Final[str] = "voice-satellite-card.js"
