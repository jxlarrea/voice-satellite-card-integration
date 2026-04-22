# Troubleshooting

## Contents

- [Running diagnostics](#running-diagnostics)
- [Nothing happens when I tap Start](#nothing-happens-when-i-tap-start)
- [Wake word not detected](#wake-word-not-detected)
- [No audio response](#no-audio-response)
- [No TTS / Audio on Announcements, Start Conversation, or Ask Question (CORS / mixed content error)](#no-tts--audio-on-announcements-start-conversation-or-ask-question-cors--mixed-content-error)

## Running diagnostics

Before digging through the rest of this page, open the **Voice Satellite** sidebar panel and scroll to **Diagnostics & troubleshooting**. Tap **Run diagnostics** to execute the full check battery against this browser and the Home Assistant server.

Checks cover the common failure modes:

- **Browser environment:** secure context (HTTPS/localhost), `navigator.mediaDevices` availability, `Permissions-Policy` for microphone and autoplay, microphone permission state, at least one audio input device, `localStorage` writeability.
- **Voice Satellite bundle:** overlay bundle loaded on this page, Lovelace resource registered exactly once (no duplicates from the archived standalone card).
- **Satellite configuration:** an entity is selected, the entity exists in Home Assistant, the Assist pipeline is resolvable, the pipeline has STT / TTS / conversation engines configured, those provider entities are loaded.
- **URLs and TTS:** Home Assistant `internal_url` and `external_url` match the page protocol. A mismatch here is the single most common cause of "text shows but TTS is silent" for `assist_satellite.announce`.
- **Wake word:** current detection mode (On Device / Home Assistant / Disabled). In Home Assistant mode, a wake word entity is configured on the pipeline and loaded.
- **Audio:** page-load autoplay probe reporting whether media element playback and `AudioContext` capture will start without a user tap. Remediation text is tailored to the current host (HA Companion App, Fully Kiosk, or a plain browser).
- **Platform:** detects Fully Kiosk, Companion App, ChromeOS, iOS, and other hosts so remediation instructions match the actual settings path.

Failures and warnings render at the top of the panel with specific remediation for your platform. Passing checks collapse into a **Show all checks** disclosure below. The **Copy report** button writes a markdown block with the full results, card/overlay version, page URL, and user agent. Paste it into a GitHub issue instead of enabling Debug Logs when asking for help.

## Nothing happens when I tap Start

1. **Check HTTPS:** Browsers require HTTPS for microphone access. If you're using HTTP, the microphone permission prompt won't appear. Use HTTPS or access via `localhost`.
2. **Check browser permissions:** Make sure the browser has microphone permission for your HA URL. Look for a microphone icon in the address bar.
3. **Check Fully Kiosk settings:** If using Fully Kiosk, ensure **Web Content Settings -> Enable Microphone Access** and **Autoplay Audio** are enabled.
4. **Check the browser console:** Open the developer tools (F12) and look for errors.

## Wake word not detected

**On-device mode (default):**

1. **Check the device settings:** Go to the satellite's device page and verify "Wake word detection" is set to "On Device" and a wake word model is selected.
2. **Try adjusting sensitivity:** Change "Wake word sensitivity" to "Very sensitive" to see if detection improves.
3. **Check browser compatibility:** On-device detection runs in pure JavaScript with `AudioWorklet` and `Float32Array` - both are supported in every current browser, but very old versions may not qualify.
4. Enable **Debug logging** in the sidebar panel to see wake word scores in the browser console (F12).

**Server-side mode ("Home Assistant"):**

1. **Verify your wake word service is running:** Check that your wake word engine (e.g., openWakeWord, microWakeWord) is available to Home Assistant - either as an add-on (**Settings -> Add-ons**) or as a Wyoming integration (**Settings -> Devices & Services**).
2. **Verify wake word detection is enabled in your pipeline:** Go to **Settings -> Voice assistants**, select your pipeline, and check that a wake word is selected. **This setting is hidden by default** - click the **three-dot menu** at the top right of the pipeline settings to reveal the wake word configuration dropdown.
3. Enable **Debug logging** in the sidebar panel to see pipeline events in the browser console (F12).

## No audio response

1. Check that TTS is configured in your Assist pipeline.
2. Check browser audio permissions.
3. If **using Fully Kiosk**, ensure that **Web Content Settings** -> **Autoplay Audio** is enabled.
4. The **Home Assistant Companion App** may block audio autoplay by default, ensure that **Settings** -> **Companion App** -> **Other settings** -> **Autoplay videos** is enabled.

Without these settings, Voice Satellite will still function (wake word detection, speech-to-text, and visual feedback all work normally) but TTS audio won't play. The UI will clean up gracefully after the interaction completes.

## No TTS / Audio on Announcements, Start Conversation, or Ask Question (CORS / mixed content error)

If normal wake word conversations play audio correctly but announcements, `assist_satellite.start_conversation`, or the Ask Question action fail silently, open the browser console (F12). If you see an error like:

```
Access to audio at 'http://<ha-ip>:8123/api/tts_proxy/...mp3' from origin 'https://<your-ha-url>' has been blocked by CORS policy
```

Your Home Assistant **internal URL** is still `http://...` while you're accessing HA over HTTPS. Browsers block this mixed content. Fix it by setting both URLs to HTTPS in `configuration.yaml`:

```yaml
homeassistant:
  external_url: "https://your-ha-url"
  internal_url: "https://your-ha-url"
```

> **WARNING:** Your Home Assistant instance **must actually be reachable over HTTPS at the internal URL** before applying this fix. If your internal URL points to a plain `http://` endpoint (for example `http://homeassistant.local:8123` or `http://192.168.x.x:8123`) and you change it to `https://` without HTTPS actually being set up on that address, Home Assistant and integrations that rely on the internal URL will break (broken links, failed media fetches, broken camera proxies, add-ons that call back to HA, etc.). Set up HTTPS first (Let's Encrypt add-on or a reverse proxy, confirm the HTTPS URL loads in a browser, then change `internal_url` to match.

Restart Home Assistant after saving. Wake word conversations work without this fix because they stream audio directly over the WebSocket, but TTS announcements fetch the MP3 via a proxy URL that HA constructs from `internal_url`.
