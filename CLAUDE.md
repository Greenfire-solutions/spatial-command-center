# Spatial Command Center: make it your own

Real web pages as screens floating in 3D. This file is for you (and Claude Code) when you
want to change it. MIT licensed: change anything, ship your own version.

## How it works in one paragraph

An Electron app. The main process (`electron/`) opens each web page in a hidden, offscreen
Chromium window and sends its pictures to the renderer. The renderer (`src/`, React Three
Fiber) paints each picture onto a flat 3D mesh and sends your clicks, scrolls and typing back
to the page as real input. So a "screen" is a real browser, not an iframe.

## Where things are

| Path | What it is |
| --- | --- |
| `src/app.jsx` | The whole renderer: scene, screens, toolbar, welcome card, keyboard shortcuts. Big; search it. |
| `src/presets/workspace-presets.js` | The ready-made layouts (Welcome, Developer, Focus...). Each screen is one line: title, position, rotation, size, address. |
| `src/store/` | The workspace state (zustand), and how a layout is saved and loaded back (`persistence.js`, `workspace-schema.js`). |
| `src/systems/`, `src/interaction/` | Camera, scene runtime, dragging, snapping, browser picture quality. |
| `src/commands/`, `src/voice/` | Typed and spoken commands for opening, finding and connecting screens. |
| `src/connectors/`, `src/agents/` | Lines between screens, and the optional AI agent node. |
| `src/xr/` | Headset (WebXR) mode: controllers, keyboard in space, entering VR. |
| `electron/main.cjs` | App start, the main window, security settings. |
| `electron/browser-source-manager.cjs` | Creates, sizes and drives the offscreen pages. |
| `electron/validation.cjs`, `electron/ipc.cjs` | Everything the renderer asks the main process for is checked here. Keep it strict. |
| `electron/agents/claude-adapter.cjs`, `electron/api-key.cjs` | The optional Claude agent and where its key comes from. |
| `electron/host/` | Remote browser host for a headset on Wi-Fi (`npm run vr`). |
| `macos-bridge/` | Optional: shows your own Mac desktop on a screen (needs ffmpeg). |
| `scripts/` | Launchers, tests, packaging. `scripts/package.sh` builds the per-Mac zips. |
| `docs/` | Design notes and measurements behind the 3D and headset decisions. |

Saved layout, cookies and sign-ins live in `~/Library/Application Support/Spatial Command Center`
(the downloaded app) or `.../spatial-command-center` (running from source), never in this folder.

## Run the tests (no install needed)

```
scripts/test.sh
```

About 370 unit tests, under a minute. In the downloaded folder they run on the app's own
engine (`scripts/node.sh` runs Electron as plain Node) with the small `node_modules` that
ships for them. In a source checkout, `npm install` then `npm test` does the same.

## Run it in development

Changing `src/` or `electron/` needs the full set of tools once:

1. Install Node.js 22 (nodejs.org), or run `scripts/setup.sh` which puts a private copy in `./runtime`.
2. `npm install` (about 300 MB, includes Electron and Vite; replaces the small test-only `node_modules`).
3. `npm run dev`: Vite with hot reload plus Electron pointed at it. Edit `src/` and watch it change.

`npm start` builds once and runs the built app. `npm run test:poc` is the full end-to-end gate:
it opens a real window and drives it, so do not use the computer while it runs.

To make your own ready-to-share zips: commit, then `bash scripts/package.sh`
(it packages the last commit) and `bash scripts/package/rehearse.sh "dist/Spatial Command Center (Intel Mac).zip"`.

## Changes you could ask Claude Code for

1. "Change the Welcome layout to open my three favourite sites in a half circle." (`src/presets/workspace-presets.js`)
2. "Add a layout called Study with a big screen in the middle and two notes screens either side."
3. "Change the background and floor to a night sky." (`src/systems/StudioEnvironment.jsx`)
4. "Add a keyboard shortcut that resets every screen to its layout position." (`src/app.jsx`, `src/store/workspace-store.js`)
5. "Let the AI agent summarise whatever page is on the selected screen with one button."

## Rules worth keeping

- Keep the security settings in `electron/main.cjs` and the checks in `electron/validation.cjs`:
  web pages must never reach Node or your files.
- Add a test next to what you change (`*.test.mjs` in `src/`, `electron/test/*.test.cjs`) and run `scripts/test.sh`.
