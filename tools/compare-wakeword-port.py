import argparse
import json
import random
import statistics
import subprocess
import sys
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter


DEFAULT_MODELS = [
    "ok_nabu",
    "hey_jarvis",
    "hey_mycroft",
    "alexa",
    "hey_home_assistant",
    "hey_luna",
    "okay_computer",
    "stop",
]


def create_patterns(length: int, steps: int, seed: int):
    rng = random.Random(seed)

    zeros = [[0] * length for _ in range(steps)]

    impulse = []
    for idx in range(steps):
        frame = [0] * length
        frame[idx % length] = 127
        impulse.append(frame)

    alternating = []
    for idx in range(steps):
        frame = []
        for i in range(length):
            frame.append(96 if ((i + idx) & 1) == 0 else -96)
        alternating.append(frame)

    random_frames = []
    for _ in range(steps):
        random_frames.append([rng.randint(-128, 127) for _ in range(length)])

    return {
        "zeros": zeros,
        "impulse": impulse,
        "alternating": alternating,
        "random": random_frames,
    }


def run_litert(model_path: Path, sequence):
    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    input_shape = input_details["shape"]
    input_length = 1
    for dim in input_shape:
        input_length *= int(dim)

    outputs = []
    for frame in sequence:
        tensor = np.array(frame, dtype=np.int8).reshape(input_shape)
        interpreter.set_tensor(input_details["index"], tensor)
        interpreter.invoke()
        value = int(interpreter.get_tensor(output_details["index"]).reshape(-1)[0])
        outputs.append(value)
    return input_length, outputs


def get_litert_input_length(model_path: Path):
    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    input_shape = input_details["shape"]
    input_length = 1
    for dim in input_shape:
        input_length *= int(dim)
    return input_length


def run_custom_runner(repo_root: Path, model_name: str, sequence):
    payload = json.dumps({
        "modelName": model_name,
        "sequence": sequence,
    })
    result = subprocess.run(
        ["node", "tools/wake-word-custom-runner-cli.mjs"],
        cwd=repo_root,
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def compare_outputs(ref_outputs, js_outputs, sequence):
    diffs = [abs(int(a) - int(b)) for a, b in zip(ref_outputs, js_outputs)]
    mismatch_steps = [idx for idx, diff in enumerate(diffs) if diff != 0]
    first = None
    if mismatch_steps:
        idx = mismatch_steps[0]
        first = {
            "step": idx,
            "ref": int(ref_outputs[idx]),
            "js": int(js_outputs[idx]),
            "diff": int(diffs[idx]),
            "frame_head": sequence[idx][:16],
        }

    return {
        "maxDiff": max(diffs) if diffs else 0,
        "meanDiff": statistics.fmean(diffs) if diffs else 0.0,
        "mismatchSteps": len(mismatch_steps),
        "firstMismatch": first,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    models = args.models or DEFAULT_MODELS
    results = []

    for model_name in models:
        model_path = repo_root / "custom_components" / "voice_satellite" / "models" / f"{model_name}.tflite"
        if not model_path.exists():
            raise FileNotFoundError(model_path)

        probe_length = get_litert_input_length(model_path)
        patterns = create_patterns(probe_length, args.steps, args.seed)

        model_result = {
            "modelName": model_name,
            "inputLength": probe_length,
            "patterns": {},
        }

        for pattern_name, sequence in patterns.items():
            _, ref_outputs = run_litert(model_path, sequence)
            js_result = run_custom_runner(repo_root, model_name, sequence)
            metrics = compare_outputs(ref_outputs, js_result["outputs"], sequence)
            model_result["patterns"][pattern_name] = metrics

        model_result["worstMaxDiff"] = max(
            pattern["maxDiff"] for pattern in model_result["patterns"].values()
        )
        model_result["totalMismatchSteps"] = sum(
            pattern["mismatchSteps"] for pattern in model_result["patterns"].values()
        )
        results.append(model_result)

    json.dump(results, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
