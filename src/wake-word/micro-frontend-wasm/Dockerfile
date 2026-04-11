# Reproducible build environment for the micro-frontend WASM module.
#
# Pins emsdk to a specific version so the WASM output is deterministic
# across machines. The official emscripten/emsdk image already ships
# emcc, clang, make, curl, tar, bash, and python — everything our
# Makefile and fetch-sources.sh need.
#
# Built and used via docker-build.sh in this directory; you should not
# need to invoke `docker build` or `docker run` by hand.

FROM emscripten/emsdk:3.1.69

# Run as the host UID/GID so build outputs in the bind-mounted volume
# end up owned by the user who launched the build, not by root.
# docker-build.sh passes --user $(id -u):$(id -g) at run time, so this
# doesn't need a USER directive — but we do need a writable HOME for
# the emsdk cache, which the official image already places at /emsdk.

WORKDIR /workspace
