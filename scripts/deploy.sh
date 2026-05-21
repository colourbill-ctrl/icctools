#!/usr/bin/env bash
# Rebuild and deploy profiletool to chardata.colourbill.com/profiletool/.
#
# Usage:
#   scripts/deploy.sh            # full rebuild: WASM + frontend + rsync
#   NO_WASM=1 scripts/deploy.sh  # skip WASM rebuild (frontend-only changes)
#
# Prerequisites:
#   - ~/.ssh/config host alias "chardata" (see ~/.ssh/config)
#   - Emscripten SDK installed (unless NO_WASM=1)
#   - iccDEV source (unless NO_WASM=1; override with ICCDEV_ROOT)
#   - nginx on the Lightsail box configured to serve /var/www/profiletool/
#     at /profiletool/ on the chardata.colourbill.com server block.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${DEPLOY_REMOTE:-chardata:/var/www/profiletool/}"

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

# Guard against rsync --delete wiping the live site if vite build produced
# nothing (aborted build, missing index.html).
if [ ! -f frontend/dist/index.html ]; then
  echo "error: frontend/dist/index.html missing — refusing to rsync --delete" >&2
  exit 1
fi

rsync -avz --delete frontend/dist/ "$REMOTE"

echo
echo "deployed → https://chardata.colourbill.com/profiletool/"
echo "if the browser shows a stale build: hard-reload (Ctrl+Shift+R / Cmd+Shift+R)"
