# Usage & Services

Day-to-day use of the satellite plus every service/action it exposes.

## Contents

- [Starting the Satellite](#starting-the-satellite)
- [Voice Interaction](#voice-interaction)
- [Visual States](#visual-states)
- [Timers](#timers)
- [Announcements](#announcements)
- [Start Conversation](#start-conversation)
- [Ask Question](#ask-question)
- [Voice Satellite Wake Action](#voice-satellite-wake-action)
- [Media Player](#media-player)

## Starting the Satellite

Once you assign a satellite entity in the sidebar panel, the engine starts automatically and begins listening for wake words. If the browser blocks auto-start due to restrictions, a floating microphone button will appear - tap it to start.

If **Auto start** is disabled in the panel settings, the engine won't start on page load. Use the **Start** button in the sidebar panel to activate it manually.

## Voice Interaction

Once running, the satellite continuously listens for your configured wake word. When detected:

1. A **wake chime** plays (if enabled) and the activity bar appears
2. **Speak your command** - the engine streams audio to your STT engine and displays the transcription in real time
3. The assistant **processes your intent** and the bar animates while thinking
4. The **TTS response plays** and the response text appears on screen
5. The bar fades and the satellite returns to **wake word listening**

If the assistant asks a follow-up question or you want to continue the conversation, the engine automatically re-enters listening mode without requiring the wake word again, allowing a natural back-and-forth exchange. This requires a conversation agent that supports multi-turn conversations, such as OpenAI, Google Generative AI, Anthropic, or Ollama. The built-in Home Assistant conversation agent does not support follow-up conversations.

## Visual States

The activity bar (styled by the selected skin) indicates the current pipeline state:

| State | Activity Bar |
|-------|-------------|
| **Listening** | Hidden (waiting for wake word) |
| **Wake Word Detected** | Visible, slow animation |
| **Processing** | Visible, fast animation |
| **Speaking** | Visible, medium animation |

When **Reactive activity bar** is enabled, the bar also responds to real-time mic input and audio output levels.

## Timers

Voice-activated timers work out of the box: "Set a 5 minute timer", "Set a pizza timer for 10 minutes", "Cancel the timer". Pills appear on the overlay with a live countdown, an alert chime fires on completion, and double-tap dismisses.

Timers can also be started from automations via the `voice_satellite.start_timer` action, and the on-screen pill / alert label can be hidden via the side panel without changing how timers run.

See the [Timers reference](timers.md) for the full surface: voice sentences, action schema, automation examples, side-panel options, attributes, and multi-timer behavior.

## Announcements

Push TTS announcements to specific devices from automations:

```yaml
action: assist_satellite.announce
target:
  entity_id: assist_satellite.living_room_tablet
data:
  message: "Dinner is ready!"
```

Announcements include a pre-announcement chime (ding-dong), play the TTS message, and show the text on screen. If a voice interaction is in progress, the announcement queues and plays after the conversation ends. The announcement blocks until the browser confirms playback is complete (or a 120-second timeout expires), so you can chain actions that depend on the user hearing the message.

The display duration is configurable in the integration's device settings.

## Start Conversation

Automations can proactively speak a prompt and listen for the user's response:

```yaml
action: assist_satellite.start_conversation
target:
  entity_id: assist_satellite.living_room_tablet
data:
  start_message: "The garage door has been open for 30 minutes. Should I close it?"
  extra_system_prompt: "The user was asked about the garage door. If they confirm, call the close_cover service on cover.garage_door."
```

After the announcement plays, the engine automatically enters listening mode (skipping wake word detection) so the user can respond immediately. The response is processed through the configured conversation agent as a normal voice interaction.

## Ask Question

Automations can ask a question, capture the user's voice response, and match it against predefined answers:

```yaml
action: assist_satellite.ask_question
target:
  entity_id: assist_satellite.living_room_tablet
data:
  question: "The front door has been unlocked for 10 minutes. Should I lock it?"
  answers:
    - id: positive
      sentences:
        - "yes [please]"
        - "[go ahead and] lock it [please]"
        - "sure"
    - id: negative
      sentences:
        - "no [thanks]"
        - "leave it [unlocked]"
        - "don't lock it"
response_variable: answer
```

After the question plays, a wake chime signals the user to speak. The engine enters STT-only mode to capture the response, then matches it against the provided sentence templates using [hassil](https://github.com/home-assistant/hassil). The result is returned to the automation via `response_variable`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Matched answer ID (e.g., `"positive"`), or `null` if no match |
| `sentence` | `string` | Raw transcribed text from STT |
| `slots` | `dict` | Captured wildcard values from `{placeholder}` syntax |

Sentence templates use [hassil](https://github.com/home-assistant/hassil) syntax: `[optional words]` and `{wildcard}` placeholders. For example, `"play {genre} music"` captures the genre value in `answer.slots.genre`.

The engine provides audio and visual feedback: a done chime on successful match, or an error chime with a flashing red gradient bar when the response doesn't match any answer.

## Voice Satellite Wake Action

Trigger the satellite as if a wake word were detected. Skips wake-word listening and goes directly to STT. Works regardless of the configured wake-word detection mode (On Device, Home Assistant, or Disabled), and is the primary way to drive interactions in [Disabled mode](wake-word.md#disabled-mode).

```yaml
action: voice_satellite.wake
target:
  entity_id: assist_satellite.living_room_tablet
```

When fired, the wake chime plays and the mic begins capturing speech for STT. The rest of the pipeline (intent -> TTS -> optional continue-conversation) runs normally. Multi-turn follow-ups are preserved - once the assistant ends the turn without a continue, the mic is released.

Common uses:

- A dashboard button that says "Talk to Assist" - wire its `tap_action` to call this service
- An automation that activates the satellite when motion or a doorbell triggers
- Older devices (e.g. Android 7-9) where always-on wake-word detection isn't viable

> **Note:** The first manual wake on a fresh page load may require a prior user gesture in the tab to satisfy the browser's autoplay/permission policy. After that, the action works freely from any source.

## Media Player

Each satellite automatically exposes a `media_player` entity in Home Assistant. This entity:

- **Controls volume** for all satellite audio (chimes, TTS, announcements) via the HA volume slider
- **Reflects playback state** - shows "Playing" whenever any sound is active on the satellite
- **Supports `tts.speak`** - target the satellite as a TTS device in automations
- **Supports `media_player.play_media`** - play arbitrary audio files on the satellite
- **Supports browsing** the HA media library

```yaml
# Play audio on the satellite
action: media_player.play_media
target:
  entity_id: media_player.kitchen_tablet_media_player
data:
  media_content_id: media-source://media_source/local/doorbell.mp3
  media_content_type: music

# Use the satellite as a TTS target
action: tts.speak
target:
  entity_id: tts.piper
data:
  media_player_entity_id: media_player.kitchen_tablet_media_player
  message: "The laundry is done!"
```

The entity supports play, pause, resume, stop, volume set, and volume mute - all controllable from the HA UI or automations.
