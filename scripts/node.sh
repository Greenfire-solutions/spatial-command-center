#!/bin/bash
#
#  Run a Node.js script without installing Node.
#
#  In the downloaded folder the app's own engine does it: Electron, inside
#  "Spatial Command Center.app", can run as plain Node. In a source checkout
#  with no app beside it, this uses the Node on your Mac (or ./runtime/node,
#  which scripts/setup.sh downloads).
#
#    scripts/node.sh macos-bridge/desktop-host.mjs
#    scripts/node.sh --test "src/**/*.test.mjs"
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENGINE="$ROOT/Spatial Command Center.app/Contents/MacOS/Electron"
if [ -x "$ENGINE" ]; then
  # Running this script is a choice to trust the folder: clear the download
  # mark so macOS does not stop the engine with an "unverified developer" box.
  /usr/bin/xattr -dr com.apple.quarantine "$ROOT/Spatial Command Center.app" 2>/dev/null || true
  ELECTRON_RUN_AS_NODE=1 exec "$ENGINE" "$@"
fi
for candidate in "$ROOT/runtime/node/bin/node" "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /opt/homebrew/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && exec "$candidate" "$@"
done
echo "No Node.js found. Run scripts/setup.sh once (it downloads Node into ./runtime), or install Node 22." >&2
exit 1
