# Timers

Voice Satellite hooks into Home Assistant's standard timer intent system, so timers behave the same whether they're started by voice, by a dashboard button, or from an automation. The countdown pill, alert chime, and cancel paths are all shared.

## Contents

- [How timers work](#how-timers-work)
- [Voice control](#voice-control)
- [Starting a timer from an automation](#starting-a-timer-from-an-automation)
- [Cancelling and reading state](#cancelling-and-reading-state)
- [Side panel options](#side-panel-options)

## How timers work

Each satellite registers itself with Home Assistant's timer manager when it loads. Anything that creates a timer with that satellite's `device_id` as context (the voice pipeline, the `voice_satellite.start_timer` action, an LLM tool that targets the device, or any future caller of HA's `TimerManager.start_timer`) gets routed to that satellite's overlay.

What you see on the satellite:

1. **Countdown pill** appears at the top of the overlay as soon as the timer is created. The pill shows the remaining time and animates a progress bar. Multiple timers stack independently.
2. **Alert** fires when the timer reaches zero: a centered alert pill flashes, the alert chime loops, and the timer name (if any) is shown below the pill in the skin's assistant text style. The wake-word stop interrupter is enabled while the alert is active so you can say "stop" to dismiss it.
3. **Cleanup** happens on dismiss (double-tap, "stop" word, or 60-second auto-dismiss).

Pill appearance is controlled by the active skin. Both pill rendering and the timer-name label can be hidden in the side panel without affecting timer behavior, see [Side panel options](#side-panel-options).

## Voice control

These all work out of the box with the built-in Home Assistant conversation agent (and most LLM agents, since `HassStartTimer` / `HassCancelTimer` are standard HA intents):

| Sentence | Effect |
|----------|--------|
| "Set a 5 minute timer" | Starts an unnamed 5 minute timer |
| "Set a pizza timer for 10 minutes" | Starts a 10 minute timer named `pizza` |
| "Start a 1 hour 30 minute timer" | Combined hours + minutes |
| "How much time is left on the pizza timer?" | Reads the remaining time |
| "Add 5 minutes to the pizza timer" | Extends the timer |
| "Cancel the pizza timer" | Cancels by name |
| "Cancel all timers" | Clears every active timer |
| "stop" (during alert) | Dismisses the alert (requires Stop word interruption switch on the device) |

## Starting a timer from an automation

The `voice_satellite.start_timer` action creates a timer on a satellite without a voice command. The result is identical to a voice-created timer.

```yaml
action: voice_satellite.start_timer
target:
  entity_id: assist_satellite.kitchen_tablet
data:
  name: Stir the sauce
  minutes: 5
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Label saved on the timer. Used by voice cancellation ("cancel the stir the sauce timer") and by automations reading `active_timers`. Hidden from the on-screen pill by design, shown below the alert when the timer fires |
| `hours` | no | Hours portion of the duration (0-24) |
| `minutes` | no | Minutes portion (0-59) |
| `seconds` | no | Seconds portion (0-59) |

At least one of `hours` / `minutes` / `seconds` must be non-zero.

### Example: cooking reminders

A common pattern: stage several reminders for a recipe.

```yaml
alias: Sauce reminders
sequence:
  - action: voice_satellite.start_timer
    target:
      entity_id: assist_satellite.kitchen_tablet
    data:
      name: Stir the sauce
      minutes: 5
  - action: voice_satellite.start_timer
    target:
      entity_id: assist_satellite.kitchen_tablet
    data:
      name: Add herbs
      minutes: 12
  - action: voice_satellite.start_timer
    target:
      entity_id: assist_satellite.kitchen_tablet
    data:
      name: Sauce ready
      minutes: 25
```

All three pills appear immediately and tick down independently.

## Cancelling and reading state

- **From the satellite UI:** double-tap the countdown pill (or the alert pill once it fires).
- **By voice:** "Cancel the X timer" or "Cancel all timers".

The satellite entity exposes timer state for templates and triggers:

| Attribute | Type | Description |
|-----------|------|-------------|
| `active_timers` | list | Active timer objects, each with `id`, `name`, `total_seconds`, `started_at` |
| `last_timer_event` | string | Last event type: `started`, `updated`, `cancelled`, or `finished` |

Example template, true when the kitchen tablet has at least one running timer:

```jinja
{{ state_attr('assist_satellite.kitchen_tablet', 'active_timers') | length > 0 }}
```

## Side panel options

Two per-browser toggles under **Voice Satellite > Timers** in the sidebar panel:

| Setting | Default | Effect |
|---------|---------|--------|
| **Hide on-screen countdown** | Off | Suppresses the countdown pill while the timer is running. The timer still fires and the alert still plays at zero. Useful for tablets that double as a wall display where pills feel intrusive |
| **Hide timer name on alert** | Off | When a timer finishes, hides the timer name shown below the alert. The icon, time, and chime still appear |

Both are stored per-browser in localStorage. Toggling them takes effect live without restarting the engine. Existing pills get torn down on the next tick when the hide-pills flag flips on.