#!/usr/bin/env bash
# Rebuild and deploy icctools to chardata.colourbill.com:5173.
#
# Usage:
#   scripts/deploy.sh            # full rebuild: WASM + frontend + rsync
#   NO_WASM=1 scripts/deploy.sh  # skip WASM rebuild (frontend-only changes)
#
# Prerequisites:
#   - ~/.ssh/config host alias "chardata" (see ~/.ssh/config)
#   - Emscripten SDK installed (unless NO_WASM=1)
#   - iccDEV source (unless NO_WASM=1; override with ICCDEV_ROOT)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${DEPLOY_REMOTE:-chardata:/var/www/icctools/}"

cd "$REPO_ROOT"

if [ -z "${NO_WASM:-}" ]; then
  # shellcheck disable=SC1091
  source "$HOME/emsdk-install/emsdk/emsdk_env.sh" 2>/dev/null || {
    echo "error: couldn't source emsdk env — set NO_WASM=1 to skip, or install emsdk" >&2
    exit 1
  }
  scripts/build-wasm.sh
fi

(cd frontend && npm run build)

rsync -avz --delete frontend/dist/ "$REMOTE"

echo
echo "deployed → https://chardata.colourbill.com:5173/"
echo "if the browser shows a stale build: hard-reload (Ctrl+Shift+R / Cmd+Shift+R)"
