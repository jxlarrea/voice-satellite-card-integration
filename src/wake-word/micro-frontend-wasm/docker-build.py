#!/usr/bin/env python3
"""
One-shot Docker build for the micro-frontend WebAssembly module.

Portable across Windows, Linux, and macOS — handles platform-specific
quirks (path conversion on Git Bash, --user mapping on Linux/macOS,
Docker Desktop bind-mount semantics on Windows) without shelling out
to bash.

Usage from this directory:

    python docker-build.py             # build (default)
    python docker-build.py fetch       # only download third_party sources
    python docker-build.py clean       # remove dist/
    python docker-build.py distclean   # remove dist/ and third_party/

Anything passed on the command line is forwarded as a `make` target
inside the container.

Requires:
    - Python 3.6+ (only uses stdlib)
    - Docker (Docker Desktop on Windows/macOS, docker engine on Linux)

The script will:
    1. Build (or reuse) a small Docker image based on emscripten/emsdk:3.1.69
       — see Dockerfile next to this script. Subsequent runs hit Docker's
       layer cache and return in milliseconds.
    2. Run `make` inside that image with this directory bind-mounted at
       /workspace, so vendored sources land in third_party/ and the
       output lands in dist/ on the host filesystem.
    3. On Linux/macOS, run as the host UID/GID so output files are
       owned by you, not root.
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

IMAGE_TAG = "voice-satellite-microfrontend-builder:emsdk-3.1.69"


def fail(message, code=1):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)


def ensure_docker():
    if shutil.which("docker") is None:
        fail(
            "docker not found on PATH. Install Docker Desktop "
            "(https://www.docker.com/products/docker-desktop) on "
            "Windows/macOS or docker engine on Linux."
        )


def docker_build(script_dir: Path):
    print(f"==> Ensuring builder image ({IMAGE_TAG})")
    try:
        subprocess.run(
            ["docker", "build", "--quiet", "-t", IMAGE_TAG, str(script_dir)],
            check=True,
        )
    except subprocess.CalledProcessError as e:
        fail(f"docker build failed (exit {e.returncode})", code=e.returncode)


def docker_run(script_dir: Path, make_target: str):
    is_windows = platform.system() == "Windows"

    # Bind-mount path. Docker Desktop on Windows accepts forward-slash
    # form (e.g. "C:/Users/jx/project"). Backslashes can confuse the
    # shell layer Docker uses to parse the -v argument, so normalize.
    if is_windows:
        mount_path = str(script_dir).replace("\\", "/")
    else:
        mount_path = str(script_dir)

    # User mapping. On Linux/macOS we want output files owned by the
    # invoking user, not root. On Windows, Docker Desktop's filesystem
    # layer handles ownership; passing --user with a Windows SID-derived
    # UID would inject an unmapped uid into the Linux container.
    user_args = []
    if not is_windows and hasattr(os, "getuid"):
        uid = os.getuid()
        gid = os.getgid()
        if uid != 0:
            user_args = ["--user", f"{uid}:{gid}"]

    cmd = [
        "docker", "run", "--rm",
        *user_args,
        "-v", f"{mount_path}:/workspace",
        # Provide a writable HOME so emcc can stash its config cache.
        "-e", "HOME=/tmp",
        IMAGE_TAG,
        "bash", "-c", f"make {make_target}".strip(),
    ]

    print(f"==> Running: make {make_target}".rstrip())
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        fail(f"build failed (exit {e.returncode})", code=e.returncode)


def show_output(script_dir: Path):
    dist = script_dir / "dist"
    print()
    print(f"==> Output in: {dist}")
    if dist.is_dir():
        entries = sorted(dist.iterdir())
        if not entries:
            print("  (empty)")
        for entry in entries:
            try:
                size = entry.stat().st_size
                size_kb = size / 1024
                print(f"  {entry.name}  ({size_kb:.1f} KB)")
            except OSError:
                print(f"  {entry.name}")
    else:
        print("  (dist/ not present — was this a clean target?)")


def main(argv):
    script_dir = Path(__file__).resolve().parent

    ensure_docker()
    docker_build(script_dir)

    make_target = " ".join(argv)
    docker_run(script_dir, make_target)
    show_output(script_dir)


if __name__ == "__main__":
    main(sys.argv[1:])
