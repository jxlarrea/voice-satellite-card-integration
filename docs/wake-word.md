# On-Device Wake Word Detection

Voice Satellite includes built-in wake word detection that runs entirely in the browser - no server-side wake word service required. Three on-device engines are available: **vsWakeWord** (purpose-built for tablets, recommended where WebGPU is available), **microWakeWord** (default, runs on every device), and **openWakeWord** (broader keyword library, requires WebGPU).

## Contents

- [Engines](#engines)
- [Performance comparison](#performance-comparison)
- [How It Works](#how-it-works)
- [Built-in Wake Words](#built-in-wake-words)
- [Custom Wake Words](#custom-wake-words)
- [Configuration](#configuration)
- [Dual Wake Words and Pipelines](#dual-wake-words-and-pipelines)
- [Stop Word Interruption](#stop-word-interruption)
- [Disabled Mode](#disabled-mode)

## Engines

All three engines run entirely in the browser in pure JavaScript and produce the same wake-event output (state transitions, chimes, pipeline routing). They differ in model architecture, runtime requirements, and the audio conditions they were trained for.

| | **vsWakeWord** | **microWakeWord** | **openWakeWord** |
|---|---|---|---|
| Trained for | **Wall-mounted tablets** (off-axis far-field capture, household background noise) | General-purpose, microcontroller-class devices | General-purpose, broad speaker / accent corpus |
| Architecture | Phoneme decoder + per-keyword phoneme matcher with layered runtime gating | Per-keyword streaming binary classifier | Shared mel + embedding feeding per-keyword binary classifiers |
| Where it runs | WebGPU | CPU only | Mel + embedding on GPU, classifiers on CPU |
| Multi-keyword scaling | Small per-keyword matcher, no shared frontend cost | Each added keyword pays full model cost on CPU | Near-flat - mel + embedding shared, each added keyword adds a sub-millisecond classifier |
| Interpretable triggers | **Yes** - every detection logs its decoded phonemes | No (opaque probability) | No (opaque probability) |
| Requires WebGPU | **Yes** | No | **Yes** |
| Available on | Devices reporting `navigator.gpu` | Every device with `AudioWorklet` | Devices reporting `navigator.gpu` |

### Why pick vsWakeWord
- **Built for the Voice Satellite use case.** Models are trained specifically for wall-mounted tablets capturing off-axis speech in real living-room conditions (mic distance, background TV/music, household acoustics). MWW and OWW were trained for general-purpose use and weren't optimized for this scenario.
- **Best recall and zero false positives** in cross-engine benchmarks (see [Performance comparison](#performance-comparison)).
- **Interpretable triggers.** vsWakeWord decodes audio into phonemes and matches the wake word's phoneme sequence directly. Every detection logs its decoded phonemes, so false-positive debugging is concrete instead of guesswork. MWW and OWW only output a probability score - when they fire incorrectly there's no signal in the log to explain why.
- **Smaller than openWakeWord.** vsWakeWord models run at roughly half the disk and VRAM footprint of openWakeWord, with no fixed shared-frontend overhead.

### Why pick microWakeWord
- Works on every device, including older Android tablets and any browser without WebGPU.
- The microWakeWord wake-word collection has years of real-world tuning behind it and is what the ESPHome / HA Voice PE ecosystem ships.
- Lowest per-chunk latency (~1 ms) - matters on ultra-constrained hardware, otherwise all three engines are well inside the 80 ms real-time budget.

### Why pick openWakeWord
- **Largest pre-trained keyword library.** Ships with a wider catalog of out-of-the-box wake words than vsWakeWord currently provides.
- **Strong speaker / accent generalization.** The 96-dim shared embedding was trained on a much broader speech corpus than any single MWW model.
- **Near-free multi-keyword scaling.** Mel + embedding are computed once per chunk regardless of how many keywords you load.

### Default and fallback
microWakeWord is the default detection mode on fresh installs because it works on every device. If you select vsWakeWord or openWakeWord on a device without WebGPU, the satellite shows an error toast and asks you to switch back - the GPU requirement is enforced, not a soft fallback.

On devices where Chrome blocks the standard (Vulkan-backed) WebGPU tier - notably Android 11 and older, where `requestAdapter()` always returns null - the engines automatically retry with a **compatibility-tier adapter** (`featureLevel: 'compatibility'`, backed by OpenGL ES). This unlocks real hardware acceleration on older tablets. Expect higher per-chunk inference times than on a Vulkan-backed device; when inference can't keep up with real time, the engine automatically skips the GPU run for backlogged chunks (audio still enters the feature window) so wake latency stays bounded instead of drifting.

The two GPU engines tolerate that skipping very differently. vsWakeWord re-reads its whole 1.3 s feature window on every inference, so skipped chunks only stretch confirmation latency - detection quality is preserved even when half the chunks are skipped. openWakeWord's streaming classifier expects one embedding per 80 ms chunk; sustained skipping compresses its feature timeline and detection accuracy collapses. On a device too slow to run openWakeWord at full rate, the engine logs a one-time warning recommending vsWakeWord or microWakeWord instead.

vsWakeWord's conv shaders are deliberately generic (shapes in uniform buffers, no per-layer specialization): heavily specialized kernels crash the fragile shader compilers found in Android WebView and GLES drivers, and on healthy devices the measured cost of the generic kernels is about 1 ms per chunk - far below the 80 ms budget.

If your device supports WebGPU and your wake word is available as a vsWakeWord model, **vsWakeWord is the recommended choice** - particularly on wall-mounted tablets, which is what the models were trained for. Pick openWakeWord when you need a keyword that vsWakeWord doesn't ship yet, or when you specifically want OWW's behavior. Stick with microWakeWord if your device has no WebGPU.

## Performance comparison

Cross-engine benchmark of the `ok_nabu` wake word. Per-clip detection: any window in the clip producing a confirmed detection through each engine's full runtime gating. Test mix covers a real on-axis recording, a real off-axis tablet recording with TV in the background, a sample of synthesized variants across multiple voices, and negative speech from long-form broadcast and crowdsourced dictation corpora.

| Metric | **vsWakeWord** | microWakeWord | openWakeWord |
|---|---|---|---|
| **Recall** (positives detected) | **100%** | 59% | 50% |
| **Clip false-positive rate** | **0%** | 3.3% | 0% |
| Off-axis tablet recording | **Detected** | Detected | Detected |
| Per-chunk latency (p50, WebGPU) | 4.8 ms | 1.1 ms (CPU) | 4.6 ms |
| Single wake + stop disk footprint | 0.95 MB | 0.20 MB | 3.74 MB |
| Estimated VRAM (dual wake + stop) | ~3-4 MB | ~1-2 MB | ~6-8 MB |

vsWakeWord is the only engine to hit both 100% recall and 0% clip false-positives on this set. openWakeWord matches on FP rate but recalls only half the positives. microWakeWord lands in the middle on recall and triggers on one negative. Latency on the deployed tablet is well inside the 80 ms per-chunk budget for all three engines (microWakeWord is the fastest in absolute terms because its int8 TFLite model is tiny, but the GPU engines are deeply inside the budget too).

The benchmark uses a fixed test set and a single wake word, so the percentages are directional rather than guaranteed across every deployment. Latency was measured on the tablet running Voice Satellite, not synthetic hardware.

## How It Works

### vsWakeWord (VWW)
Decodes each audio chunk into a per-frame phoneme distribution via a WebGPU CNN, then matches the wake word's expected phoneme sequence directly against the decoded frames using an anchored edit-distance matcher with several runtime gating layers (consecutive-hit smoothing, per-matched-phoneme confidence threshold, asymmetric window matching, end-anchor trail tolerance). The matcher rejects decodes missing the wake-discriminating phonemes and rejects mid-utterance embeddings of the wake shape. Each detection logs the decoded phonemes that triggered it, so false positives can be diagnosed and the gating tuned without retraining the model.

### microWakeWord (MWW)
Runs streaming int8 TFLite models entirely in pure JavaScript: a hand-rolled interpreter for the streaming model plus a bit-exact port of the TFLM audio frontend (windowing, KISS FFT, mel filterbank, noise reduction, PCAN, log-scale). Each chunk produces an updated probability via a sliding window, so the model can fire on the very first audio frame after warmup. One full model per keyword.

### openWakeWord (OWW)
Runs a three-stage pipeline: a shared mel-spectrogram model, a shared embedding model, and one classifier per keyword. The mel + embedding stages are dispatched as WebGPU compute shaders generated per-layer, with weights baked into the WGSL at compile time so the shader stack runs without per-call buffer round-trips. Classifiers stay on CPU since each one is sub-millisecond. The whole pipeline is pure JavaScript - no WebAssembly is loaded. WebGPU is required because the embedding stage is too heavy to run on CPU within the 80 ms real-time budget, so the engine refuses to start on devices that don't expose `navigator.gpu`. Because mel + embedding are shared across keywords, adding a second wake word adds only a tiny classifier - the same shared backbone is what makes OWW efficient for multi-keyword setups.

### Common to all three engines

The browser continuously processes audio and runs lightweight keyword classifiers to detect the wake word. Audio is only streamed to Home Assistant after detection. This means:

- **Lower latency** - detection happens instantly on the device, no network round-trip
- **Reduced server load** - audio is only sent to HA for STT after the wake word is detected
- **No wake word add-on required** - works without vsWakeWord, openWakeWord, or microWakeWord installed on HA
- **Energy-efficient** - optional noise gate pauses inference during silence and resumes instantly when sound is detected (enable via the "Wake word noise gate" switch)
- **Optional stop-word interruption** - enable the "Stop word interruption" switch if you want the browser to listen for a stop keyword during timer alerts, TTS, and announcement playback. See [Stop Word Interruption](#stop-word-interruption) for the keyword each engine uses

## Custom Wake Words

Drop your model file in the right folder, restart Home Assistant, and it appears in the "Wake word model" dropdown for the matching engine.

| Engine | Model file | Drop folder |
|---|---|---|
| vsWakeWord   | `.onnx` (+ companion `.json` manifest) | `config/voice_satellite/models/vswakeword/` |
| microWakeWord | `.tflite` | `config/voice_satellite/models/` |
| openWakeWord  | `.onnx` classifier | `config/voice_satellite/models/openwakeword/` |

If the model has a companion `.json` manifest, place it next to the model file with the same base filename. The filename without its extension becomes the dropdown label - `hey_computer.tflite` for microWakeWord, `hey_computer.onnx` for openWakeWord, or `hey_computer.onnx` (with `hey_computer.json`) for vsWakeWord all appear as `hey_computer`. vsWakeWord models always require their `.json` manifest (it carries the phoneme target sequence and per-model gating parameters). Only OWW classifier `.onnx` files go in the custom openWakeWord folder; the shared mel-spectrogram and embedding models are bundled.


## Configuration

All wake word settings are configured per-device on the satellite's device page (**Settings -> Devices & Services -> Voice Satellite -> [device]**):

- **Wake word detection** - one of:
  - **On Device (microWakeWord)** *(default)* - runs MWW locally on CPU
  - **On Device (openWakeWord)** - runs OWW locally on WebGPU
  - **On Device (vsWakeWord)** - runs VWW locally on WebGPU (recommended for wall-mounted tablets that support WebGPU)
  - **Home Assistant** - server-side detection via the pipeline's wake word service
  - **Disabled** - no automatic listening
- **Wake word 1** - primary wake word (always active in any On Device mode). The dropdown is engine-specific: switching between engines shows the right model list automatically
- **Wake word 2** - optional second wake word with its own pipeline, defaults to "Disabled". See [Dual Wake Words and Pipelines](#dual-wake-words-and-pipelines)
- **Pipeline 1** - Assist pipeline used when Wake word 1 fires (this is the device's default pipeline)
- **Pipeline 2** - Assist pipeline used when Wake word 2 fires, only shown when Wake word 2 is enabled
- **Stop word interruption** - optional on-device stop keyword that can cancel timer alerts, TTS, and announcement playback. Disabled by default. Keyword is engine-specific: `"stop"` on microWakeWord and openWakeWord, `"ok stop"` on vsWakeWord. See [Stop Word Interruption](#stop-word-interruption)
- **Wake word sensitivity** - "Slightly sensitive", "Moderately sensitive" (default), or "Very sensitive" (shared by both slots)

To use server-side detection instead, set "Wake word detection" to "Home Assistant". This requires a wake word service (openWakeWord or microWakeWord) configured in your Assist pipeline. Server-side detection is single-slot only - dual wake words require On Device mode.

## Dual Wake Words and Pipelines

Voice Satellite can listen for two wake words at the same time and route each to its own Assist pipeline. Common use cases:

- **Dual language** - "Okay Nabu" runs an English pipeline, "Hey Jarvis" runs a Spanish one
- **Local + cloud** - one wake word hits a fully-local Speech-to-Phrase + Piper pipeline, the other routes to an LLM-backed cloud pipeline for harder questions
- **Per-character personalities** - pair each wake word with its own conversation agent and Piper voice to switch between characters (e.g. "Hey Jarvis" vs. "Hey Bender") without a sentence trigger and without bouncing through an LLM

### How to configure

1. Set **Wake word detection** to one of the On Device modes (vsWakeWord, microWakeWord, or openWakeWord).
2. Pick a primary model in **Wake word 1** and the pipeline you want it to route to in **Pipeline 1**.
3. Pick a different model in **Wake word 2** - the select defaults to "Disabled".
4. Pick the target pipeline for slot 2 in **Pipeline 2**. "Preferred" falls back to Pipeline 1, effectively making slot 2 inert.

For microWakeWord, the runtime loads both TFLite models into a single shared feature extractor and runs both classifiers in parallel. Per-keyword quantization is applied at the model input, so the two models can have different training parameters without interfering. For openWakeWord, both ONNX classifiers share the same mel + embedding frontend, so the second wake word adds only a small classifier pass. For vsWakeWord, each wake word is matched against the same per-frame phoneme decode, so the second wake word only adds a second matcher pass (no shared frontend to amortize, but no per-keyword backbone either).

### Details and edge cases

- **Single-slot quantization:** this is a real change to the feature pipeline used by every satellite, single-slot included. Detection accuracy should be identical to before; if you see a regression file an issue with the model name and wake word sensitivity.
- **Same model in both slots:** silently deduped - only one copy loads and every detection routes to Pipeline 1. The diagnostics panel surfaces a warning so you know Pipeline 2 is inert until you pick a different model.
- **Sensitivity is shared:** one sensitivity slider controls both slots. File an issue if per-slot sensitivity would help your setup.
- **Chime is shared:** both wake words use the same wake chime.
- **CPU cost:** running two models roughly doubles inference work for microWakeWord. openWakeWord shares mel + embedding across both slots, so the only added cost is the second classifier (<1 ms). vsWakeWord runs the phoneme decoder once and adds a second matcher pass per slot - the matcher is cheap, so dual slot is comfortable on any device that runs single-slot. Modern desktops, Galaxy Tab S8, and Fire HD 10 (2021+) handle MWW dual-slot without trouble. On older or low-powered devices, stick to one slot or enable the "Wake word noise gate" switch to pause inference during silence.

## Stop Word Interruption

The **Stop word interruption** switch on the satellite's device page enables an on-device stop keyword that can cancel timer alerts, TTS playback, announcements, ask_question prompts, and start_conversation prompts. It's disabled by default to avoid extra CPU/memory on slower devices.

### Which keyword to say

The exact keyword depends on the active wake-word engine, because each engine ships its own stop classifier trained on a different phrase:

| Engine | Say this | Model file |
|---|---|---|
| **vsWakeWord** | **"ok stop"** | bundled `vswakeword/ok_stop.onnx` |
| microWakeWord | **"stop"** | bundled `stop.tflite` |
| openWakeWord | **"stop"** | bundled `openwakeword/stop.onnx` |

If you switch engines, the keyword switches with it - no extra configuration. Saying the wrong phrase for the active engine just won't trigger. vsWakeWord uses the longer "ok stop" because a single-syllable "stop" classifier tuned at the recall vsWakeWord targets would false-trigger on common conversational speech.

### How it behaves

- The stop classifier only listens during interruptible states (timer alert active, TTS playing, notification audio playing). It stays dormant the rest of the time.
- On wake-word slot 1 / slot 2: only the primary wake word(s) trigger fresh interactions. The stop classifier is a separate slot, loaded once and reused across all interruptible states.
- It's a hard cancel - same effect as a double-tap dismiss. For timer alerts the alert chime stops and the alert pill clears. For TTS or notification audio the playback is interrupted and the done chime fires.
- Cost when enabled: one extra classifier head running only during interruptible windows. Negligible CPU on every supported device.

## Disabled Mode

Set "Wake word detection" to **Disabled** when you want full manual control over when the satellite listens. The microphone stream is **not activated at all** until you explicitly trigger a wake. Useful for older or low-powered devices (e.g. Android 7-9 tablets where always-on detection is unreliable), shared spaces where passive listening isn't wanted, or fully automation-driven workflows.

In Disabled mode:

- The mic stays off and no audio is streamed to Home Assistant
- Announcements, `start_conversation`, and `ask_question` from automations still work normally - they bring the mic up only for the brief STT phase, then release it
- Trigger listening via the [`voice_satellite.wake`](usage.md#voice-satellite-wake-action) action from a dashboard button, automation, or the mini card's mic icon

The mini card keeps its small mic-dot icon visible so users can tap to talk. The full card stays clean - wake it via the action.
