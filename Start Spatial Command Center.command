#!/bin/bash
# Spatial Command Center, started from Terminal (a backup for double-clicking
# "Spatial Command Center.app"). Messages from the app show in this window.
#
# In the downloaded folder it starts the ready app. In a source checkout with
# no app beside it, it sets itself up from source the first time (see
# scripts/start.sh) and then starts.
#
#   SCC_LAUNCH_QUIET=1   start with no window on screen (for automated checks)
#   SCC_PORT=10250       also open Chromium's debugging port there (checks only)
DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP="$DIR/Spatial Command Center.app"
if [ ! -d "$APP" ]; then
  exec /bin/bash "$DIR/scripts/start.sh" "$@"
fi

# You already chose to open this file, so the app beside it is trusted too:
# clear the download mark so macOS does not ask a second time.
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Set by some developer tools; it would make the app run as plain Node instead.
unset ELECTRON_RUN_AS_NODE

ARGS=()
[ -n "${SCC_PORT:-}" ] && ARGS+=("--remote-debugging-port=$SCC_PORT")
[ "${SCC_LAUNCH_QUIET:-0}" = 1 ] && export SCC_HIDDEN_WINDOW=1

echo "Spatial Command Center is starting. The window opens in a few seconds."
echo "Keep this Terminal window open while you use it. Quit the app with Cmd+Q."
"$APP/Contents/MacOS/Electron" "${ARGS[@]+"${ARGS[@]}"}" "$@"
CODE=$?
[ $CODE -eq 0 ] || echo "The app stopped with an error (code $CODE). The lines above say why."
exit $CODE
