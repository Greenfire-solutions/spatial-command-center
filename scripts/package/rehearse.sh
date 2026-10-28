#!/bin/bash
#
#  Clean-Mac rehearsal for a finished zip: unzip it somewhere new, mark every
#  file as downloaded from the internet (com.apple.quarantine), then with an
#  empty home folder, no Node and nothing but /usr/bin:/bin on PATH:
#    1. run the tests from inside the folder (scripts/test.sh)
#    2. start the app with no window and prove it works (boot-check.mjs)
#  open and osascript are replaced by stubs so nothing appears on screen.
#
#    scripts/package/rehearse.sh "dist/Spatial Command Center (Intel Mac).zip" [port]
#
set -euo pipefail
ZIP="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
PORT="${2:-10252}"
T="$(mktemp -d "${TMPDIR:-/tmp}/scc-rehearse.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/stubs" "$T/unzipped"
for tool in open osascript; do
  printf '#!/bin/sh\necho "[stub] %s $*" >> "%s/stubs.log"\n' "$tool" "$T" > "$T/stubs/$tool"
  chmod +x "$T/stubs/$tool"
done

/usr/bin/ditto -x -k "$ZIP" "$T/unzipped"
APPDIR="$T/unzipped/Spatial Command Center"
[ -d "$APPDIR" ] || { echo "the zip has no 'Spatial Command Center' folder"; exit 1; }
MARK="0081;$(printf %x "$(date +%s)");Safari;"
find "$APPDIR" \( -type f -o -type d \) -exec /usr/bin/xattr -w com.apple.quarantine "$MARK" {} +
echo "unzipped $(du -sh "$APPDIR" | cut -f1) and quarantined $(find "$APPDIR" -type f | wc -l | tr -d ' ') files"

clean() { ( cd "$APPDIR" && env -i HOME="$T/home" PATH="$T/stubs:/usr/bin:/bin" TMPDIR="$T/" LANG=en_US.UTF-8 "$@" ); }

if clean /bin/bash -c 'command -v node' >/dev/null; then echo "FAIL: node is on the clean PATH"; exit 1; fi
for f in "READ ME FIRST.txt" README.md CLAUDE.md "Spatial Command Center.app" "Start Spatial Command Center.command" scripts/test.sh; do
  [ -e "$APPDIR/$f" ] || { echo "FAIL: $f is missing"; exit 1; }
done
echo "PASS  READ ME FIRST, README, CLAUDE.md, the app, the launcher and the tests are all there"

echo "--- tests from inside the zip"
clean /bin/bash scripts/test.sh > "$T/tests.log" 2>&1 || { tail -30 "$T/tests.log"; echo "FAIL: tests"; exit 1; }
grep -E '^ℹ (tests|pass|fail)' "$T/tests.log"

echo "--- start the app (no window) and check it"
clean /bin/bash scripts/node.sh scripts/package/boot-check.mjs . "$PORT"

if [ -s "$T/stubs.log" ]; then echo "note: tried to open something:"; cat "$T/stubs.log"; fi
echo "rehearsal: PASS"
