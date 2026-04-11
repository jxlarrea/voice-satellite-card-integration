/**
 * Voice Satellite Engine Bootstrap
 *
 * Loaded as part of the main card JS (which runs globally via
 * add_extra_js_url). Creates the session singleton and starts the
 * voice pipeline without requiring a card on any dashboard.
 *
 * If a card already started the session, the engine just keeps
 * feeding hass updates across page navigations.
 */

import { VERSION, DEFAULT_CONFIG } from '../constants.js';
import { VoiceSatelliteSession } from '../session';
import { resolveEntity } from '../shared/entity-picker.js';
import { preloadChimes } from '../audio/chime.js';
import { startDiagnostics } from '../diagnostics.js';

const ENGINE_KEY = '__vsEngine';
const CONFIG_KEY = 'vs-panel-config';

/** Read full panel config from localStorage. */
function getStoredConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

/**
 * Initialize the global engine. Safe to call multiple times —
 * guards against double-init.
 */
export function initEngine() {
  if (window[ENGINE_KEY]) return;
  window[ENGINE_KEY] = true;

  console.info(
    `%c VOICE-SATELLITE-ENGINE %c v${VERSION} `,
    'color: white; background: #4caf50; font-weight: bold;',
    'color: #4caf50; background: white; font-weight: bold;',
  );

  bootstrapEngine();
}

async function bootstrapEngine() {
  const ha = await waitForHass();
  const session = VoiceSatelliteSession.getInstance();

  // Preload chime sound files so the first play has zero fetch latency
  preloadChimes();

  // Start memory diagnostics if enabled (?vs_diag=true)
  startDiagnostics(session);

  // Start continuous hass feed (survives page navigations)
  startHassObserver(ha, session);

  // Attempt entity resolution and start
  attemptStart(ha.hass, session);

  // Explicit WASM teardown on page unload. The browser is supposed
  // to tear everything down for us, but on memory-constrained
  // Android WebViews (Fully Kiosk on wall-mounted tablets) there's
  // a window where the outgoing page's compiled WASM code still
  // occupies V8's code-space pool while the incoming page is
  // already allocating, and the process loses that race and the
  // WebView crashes. Calling session.teardown() from `pagehide`
  // gives V8 a head start on reclaiming TFLite + micro-frontend
  // linear memory, destroys the AudioWorklet, and stops the mic
  // MediaStream before navigation completes.
  //
  // `pagehide` fires on both reload and bfcache navigation on
  // mobile, unlike `beforeunload`. Synchronous — the release path
  // and audio teardown both run to completion in the handler.
  window.addEventListener('pagehide', () => {
    try {
      console.info('[VS] pagehide — tearing down session for WASM reclaim');
      session.teardown();
    } catch (e) {
      console.warn('[VS] pagehide teardown failed:', e);
    }
  });
}

/**
 * Try to resolve the satellite entity and start the session.
 * Called on init and whenever hass updates with no entity configured.
 */
function attemptStart(hass, session) {
  if (session.isStarted) return;
  if (session._starting) return;
  if (session._userStopped) return;

  // Respect auto_start setting from panel config
  const storedConfig = getStoredConfig();
  if (storedConfig.auto_start === false) return;

  const entityId = resolveEntity(hass);
  if (!entityId) return;

  // Merge panel config (skin, mic settings, etc.) from localStorage
  const config = Object.assign({}, DEFAULT_CONFIG, getStoredConfig(), {
    satellite_entity: entityId,
  });
  session.updateConfig(config);
  session.updateHass(hass);

  // Create a full card instance so the global UI overlay renders
  // even when no card is placed on any dashboard. Registration
  // happens in the card's rAF, so wait a frame before starting.
  ensureEngineCard(hass, session, config);

  // Try starting after the card registers (rAF). If the browser blocks
  // mic/AudioContext due to missing user gesture, startListening handles
  // it gracefully and shows the start button for the user to tap.
  if (!session.isStarted && !session._startAttempted) {
    requestAnimationFrame(() => {
      if (!session.isStarted) {
        session.start();
      }
    });
  }
}

/**
 * Create a hidden full card element and register it with the session.
 * This ensures the global UI overlay (rainbow bar, start button, chat)
 * renders even without a dashboard card. No-op if a card is already registered.
 */
function ensureEngineCard(hass, session, config) {
  if (session._cards.size > 0) return;

  const card = document.createElement('voice-satellite-card');
  card._engineOwned = true;
  card.setConfig(config);
  card.style.display = 'none';
  document.body.appendChild(card);
  card.hass = hass;
}

/**
 * Wait for the home-assistant element and its hass + connection.
 * @returns {Promise<HTMLElement>}
 */
function waitForHass() {
  return new Promise((resolve) => {
    const check = () => {
      const ha = document.querySelector('home-assistant');
      if (ha?.hass?.connection) {
        resolve(ha);
        return;
      }
      setTimeout(check, 200);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check, { once: true });
    } else {
      check();
    }
  });
}

/**
 * Poll hass changes and feed them to the session. Also re-attempts
 * entity resolution if the session hasn't started yet (e.g. user
 * just added the integration, entity wasn't available at boot).
 */
function startHassObserver(ha, session) {
  let lastHass = ha.hass;

  session._hassObserverInterval = setInterval(() => {
    if (!ha.hass || ha.hass === lastHass) return;
    lastHass = ha.hass;

    session.updateHass(lastHass);

    // Re-attempt start if entity wasn't available before
    if (!session.config.satellite_entity || !session.isStarted) {
      attemptStart(lastHass, session);
    }
  }, 1000);
}

