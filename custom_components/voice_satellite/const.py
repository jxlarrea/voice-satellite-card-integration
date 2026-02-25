"""Constants for the Voice Satellite Card integration."""

from typing import Final

DOMAIN: Final[str] = "voice_satellite"
SCREENSAVER_INTERVAL: int = 5  # seconds

# Version — synced from package.json by scripts/sync-version.js
INTEGRATION_VERSION: str = "5.6.2"

# Frontend serving
URL_BASE: Final[str] = "/voice_satellite"
JS_FILENAME: Final[str] = "voice-satellite-card.js"
