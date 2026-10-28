#!/bin/bash
#
#  Run the unit tests (about 370 of them, under a minute). Works inside the
#  downloaded folder with nothing installed: it uses the app's own engine
#  (see scripts/node.sh) and the small node_modules folder that ships beside
#  the source. In a source checkout run "npm install" first, or use npm test.
#
#  The tests start no servers on fixed ports and never touch your saved layout.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
exec /bin/bash scripts/node.sh --test "electron/test/**/*.test.cjs" "src/**/*.test.mjs"
