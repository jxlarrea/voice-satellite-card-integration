// Embind wrapper around the TensorFlow Lite micro_frontend C library.
//
// Compiled to WebAssembly so the browser uses bit-exact-to-reference
// feature extraction — same code path as the HA Android app and the
// Voice PE hardware satellite. Replaces the hand-rolled JS port in
// src/wake-word/micro-frontend.js (which had numerical drift relative
// to the C reference, especially in pcanShrink and the noise reduction).
//
// API surface (exposed to JS via Embind):
//   class MicroFrontend
//     ctor(int sampleRate, int stepSizeMs)
//     bool isInitialized()
//     int processSamples(uintptr_t samplesPtr, size_t numSamples,
//                        uintptr_t outputPtr, size_t maxFrames)
//     void reset()
//
// Caller is responsible for allocating input + output buffers via
// Module._malloc and passing the raw pointer addresses. Output is a
// flat array of (frames * 40) float32 values, scaled by FLOAT32_SCALE
// to match what the OHF-Voice micro-wake-word inference pipeline feeds
// into the model. Each frame is 40 mel features.

#include <emscripten/bind.h>

#include <cstddef>
#include <cstdint>

extern "C" {
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
}

using namespace emscripten;

namespace {

// micro_frontend configuration matching the ESPHome / Voice PE / HA
// Android pipeline. Source for these constants:
//   https://github.com/esphome/esphome/blob/.../components/micro_wake_word/preprocessor_settings.h
//   https://github.com/home-assistant/android/blob/.../microwakeword/src/main/cpp/MicroFrontendWrapper.cpp
constexpr size_t kFeatureDurationMs = 30;
constexpr float kFilterbankLowerBandLimit = 125.0f;
constexpr float kFilterbankUpperBandLimit = 7500.0f;
constexpr int kNoiseReductionSmoothingBits = 10;
constexpr float kNoiseReductionEvenSmoothing = 0.025f;
constexpr float kNoiseReductionOddSmoothing = 0.06f;
constexpr float kNoiseReductionMinSignalRemaining = 0.05f;
constexpr float kPcanGainControlStrength = 0.95f;
constexpr float kPcanGainControlOffset = 80.0f;
constexpr int kPcanGainControlGainBits = 21;
constexpr int kLogScaleShift = 6;
constexpr size_t kFeatureSize = 40;

// Scale factor to convert uint16 micro_frontend output to float32, matching
// the OHF-Voice micro-wake-word inference path:
//   https://github.com/OHF-Voice/micro-wake-word/blob/a70bd740d4e79ee8a8bb3db843fe862b88d5d6b0/microwakeword/inference.py#L94
constexpr float kFloat32Scale = 0.0390625f;  // 1/256 * 10

}  // namespace

class MicroFrontend {
 public:
  MicroFrontend(int sampleRate, int stepSizeMs)
      : sample_rate_(sampleRate), step_size_ms_(stepSizeMs), initialized_(false) {
    struct FrontendConfig config{};
    FrontendFillConfigWithDefaults(&config);

    config.window.size_ms = kFeatureDurationMs;
    config.window.step_size_ms = static_cast<size_t>(stepSizeMs > 0 ? stepSizeMs : 10);

    config.filterbank.num_channels = kFeatureSize;
    config.filterbank.lower_band_limit = kFilterbankLowerBandLimit;
    config.filterbank.upper_band_limit = kFilterbankUpperBandLimit;

    config.noise_reduction.smoothing_bits = kNoiseReductionSmoothingBits;
    config.noise_reduction.even_smoothing = kNoiseReductionEvenSmoothing;
    config.noise_reduction.odd_smoothing = kNoiseReductionOddSmoothing;
    config.noise_reduction.min_signal_remaining = kNoiseReductionMinSignalRemaining;

    config.pcan_gain_control.enable_pcan = 1;
    config.pcan_gain_control.strength = kPcanGainControlStrength;
    config.pcan_gain_control.offset = kPcanGainControlOffset;
    config.pcan_gain_control.gain_bits = kPcanGainControlGainBits;

    config.log_scale.enable_log = 1;
    config.log_scale.scale_shift = kLogScaleShift;

    if (FrontendPopulateState(&config, &state_, sample_rate_)) {
      initialized_ = true;
    }
  }

  ~MicroFrontend() {
    if (initialized_) {
      FrontendFreeStateContents(&state_);
      initialized_ = false;
    }
  }

  // Non-copyable: state_ owns C-allocated buffers.
  MicroFrontend(const MicroFrontend&) = delete;
  MicroFrontend& operator=(const MicroFrontend&) = delete;

  bool isInitialized() const { return initialized_; }

  // Process int16 samples and write feature frames to the output buffer.
  //
  // samplesPtr  : raw address of an int16_t[numSamples] in WASM heap
  //               (caller allocated via Module._malloc, populated via
  //               Module.HEAP16.set(...)).
  // numSamples  : number of int16 samples to process.
  // outputPtr   : raw address of a float[maxFrames * 40] in WASM heap.
  //               Each emitted feature frame is written contiguously
  //               (frame 0 occupies output[0..39], frame 1 occupies
  //               output[40..79], etc.).
  // maxFrames   : caller's capacity for output (frames, not floats).
  //
  // Returns the number of feature frames written. Caller reads them via
  // Module.HEAPF32.subarray(outputPtr/4, outputPtr/4 + framesProduced * 40).
  int processSamples(uintptr_t samplesPtr,
                     size_t numSamples,
                     uintptr_t outputPtr,
                     size_t maxFrames) {
    if (!initialized_) return 0;

    const int16_t* samples = reinterpret_cast<const int16_t*>(samplesPtr);
    float* output = reinterpret_cast<float*>(outputPtr);

    size_t samplesProcessed = 0;
    size_t framesProduced = 0;

    while (samplesProcessed < numSamples && framesProduced < maxFrames) {
      size_t numSamplesRead = 0;
      FrontendOutput frontOutput = FrontendProcessSamples(
          &state_,
          samples + samplesProcessed,
          numSamples - samplesProcessed,
          &numSamplesRead);

      if (numSamplesRead == 0) {
        // No further window can be advanced from the remaining samples.
        break;
      }
      samplesProcessed += numSamplesRead;

      if (frontOutput.values != nullptr && frontOutput.size > 0) {
        float* dst = output + framesProduced * kFeatureSize;
        const size_t copy = frontOutput.size < kFeatureSize ? frontOutput.size : kFeatureSize;
        for (size_t i = 0; i < copy; i++) {
          dst[i] = static_cast<float>(frontOutput.values[i]) * kFloat32Scale;
        }
        // Pad if frontend produced fewer than 40 channels (shouldn't
        // happen, but be defensive).
        for (size_t i = copy; i < kFeatureSize; i++) {
          dst[i] = 0.0f;
        }
        framesProduced++;
      }
    }

    return static_cast<int>(framesProduced);
  }

  // Reset the adaptive state (noise estimate, PCAN, etc.) without
  // reallocating. Call between independent audio streams; in normal
  // continuous use the C reference does not auto-reset.
  void reset() {
    if (initialized_) {
      FrontendReset(&state_);
    }
  }

 private:
  int sample_rate_;
  int step_size_ms_;
  struct FrontendState state_;
  bool initialized_;
};

EMSCRIPTEN_BINDINGS(micro_frontend_module) {
  class_<MicroFrontend>("MicroFrontend")
      .constructor<int, int>()
      .function("isInitialized", &MicroFrontend::isInitialized)
      .function("processSamples", &MicroFrontend::processSamples)
      .function("reset", &MicroFrontend::reset);
}
