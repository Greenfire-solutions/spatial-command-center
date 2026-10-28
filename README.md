# Spatial Command Center

**Real web pages on big screens floating in 3D around you.** Click, type and scroll in
every screen, move and turn them, save the layout. Free and open source (MIT).

## Download for Mac (free)

Nothing to install first. Download the zip for your Mac, unzip it, and double-click
**Spatial Command Center** inside the folder (the first time, right-click it and choose Open).
Read **READ ME FIRST.txt** in the folder for the rest.

- [Intel Mac](https://github.com/Greenfire-solutions/spatial-command-center/releases/latest/download/Spatial-Command-Center-Intel-Mac.zip)
- [Apple Silicon Mac (M1 and newer)](https://github.com/Greenfire-solutions/spatial-command-center/releases/latest/download/Spatial-Command-Center-Apple-Silicon.zip)

Not sure which Mac you have? Apple menu, About This Mac: "Chip: Apple M..." is Apple Silicon,
"Processor: Intel" is Intel. Needs macOS 12 or newer and an internet connection for the web pages.

What works straight away, with no keys or extras: the 3D workspace, two example screens
(Wikipedia and a map), adding your own screens, arranging them, ready-made layouts, and a
layout that saves itself. Optional extras, each needed only for its own feature:

| Optional extra | Only needed for |
| --- | --- |
| An Anthropic API key, in `~/Spatial Command Center Data/anthropic-api-key.txt` | the AI agent you can connect to a screen |
| ffmpeg + Apple's Command Line Tools + `scripts/node.sh macos-bridge/desktop-host.mjs` | showing your own Mac desktop on a screen (the Desktop layouts) |
| A VR headset, Node.js and `npm install` | the immersive headset mode (see "On a headset") |

## Make it your own

The zip carries the full source beside the app. Open the folder in Claude Code and read
**CLAUDE.md**: how the code is laid out, how to run it in development, how to run the tests
(`scripts/test.sh`, no install needed) and some first changes to ask for.

## How it works

A React Three Fiber workspace that arranges **real browser surfaces** as movable
screens in 3D space, running as an Electron desktop application.

Each "Full Browser" screen is a genuine Chromium `webContents` rendered
offscreen. Its paint frames are delivered to the renderer and uploaded to a
`THREE.DataTexture`, so a browser page is an actual textured mesh in the scene,
not an HTML iframe floating over the canvas. Pointer, wheel, and keyboard input
travel back the other way: a ray hit on the mesh becomes a UV coordinate, which
becomes a Chromium input event.

The long-term target is the same workspace running in immersive WebXR on a
headset, with the browser sources supplied over a transport-independent
provider interface.

The rest of this file is for developers.

## Requirements

- Node.js 20 or newer (developed on Node 24)
- macOS, Windows, or Linux desktop

```
npm install
```

## Running

### Development

```
npm run dev
```

Starts Vite on `127.0.0.1:4173`, waits for it to answer, then launches Electron
pointed at that dev server with hot module reloading. Both processes are
supervised together; stopping one stops the other.

Configuration is read from an optional `.env` file, see `.env.example`.
Existing shell variables always win.

### Production build

```
npm run build     # bundle the renderer into dist/
npm start         # launch Electron against the built renderer
```

Or in one step:

```
npm run start:built
```

`npm start` loads `dist/index.html` from disk. It now builds first when there is
no build yet or a source file is newer than the build (`scripts/ensure-build.mjs`),
so a fresh copy no longer stops at "Renderer build not found".

### On a headset

```
npm run xr:serve            # adb reverse when a device is connected
npm run xr:serve:https      # self-signed https on the LAN address
```

WebXR is only exposed in a secure context. Serving the build over plain http
from a LAN address means the headset never sees `navigator.xr` at all, which
looks like the app failing rather than the page being insecure:

| Served as | isSecureContext | navigator.xr |
| --- | --- | --- |
| `http://<lan-ip>:4173` | false | absent |
| `https://<lan-ip>:4174` | true | present |
| `http://localhost:4173` via adb reverse | true | present |

The adb path is preferred: localhost is a secure context, so nothing has to be
trusted on the device. Install Android platform-tools, enable developer mode on
the headset, connect it, and `npm run xr:serve` sets up the reverse tunnel and
prints the URL to open. Without adb, use `--https` and accept the self-signed
certificate once on the headset.

#### Real pages, not placeholders

`xr.html` installs a **synthetic bridge** that draws static, page-shaped
content onto a canvas. It exists so layout and legibility could be measured
before any transport existed, and it announces itself in the console:

```
[xr-probe] synthetic browser bridge installed. Pages are static.
```

If browser surfaces in the headset look like placeholders, that is what you are
looking at, and the fix is to give the page a host to talk to.
`resolveBrowserProvider()` checks `?host=` **before** `window.spatialBrowser`,
so a configured host wins and the synthetic bridge is bypassed.

**With adb**, the preferred path, no certificates:

```
npm run build
npm run host                # prints a one-time token
npm run xr:serve            # adb reverse
```

```
http://localhost:4173/xr.html?host=ws://localhost:8787&token=<token>
```

**Without adb**, over the LAN. Three facts decide the shape of this: WebXR
needs a secure context, so the page must be https; an https page may not open a
`ws://` socket; therefore the host needs TLS too. Without it the workspace
renders and every browser surface silently fails to connect, which looks like
the app being broken rather than the transport being blocked.

```
npm run build
npm run xr:serve:https                              # generates the certificate
npm run host:https -- --host <lan-ip>               # reuses the same certificate
```

```
https://<lan-ip>:4174/xr.html?host=wss://<lan-ip>:8787&token=<token>
```

**Accept the certificate twice.** The browser trusts per origin, and the page
and the socket are different ports. Visit `https://<lan-ip>:8787` once directly
and accept there as well, a WebSocket certificate prompt has no interface, so
it fails silently otherwise. Then reload the page.

`--host` binds beyond loopback, and the host says so on startup: anyone who
reaches that port with the token controls a real browser. It is fine on a
trusted network for a session; it is not a thing to leave running. Prefer adb.

### Browser-only preview

```
npm run dev:frontend
```

Serves the renderer without Electron. The 3D workspace, arrangement, and iframe
screens work; Full Browser screens report that local Chromium is offline,
because `window.spatialBrowser` only exists inside the Electron preload.

## Testing

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | Alias for `test:unit` | nothing extra |
| `npm run test:unit` | Validation, source manager, frame transport, IPC trust boundary, UV mapping, URL normalization, workspace persistence and migrations | Node only |
| `npm run test:runtime` | Real offscreen Chromium: hidden window, paint, focus, pointer/keyboard/wheel, navigation, resize, multiple simultaneous sources, destroy | Electron |
| `npm run test:poc` | Full end-to-end regression gate. Builds, launches the real app, and drives the visible R3F canvas over CDP: live texture, raycast→pixel input, typing, navigation, address bar, wheel, and arrange-mode move/rotate | Electron |
| `npm run test:all` | `test:unit` + `test:runtime` + `test:poc` | Electron |
| `npm run test:host` | Launches the real remote host, connects as a headset, and asserts that JPEG frames actually arrive | Electron |
| `npm run test:sites` | Loads representative real websites through the browser source manager | Electron + network |
| `npm run test:smoke` | Drives the browser-only build through an external Chrome DevTools endpoint | Running Chrome with `--remote-debugging-port` |
| `npm run test:xr` | Drives a real immersive session in a headless browser: enters VR, poses controllers, presses buttons, and asserts tracking-loss recovery | A dev server or `npm run vr`, and Chrome |

`npm run test:poc` is the important one. It is the regression gate that proves
the Chromium-texture architecture still works end to end, and it should pass
before and after any structural change. It currently makes 14 assertions.

It drives a real, visible Electron window, so it is sensitive to the desktop it
runs on. It takes the foreground deliberately and opts out of Chromium's
background throttling, but on a busy machine roughly one run in ten still loses
a synthetic pointer or key event. Every failure reports the application state at
the moment it gave up, so a genuine defect is distinguishable from a dropped
input at a glance: a dropped input shows no recorded manipulation attempt, while
a real defect names the reason the application rejected the gesture. Do not run
`npm run build` while the gate is running, it rewrites `dist/` underneath the
app being tested.

## Architecture

### Processes

```
Electron main process
  main.cjs                  window creation, navigation lockdown, permissions
  browser-source-manager    one hidden offscreen BrowserWindow per Full Browser
  frame-transport           paint frames -> renderer, with backpressure
  ipc.cjs                   trusted-sender-only IPC surface
  validation.cjs            URL / input / viewport validation
        |
        |  contextBridge (preload.cjs) -> window.spatialBrowser
        v
Electron renderer process
  React Three Fiber scene, Zustand store, Chromium textures
```

### The browser provider

The renderer never talks to Electron directly. It talks to a
`BrowserSourceProvider` (`src/providers/browser-provider.js`) covering
lifecycle, navigation, presentation, input, and the frame, metadata, and event
streams. `ElectronChromiumProvider` is the first implementation and is the
only code that knows frames arrive as premultiplied BGRA over IPC.

This matters because Electron cannot run on a headset. A remote provider , 
Chromium on a desktop, reached over WebRTC, will satisfy the same contract,
and the spatial scene, the interaction system, and the store are all written
so that swapping the provider changes nothing above it.

Frames are delivered as descriptors carrying an explicit `format` rather than
as bare byte arrays. Bitmap formats are implemented; `video-frame`,
`video-element`, and `shared-texture` are declared so a decoded video surface
can be added without reshaping the scene.

### Chrome surfaces: overlay and spatial

Essential screen chrome can render two ways, selected by the OVERLAY/SPATIAL
switch and remembered per workspace:

- **Overlay**, drei `<Html>` controls. Crisp and familiar on a desktop.
- **Spatial**, real in-scene geometry driven entirely by ray intersections.

The distinction is not cosmetic. `<Html>` renders into a DOM layer that does
not exist inside an immersive WebXR session, so anything essential that lives
only there disappears the moment a headset enters immersive mode. Screen
manipulation and browser navigation are essential, so both exist as geometry in
`src/spatial-ui/` and `src/components/spatial/`. Both surfaces drive the same
`createScreenActions` implementation, so they cannot drift apart.

The regression gate covers this: it switches to spatial chrome, asserts the
HTML chrome is genuinely gone, and drives an in-scene control by raycast to
confirm it changes real workspace state.

Text entry is the one thing not yet solved spatially. The address field is
displayed and activatable in-scene; on the desktop it hands focus to the DOM
field. A headset will need a spatial keyboard, which belongs with the XR input
work.

### WebXR

The workspace is not duplicated for a headset. The same scene, the same
screens, and the same interaction system serve both; entering a session
changes two things through existing abstractions rather than branching the
application:

- the **viewpoint** switches from the desktop camera to the head pose, so
  face-me, the arc layout, depth, and focus framing follow the user;
- the **chrome surface** switches to spatial, because HTML overlays render
  nothing inside an immersive session.

Entry controls appear only when the runtime actually supports a session. In
the desktop Electron build there is no `navigator.xr`, so nothing is offered.

Interaction is one model with several input sources. The mapping is recorded
in `src/xr/xr-interaction.js` and implemented in
`src/xr/XrControllerInput.jsx`:

| Controller | Desktop equivalent | Implemented by |
| --- | --- | --- |
| trigger / hand pinch | left click | @react-three/xr pointer events, no XR-specific code |
| squeeze | drag in Arrange | `ScreenInteraction.beginGrab` / `updateGrab` |
| squeeze + move | drag | the same grab session |
| both squeezes | corner handle drag | `ScreenInteraction.beginPinchScale` |
| thumbstick Y | wheel | `provider.sendWheelEvent`, or push/pull on a held screen |

Trigger and pinch need no code because @react-three/xr synthesizes pointer
events from controller rays and hand pinches, so spatial buttons and browser
surfaces answer them through the same handlers a mouse uses. That is the payoff
from making interaction ray-based before adding XR. Everything else routes into
the same actions the desktop uses; there is no XR-specific transform maths.

A unit test asserts every mapped gesture is also reachable from the desktop, so
the two input models cannot quietly diverge.

### Testing XR without a headset

`npm run test:xr` drives a real immersive session in a headless browser and asserts
what happens in it. It enters VR, poses a controller, points it at a window, pulls
the grip, drags the window, then makes the controller disappear mid-drag and checks
that the window settles exactly where it was held rather than staying stuck to a
hand that no longer exists.

```
npm run dev:frontend                 # or npm run vr, in another shell
npm run test:xr                      # add -- --url <origin>/xr.html to point elsewhere
```

It is built on IWER, which is already a dependency, `@react-three/xr` pulls it in
for its own emulator, so nothing extra is installed. The page side is
`src/xr/test-harness.js`, which installs `window.__SCC_XR__` only when the document
carries `?xr-harness=1`, and which stands down entirely when a real WebXR runtime is
present so that a harnessed build opened on a Quest still tests the headset rather
than an emulator.

Two things worth knowing before trusting a run. The emulator is not hardware: this
proves the application responds correctly to the signals a runtime produces, not
that a Quest produces those signals. And it needs a GPU, under software rendering
the XR frame loop falls to one or two frames per second, which makes anything polled
per frame unreliable; the runner asks Chrome for ANGLE over Metal for that reason.

To develop XR without a headset interactively, append `?xr-emulate=1`. The emulator is
opt-in on purpose: the library's default emulates a Quest whenever WebXR is
absent on localhost, which is exactly the desktop development setup, and it
would both offer Enter VR on a machine with no headset and fetch several
megabytes of emulator assets.

### Quest status: what is and is not verified

This matters more than any feature list, so it is stated plainly.

**The application has never run on a headset.** The XR path is unit-tested and
built on abstractions the desktop exercises continuously, but no immersive
session has been observed. The bundled device emulator (`?xr-emulate=1`) loads
its chunks correctly but does not expose a session under headless software
rendering, so it cannot stand in for hardware here.

| | Status |
| --- | --- |
| Desktop workspace, browser textures, input | verified continuously, 77 unit tests, POC gate 15 validations |
| Loads with no Electron bridge (the Quest case) | verified, mounts clean, WebGL2, zero renderer errors |
| Spatial chrome with no DOM | verified, controls exist as scene geometry and drive real state |
| Secure context for WebXR | verified, https and adb paths both measured |
| Head tracking, immersion, controller input | **written, never executed** |
| Browser content on a headset | **will not work yet**, see below |

**Browser surfaces will be offline on a Quest.** Chromium sources require
Electron, and Electron cannot run on Horizon OS. Screens, arrangement, spatial
chrome and controller input are expected to work; the pages inside them will
report `OFFLINE` until the remote host half exists. That is the single largest
remaining piece of work, and it is a multi-day build rather than an evening's.

To find out where reality diverges from this, serve the build to the headset
(see **On a headset** above) and report what happens. That loop is fast.

### Remote browsers

`RemoteChromiumProvider` runs the browser on a desktop companion and streams it
to a headset: one hardware-encoded video track per browser source, and control
and input over a DataChannel. It satisfies the same provider contract as the
Electron one, so the scene, the interaction system, and the store are
indifferent to which is in use.

The client half is implemented and tested against a fake host that speaks the
real protocol: offer/answer, request/response with timeouts, per-source
metadata and event routing, track binding, and teardown that fails outstanding
work rather than leaving it pending. Its peer connection and signaling channel
are injected, so it is testable without a network.

Frames arrive as `video-element` descriptors and bind a `THREE.VideoTexture`
that the GPU samples directly, no frame crosses JavaScript, which is why the
remote path can carry several surfaces where the bitmap path cannot. The scene
picks the surface from the provider's declared frame format
(`src/video-texture-surface.js`).

The control protocol (`src/providers/remote/protocol.js`) is an allowlist:
unknown actions, malformed source ids, wrong versions, and oversized messages
are refused, so the channel cannot be used as a data pipe. The host must
validate every request exactly as `electron/validation.cjs` does locally, a
browser host that trusts the network is a far worse liability than one embedded
in a desktop app. The full security bar is recorded as
`REMOTE_PROVIDER_REQUIREMENTS` in the source.

### The WebSocket host, the path that works today

`RemoteChromiumProvider` targets WebRTC, which remains the right destination:
hardware decode costs the client almost nothing. `WebSocketBrowserProvider`
takes the shorter road to the same place, and it is the one that currently
puts web pages on a headset.

The host encodes each Chromium paint as JPEG and pushes it down the same
socket the control messages travel on. `NativeImage.toJPEG()` is built into
Electron, so this needs no codec, no signaling server, and no STUN/TURN:

    1280x800 raw BGRA   3.91 MB per frame     cannot leave the machine
    the same frame JPEG   ~23 KB              measured, 175x smaller

Frames are decoded with `createImageBitmap()`, which runs off the main thread
and yields an object three.js uploads directly, no channel swizzle, because
unlike the Electron bitmap path a decoded image is already in the renderer's
colour space. An `ImageBitmap` is also a valid WebXR layer source, so the same
frame can feed a composition layer without a second copy.

```
npm run host                     # loopback on 8787, prints a one-time token
npm run host -- --port 9000      # a different port
npm run host -- --host 0.0.0.0   # LAN; prefer adb reverse instead
```

The host prints a URL with its token. Open the served build on the headset
with that host and token in the query string:

```
http://localhost:4173/?host=ws://localhost:8787&token=<token>
```

With `adb reverse` both are localhost from the headset's point of view, so
nothing is exposed to the network and WebXR still sees a secure context.
`resolveBrowserProvider` treats this as configuration rather than feature
detection, the Quest browser has no Electron bridge, so detection alone could
only ever conclude "offline".

Security, because the browser is now reachable over a socket: the host binds
loopback by default, requires the token before the upgrade completes, accepts
one client at a time, and puts every message through the protocol allowlist and
then through `BrowserSourceManager`, which validates URLs and input exactly as
it does for local IPC. `--host` prints a warning.

**Still to build on the WebRTC path:** a host that captures each source as a
media track. The protocol, the validation, and the client contract are shared,
so that work replaces the transport and the surface, not the seam.

### Renderer layout

```
src/
  constants.js              shared spatial and schema constants
  utils/                    pure helpers
  store/
    workspace-schema.js     screen/source normalization and serialization
    persistence.js          versioned, migrating, coalesced localStorage
    workspace-store.js      the Zustand store
  presets/                  built-in workspace layouts
  interaction/
    screen-interaction.js   ray-based grab/rotate/scale actions
    snapping.js             alignment and grid snapping
  systems/
    scene-runtime.js        live Object3D registry
    workspace-actions.js    add-screen and arc arrangement
    StudioEnvironment.jsx   local image-based lighting
  providers/
    browser-provider.js     the transport-independent contract
    electron-chromium-provider.js
    frame-formats.js        frame descriptors and format constants
  spatial-ui/               in-scene UI primitives (panel, button, label)
  components/spatial/       in-scene screen and browser chrome
  xr/                       XR session, entry controls, interaction model
  chromium-texture-source.js   frame -> DataTexture, input -> Chromium
  app.jsx                   components and application entry
```

### Screens and sources are separate

This separation is deliberate and load-bearing:

- A **screen** owns `position`, `rotation`, `scale`, `size`, and lock state.
- A **source** owns `type`, `url`, `sourceId`, and browser viewport size.

Moving, rotating, or scaling a monitor must never recreate or renavigate its
Chromium source. The Chromium lifecycle hook's dependency list deliberately
contains no world-space values, and `test:poc` asserts that a live page keeps
its scroll position and frame counter across a move and a rotate.

### Screen source types

- `chromium`, a real offscreen Chromium `webContents` as a Three.js texture.
  This is the source type that will work in WebXR.
- `iframe`, a DOM iframe in an HTML overlay. Convenient on desktop; cannot
  exist in an immersive session.
- `mock`, static placeholder content.
- `chrome-tab`, `desktop-window`, `stream`, declared connection placeholders,
  not yet implemented.

Many sites refuse to be embedded via `X-Frame-Options` or CSP
`frame-ancestors`, and a web page cannot reliably detect that. Rather than
stripping headers or proxying, an `iframe` screen offers "Open in Full Browser"
(real Chromium, headers intact) and "Open in real tab".

## Controls

- **Browse Mode**, screens receive clicks, typing, scrolling, and selection.
- **Arrange Mode**, press `A`, or use the mode switch. Page input pauses for
  unlocked screens so they can be manipulated.
- Drag an unlocked screen to move it on a camera-facing plane.
- `Shift` + drag vertically moves it nearer or farther.
- `R` + drag, the rotation handle, or the ± buttons rotate it.
- Mouse wheel over an arranged screen adjusts depth.
- **Face Me** points a screen at the current viewpoint.
- **Scale** reveals corner resize handles.
- **Lock** prevents physical changes while leaving the page usable.
- `Cmd/Ctrl + L` focuses the selected screen's address field.
- Double-click a frame, or use **Focus**, to move the camera to it.

Screen transforms, sizes, URLs, lock state, source types, connections, snapping
preferences, and workspace metadata persist to `localStorage`. Writes are
coalesced, so a continuous drag does not serialize the workspace every frame,
and pending writes are flushed when the window hides or unloads.

Saved workspaces carry a schema version. Older formats are migrated forward; a
format this build cannot read is archived under a backup key rather than
discarded, and the app starts from defaults.

## Security posture

The Electron configuration is intentionally strict, and should stay that way:

- Renderer sandboxing and context isolation, with no node integration.
- The spatial window may only navigate to its own trusted URL.
- Renderer-initiated window creation and `<webview>` are denied. "Open in real
  tab" therefore routes through validated IPC to `shell.openExternal`, which
  accepts only complete HTTP(S) URLs with no embedded credentials.
- Every browser-source IPC call verifies that the sender is exactly the trusted
  spatial renderer.
- URLs, input events, viewports, and source ids are validated in the main
  process, never trusted from the renderer.
- Browser sources share a persistent partition so logins survive restarts, but
  all site permission requests are denied until a permission UI exists.
- No remote debugging port, proxy, or header stripping is used in normal
  operation.

## Chrome tab bridge (scaffold)

`extension/` holds a deliberately minimal Manifest V3 companion that can list,
open, navigate, and close Chrome tabs as future `chrome-tab` sources. It
requests only the `tabs` permission. Pixel capture, synthetic input, debugger
access, and host permissions are intentionally absent. See
`extension/README.md` and `extension/bridge/PROTOCOL.md`.

## Packaging

`scripts/package.sh` builds the two ready zips into `dist/` from the last commit (Electron
43.5.1 pinned and SHA-256 checked, the app in `Contents/Resources/app`, ad-hoc signed, the
tests run from inside the Intel folder before it is zipped). `scripts/package/rehearse.sh
<zip>` replays a clean Mac: quarantined files, empty home folder, no Node on PATH, tests, then
a windowless start that checks the example pages really load.

## License

MIT, see `LICENSE`. Copyright (c) 2026 Greenfire Research and Innovation Center.

## Further reading

- `docs/FRAME_TRANSPORT.md`, how browser pixels reach a screen, what was
  measured about Electron shared textures, and the adaptive quality policy.
- `docs/STEEL_EVALUATION.md`, why local Electron Chromium is the browser
  backend today, and what a future remote provider needs to offer.
- `docs/VOICE_CONNECTORS_AGENTS.md`, the proposed next phase: voice as an input
  layer over a central command registry, semantic named windows, the spatial
  connector graph, structured content extraction, agent nodes, and
  passthrough/mixed-reality mode. Proposal only; not yet implemented.
