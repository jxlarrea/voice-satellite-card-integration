"""Same-origin media stream proxy.

Some media sources (notably Music Assistant) only serve audio over plain
HTTP from a separate stream server, and refuse to serve it over HTTPS by
design.  When the Voice Satellite panel is loaded over HTTPS - which it
must be, for microphone access - the browser blocks those HTTP streams as
mixed content, and playback silently fails.

This proxy resolves that the same way Home Assistant's own tts_proxy and
camera_proxy do: the integration registers the upstream HTTP URL behind
an unguessable capability token and hands the browser a *same-origin*
path (`/api/voice_satellite/media_proxy/<token>`).  The browser fetches
that over the HA HTTPS origin; the integration fetches the real stream
server-side (server-to-server HTTP, no mixed-content rule) and pipes the
bytes through.  Range requests (seeking) and the endless chunked streams
Music Assistant uses in flow mode are both handled.

The token is the capability: it is 256-bit random, expires, and only
ever maps to a URL an authenticated `media_player.play_media` call
registered - so this is not an open relay.
"""

from __future__ import annotations

import logging
import secrets
import time

from aiohttp import ClientError, ClientTimeout, web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_STORE_KEY = f"{DOMAIN}_media_proxy"
_VIEW_KEY = f"{DOMAIN}_media_proxy_view"

# How long a registered URL stays resolvable.  Flow-mode streams can run
# for a long time (one URL for a whole queue), and a user may pause for a
# while and resume, so keep tokens valid for a day.
TOKEN_TTL_S = 24 * 60 * 60
# Bound the store so a long-running server can't accumulate tokens without
# limit; oldest entries are evicted first.
MAX_TOKENS = 256
# Chunk size for piping the upstream body to the client.
CHUNK_BYTES = 64 * 1024
# Headers worth carrying from the upstream response to the client so
# seeking and content typing work.
_PASSTHROUGH_HEADERS = (
    "Content-Type",
    "Content-Length",
    "Accept-Ranges",
    "Content-Range",
    "Cache-Control",
)


def async_setup_media_proxy(hass: HomeAssistant) -> None:
    """Register the proxy view once for the whole integration."""
    if hass.data.get(_VIEW_KEY):
        return
    hass.data.setdefault(_STORE_KEY, {})
    hass.http.register_view(VoiceSatelliteMediaProxyView())
    hass.data[_VIEW_KEY] = True


def register_proxied_url(hass: HomeAssistant, url: str) -> str:
    """Register an upstream URL and return a same-origin proxy path.

    Returns a root-relative path the browser resolves against the HTTPS
    origin it is already on, so the result is never mixed content.
    """
    store: dict[str, dict] = hass.data.setdefault(_STORE_KEY, {})
    now = time.monotonic()

    # Drop expired entries, then cap the store (oldest-first eviction).
    expired = [tok for tok, rec in store.items() if rec["expires"] < now]
    for tok in expired:
        del store[tok]
    if len(store) >= MAX_TOKENS:
        for tok in sorted(store, key=lambda t: store[t]["expires"])[: len(store) - MAX_TOKENS + 1]:
            del store[tok]

    token = secrets.token_urlsafe(32)
    store[token] = {"url": url, "expires": now + TOKEN_TTL_S}
    return f"/api/voice_satellite/media_proxy/{token}"


class VoiceSatelliteMediaProxyView(HomeAssistantView):
    """Stream an upstream media URL through the HA origin."""

    url = "/api/voice_satellite/media_proxy/{token}"
    name = "api:voice_satellite:media_proxy"
    # The token is the capability; this is not behind normal auth so the
    # browser's <audio> element (which cannot attach auth headers) can
    # fetch it.  The token is unguessable and short-lived.
    requires_auth = False

    async def get(self, request: web.Request, token: str) -> web.StreamResponse:
        """Proxy a GET, forwarding Range and streaming the body."""
        return await self._proxy(request, token, body=True)

    async def head(self, request: web.Request, token: str) -> web.StreamResponse:
        """Proxy a HEAD (some players probe before playing)."""
        return await self._proxy(request, token, body=False)

    async def _proxy(
        self, request: web.Request, token: str, *, body: bool
    ) -> web.StreamResponse:
        hass: HomeAssistant = request.app["hass"]
        store: dict[str, dict] = hass.data.get(_STORE_KEY, {})
        record = store.get(token)
        if record is None or record["expires"] < time.monotonic():
            store.pop(token, None)
            return web.Response(status=404, text="Not found")

        upstream_url = record["url"]
        # Defensive: only ever proxy plain web schemes we registered.
        if not (upstream_url.startswith("http://") or upstream_url.startswith("https://")):
            return web.Response(status=400, text="Unsupported URL")

        # Forward only the Range header; the upstream is a dumb media
        # server and anything else risks confusing it.
        upstream_headers = {}
        if (rng := request.headers.get("Range")) is not None:
            upstream_headers["Range"] = rng

        session = async_get_clientsession(hass)
        # No read timeout: flow-mode streams are effectively endless and a
        # client disconnect (below) is what ends them, not a timer.
        timeout = ClientTimeout(total=None, connect=30, sock_connect=30, sock_read=None)

        try:
            upstream = await session.request(
                "GET", upstream_url, headers=upstream_headers, timeout=timeout
            )
        except (ClientError, TimeoutError) as err:
            _LOGGER.warning("media proxy: upstream request failed: %s", err)
            return web.Response(status=502, text="Upstream unavailable")

        try:
            response = web.StreamResponse(status=upstream.status)
            for header in _PASSTHROUGH_HEADERS:
                if (value := upstream.headers.get(header)) is not None:
                    response.headers[header] = value
            if "Accept-Ranges" not in response.headers:
                response.headers["Accept-Ranges"] = "bytes"

            if not body:
                await response.prepare(request)
                await response.write_eof()
                return response

            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(CHUNK_BYTES):
                await response.write(chunk)
            await response.write_eof()
            return response
        except (ConnectionResetError, ConnectionError):
            # Browser stopped/seeked/closed the stream - normal, not an error.
            _LOGGER.debug("media proxy: client disconnected")
            return response
        except ClientError as err:
            _LOGGER.warning("media proxy: upstream stream error: %s", err)
            return response
        finally:
            upstream.close()
