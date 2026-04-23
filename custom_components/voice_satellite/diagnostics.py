"""Server-side diagnostic checks for the Voice Satellite panel.

Exposes a single websocket command (`voice_satellite/run_diagnostics`) that
returns a list of check results matching the shape expected by
`src/diagnostics/` on the client.

Result shape:
    {
        "id": str,                # stable identifier
        "category": str,          # UI grouping label
        "title": str,             # short title shown in the panel
        "status": "pass" | "warn" | "fail" | "info" | "skip",
        "detail": str,            # optional explanation
        "remediation": str,       # optional fix instructions
    }

Checks are intentionally defensive: a single failure must never cause the
whole command to error. A broken environment is exactly when we need the
report most.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, INTEGRATION_VERSION, JS_FILENAME, URL_BASE

_LOGGER = logging.getLogger(__name__)

CAT_HA = "Home Assistant"
CAT_URLS = "URLs and TTS"
CAT_PIPELINE = "Assist pipeline"
CAT_SATELLITE = "Satellite"
CAT_FRONTEND = "Frontend resource"
CAT_WAKE = "Wake word"


def register(hass: HomeAssistant) -> None:
    """Register the diagnostics websocket command."""
    websocket_api.async_register_command(hass, ws_run_diagnostics)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "voice_satellite/run_diagnostics",
        vol.Optional("entity_id"): vol.Any(str, None),
        vol.Optional("page_protocol"): vol.Any(str, None),
        vol.Optional("bundle_version"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_run_diagnostics(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Run the server-side check battery and return the results."""
    entity_id = msg.get("entity_id")
    page_protocol = (msg.get("page_protocol") or "").rstrip(":").lower() or None
    bundle_version = msg.get("bundle_version")

    results: list[dict[str, Any]] = []

    try:
        results.extend(_check_components(hass))
        results.extend(_check_urls(hass, page_protocol))
        results.extend(_check_version(bundle_version))
        results.extend(await _check_entity_and_pipeline(hass, entity_id))
        results.extend(_check_frontend_resource(hass))
        results.extend(_check_wake_word_assets(hass))
    except Exception as err:  # noqa: BLE001 - surface as a single result
        _LOGGER.exception("run_diagnostics crashed")
        results.append(
            _result(
                "srv.crash",
                CAT_HA,
                "Server diagnostics",
                "fail",
                detail=f"Server checks crashed: {err}",
                remediation="File a bug at https://github.com/jxlarrea/voice-satellite-card-integration/issues",
            )
        )

    connection.send_result(msg["id"], {"results": results})


# ── Components ──────────────────────────────────────────────────────


def _check_components(hass: HomeAssistant) -> list[dict[str, Any]]:
    loaded = hass.config.components
    specs = [
        ("srv.comp.assist_pipeline", "Assist Pipeline component loaded", "assist_pipeline", "fail",
         "Enable Assist in Settings → Voice assistants. Without the Assist Pipeline the satellite cannot run."),
        ("srv.comp.conversation", "Conversation Agent component loaded", "conversation", "fail",
         "Configure at least one conversation agent under Settings → Voice assistants."),
        ("srv.comp.stt", "STT component loaded", "stt", "fail",
         "Add a Speech-to-Text engine (Whisper, HA Cloud, or another provider)."),
        ("srv.comp.tts", "TTS component loaded", "tts", "fail",
         "Add a Text-to-Speech engine (Piper, Kokoro, HA Cloud, or another provider)."),
        ("srv.comp.intent", "Intent component loaded", "intent", "warn",
         "Needed for timer end notifications and intent actions."),
    ]
    out = []
    for check_id, title, component, fail_status, remediation in specs:
        if component in loaded:
            out.append(_result(check_id, CAT_HA, title, "pass"))
        else:
            out.append(
                _result(
                    check_id,
                    CAT_HA,
                    title,
                    fail_status,
                    detail=f"{component} is not loaded in Home Assistant.",
                    remediation=remediation,
                )
            )
    return out


# ── URLs and TTS mixed-content predictor ────────────────────────────


def _check_urls(hass: HomeAssistant, page_protocol: str | None) -> list[dict[str, Any]]:
    out = []
    internal = hass.config.internal_url
    external = hass.config.external_url

    out.append(_url_result(
        "srv.url.internal",
        "Home Assistant internal URL",
        internal,
        page_protocol,
        remediation_https=(
            "Set `homeassistant: internal_url: https://…` in configuration.yaml. "
            "This is the single most common cause of silent TTS when the page is served over HTTPS."
        ),
    ))
    out.append(_url_result(
        "srv.url.external",
        "Home Assistant external URL",
        external,
        page_protocol,
        remediation_https=(
            "Set `homeassistant: external_url: https://…` in configuration.yaml."
        ),
    ))
    return out


def _url_result(
    check_id: str,
    title: str,
    url: str | None,
    page_protocol: str | None,
    remediation_https: str,
) -> dict[str, Any]:
    if not url:
        return _result(
            check_id,
            CAT_URLS,
            title,
            "warn",
            detail="Not configured. Home Assistant will fall back to the internal IP.",
            remediation="Set this URL in configuration.yaml so TTS and media URLs match the page origin.",
        )
    try:
        parsed = urlparse(url)
    except Exception:  # noqa: BLE001
        return _result(check_id, CAT_URLS, title, "warn", detail=f"Could not parse: {url}")

    scheme = (parsed.scheme or "").lower()
    if page_protocol == "https" and scheme != "https":
        return _result(
            check_id,
            CAT_URLS,
            title,
            "fail",
            detail=(
                f"This page is served over HTTPS but {title.lower()} is {url}. "
                "The browser will block TTS audio as mixed content, which is the "
                "most common cause of 'text shows but no voice'."
            ),
            remediation=remediation_https,
        )
    return _result(check_id, CAT_URLS, title, "pass", detail=url)


# ── Version ─────────────────────────────────────────────────────────


def _check_version(bundle_version: str | None) -> list[dict[str, Any]]:
    if not bundle_version:
        return []
    if bundle_version == INTEGRATION_VERSION:
        return [_result(
            "srv.version",
            CAT_HA,
            "Integration version matches overlay bundle",
            "pass",
            detail=f"Both report v{INTEGRATION_VERSION}.",
        )]
    return [_result(
        "srv.version",
        CAT_HA,
        "Integration version matches overlay bundle",
        "warn",
        detail=f"Browser has v{bundle_version}, server has v{INTEGRATION_VERSION}.",
        remediation="Clear the browser cache and hard-refresh so the current bundle is fetched.",
    )]


# ── Entity + pipeline ───────────────────────────────────────────────


async def _check_entity_and_pipeline(
    hass: HomeAssistant, entity_id: str | None
) -> list[dict[str, Any]]:
    out = []
    if not entity_id:
        out.append(_result(
            "srv.entity.selected",
            CAT_SATELLITE,
            "Satellite entity selected",
            "skip",
            detail="No entity was passed to the server. Client will report this.",
        ))
        return out

    entity = _find_entity(hass, entity_id)
    if entity is None:
        out.append(_result(
            "srv.entity.exists",
            CAT_SATELLITE,
            "Selected satellite entity exists",
            "fail",
            detail=f"Entity {entity_id} is not registered in voice_satellite.",
            remediation="Pick a different entity, or add a device under Settings → Devices & Services → Voice Satellite.",
        ))
        return out
    out.append(_result(
        "srv.entity.exists", CAT_SATELLITE, "Selected satellite entity exists",
        "pass", detail=entity_id,
    ))

    # Resolve the configured pipeline via HA's assist_pipeline API
    pipeline = await _resolve_pipeline(hass, entity)
    if pipeline is None:
        out.append(_result(
            "srv.pipeline.exists",
            CAT_PIPELINE,
            "Pipeline resolvable",
            "fail",
            detail="Could not resolve the Assist pipeline configured for this satellite.",
            remediation="Open the satellite's device page and choose a pipeline in the Pipeline select.",
        ))
        return out
    out.append(_result(
        "srv.pipeline.exists", CAT_PIPELINE, "Pipeline resolvable",
        "pass", detail=f"Using pipeline '{pipeline.name}'.",
    ))

    # STT / TTS / conversation engines configured
    out.append(_stage_result("srv.pipeline.stt", "Speech-to-Text engine configured",
                             pipeline.stt_engine))
    out.append(_stage_result("srv.pipeline.tts", "Text-to-Speech engine configured",
                             pipeline.tts_engine))
    out.append(_stage_result("srv.pipeline.conversation", "Conversation agent configured",
                             pipeline.conversation_engine))

    # Availability of the STT / TTS entity states
    out.extend(_entity_available_checks(hass, pipeline))

    # Wake word checks vary by the satellite's detection mode
    out.extend(_check_wake_word_mode(hass, entity, pipeline))

    return out


WAKE_MODE_HA = "Home Assistant"
WAKE_MODE_LOCAL = "On Device"
WAKE_MODE_DISABLED = "Disabled"


def _check_wake_word_mode(hass: HomeAssistant, entity, pipeline) -> list[dict[str, Any]]:
    """Mode-aware wake word checks.

    - Home Assistant mode: pipeline must have a wake word entity and it must
      not be 'unavailable'.
    - On Device mode: the pipeline does not need wake word configured, and
      the model file lives on the client. Passed through with an info note.
    - Disabled: nothing to check.
    """
    from homeassistant.helpers import entity_registry as er

    registry = er.async_get(hass)
    ww_detection_eid = registry.async_get_entity_id(
        "select", DOMAIN, f"{entity._entry.entry_id}_wake_word_detection"
    )
    if not ww_detection_eid:
        return []
    state = hass.states.get(ww_detection_eid)
    if state is None or state.state in ("unknown", "unavailable"):
        return [_result(
            "srv.wake.mode",
            CAT_WAKE,
            "Wake word detection mode",
            "warn",
            detail="Wake word detection select is not ready.",
        )]
    mode = state.state

    out: list[dict[str, Any]] = [_result(
        "srv.wake.mode",
        CAT_WAKE,
        "Wake word detection mode",
        "info",
        detail=mode,
    )]

    if mode == WAKE_MODE_DISABLED:
        return out

    if mode == WAKE_MODE_LOCAL:
        # Inference runs in the browser; server-side checks are limited to
        # the persistent models folder (already covered by a top-level check).
        return out

    if mode == WAKE_MODE_HA:
        # Enumerate every wake_word.* entity in HA and check which ones
        # are actually usable (not 'unavailable'). HA's assist_pipeline
        # falls back to any available wake word service when the pipeline
        # itself has no wake_word_entity set, so "pipeline has wake word
        # configured" is NOT the right question to ask; "is a wake word
        # service available at all" is.
        all_ww = [
            s for s in hass.states.async_all("wake_word")
            if s.state != "unavailable"
        ]
        pipeline_wake_entity = getattr(pipeline, "wake_word_entity", None)

        if not all_ww:
            out.append(_result(
                "srv.wake.ha_service_available",
                CAT_WAKE,
                "Wake word service available",
                "fail",
                detail="No wake word service is loaded and available in Home Assistant.",
                remediation="Install and start a wake word service (for example the openWakeWord or microWakeWord add-on, or a Wyoming-based provider). Or switch the satellite to On Device wake word detection.",
            ))
            return out

        if pipeline_wake_entity:
            # The pipeline pins a specific wake word entity; verify it's one
            # of the available ones.
            match = next((s for s in all_ww if s.entity_id == pipeline_wake_entity), None)
            if match is None:
                out.append(_result(
                    "srv.wake.ha_service_available",
                    CAT_WAKE,
                    "Pipeline's wake word entity is available",
                    "fail",
                    detail=f"Pipeline is pinned to {pipeline_wake_entity}, but that entity is not available.",
                    remediation="Start the corresponding wake word add-on, or pick a different wake word entity on the pipeline.",
                ))
            else:
                out.append(_result(
                    "srv.wake.ha_service_available",
                    CAT_WAKE,
                    "Pipeline's wake word entity is available",
                    "pass",
                    detail=pipeline_wake_entity,
                ))
        else:
            # No explicit wake_word_entity on the pipeline: HA will pick
            # one of the available wake word services at runtime. Surface
            # as an info so the user knows the implicit fallback is in play.
            names = ", ".join(s.entity_id for s in all_ww)
            out.append(_result(
                "srv.wake.ha_service_available",
                CAT_WAKE,
                "Wake word service available",
                "info",
                detail=(
                    "Pipeline has no explicit wake word entity; "
                    f"Home Assistant will fall back to an available service ({names})."
                ),
            ))

    return out


async def _resolve_pipeline(hass: HomeAssistant, entity):
    """Resolve the assist_pipeline.Pipeline for a voice_satellite entity.

    Falls back through multiple paths because HA's pipeline ID storage
    has shifted across versions.
    """
    try:
        from homeassistant.components.assist_pipeline import (
            async_get_pipeline,
            async_get_pipelines,
        )
    except ImportError:
        return None

    pipeline_entity_id = getattr(entity, "pipeline_entity_id", None)
    if pipeline_entity_id:
        state = hass.states.get(pipeline_entity_id)
        if state and state.state not in ("unknown", "unavailable"):
            # State may hold the pipeline display name; async_get_pipelines
            # lets us map it back to a Pipeline object.
            try:
                pipelines = async_get_pipelines(hass)
                for p in pipelines:
                    if p.name == state.state:
                        return p
            except Exception:  # noqa: BLE001
                pass

    # Fall back to the default pipeline
    try:
        return async_get_pipeline(hass)
    except Exception:  # noqa: BLE001
        return None


def _stage_result(check_id: str, title: str, engine_value) -> dict[str, Any]:
    if engine_value:
        return _result(check_id, CAT_PIPELINE, title, "pass", detail=str(engine_value))
    return _result(
        check_id,
        CAT_PIPELINE,
        title,
        "fail",
        detail="Not configured on the Assist pipeline.",
        remediation="Settings → Voice assistants → (your pipeline) → configure this stage.",
    )


def _entity_available_checks(hass: HomeAssistant, pipeline) -> list[dict[str, Any]]:
    """Check that pipeline STT/TTS entities are loaded and not 'unavailable'.

    STT and TTS providers typically don't expose a meaningful entity state.
    Most sit in the 'unknown' state as their normal resting value. Only
    'unavailable' (provider unloaded / add-on stopped) is a real problem.
    """
    out = []
    for check_id, label, engine in (
        ("srv.pipeline.stt_available", "STT entity loaded", pipeline.stt_engine),
        ("srv.pipeline.tts_available", "TTS entity loaded", pipeline.tts_engine),
    ):
        # Pipeline engine identifiers are entity_ids when entity-backed
        # (stt.xxx / tts.xxx). Legacy string engines (e.g. "google_translate")
        # don't have an entity to inspect, skip those.
        if not engine or "." not in str(engine):
            continue
        state = hass.states.get(engine)
        if state is None:
            out.append(_result(
                check_id, CAT_PIPELINE, label, "warn",
                detail=f"Entity {engine} is not loaded in Home Assistant.",
                remediation="Reload the provider integration, or pick a different engine on the pipeline.",
            ))
            continue
        if state.state == "unavailable":
            out.append(_result(
                check_id, CAT_PIPELINE, label, "fail",
                detail=f"{engine} is unavailable.",
                remediation="Start or restart the provider (for example the Whisper or Piper add-on).",
            ))
        else:
            out.append(_result(check_id, CAT_PIPELINE, label, "pass", detail=engine))
    return out


def _find_entity(hass: HomeAssistant, entity_id: str):
    for _, ent in hass.data.get(DOMAIN, {}).items():
        if getattr(ent, "entity_id", None) == entity_id:
            return ent
    return None


# ── Frontend resource ───────────────────────────────────────────────


def _check_frontend_resource(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Verify that the Lovelace resource for the card JS is registered."""
    try:
        from homeassistant.components.lovelace.resources import (
            ResourceStorageCollection,
        )
    except ImportError:
        return []

    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        return []
    resources = (
        lovelace.resources
        if hasattr(lovelace, "resources")
        else lovelace.get("resources") if isinstance(lovelace, dict) else None
    )
    if not isinstance(resources, ResourceStorageCollection):
        # YAML resources mode, we cannot introspect, surface as info
        return [_result(
            "srv.frontend.resource",
            CAT_FRONTEND,
            "Card JS registered as a Lovelace resource",
            "info",
            detail="Lovelace is in YAML mode; resource registration happens via add_extra_js_url instead.",
        )]

    url_base = f"{URL_BASE}/{JS_FILENAME}"
    matches = [
        item for item in resources.async_items()
        if item.get("url", "").split("?")[0] == url_base
    ]
    if not matches:
        return [_result(
            "srv.frontend.resource",
            CAT_FRONTEND,
            "Voice Satellite JS registered as a Lovelace resource",
            "fail",
            detail="The Voice Satellite overlay JS is not in the Lovelace resources list.",
            remediation="Restart Home Assistant, or add the resource manually: Settings → Dashboards → Resources → Add Resource with URL /voice_satellite/voice-satellite-card.js as a JavaScript Module.",
        )]
    if len(matches) > 1:
        return [_result(
            "srv.frontend.resource",
            CAT_FRONTEND,
            "Voice Satellite JS registered as a Lovelace resource",
            "warn",
            detail=f"Found {len(matches)} resource entries. Duplicates can cause 'custom element not found' errors.",
            remediation="Delete the older entries under Settings → Dashboards → Resources.",
        )]
    return [_result(
        "srv.frontend.resource",
        CAT_FRONTEND,
        "Voice Satellite JS registered as a Lovelace resource",
        "pass",
        detail=matches[0].get("url", ""),
    )]


# ── Wake word assets ────────────────────────────────────────────────


def _check_wake_word_assets(hass: HomeAssistant) -> list[dict[str, Any]]:
    persistent = Path(hass.config.config_dir, "voice_satellite", "models")
    if not persistent.exists():
        return [_result(
            "srv.wake.persistent_dir",
            CAT_WAKE,
            "Persistent wake word models folder",
            "info",
            detail=f"{persistent} does not exist yet. It will be created on next start.",
        )]
    tflite_count = len(list(persistent.glob("*.tflite")))
    return [_result(
        "srv.wake.persistent_dir",
        CAT_WAKE,
        "Persistent wake word models folder",
        "pass",
        detail=f"{persistent} ({tflite_count} custom .tflite file(s))",
    )]


# ── Result helper ───────────────────────────────────────────────────


def _result(
    check_id: str,
    category: str,
    title: str,
    status: str,
    *,
    detail: str | None = None,
    remediation: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": check_id,
        "category": category,
        "title": title,
        "status": status,
    }
    if detail:
        out["detail"] = detail
    if remediation:
        out["remediation"] = remediation
    return out
