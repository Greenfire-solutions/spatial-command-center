#!/bin/bash
#
#  Spatial Command Center: everything a double-click needs, in order.
#    1. find Node.js, or download the pinned version into ./runtime (one time)
#    2. install the app's parts, including Electron (one time, a few minutes)
#    3. build the app's screens (one time, and again only after an update)
#    4. start it
#  Nothing is installed system-wide and no administrator password is needed.
#  Deleting the runtime and node_modules folders undoes steps 1 and 2.
#
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 1
say() { printf '\n%s\n' "$*"; }
fail() {
  say "$*"
  say "Nothing on your Mac was changed outside this folder. Fix the problem above and double-click Start Spatial Command Center again."
  [ -t 0 ] && { printf '\nPress Enter to close this window.'; read -r _; }
  exit 1
}

say "Spatial Command Center"
say "Step 1 of 4: Node.js (the engine it runs on)..."
NODE="$(/bin/bash scripts/setup.sh)" || fail "Could not get Node.js. Check that this Mac is online."
NODE_DIR="$(dirname "$NODE")"
export PATH="$NODE_DIR:$PATH"
NPM="$NODE_DIR/npm"
[ -x "$NPM" ] || NPM="$(command -v npm)"
[ -n "$NPM" ] || fail "Node.js was found but npm (its installer) was not."

say "Step 2 of 4: the app's parts..."
LOCK_MARK="node_modules/.package-lock.json"
if [ -f "$LOCK_MARK" ] && [ ! "package-lock.json" -nt "$LOCK_MARK" ] && [ -f node_modules/electron/path.txt ]; then
  echo "Already installed."
else
  if [ -d node_modules ]; then
    echo "Updating the app's parts after an update (usually under a minute)."
  else
    echo "First time only: downloading about 300 MB, including Electron (the built-in browser)."
    echo "This takes about 3 to 10 minutes depending on your internet. Lines of text scrolling past are normal."
  fi
  "$NPM" install --no-audit --no-fund --no-update-notifier --loglevel=error || fail "Installing the app's parts did not finish. Check that this Mac is online."
  [ -f node_modules/electron/path.txt ] || "$NODE" node_modules/electron/install.js \
    || fail "Electron (the built-in browser) did not download. Check that this Mac is online."
fi

say "Step 3 of 4: building the app's screens..."
"$NODE" scripts/ensure-build.mjs || fail "Building the app did not finish."

say "Step 4 of 4: starting. The app window opens in a few seconds."
echo "Keep this Terminal window open while you use it. Quitting the app (Cmd+Q) ends it."
"$NODE" scripts/run-electron.mjs . "$@"
CODE=$?
[ $CODE -eq 0 ] || say "The app stopped with an error (code $CODE). The lines above say why."
exit $CODE
