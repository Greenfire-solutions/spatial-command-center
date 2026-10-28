# Phase One build prompt

The implementation prompt produced by the September 2026 architecture
investigation. Paste it into a fresh Claude Code session at the repository
root. Full reasoning, prior-art survey, comparison table and performance
budget live in the accompanying report; this file is only the pasteable half,
kept in the repo so it does not have to be retyped.

The scope is deliberately stages 1–4: land the finished work sitting in the
working tree, fix the WebXR layer binding, measure the decode ceiling, and
only then replace the transport. Stage 3 is a gate, not a formality, the one
number the investigation could not find published anywhere is how many
hardware-decoded video streams a WebXR *page* can hold at 90 Hz in the Quest
Browser, and four later stages rest on it.

---

You are working in `control center 3d`, the Spatial Command Center, a React
Three Fiber spatial workspace whose browser surfaces are real Chromium
`webContents` rendered offscreen and delivered to the scene as textures.

Read these first, in this order, before writing any code:
  README.md
  docs/WEBXR_HEADSET_FINDINGS.md
  docs/FRAME_TRANSPORT.md
  docs/STEEL_EVALUATION.md
  src/xr/layer-policy.js
  src/chromium-texture-source.js  (the render block at the end)
  src/image-bitmap-surface.js
  src/providers/browser-provider.js and src/providers/frame-formats.js

The architecture has already been investigated and settled. Do not propose
iframes, CORS proxies, header stripping, or a Unity/native rewrite. The
architecture is: real Chromium runs on a desktop companion, pixels stream to
a WebXR client on Quest 3, input travels back as validated control messages.
That is correct and stays.

Your job is four changes, in this order, each independently testable. Do not
start one before the previous is done and its tests pass.

STAGE 1, Land the working tree.
The tree has finished, tested work uncommitted: `src/xr/system-keyboard.js`,
`scripts/vr.mjs`, the `imageOrientation: 'flipY'` decode fix, the injected
`__SCC_REMOTE__` host resolution, the `window.add` controller binding, the
HTTPS certificate landing page, and preset screens defaulting to real
Chromium sources.
- Run `npm run test:unit` and `npm run build`. Both currently pass; keep them
  passing.
- Review each hunk. If anything is incomplete, finish it rather than
  committing it half-done.
- Commit in coherent pieces with messages in this repository's existing
  style: what changed and why it mattered, not a changelog.

STAGE 2, Fix the WebXR layer binding. This is the important one.
`src/chromium-texture-source.js` currently renders a promoted browser screen
as `<XRLayer src={surface.layerSource} .../>`. That is wrong in three ways
and cannot show live content:
  a) `useChromiumFrameSurface` updates the surface imperatively inside a
     subscription callback and never triggers a React re-render, so
     `surface.layerSource` read during render is a stale ImageBitmap.
  b) `BrowserImageBitmapSurface.update()` closes the previous bitmap as soon
     as the next frame arrives, so the bitmap handed to the layer is detached
     within ~66ms while `@pmndrs/xr`'s `setupXRImageLayer` still redraws from
     it asynchronously.
  c) `src` is in `XRLayerImplementation`'s useEffect dependency array, so a
     fresh ImageBitmap per frame would destroy and recreate the XRQuadLayer
    , and call `updateRenderState({layers})`, at frame rate.
Verify each of these claims yourself in `node_modules/@react-three/xr/dist/
layer.js` and `node_modules/@pmndrs/xr/dist/layer.js` before changing
anything. If any is wrong, say so and stop.

The fix: make the layer a per-frame render target instead of a static image.
Render `<XRLayer quality="text-optimized" shape="quad" pixelWidth={...}
pixelHeight={...}>` with a child mesh carrying the existing surface material
and a plane geometry sized to the layer, so @pmndrs/xr's
`ChildrenToRenderTarget` draws the live texture into the layer every frame.
Then remove `layerSource` from `image-bitmap-surface.js` and
`video-texture-surface.js` if nothing else consumes it, so a closed bitmap
can never reach a compositor layer again.

Preserve every existing behaviour: `layer-policy.js` still decides which
screens are layers and in what order (farthest first, layers are not depth
tested), the base layer must stay transparent where a layer is drawn, and
`environmentAllowed()` must still suppress the environment while layers are
live. Do not change layer-policy.js; it is pure, tested, and correct.

Tests for Stage 2:
- Extend `src/xr/layer-policy.test.mjs` or add a sibling test asserting the
  promoted path no longer reads a bitmap that the surface may free.
- `npm run test:unit`, `npm run test:runtime`, `npm run test:poc` all pass.
- Then stop and tell me to check it on the headset. State plainly that you
  have NOT verified it on hardware. Do not claim the layer path works until
  I report back from a Quest 3.

STAGE 3, Measure the decode ceiling. Build a measurement, not a feature.
Add a standalone page (e.g. `probe-decode.html` served by
`scripts/serve-xr.mjs`) that, inside an `immersive-vr` session on the Quest
Browser, decodes N simultaneous 1280x800 H.264 streams into textures and
reports sustained frame rate for N = 1..6 on the in-scene diagnostics HUD.
Streams may be pre-encoded local files; this measures decode and composite
cost, not the network.

This gates everything after it. Report the number. Do not build Stage 4 on
an assumed answer, and if N is 1 or 2, stop and tell me, that result means
the client may need to become native and we will decide then.

STAGE 4, Replace the JPEG transport with H.264, only if Stage 3 allows.
Keep the existing WebSocket, the existing `src/providers/remote/protocol.js`
allowlist, and the existing host-side validation in
`electron/browser-source-manager.cjs` and `electron/validation.cjs`. Nothing
about the security posture may weaken: loopback by default, token before
upgrade, one client at a time, every message validated.
- Host: hardware-encode each source as H.264 Annex-B; keep frames as one
  binary message per access unit with the existing length-prefixed header.
- Client: a new provider (or a new frame format on the existing one)
  declaring an appropriate `FRAME_FORMATS` value, decoding with WebCodecs
  `VideoDecoder` and presenting `VideoFrame`s to the layer render target.
- Keep the attention scheduler authoritative: `browser-quality.js` tiers must
  drive encoder bitrate and frame rate exactly as they drive
  `setSourceFrameRate` today.
- `npm run test:host` must be extended to assert decodable frames actually
  arrive, the way it currently asserts JPEG frames do.

Rules for the whole task:
- Prioritise Quest 3, but never break desktop testing. `npm run test:poc` is
  the regression gate and must pass before and after every stage.
- Run tests after each stage. Report real output. If something fails, say so
  with the output rather than describing what you intended.
- Never claim hardware behaviour you have not observed. This repository has a
  strong habit of stating plainly what is verified and what is written but
  never executed, keep it.
- Match the existing comment style: comments explain why a decision was made
  and what would go wrong otherwise, not what the line does.
- If you find that a platform limitation makes one of these stages
  impossible, stop, explain exactly what you found and where you verified it,
  and propose the alternative. Do not work around it silently.
- Do not touch the connector, agent, or voice systems. Do not add the AI
  layer. Do not delete `src/xr/synthetic-bridge.js` until Stage 4 lands.
