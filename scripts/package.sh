#!/bin/bash
#
#  Spatial Command Center: build one ready-to-run zip per Mac.
#
#    dist/Spatial Command Center (Intel Mac).zip       + Spatial-Command-Center-Intel-Mac.zip
#    dist/Spatial Command Center (Apple Silicon).zip   + Spatial-Command-Center-Apple-Silicon.zip
#  (the dashed names are the same files, hard-linked, for GitHub Release assets)
#
#  Each zip holds a real Mac app (Electron, pinned and SHA-256 checked, with this
#  app inside Contents/Resources/app and only the two packages it needs at run
#  time), ad-hoc signed, plus the full source, the tests and just enough of
#  node_modules for the tests to run from inside the zip. The person who
#  downloads it needs no Node, no npm and no developer tools.
#
#  Run from a git checkout it packages the last COMMIT, in a clean copy, never
#  the working folder. Run inside a clean copy with no .git (the store does
#  this) it builds right there. Downloads are cached in
#  ~/Library/Caches/spatial-command-center-package.
#
#    SCC_PACKAGE_ARCHES="x64"   build only one (x64, arm64 or both; default both)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_NAME="Spatial Command Center"
SLUG="Spatial-Command-Center"
CACHE="${SCC_PACKAGE_CACHE:-$HOME/Library/Caches/spatial-command-center-package}"
OUT="${SCC_PACKAGE_OUT:-$ROOT/dist}"
ARCHES="${SCC_PACKAGE_ARCHES:-x64 arm64}"

# Electron, pinned. The checksums are the ones Electron publishes for v43.5.1
# (node_modules/electron/checksums.json). Change all three together.
ELECTRON_VERSION="43.5.1"
ELECTRON_SHA_x64="41594e381b05c76a716ac99dcb8b6a04fac60f206d823eecffc1ad508939bab2"
ELECTRON_SHA_arm64="5e3967f5f31b30b05edb4b825b31feb9709664ac3eeab76a6e74daa6e09b351c"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\npackage.sh: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "build on a Mac (it signs the app with codesign)."
mkdir -p "$CACHE"

# 1. From a checkout: package the committed HEAD in a clean copy.
if [ -e "$ROOT/.git" ] && [ "${SCC_PACKAGE_IN_PLACE:-0}" != 1 ]; then
  SRC="$CACHE/src"
  rm -rf "$SRC" && mkdir -p "$SRC"
  git -C "$ROOT" archive HEAD | tar -x -C "$SRC"
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "Note: this folder has uncommitted changes. They are NOT in the zips (built from $(git -C "$ROOT" rev-parse --short HEAD))."
  fi
  mkdir -p "$OUT"
  SCC_PACKAGE_IN_PLACE=1 SCC_PACKAGE_OUT="$OUT" /bin/bash "$SRC/scripts/package.sh"
  rm -rf "$SRC"
  exit 0
fi

cd "$ROOT"
WORK="$CACHE/work"
rm -rf "$WORK" && mkdir -p "$WORK" "$OUT"
trap 'rm -rf "$WORK"' EXIT

say "Node (for building only; the zips do not need it)"
NODE="$(/bin/bash scripts/setup.sh)"
export PATH="$(dirname "$NODE"):$PATH"
VERSION="$("$NODE" -p "require('./package.json').version")"
echo "Spatial Command Center $VERSION"

say "Installing packages (Electron's own download skipped; the pinned one is used below)"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --cache "$CACHE/npm" --prefer-offline \
  --no-audit --no-fund --no-update-notifier --loglevel=error

say "Building the app's screens"
"$NODE" node_modules/vite/bin/vite.js build --logLevel warn
[ -f dist/index.html ] || fail "the build made no dist/index.html"

say "Running the unit tests, and noting which packages they load"
TRACE="$WORK/trace.txt"; : > "$TRACE"
SCC_TRACE_FILE="$TRACE" "$NODE" --import ./scripts/package/trace-register.mjs \
  --test "electron/test/**/*.test.cjs" "src/**/*.test.mjs" > "$WORK/tests.log" 2>&1 \
  || { tail -40 "$WORK/tests.log"; fail "the unit tests fail; fix them before packaging."; }
grep -E '^ℹ (tests|pass|fail)' "$WORK/tests.log" || true

# The source a person gets beside the app, to read, change and test.
SOURCE_ITEMS=(README.md CLAUDE.md "READ ME FIRST.txt" "Start Spatial Command Center.command"
  package.json package-lock.json index.html xr.html vite.config.js tailwind.config.js
  postcss.config.js .env.example src electron scripts macos-bridge bin docs extension chrome-bridge)
[ -f LICENSE ] && SOURCE_ITEMS+=(LICENSE)
[ -f GREENFIRE_LICENSE.md ] && SOURCE_ITEMS+=(GREENFIRE_LICENSE.md)

HOST_ARCH="$(uname -m)"; [ "$HOST_ARCH" = x86_64 ] && HOST_ARCH=x64

for ARCH in $ARCHES; do
  case "$ARCH" in
    x64)   LABEL="Intel Mac";     ASSET="Intel-Mac";     LIPO=x86_64 ;;
    arm64) LABEL="Apple Silicon"; ASSET="Apple-Silicon"; LIPO=arm64 ;;
    *) fail "unknown arch $ARCH" ;;
  esac
  say "$LABEL"

  EZIP="$CACHE/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
  SUM_VAR="ELECTRON_SHA_$ARCH"
  sha_ok() { [ -f "$1" ] && [ "$(/usr/bin/shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]; }
  if ! sha_ok "$EZIP" "${!SUM_VAR}"; then
    echo "Downloading Electron $ELECTRON_VERSION for $ARCH (about 120 MB, cached after this)..."
    /usr/bin/curl -fL --retry 3 -o "$EZIP.part" \
      "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
    sha_ok "$EZIP.part" "${!SUM_VAR}" || { rm -f "$EZIP.part"; fail "Electron for $ARCH did not match its checksum."; }
    mv "$EZIP.part" "$EZIP"
  fi

  STAGE="$WORK/$ARCH/$APP_NAME"
  mkdir -p "$STAGE" "$WORK/$ARCH/electron"
  /usr/bin/ditto -x -k "$EZIP" "$WORK/$ARCH/electron"
  BUNDLE="$STAGE/$APP_NAME.app"
  mv "$WORK/$ARCH/electron/Electron.app" "$BUNDLE"
  rm -rf "$WORK/$ARCH/electron"
  [ "$(/usr/bin/lipo -archs "$BUNDLE/Contents/MacOS/Electron")" = "$LIPO" ] || fail "Electron for $ARCH is not $LIPO"

  RES="$BUNDLE/Contents/Resources"
  rm -f "$RES/default_app.asar"
  mkdir -p "$RES/app"
  cp -R electron dist "$RES/app/"
  rm -rf "$RES/app/electron/test" "$RES/app/electron/integration" "$RES/app/electron/fixtures"
  # productName gives the app its own settings folder:
  # ~/Library/Application Support/Spatial Command Center (outside the app, so
  # replacing the app with a newer zip keeps the saved layout and sign-ins).
  "$NODE" -e '
    const p = require("./package.json");
    const out = { name: p.name, productName: process.argv[1], version: p.version,
      description: p.description, license: p.license, main: p.main, private: true };
    require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
  ' "$APP_NAME" "$RES/app/package.json"
  "$NODE" scripts/package/copy-deps.mjs packages . "$RES/app/node_modules" ws @anthropic-ai/sdk

  PL="$BUNDLE/Contents/Info.plist"
  PB=/usr/libexec/PlistBuddy
  "$PB" -c "Set :CFBundleName $APP_NAME" "$PL"
  "$PB" -c "Set :CFBundleDisplayName $APP_NAME" "$PL"
  "$PB" -c "Set :CFBundleIdentifier earth.greenfire.spatial-command-center" "$PL"
  "$PB" -c "Set :CFBundleShortVersionString $VERSION" "$PL"
  "$PB" -c "Set :CFBundleVersion $VERSION" "$PL"

  # Chromium's translations for 50+ languages: the app's own words are English.
  find "$BUNDLE/Contents" -type d -name '*.lproj' ! -name 'en.lproj' ! -name 'Base.lproj' -prune -exec rm -rf {} +

  # Ad-hoc signature: required to run on Apple Silicon at all, and it seals
  # the files so a damaged download is refused rather than half-working.
  /usr/bin/codesign --force --deep --sign - "$BUNDLE" 2>&1 | grep -v 'replacing existing signature' || true
  /usr/bin/codesign --verify --deep --strict "$BUNDLE" || fail "the $ARCH app's signature does not verify"

  for item in "${SOURCE_ITEMS[@]}"; do cp -R "$item" "$STAGE/"; done
  rm -rf "$STAGE/dist"
  # Just what the tests (and the optional desktop helper) load: see trace-register.mjs.
  "$NODE" scripts/package/copy-deps.mjs files . "$STAGE/node_modules" "$TRACE"
  "$NODE" scripts/package/copy-deps.mjs packages . "$STAGE/node_modules" ws
  if find "$STAGE/node_modules" "$RES/app/node_modules" -name '*.node' | grep . >/dev/null; then
    fail "a native .node file got into the zip; it would only run on one kind of Mac."
  fi
  chmod +x "$STAGE/Start Spatial Command Center.command" "$STAGE"/scripts/*.sh

  if [ "$ARCH" = "$HOST_ARCH" ]; then
    say "Running the tests from inside the $LABEL folder, on its own Electron, with no Node on PATH"
    mkdir -p "$WORK/home"
    ( cd "$STAGE" && env -i HOME="$WORK/home" PATH=/usr/bin:/bin TMPDIR="$WORK/" /bin/bash scripts/test.sh ) \
      > "$WORK/stage-tests.log" 2>&1 || { tail -40 "$WORK/stage-tests.log"; fail "tests fail inside the $LABEL folder"; }
    grep -E '^ℹ (tests|pass|fail)' "$WORK/stage-tests.log" || true
  fi

  ZIP="$OUT/$APP_NAME ($LABEL).zip"
  rm -f "$ZIP" "$OUT/$SLUG-$ASSET.zip"
  ( cd "$WORK/$ARCH" && /usr/bin/ditto -c -k --norsrc --noextattr --noacl --keepParent "$APP_NAME" "$ZIP" )
  ln "$ZIP" "$OUT/$SLUG-$ASSET.zip"
  rm -rf "$WORK/$ARCH"
  echo "$(basename "$ZIP"): $(( $(stat -f %z "$ZIP") / 1048576 )) MB"
done

say "Done"
ls -la "$OUT"
