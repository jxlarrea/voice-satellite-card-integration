# Build the micro-frontend WebAssembly module.
#
# Requires the Emscripten SDK on PATH (`emcc --version` should work).
# See README.md for installation instructions.
#
# Targets:
#   make             — fetch sources (if needed) and build dist/micro-frontend.{js,wasm}
#   make fetch       — only download third_party sources
#   make clean       — remove build artifacts (preserves third_party/)
#   make distclean   — remove build artifacts and third_party/

EMCC ?= emcc

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
THIRD_PARTY := $(ROOT_DIR)/third_party
TFLITE := $(THIRD_PARTY)/tflite-micro
KISSFFT := $(THIRD_PARTY)/kissfft
FRONTEND := $(TFLITE)/tensorflow/lite/experimental/microfrontend/lib

DIST := $(ROOT_DIR)/dist
OUT_JS := $(DIST)/micro-frontend.js
OUT_WASM := $(DIST)/micro-frontend.wasm

# Source files — mirror microwakeword/src/main/cpp/CMakeLists.txt from
# the HA Android app so we get a bit-exact build of the same pipeline.
FRONTEND_C_SRCS := \
  $(FRONTEND)/filterbank.c \
  $(FRONTEND)/filterbank_util.c \
  $(FRONTEND)/frontend.c \
  $(FRONTEND)/frontend_util.c \
  $(FRONTEND)/log_lut.c \
  $(FRONTEND)/log_scale.c \
  $(FRONTEND)/log_scale_util.c \
  $(FRONTEND)/noise_reduction.c \
  $(FRONTEND)/noise_reduction_util.c \
  $(FRONTEND)/pcan_gain_control.c \
  $(FRONTEND)/pcan_gain_control_util.c \
  $(FRONTEND)/window.c \
  $(FRONTEND)/window_util.c

FRONTEND_CC_SRCS := \
  $(FRONTEND)/fft.cc \
  $(FRONTEND)/fft_util.cc \
  $(FRONTEND)/kiss_fft_int16.cc

# We deliberately do NOT compile kissfft's kiss_fft.c / kiss_fftr.c as
# standalone TUs here. The tflite-micro file kiss_fft_int16.cc already
# #includes them inline (inside a kissfft_fixed16 namespace) — but the
# kissfft headers wrap their declarations in extern "C", so the inlined
# functions still get C linkage. Compiling the .c files separately would
# emit the same unnamespaced symbols (kiss_fft, kiss_fftr_alloc, ...)
# twice and the linker errors out. The HA Android CMakeLists takes the
# same approach: kissfft is fetched only for its headers + includable
# .c sources, never built as a separate compilation target that flows
# into the frontend lib.
ALL_SRCS := $(FRONTEND_C_SRCS) $(FRONTEND_CC_SRCS) $(ROOT_DIR)/wrapper.cc

# Compiler flags
#   -I tflite-micro       : for tensorflow/lite/experimental/... includes
#   -I kissfft            : for kiss_fft.h + tools/kiss_fftr.h
#   -DFIXED_POINT=16      : kissfft int16 mode (matches the model training)
#   -O3 -ffast-math       : speed (safe in fixed-point land)
#   -Wno-...              : suppress noisy warnings from third-party code
INCLUDES := -I$(TFLITE) -I$(KISSFFT)
DEFINES := -DFIXED_POINT=16
CFLAGS := -O3 -ffast-math -ffunction-sections -fdata-sections \
          $(INCLUDES) $(DEFINES) \
          -Wno-unused-parameter -Wno-sign-compare -Wno-unused-variable \
          -Wno-unused-but-set-variable

# Linker flags for the final emcc invocation.
#   --bind                          : link the Embind glue
#   -s MODULARIZE=1                 : export as a factory function on a
#                                     window global, mirroring how the
#                                     existing TFLite Web API client is
#                                     loaded (script-tag injection from
#                                     loadTFLite() in micro-models.js)
#   -s EXPORT_NAME=createModule     : factory function global name
#   -s ENVIRONMENT=web              : drop node/worker code paths
#   -s ALLOW_MEMORY_GROWTH=1        : grow heap on demand
#   -s INITIAL_MEMORY=256KB         : start small — micro_frontend's
#                                     internal state + our I/O buffers are
#                                     ~150KB total. Heap auto-grows if
#                                     needed (very rare in practice).
#   -s EXPORTED_RUNTIME_METHODS     : expose heap views the JS wrapper uses
#   -s EXPORTED_FUNCTIONS           : expose _malloc/_free C API for JS
#                                     to allocate input/output buffers
#   -s WASM=1                       : explicit WASM target
#   --closure 0                     : Embind runtime breaks under closure
#
# NOTE: We deliberately do NOT set SINGLE_FILE=1 or EXPORT_ES6=1. Those
# would force webpack to ingest the WASM as a JS module and bundle it
# into every chunk that imports it (we ended up with ~190KB of dupe
# WASM in two different chunks). Instead the emitted .js + .wasm pair
# is copied into custom_components/voice_satellite/wake-word-frontend/
# at build time and HA serves them as static assets, exactly like the
# existing tflite_web_api_client.js + .wasm pair.
LDFLAGS := --bind \
           -O3 \
           -s WASM=1 \
           -s MODULARIZE=1 \
           -s EXPORT_NAME=createMicroFrontendModule \
           -s ENVIRONMENT=web \
           -s ALLOW_MEMORY_GROWTH=1 \
           -s INITIAL_MEMORY=256KB \
           -s EXPORTED_RUNTIME_METHODS='["HEAP16","HEAPF32"]' \
           -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
           --closure 0

.PHONY: all fetch clean distclean

all: $(OUT_JS)

fetch:
	bash $(ROOT_DIR)/scripts/fetch-sources.sh

# Touch the frontend.h file as a sentinel for "sources are present".
$(FRONTEND)/frontend.h:
	bash $(ROOT_DIR)/scripts/fetch-sources.sh

$(OUT_JS): $(FRONTEND)/frontend.h $(ROOT_DIR)/wrapper.cc
	@mkdir -p $(DIST)
	$(EMCC) $(CFLAGS) $(ALL_SRCS) -o $(OUT_JS) $(LDFLAGS)
	@echo
	@echo "Built: $(OUT_JS)"

clean:
	rm -rf $(DIST)

distclean: clean
	rm -rf $(THIRD_PARTY)
