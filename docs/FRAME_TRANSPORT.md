# Frame transport

How browser pixels reach a spatial screen today, what was measured, and what
the remote path needs to look like.

## Today: CPU bitmaps over IPC

```
Chromium OSR paint
  -> NativeImage.toBitmap()          full-frame BGRA copy
  -> structured clone over IPC       one copy per frame
  -> THREE.DataTexture upload        one GPU upload per frame
  -> ShaderMaterial                  BGRA swizzle + un-premultiply on the GPU
```

At 1280x800 that is 4,096,000 bytes per frame. At 30fps this is roughly
123 MB/s per screen. Acceptable for a desktop proof of concept with one or two
Full Browser screens; not acceptable for many screens, and not viable at all
across a network.

`IpcBitmapFrameTransport` already limits this with a one-frame-in-flight
acknowledgement gate and a single pending slot, so a slow renderer drops stale
paints rather than queueing them.

## Measured: Electron shared textures

Electron 43 / Chromium 140 was probed directly on this project's pinned
version. With `webPreferences.offscreen.useSharedTexture = true`, the `paint`
event delivers:

```
event.texture.textureInfo = {
  pixelFormat: 'bgra',
  codedSize:   { width, height },
  visibleRect, contentRect, timestamp, colorSpace,
  widgetType:  'frame',
  metadata,
  handle       // native GPU handle (IOSurface on macOS)
}
```

This works, and it removes the CPU copy on the main-process side.

**It is not currently usable by this renderer.** `handle` is a native GPU
handle intended for native code or another process that can import it. There is
no supported path to bind it into the WebGL context that three.js draws with
from renderer JavaScript. Adopting it would require a native module that
imports the handle and exposes it as a GL texture.

That is a real option later, and `BrowserFrameTransport` exists so it can be
added as another transport without touching `BrowserSourceManager` or the
scene. It is recorded here so the next person does not re-derive it: the
blocker is the renderer-side import, not Electron's capture.

## Implemented instead: adaptive quality

The cheapest frame is the one never produced. Rather than degrade what the user
is looking at, the workspace spends its frame budget according to attention
(`src/systems/browser-quality.js`):

| Tier | When | Frame rate | Painting |
| --- | --- | --- | --- |
| focused | the selected screen | 30 | yes |
| near | visible, within 4m | 20 | yes |
| far | visible, beyond 4m | 8 | yes |
| hidden | outside the view frustum | 2 | no |

Pausing is not destruction. `stopPainting()` leaves the page running with its
scroll position, session, and media intact; `startPainting()` plus an explicit
`invalidate()` brings it back immediately. The invalidate matters: Chromium
only paints on invalidation, so without it a resumed screen would keep showing
the texture it had when it paused until the page happened to change by itself.

The policy is re-evaluated four times a second and only issues a request when a
source's tier actually changes, so it costs a handful of IPC calls per minute
rather than one per source per frame.

`npm run test:runtime` verifies both levers against real Chromium, including
that page state survives a pause.

## Resolution is a budget, not a constant

deviceScaleFactor used to be a hard-coded 1, which is why browser text looks
soft on a HiDPI display. That was not an oversight; it was the transport.

    1280 x 800 @ 1x  =   4.1 MB/frame  (~123 MB/s at 30fps)
    1280 x 800 @ 2x  =  16.4 MB/frame  (~491 MB/s at 30fps)

`src/systems/browser-resolution.js` now derives the scale factor from an
explicit per-frame byte budget instead: a surface renders as sharply as it can
while staying inside it, capped by the display's own pixel ratio because detail
the display cannot resolve is pure cost. Small surfaces get a higher factor
today, and when frames stop being CPU bitmaps, raising
`DEFAULT_FRAME_BYTE_BUDGET` sharpens every screen without touching a call site.

## Next: compressed video for remote providers

The remote provider cannot send raw pixels. The intended pipeline:

```
Chromium (desktop companion)
  -> efficient capture (shared texture where available)
  -> hardware video encoding
  -> WebRTC media track
  -> decoded VideoFrame / HTMLVideoElement in the headset
  -> THREE.VideoTexture on the spatial screen
```

with input travelling the other way over a DataChannel:

```
controller ray / hand pinch / mouse
  -> ray/mesh intersection
  -> UV
  -> normalized browser coordinate
  -> DataChannel
  -> Chromium input event
```

The seams for this already exist:

- `FRAME_FORMATS` in `src/providers/frame-formats.js` declares `video-frame`,
  `video-element`, and `shared-texture` alongside the implemented bitmap
  formats, and frames carry their format rather than being assumed.
- `BrowserSourceProvider` is transport-independent, so a `RemoteChromiumProvider`
  satisfies the same contract as the Electron one.
- The UV to browser-coordinate mapping in `src/chromium-texture-utils.js` is
  already shared and pure, so the control path is identical whether the browser
  is in this process or on another machine.
- Adaptive quality already expresses itself as frame rate and pause requests,
  which map directly onto encoder bitrate and track enable/disable.

What a remote transport must not do is ship raw frames over the network, or
expose an unauthenticated pixel bridge. See `docs/STEEL_EVALUATION.md` for the
security posture a remote browser backend has to meet.
