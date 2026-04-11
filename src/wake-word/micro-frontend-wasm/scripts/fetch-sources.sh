#!/usr/bin/env bash
#
# Fetch the third-party C source files needed to build the
# micro-frontend WASM module.
#
# Mirrors the dependencies the HA Android app pins in
# microwakeword/src/main/cpp/CMakeLists.txt so we get a bit-exact
# build of the same feature pipeline.
#
# Source 1: tflite-micro -> tensorflow/lite/experimental/microfrontend/lib/
# Source 2: kissfft -> kiss_fft.{c,h} + kiss_fftr.{c,h} (real-input FFT)
#
# Run from the micro-frontend-wasm directory:
#   bash scripts/fetch-sources.sh

set -euo pipefail

# Pinned versions — must match HA Android app's CMakeLists.txt for
# bit-exact feature parity.
TFLITE_MICRO_COMMIT="2747abd5c82a95fb1624106a946fc671c31f16e8"
KISSFFT_COMMIT="7bce4153c6bc8aba2db0e889e576f9d00505cbe1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
THIRD_PARTY="${ROOT_DIR}/third_party"

mkdir -p "${THIRD_PARTY}"

# ─── kissfft ──────────────────────────────────────────────────────────
# Sentinel file we use to detect a *complete* prior fetch. If anything
# in this list is missing we wipe and re-fetch — easier than guessing
# which transitive header might be needed next.
KISSFFT_DIR="${THIRD_PARTY}/kissfft"
KISSFFT_SENTINELS=(
  "${KISSFFT_DIR}/kiss_fft.c"
  "${KISSFFT_DIR}/kiss_fft.h"
  "${KISSFFT_DIR}/_kiss_fft_guts.h"
  "${KISSFFT_DIR}/kiss_fft_log.h"
  "${KISSFFT_DIR}/tools/kiss_fftr.c"
  "${KISSFFT_DIR}/tools/kiss_fftr.h"
)
kissfft_complete=1
for f in "${KISSFFT_SENTINELS[@]}"; do
  if [ ! -f "$f" ]; then
    kissfft_complete=0
    break
  fi
done
if [ "${kissfft_complete}" = "0" ]; then
  echo "Downloading kissfft (${KISSFFT_COMMIT})..."
  rm -rf "${KISSFFT_DIR}"
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/mborgerding/kissfft/archive/${KISSFFT_COMMIT}.tar.gz" -o "${TMP}/kissfft.tar.gz"
  tar -xzf "${TMP}/kissfft.tar.gz" -C "${TMP}"
  mkdir -p "${KISSFFT_DIR}/tools"
  # Copy ALL .c and .h files from the kissfft root. The library is small
  # (~10 files) and copying individually has been a recurring source of
  # missing-header build failures (kiss_fft_log.h, etc.). Better to grab
  # everything than to maintain a fragile per-file list.
  cp "${TMP}/kissfft-${KISSFFT_COMMIT}"/*.c "${KISSFFT_DIR}/" 2>/dev/null || true
  cp "${TMP}/kissfft-${KISSFFT_COMMIT}"/*.h "${KISSFFT_DIR}/" 2>/dev/null || true
  # TFLite micro_frontend includes kiss_fftr from "tools/" — kissfft
  # ships it at the root, so put a copy under tools/ so the include
  # path "tools/kiss_fftr.h" resolves.
  cp "${TMP}/kissfft-${KISSFFT_COMMIT}/kiss_fftr.c" "${KISSFFT_DIR}/tools/"
  cp "${TMP}/kissfft-${KISSFFT_COMMIT}/kiss_fftr.h" "${KISSFFT_DIR}/tools/"
  rm -rf "${TMP}"
  echo "  → ${KISSFFT_DIR}"
else
  echo "kissfft already vendored, skipping"
fi

# ─── tflite-micro micro_frontend ──────────────────────────────────────
TFLITE_DIR="${THIRD_PARTY}/tflite-micro"
FRONTEND_REL="tensorflow/lite/experimental/microfrontend/lib"
FRONTEND_DIR="${TFLITE_DIR}/${FRONTEND_REL}"
if [ ! -d "${FRONTEND_DIR}" ]; then
  echo "Downloading tflite-micro micro_frontend (${TFLITE_MICRO_COMMIT})..."
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/tensorflow/tflite-micro/archive/${TFLITE_MICRO_COMMIT}.tar.gz" -o "${TMP}/tflm.tar.gz"
  tar -xzf "${TMP}/tflm.tar.gz" -C "${TMP}"
  mkdir -p "${FRONTEND_DIR}"
  cp -R "${TMP}/tflite-micro-${TFLITE_MICRO_COMMIT}/${FRONTEND_REL}/." "${FRONTEND_DIR}/"
  rm -rf "${TMP}"
  echo "  → ${FRONTEND_DIR}"
else
  echo "tflite-micro micro_frontend already vendored, skipping"
fi

echo
echo "Vendored sources ready:"
echo "  ${KISSFFT_DIR}"
echo "  ${FRONTEND_DIR}"
echo
echo "Next: install emsdk (https://emscripten.org/docs/getting_started/downloads.html)"
echo "Then: make"
