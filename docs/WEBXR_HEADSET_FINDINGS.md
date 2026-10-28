# What happened on a real Quest 3

The README asked for exactly this: serve the build to a headset and report where
reality diverges. This is that report. Hardware was a Quest 3 running
OculusBrowser 150.1, reached over HTTPS on a named tunnel.

Two faults stopped the workspace from being usable. Both are fixed here.

## 1. ContactShadows blanked every immersive session

**Symptom.** The page renders correctly in the Quest browser. Pressing ENTER VR
turns the display black in every direction, and leaving the session requires
quitting. Nothing errors.

**Why it was hard to see.** Every indicator said healthy:

| | |
| --- | --- |
| `requestSession` | granted in 425 ms |
| `presenting` | true |
| frames | 10926 and climbing |
| meshes / visible | 97 / 97 |
| errors | none |
| context lost | no |

**Cause.** `ContactShadows` renders the scene into its own `WebGLRenderTarget`
every frame, then restores by binding `null`. On a desktop `null` and the render
surface are the same framebuffer, so this is invisible. Inside an XR session they
are different surfaces, and everything drawn afterwards goes somewhere the
headset never reads.

**Fix.** It renders on desktop only. That is also correct on its own terms: it is
a virtual-floor effect, and section 13A of `VOICE_CONNECTORS_AGENTS.md` is
explicit that nothing critical may depend on a virtual floor. In passthrough
there is no floor to receive it.

`<Environment>` uses the same mechanism and was cleared by the same bisection: it
renders once at `frames={1}`, before any session exists.

## 2. The workspace could start behind you

The workspace lives at fixed world coordinates authored for a desktop camera
placed to look at it. A headset decides your facing from its own reference
space, which on a Quest follows the guardian and the last recenter, so the arc
can begin behind you. It did.

`XrNavigation` recenters on session entry by solving for the origin transform
that lands the head at a chosen pose. It moves the player, never the workspace,
so every world coordinate and all the ray-based interaction from Phase 4 are
untouched.

## What was verified working on hardware

The README listed head tracking, immersion and controller input as written but
never executed. They work.

- Session grant, `immersive-vr` and `immersive-ar` both supported
- Head tracking through the Phase 4 viewpoint abstraction, reporting a correct
  `local-floor` head height of ~1.24 m
- In-scene spatial chrome, drawn and readable
- Controller models and hand models present in the scene
- Browser surfaces textured and legible

## What the headset told us that a desktop cannot

- **`maxTextureSize` is 8192**, against 16384 in desktop Chrome. A hard ceiling
  on how much source resolution a mesh-textured surface can carry.
- **The desktop layout does not transfer to headset scale.** The arc is authored
  for a camera about six metres back, which is right on a monitor. Standing in
  it, the screens read as distant and small. `?standoff=` tunes it live; 2.4 m is
  the current default and wants refining by feel.

## Flight locomotion

`XrNavigation` also adds movement, because a wall of screens spanning y 0.42 to
2.82 cannot be read from one standing position.

| Input | Action |
| --- | --- |
| Left thumbstick | Strafe and forward/back, relative to gaze |
| Right thumbstick X | Turn |
| Right thumbstick Y | Altitude |
| Either squeeze | Boost |

Turning pivots on the viewer rather than the world origin, which avoids swinging
the user through an arc and the motion sickness that causes. Locomotion stands
down while `isManipulatingScreen` is set, so it never fights the thumbstick
bindings `XrControllerInput` uses during a grab.

## Testing browser content before the remote host exists

The README notes that browser surfaces will report `OFFLINE` on a Quest until the
remote host half is built, and that this is the largest remaining piece.

`xr.html` plus `src/xr/entry.jsx` install a synthetic `window.spatialBrowser`
before the app boots, so `resolveBrowserProvider` finds a bridge exactly as it
does under Electron and the whole application runs against static canvas pages.
The bridge emits premultiplied BGRA at the source's real pixel size, which is
Electron's own byte order, so the un-swizzle shader runs unchanged and this
exercises the real texture path rather than a parallel one. It refuses to replace
a real preload bridge.

This is scaffolding for measurement, not a product path. It retires when the
remote provider has a host to talk to.

## Debugging a headset at all

A Quest has no reachable console, and `<Html>` renders nothing inside a session,
so a failure there is normally invisible. `src/xr/diagnostics.js` posts errors,
console errors, renderer facts, session lifecycle, and a wrapped
`navigator.xr.requestSession` to a dev-server sink at `/__diag`.

Wrapping `requestSession` is what produced the rejection reason that mattered:
the caller catches it to render a DOM message, which is invisible in a headset
and never reaches an `unhandledrejection` handler.

`DiagnosticsHud` is head-locked and built only from unlit primitives, with no
texture and nothing that can suspend. That is deliberate: it is a control that
cannot itself fail, so if it draws, the renderer and session are fine and the
fault is content.

Scene layers are switched with one positional mask so a test can be typed on a
headset keyboard without error:

```
?diag=<digits>     hud env shadow screens quality
?diag=1            everything, panel on
?diag=10000        panel only
?diag=110          shadows off
```

The panel prints the active mask, so what is switched on is visible from inside
the headset rather than inferred from a URL you typed blind.

## Settled on hardware: use a compositor layer

Measured on a Quest 3, both panels carrying the identical canvas at identical
world size and distance, the only variable being how the pixels reach the eye.

| Surface | Result |
| --- | --- |
| Textured mesh | degrades quickly; small type is not resolvable |
| Quad layer, `quality="text-optimized"` | **every row legible, down to 10 px** |

The gap is not marginal. It is the difference between a browser surface being
readable and being decorative.

### What this means for the transport

`image-bitmap-surface.js` already decodes frames to an `ImageBitmap`, which is a
valid `XRLayer` source. The JPEG-over-WebSocket host therefore already produces
the thing a compositor layer consumes, and the sharpness win is reachable
without changing the transport.

The deviceScaleFactor budget in `cb52f1a` remains the right lever on the
desktop, where everything is drawn into one framebuffer. It is not the lever
that decides headset legibility.

### The architectural cost, which is real

A quad layer is only visible where the WebGL base layer is transparent.
`@pmndrs/xr` composites with `layers.push(xrManager.getBaseLayer())`, so the base
layer is drawn **on top of** every quad layer. The probe read as completely black
until the scene stopped painting over it.

Adopting layers therefore is not a drop-in swap for a textured mesh:

- the canvas needs `alpha: true` rather than the current opaque context;
- the opaque `<color attach="background">` cannot fill the frame;
- anything else that covers the view, `StudioEnvironment` included, becomes a
  constraint rather than a free choice;
- each screen needs a transparent region where its layer sits.

Probe mode requests a transparent base layer for exactly this reason. Everywhere
else keeps the opaque context, which is cheaper and correct while the app draws
no layers.

## Original framing: mesh or compositor layer

`?probe=1` puts a browser surface drawn as a textured mesh beside the same
surface drawn as a WebXR quad layer at `quality="text-optimized"`, identical
content at identical size and distance. Read the smallest legible row on each.

This decides whether the remote provider should deliver pixels for a mesh
texture or a source a compositor layer can consume, which changes what the
transport must produce. Given `maxTextureSize` is 8192 on the device and
`cb52f1a` is already spending real effort on sharpness through the
deviceScaleFactor budget, it is cheaper to settle now than after the WebRTC
transport is built on the assumption.
