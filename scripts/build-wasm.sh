#!/usr/bin/env bash
# Build the WASM validator, copy the artifacts into the frontend, and refresh
# the committed checksums so anyone can verify public/wasm/* matches
# validator-wasm/wrapper.cpp + the pinned IccProfLib sources.
#
# Prerequisites:
#   - Emscripten SDK activated (source emsdk_env.sh)
#   - iccDEV source at /home/colour/code/iccdev (override with ICCDEV_ROOT)
#
# Usage:
#   scripts/build-wasm.sh          # build + copy + update checksums
#   scripts/build-wasm.sh --verify # rebuild and diff against committed checksums
#                                  # (exits non-zero if they drift)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICCDEV_ROOT="${ICCDEV_ROOT:-/home/colour/code/iccdev}"
BUILD_DIR="$REPO_ROOT/validator-wasm/build"
SRC_DIR="$REPO_ROOT/validator-wasm"
OUT_DIR="$REPO_ROOT/frontend/public/wasm"
CHECKSUM_FILE="$OUT_DIR/SHA256SUMS"

if ! command -v emcmake >/dev/null; then
  echo "error: emcmake not on PATH — source your emsdk_env.sh first" >&2
  exit 1
fi

if [ ! -f "$ICCDEV_ROOT/IccProfLib/IccProfile.h" ]; then
  echo "error: iccDEV source not found at $ICCDEV_ROOT" >&2
  echo "       set ICCDEV_ROOT=/path/to/iccdev" >&2
  exit 1
fi

if [ ! -d "$BUILD_DIR" ]; then
  emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" -DICCDEV_ROOT="$ICCDEV_ROOT"
fi
cmake --build "$BUILD_DIR" -j"$(nproc)"

mkdir -p "$OUT_DIR"

if [ "${1:-}" = "--verify" ]; then
  if [ ! -f "$CHECKSUM_FILE" ]; then
    echo "error: no committed checksums at $CHECKSUM_FILE" >&2
    exit 2
  fi
  cd "$BUILD_DIR"
  # Compare build output hashes against committed ones.
  expected=$(sort "$CHECKSUM_FILE")
  actual=$(sha256sum iccprofiledump.mjs iccprofiledump.wasm | sort)
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: rebuilt artifacts do not match committed checksums" >&2
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    exit 3
  fi
  echo "OK: rebuilt artifacts match $CHECKSUM_FILE"
  exit 0
fi

cp "$BUILD_DIR/iccprofiledump.mjs"  "$OUT_DIR/"
cp "$BUILD_DIR/iccprofiledump.wasm" "$OUT_DIR/"

cd "$OUT_DIR"
sha256sum iccprofiledump.mjs iccprofiledump.wasm > SHA256SUMS
echo
echo "=== committed artifact checksums (frontend/public/wasm/SHA256SUMS) ==="
cat SHA256SUMS
