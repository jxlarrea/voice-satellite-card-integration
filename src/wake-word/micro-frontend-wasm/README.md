# micro-frontend-wasm

WebAssembly build of the TensorFlow Lite **`micro_frontend`** C library
— the audio feature pipeline used by ESPHome's `micro_wake_word`
component, the Voice PE hardware satellite, and the Home Assistant
Android app. This subproject lets the browser path use the same
bit-exact code so detection reliability matches the native references.

## Why

The browser-side wake word detection originally used a hand-rolled
JavaScript port of `micro_frontend` ([../micro-frontend.js](../micro-frontend.js)).
That port had numerical drift relative to the C reference (most
notably in `pcanShrink`, the noise reduction smoothing, and the FFT
rounding). For permissive models like `ok_nabu` (cutoff 0.85) the
drift was tolerable, but for picky models like `hey_jarvis` (cutoff
0.97) it pushed the model output below threshold and detection became
unreliable.

This project compiles the actual reference C code to WASM so the
browser pipeline produces features identical to what the C reference
produces, byte for byte.

## Layout

```
micro-frontend-wasm/
├── README.md              ← this file
├── Dockerfile             ← reproducible build environment (pinned emsdk)
├── docker-build.py        ← one-shot build wrapper (recommended, portable)
├── Makefile               ← emscripten build rules
├── wrapper.cc             ← Embind C++ wrapper (small shim)
├── index.js               ← JS loader / public API
├── scripts/
│   └── fetch-sources.sh   ← downloads pinned third-party C sources
├── third_party/           ← populated by fetch-sources.sh (gitignored)
│   ├── tflite-micro/
│   │   └── tensorflow/lite/experimental/microfrontend/lib/...
│   └── kissfft/
│       ├── kiss_fft.{c,h}
│       ├── _kiss_fft_guts.h
│       └── tools/kiss_fftr.{c,h}
└── dist/                  ← build output (gitignored)
    └── micro-frontend.js  ← single-file ES module (WASM embedded)
```

## Pinned versions

The third-party source versions are pinned in
[`scripts/fetch-sources.sh`](scripts/fetch-sources.sh) and **must match**
the versions used by the HA Android app
([`microwakeword/src/main/cpp/CMakeLists.txt`](https://github.com/home-assistant/android/blob/main/microwakeword/src/main/cpp/CMakeLists.txt))
so the bit-exact guarantee holds.

| Dependency      | Source                                          |
|-----------------|-------------------------------------------------|
| tflite-micro    | github.com/tensorflow/tflite-micro @ `2747abd5` |
| kissfft         | github.com/mborgerding/kissfft @ `7bce4153`     |

## Build

### Recommended: Docker (no host toolchain needed)

```bash
cd src/wake-word/micro-frontend-wasm
python docker-build.py
```

(Use `python3` instead of `python` if your distro splits them.)

That's it. The wrapper script:
1. Builds a small Docker image based on `emscripten/emsdk:3.1.69`
   (cached after the first run — subsequent builds skip image creation).
2. Mounts this directory into the container.
3. Fetches the pinned third-party C sources into `third_party/`.
4. Compiles `wrapper.cc` + the C library into `dist/micro-frontend.js`
   with the WASM embedded.
5. On Linux/macOS, maps file ownership back to your host user so the
   output isn't owned by root. On Windows Docker Desktop handles this
   automatically.

You only need:
- Docker (Docker Desktop on Windows/macOS, docker engine on Linux)
- Python 3.6+

No emsdk, no make, no C toolchain on the host.

Pass extra Makefile targets through if you need them:

```bash
python docker-build.py fetch       # only download third_party sources
python docker-build.py clean       # remove dist/
python docker-build.py distclean   # remove dist/ and third_party/
```

### Alternative: native install (for tinkering)

If you want to iterate on the C wrapper or experiment with emcc flags
without spinning a container each time, install Emscripten directly:

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh    # adds emcc to PATH for the current shell
```

Verify:
```bash
emcc --version
```

On Windows, use the equivalent `emsdk_env.bat` from a shell where you
plan to run `make`. Git Bash works fine.

Then from this directory:

```bash
make            # fetches sources (if needed) and compiles
make fetch      # only download third_party/ sources
make clean      # remove dist/
make distclean  # remove dist/ and third_party/
```

The output is two files in `dist/`:
- `micro-frontend.js` — emscripten JS glue (~44 KB)
- `micro-frontend.wasm` — compiled WebAssembly binary (~38 KB)

`scripts/copy-microfrontend.js` (run from the npm `predev`/`prebuild`
hook) copies both into `custom_components/voice_satellite/wake-word-frontend/`,
which `frontend.py` registers as a static path. The runtime loads
`micro-frontend.js` via a `<script>` tag (same pattern as `loadTFLite()`
in `micro-models.js` uses for the much larger TFLite Web API client),
and the JS glue fetches `micro-frontend.wasm` via `locateFile`.

## Public API (from `index.js`)

```js
import { createWasmMicroFrontend } from './micro-frontend-wasm';

const fe = await createWasmMicroFrontend();

// Configure per-model input quantization (optional — defaults match
// all known V2 micro-wake-word models).
fe.setQuantization(scale, zeroPoint);

// Stream audio (16 kHz mono float32, [-1, 1])
const features = fe.feed(samples);   // → Int8Array[40][]
for (const frame of features) {
  // pass to TFLite model input
  fe.recycleFeature(frame);
}

// Reset adaptive state (only on session boundaries)
fe.reset();

// Destroy on teardown to release WASM memory
fe.destroy();
```

## History

This module replaced a hand-rolled JavaScript port of `micro_frontend`
that lived at `src/wake-word/micro-frontend.js` (now deleted). The JS
port had numerical drift relative to the C reference (broken `pcanShrink`
formula, asymmetric noise reduction tweaks, an `AUDIO_SCALE` constant
that was ~13× too low, etc.) which made high-cutoff models like
`hey_jarvis` (0.97) fundamentally unreliable. Compiling the actual C
library to WebAssembly fixed every detection problem we had been
chasing through workarounds.
