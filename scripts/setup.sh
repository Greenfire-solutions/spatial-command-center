#!/bin/bash
#
#  Spatial Command Center: find or fetch Node.js for macOS. Safe to run again.
#  (Same pattern as Orbit Performer Desk's scripts/setup.sh.)
#
#  The app needs Node.js 22.12 or newer (or 20.19+) to install and build.
#  If no Node on this Mac will do, this fetches the exact pinned version into ./runtime,
#  checks it against the SHA-256 nodejs.org publishes, and uses only that.
#  Nothing is installed system-wide, no administrator password is needed, and
#  deleting the runtime folder undoes it.
#
#    scripts/setup.sh           find or fetch Node; prints the node path last
#    scripts/setup.sh --check   only report
#    SETUP_FRESH=1              ignore everything outside ./runtime (rehearse a new Mac)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RT="$ROOT/runtime"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
FRESH="${SETUP_FRESH:-0}"

NODE_VERSION="v22.23.4"
NODE_SHA_x64="efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819"
NODE_SHA_arm64="c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428"

say() { printf '%s\n' "$*" >&2; }
[ "$(uname -s)" = "Darwin" ] || { say "Spatial Command Center runs on a Mac."; exit 2; }
case "$(uname -m)" in
  x86_64) NARCH=x64 ;;
  arm64)  NARCH=arm64 ;;
  *) say "Unknown processor $(uname -m)."; exit 2 ;;
esac

sha_ok() { [ "$(/usr/bin/shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]; }
# A binary a browser downloaded carries a quarantine mark that makes macOS
# refuse to run it. Clearing it on our own runtime is the whole point of setup.
unquarantine() { /usr/bin/xattr -rd com.apple.quarantine "$1" 2>/dev/null || true; }
node_ok() { [ -x "$1" ] && "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)" >/dev/null 2>&1; }

NODE=""
[ -d "$RT/node" ] && unquarantine "$RT/node"
CANDS=("$RT/node/bin/node")
[ "$FRESH" = 1 ] || CANDS+=(/usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node)
for c in "${CANDS[@]}"; do
  if node_ok "$c"; then NODE="$c"; break; fi
done

if [ -n "$NODE" ]; then
  say "Node: ok ($NODE, $("$NODE" -v))"
elif [ $CHECK = 1 ]; then
  say "Node: MISSING (needs 22.12 or newer)"; exit 1
else
  say "Node: downloading $NODE_VERSION for $NARCH (about 50 MB, one time only)..."
  mkdir -p "$RT"
  T="$RT/node.tar.gz"
  /usr/bin/curl -fL --retry 3 -o "$T" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$NARCH.tar.gz" \
    || { rm -f "$T"; say "Could not download Node. Are you online?"; exit 1; }
  SUM_VAR="NODE_SHA_$NARCH"
  sha_ok "$T" "${!SUM_VAR}" || { rm -f "$T"; say "The Node download did not match its checksum. Nothing was installed."; exit 1; }
  rm -rf "$RT/node" && mkdir -p "$RT/node"
  /usr/bin/tar -xzf "$T" -C "$RT/node" --strip-components 1
  rm -f "$T"
  echo "$NARCH" > "$RT/ARCH"
  NODE="$RT/node/bin/node"
  node_ok "$NODE" || { say "Node was downloaded but does not run on this Mac."; exit 1; }
  say "Node: installed ($("$NODE" -v))"
fi
printf '%s\n' "$NODE"
