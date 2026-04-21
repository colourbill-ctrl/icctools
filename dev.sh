#!/usr/bin/env bash
# Start the icctools frontend. Validation runs client-side via WASM, so no
# backend service is required.
#
# Prerequisites:
#   - Node.js 20+
#   - WASM artifacts at frontend/public/wasm/ (built from validator-wasm/)
#
# Usage:
#   bash dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/frontend/public/wasm/iccprofiledump.wasm" ]; then
  echo "ERROR: WASM artifacts missing at frontend/public/wasm/" >&2
  echo "Build them with:" >&2
  echo "  source ~/emsdk-install/emsdk/emsdk_env.sh" >&2
  echo "  emcmake cmake -S validator-wasm -B validator-wasm/build -DICCDEV_ROOT=/home/colour/code/iccdev" >&2
  echo "  cmake --build validator-wasm/build -j\$(nproc)" >&2
  echo "  cp validator-wasm/build/iccprofiledump.{mjs,wasm} frontend/public/wasm/" >&2
  exit 1
fi

echo "==> Installing frontend dependencies..."
(cd "$SCRIPT_DIR/frontend" && npm install)

echo ""
echo "==> Starting frontend dev server on http://localhost:5173"
echo ""

cd "$SCRIPT_DIR/frontend" && npm run dev
