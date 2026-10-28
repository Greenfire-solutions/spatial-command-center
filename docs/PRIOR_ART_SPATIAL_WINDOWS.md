# Prior art: spatial window systems

Everyone who has built a 3D space for viewing web content and running real programs
inside it, what they built, how it actually worked, and what it costs us to ignore them.

Research date: 2026-09-03. Companion to `docs/XR_FOUNDATION_ARCHITECTURE.md`.

Claims are marked **FACT** (primary source, spec, paper, or source code I read),
**COMMUNITY** (developer reports, corroborated, not official), or **ASSUMPTION** (my
inference, flagged so it can be argued with).

---

## 1. What the prior art actually proves

Three findings, and each one changes what Control Center 3D should do.

**First: this problem was solved in 1993, and the solution has not changed since.** Every
system that has ever put a live, interactive 2D application into a 3D space, without
exception, across 33 years, four operating systems and every headset ever shipped, uses
the same two mechanisms:

> **Output redirection.** The application renders to an offscreen surface instead of a
> screen. That surface becomes a texture.
>
> **Input redirection.** Pointer and keyboard events are routed to the application, with
> coordinates translated from 3D back into the application's own 2D space.

Microsoft Research named these in 2000. Control Center 3D implements exactly this today:
Chromium renders offscreen, paint frames become a `DataTexture`, and a ray hit becomes a
UV which becomes a Chromium input event. **The architecture is not a compromise. It is the
only known solution, and the project already found it.**

**Second: nobody has built this in WebXR.** The `awesome-webxr` list contains exactly one
project in this category. Not one open-source WebXR spatial window manager exists. Every
serious implementation, Simula, xrdesktop, Stardust XR, WayVR, Immersed, Virtual Desktop,
Horizon OS, visionOS, Android XR, is native, because native code can read another
process's rendered surface and a web page cannot. That is the whole reason the niche is
empty, and §7 argues it is also the reason the niche is worth occupying.

**Third: the interaction problem you named has a measured answer.** "The user should never
accidentally move a panel when they intended to click something inside it" is not a
tuning problem. It has a name in the literature, the *Heisenberg Effect of Spatial
Interaction*, a measured magnitude, a known direction, and a published correction. §8.1.

---

## 2. The lineage

```
1993  Windows on the World        Columbia · X server in a head-tracked HMD
                                  → defines display-fixed / surround-fixed / world-fixed
2000  Task Gallery                Microsoft Research · unmodified Windows apps in 3D
                                  → names output + input redirection
2004  Scalable Fabric             Microsoft Research · peripheral task management
2013  SpaceTop                    MIT Media Lab · see-through desktop, windows in depth
2014  Personal Cockpit            Ens et al. · body-centric window scaffold
2014  Ethereal Planes             Ens et al. · the design framework for all of the above
2017  Projective Windows          arranging windows via projective geometry
2018  JanusVR / JanusWeb          3D rooms authored in HTML markup
2019  xrdesktop                   Collabora, Valve-funded · GNOME/KDE windows in VR
2019  Firefox Reality             Mozilla · a real XR browser
2020  Simula                      SimulaVR · Wayland compositor inside Godot
2021  Wolvic                      Igalia · Firefox Reality's successor
2022→ Stardust XR                 a display server designed for XR from scratch
2023  Apple Vision Pro            visionOS · windows, volumes, Shared Space
2024  Horizon OS v67              Quest · movable panels, multi-window
2024→ WayVR                       Wayland apps inside VR overlays, via Smithay
2024  Android XR                  Jetpack SceneCore · SpatialPanel / PanelEntity
2025  Handows · Spatial Bar       palm-anchored windows · gaze window switching
2025  DuoZone                     LLM-guided XR window management
```

**FACT**, Every entry after 1993 is a variation on the same two mechanisms. What changed
is the display, the input device, and the layout metaphor. Not the architecture.

---

## 3. The two-mechanism law, and how each system implements it

This table is the reverse-engineering answer. It is the most useful thing in this document.

| System | Output redirection, how pixels are obtained | Input redirection, how events get back |
|---|---|---|
| **Windows on the World** (1993) | Head-tracked HMD indexes into one large X bitmap | Native X event routing |
| **Task Gallery** (2000) | Windows apps render to **off-screen bitmaps**, used as textures, with update notifications | Mouse/keyboard delivered to the app, **coordinates translated 3D → 2D** |
| **xrdesktop** | Window pixels via Vulkan (Gulkan), **DMA-BUF** import from the compositor | `libinputsynth`, xdo / XI2 / Clutter backends synthesise mouse and keys |
| **Simula** | Forked **wlroots** Wayland compositor; surfaces become Godot textures via `gdwlroots` | Godot input actions routed to wlroots surfaces through Haskell glue |
| **Stardust XR** | Server has a **built-in Wayland compositor**; clients render into the scenegraph | Server distributes input to handlers via its Spatial Universal Interaction System |
| **WayVR / wlx-overlay-s** | Embedded **Smithay** Wayland compositor; screens via `wlx-capture`, zero-copy GPU where available | Pointer and key injection into the focused overlay |
| **Immersed / Virtual Desktop / Bigscreen** | OS desktop capture, often via a **virtual display driver**, then **hardware H.264/HEVC encode** | Input sent back over the network to the host OS |
| **vSpatial** | **Per-application-window** capture, one virtual monitor per window | Host-side injection |
| **Horizon OS / visionOS / Android XR** | OS compositor owns the surface; app draws into a system-provided panel | System input routing; app never sees 3D |
| **Ultralight / CEF / Coherent** | Browser engine renders to an offscreen bitmap or directly to GPU | Host app forwards synthesised DOM events |
| **Neko / Hyperbeam / Kasm** | Server-side browser captured and **WebRTC-encoded** | Input over a data channel, replayed into the remote browser |
| **Control Center 3D** | Electron Chromium **offscreen rendering** → `DataTexture`; or JPEG over WebSocket → `ImageBitmap` | Ray hit → **UV → browser pixel** → Chromium input event |

**The read:** Control Center 3D sits in the same row as Task Gallery and the CEF family. It
is a textbook implementation of the canonical mechanism. The only unusual thing about it is
that it is trying to do this *from inside a web page*, which is why §14 of the architecture
document is as constrained as it is.

**FACT**, Task Gallery's own words, from the CHI 2000 paper:

> "Output redirection causes applications to render to off-screen bitmaps instead of the
> screen, gain access to those bitmaps so that they can be used as textures in the 3D
> environment, and receive notification whenever an application has updated its visual
> display. Input redirection causes mouse and keyboard events to be received by an
> application rather than the 3D environment's main window, but with mouse coordinates
> translated from 3D to 2D."

That is a description of `chromium-texture-source.js` written twenty-six years early.

---

## 4. Reference frames: the taxonomy is 33 years old and still correct

**FACT**, Windows on the World (UIST 1993) defined three frames, and every system since
has used the same three under different names:

| Windows on the World (1993) | Meaning | Today |
|---|---|---|
| **Display-fixed** | Fixed relative to the head | Head-locked HUD |
| **Surround-fixed** | Fixed to an information surround that travels with the user | Body-anchored / egocentric |
| **World-fixed** | Fixed to locations and objects in the 3D world | World-anchored |

**FACT**, DuoZone (2025) surveys the field and uses exactly this trichotomy , 
"world-fixed, head-fixed, and body-anchored layouts", citing Windows on the World for the
first. Thirty-one years, no change.

**FACT**, Ethereal Planes (SUI 2014, Ens / Hincapié-Ramos / Irani) is the framework that
formalises this: seven design dimensions and **four reference frames, fixed-egocentric,
fixed-exocentric, movable-egocentric, movable-exocentric.** It was derived from a
literature review and then used to design the Personal Cockpit. The full seven dimensions
are in a scanned PDF I could not extract; the four frames and the framework's purpose are
confirmed from the University of Manitoba HCI Lab's own listing.

**What this means for Control Center 3D.** The `WORKSPACE ROOT` proposal in the
architecture document is *movable-exocentric*: a world-fixed layout whose origin can be
relocated as a unit. That is a named, studied configuration, not an invention. And the
diagnostics HUD is the one *display-fixed* element, which is also the conventional and
correct choice.

---

## 5. The implementations, in depth

### 5.1 Open-source Linux VR desktops, the reverse-engineerable ones

These are the four codebases worth actually reading, because they are complete, they are
open, and they solved the same problem.

**Simula**, `github.com/SimulaVR/Simula`
**FACT**, A VR window manager built as a **Wayland compositor embedded in Godot**. The
stack: a fork of **wlroots** (`SimulaVR/wlroots`) supplies the Wayland infrastructure;
`SimulaVR/gdwlroots` exposes it to Godot; a forked Godot (`SimulaVR/godot`) owns rendering,
the 3D scene graph, physics and input mapping; **Haskell** glue in the main repo
orchestrates it via `SimulaVR/godot-haskell` bindings; and **Monado** provides OpenXR.
X11 apps work through XWayland, which "masquerades as a Wayland client."

*The architectural lesson:* Simula chose Godot for the 3D scene graph, physics and input , 
i.e. it treated a **game engine as the window manager's rendering layer**. Control Center
3D made the same call with Three.js. Simula's own stated cost is the language boundary:
godot-haskell forces manual memory management and pushes large parts of the code into `IO`.
The lesson is not "use Haskell"; it is that **the seam between the compositor and the 3D
engine is where the complexity concentrates**, and it should be as narrow as possible.

**xrdesktop**, Collabora, sponsored by Valve
**FACT**, Makes GNOME and KDE window managers VR-aware, rendering desktop windows in 3D
and generating mouse and keyboard input from VR controllers. Three libraries carry it:
**Gulkan** (Vulkan helpers, including initialising textures from memory or **DMA buffers**),
**GXR** (an abstraction over the XR runtime API, OpenVR first, OpenXR added in 0.14), and
**libinputsynth** (input synthesis with **xdo, XI2 and Clutter backends**).

*The architectural lesson, and it is the important one:* **xrdesktop separated the runtime
abstraction (GXR) and the input synthesis (libinputsynth) into their own libraries with
swappable backends.** That is precisely the shape recommended in §5 and §10 of the
architecture document, a device-abstraction layer and an input layer that are independent
of both the application and the runtime. xrdesktop then proved the value by swapping OpenVR
for OpenXR in a point release without touching the desktop integration.

**Stardust XR**, `github.com/StardustXR/server`
**FACT**, Not a VR desktop but **a display server designed for XR from first principles**.
Rust, Bevy-based reference server, IPC over **Unix domain sockets with a flatbuffers/
flexbuffers protocol**, an **object-oriented protocol built on a scenegraph** on both ends,
and a built-in Wayland compositor so 2D applications work. Input is distributed by the
**SUIS, Spatial Universal Interaction System**.

*The architectural lesson:* the project's own framing is the interesting part, *"all the
functionality is implemented in the clients. The server is just the glue."* The server
renders meshes, takes input from input methods, and routes it to input handlers. Everything
else is a client. That is a far more radical version of the layer boundary this project is
proposing, and it is worth reading `StardustXR/core` specifically for how the input routing
is expressed as a protocol rather than as function calls.

**WayVR + wlx-overlay-s**, `github.com/wayvr-org/wayvr`, `github.com/galister/wlx-overlay-s`
**FACT**, wlx-overlay-s is a lightweight OpenXR/OpenVR overlay giving access to
Wayland/X11 desktop screens from **Monado, WiVRn or SteamVR**, explicitly designed to run
alongside VR games with minimal performance impact. **WayVR extends it to run Wayland
applications directly inside VR**, using **Smithay** to run a Wayland compositor internally.
`wayvr-dashboard` is a separate overlay app, communicating **over IPC**, that launches
applications and games into the VR environment.

**FACT**, WayVR's crate layout: `wayvr`, `wayvr-ipc`, `wlx-capture`, `wlx-common`, `wgui`,
`wayvrctl`, `dash-frontend`, `uidev`. Documented limitation: *"X11 capture can generally
seem slow. This is because zero-copy GPU capture is not supported on the general X11
desktop."*

*The architectural lesson, and this is the closest analogue to Control Center 3D that
exists:* WayVR is a **content-source registry with a capture backend per source type**
(`wlx-capture`), a **separate compositor for hosting real programs** (Smithay), and a
**separate launcher UI talking over IPC** (`wayvr-dashboard`). That is the backend registry
of §14.3 and the command layer of §25, built and shipping. The zero-copy note is also the
same finding as `docs/FRAME_TRANSPORT.md`: the transport, not the renderer, is the ceiling.

### 5.2 Commercial desktop streamers

**FACT**, Immersed streams at up to **150 Mbps with H.264+ encoding** and requires a GPU
with hardware encode, **NVENC on NVIDIA, or an AMD equivalent**. **COMMUNITY**, Virtual
Desktop users measure desktop latency around **19–22 ms**, and Virtual Desktop supports both
H.264 and HEVC. Bigscreen Remote Desktop installs a host application and presents the
desktop on a screen in a virtual room.

**FACT**, vSpatial takes the more interesting approach: **a virtual monitor per application
window**, rather than one capture of the whole desktop.

**FACT**, `MolotovCherry/virtual-display-rs` (899★, Rust) is a Windows **virtual display
driver** that adds multiple virtual monitors, explicitly listing VR as a use case. This is
the infrastructure layer the commercial streamers depend on: create monitors that do not
physically exist, let the OS composite into them, then capture and stream them.

*The architectural lesson:* the commercial answer to "many windows in VR" is **not** many
windows. It is *a few very large virtual monitors*, because one encoded video stream is
enormously cheaper than N application captures. Apple reached the same conclusion , 
**FACT**, visionOS 2's Mac Virtual Display ultrawide mode is documented as equivalent to
two 4K monitors side by side, in **one** display.

This is a real strategic finding for Control Center 3D and it cuts against the product
concept. §8.4.

### 5.3 OS-native panel systems, what the platforms decided

**Horizon OS.** **FACT**, v67 introduced movable panels; users can arrange up to **three
panels in a "hinged" layout**, panels connected at their left and/or right edges, **moved as
a group by grabbing a manipulation handle**, and place three more freely. Later versions
raised the ceiling to **up to 12 apps at once**. Panels can be **pinned** to a location via
the control bar. **Theater View** expands one panel, centres it, and dims everything else.
Developers can set **resize modes**, free, fixed aspect ratio, or no resize, along with
minimum and maximum dimensions and aspect-ratio locking.

**visionOS.** **FACT**, Content is organised into a **Shared Space** where multiple windows
(flat) and volumes (bounded 3D) from multiple apps coexist, with initial placement decided
by the system. Compositor Services bridges to Metal for fully immersive rendering; RealityKit
handles the shared case.

**Android XR.** **FACT**, Jetpack XR's SceneCore exposes `PanelEntity` and Compose for XR
exposes `SpatialPanel`; an app may use one panel or migrate its 2D UI to **multiple spatial
panels** that can be positioned and rotated. SceneCore's component system provides
"affordances for users to move, resize, and interact with models and panels."

*The architectural lesson, and all three platforms independently agree:* **the panel is a
system primitive, and the application never sees 3D.** The OS owns placement, movement,
resize affordances and grouping. The app draws 2D into a rectangle. Control Center 3D is
attempting to be that OS layer from inside a web page, which is the ambition, and also the
reason it inherits every problem the platforms solved in native code.

The most directly stealable idea is Horizon OS's **hinge**: a group of 2–3 panels joined at
their edges with one manipulation handle. It is a grouping primitive with a physical
metaphor, and it is much better than a checkbox list of "groups."

### 5.4 XR browsers

**FACT**, **Wolvic** (`github.com/Igalia/wolvic`, Igalia, successor to Mozilla's Firefox
Reality) supports **both GeckoView and Chromium backends** and handles devices with
opaque-only blend modes (Quest), alpha blend (Pico 4), and additive displays (Magic Leap 2).
Note the maintenance cost this exposes: WebXR sessions do not work with prebuilt GeckoView
Maven artifacts, so GeckoView must be built manually with patches.

**FACT**, **JanusVR / JanusWeb** (`github.com/jbaicoianu/janusweb`) took the opposite
approach: rather than putting websites in 3D, it defined **JML**, a markup language inside
`<FireBoxRoom>` tags, so that a document *becomes* a 3D room. Rooms are "hosted in the same
manner as regular websites."

*The architectural lesson:* JanusVR is the road not taken. It bet that the web would author
3D natively rather than being viewed as flat panels in 3D. That bet lost. **Everything that
shipped and stuck, Horizon OS, visionOS, Android XR, every VR desktop in §5.1, renders
existing 2D content on flat rectangles.** The flat panel is not a failure of imagination; it
is what content actually is.

### 5.5 Browser-as-texture in native engines

This is the mature, well-trodden version of what Control Center 3D does.

**FACT**, **Ultralight** is a GPU-accelerated HTML renderer for embedding in games and
native apps, WebKit-derived, supporting Windows, macOS, Linux, Xbox, PlayStation and ARM64.
It can render to an **offscreen bitmap for texture upload**, or **directly to the GPU** via
low-level driver commands. A portion of WebCore is LGPL; the full source is proprietary and
requires a commercial licence.

**FACT**, **Coherent UI** renders an HTML5 page plus its JavaScript context and hands the
engine **a texture**, usable on a HUD or "on the world."

**FACT, and this is the load-bearing one**, Coherent Labs' own published position on CEF:
CEF *"was not designed for games or demanding real-time applications"*; getting image bytes
into an engine texture *"requires at least two copy operations between GPU VRAM and system
RAM, which are expensive."*

*The architectural lesson:* **the two-copy problem is universal and known**, and Control
Center 3D has already measured its own instance of it, 1280×800 BGRA is 3.91 MB per frame,
~123 MB/s per screen at 30 fps, and the Electron shared-texture probe in
`docs/FRAME_TRANSPORT.md` failed for exactly the reason the games industry documents: the
GPU handle cannot be imported from renderer JavaScript. The JPEG-over-WebSocket path that
replaced it is the same move the whole industry makes when zero-copy is unavailable.

### 5.6 Remote browser streaming

Covered in the architecture document §14. The short version: **Neko** (`m1k1o/neko`,
Apache 2.0, WebRTC, self-hosted) is the open reference implementation; **Hyperbeam** is the
commercial one; **Kasm** is the heavyweight; **browserless**/CDP screencast is the wrong
tool for interactive video.

### 5.7 WebXR, the empty niche

**FACT**, The `msub2/awesome-webxr` curated list contains **exactly one** project matching
"spatial desktop, window manager, browser in VR, workspace, or running applications in XR":

> **XRSH**, "Linux virtual machines running inside WebXR to enable live-scripting, packages
> and prototyping inside an in-VR shell." `https://xrsh.isvery.ninja` ·
> repository at `https://codeberg.org/xrsh/xrsh`

XRSH is the only WebXR project I found that runs *real programs* inside an XR session, and
it does so by running Linux VMs **in the browser** (compiled emulation), not by streaming
them. That sidesteps the entire cross-origin problem by never crossing an origin, the VM is
the page's own content.

**FACT**, `github.com/exokitxr/exokit` (MIT) is the other historically relevant attempt: a
native XR engine that runs web pages, implemented as **a Node.js module that emulates a
browser** with C++ bindings for hardware, supporting OpenVR, Oculus Desktop and Mobile, and
Magic Leap. Its documentation shows launching individual URLs, and I found **no evidence it
composited multiple independent web pages into one scene**. Downloads are unavailable and
the project appears dormant.

**ASSUMPTION, but a well-supported one:** the WebXR niche is empty because the web platform
forbids the mechanism. Output redirection requires reading another origin's rendered
surface, which every browser prohibits by design and which `WICG/html-in-canvas` explicitly
excludes at spec level. You cannot write Simula as a web page. You can only write the client
half and put the compositor somewhere else, which is exactly what Control Center 3D's
remote host is.

### 5.8 Field evidence: someone tried the obvious thing

**COMMUNITY**, A three.js forum thread, "Issue with Rendering HTML iframe in WebXR Quad
Layer with Three.js," documents a developer attempting precisely the approach most people
assume must work: create an iframe, draw its content to a canvas, make a `CanvasTexture`,
bind it to an `XRQuadLayer`. Result: **a CORS error blocking the canvas draw**. They fell
back to **html2canvas**, which worked only because it re-paints DOM it can read, and then
broke anyway, *"if page have more than 100vh, it will make a bad texture."*

This is the architecture document's §14 reproduced independently by a stranger. Worth
keeping as a citation the next time someone proposes the iframe route.

---

## 6. Research systems: the measured findings

The academic literature has already run the experiments this project would otherwise run by
feel. These are the results with numbers attached.

### 6.1 Task Gallery (Microsoft Research, CHI 2000)

**FACT**, Hosted **any unmodified Windows application** via the redirection mechanism in
§3. The metaphor: tasks as artwork on the walls of a virtual gallery, the selected task on
a stage, transitioning "from artwork into live windows" on a one-second animation with a
ghosted marker left behind.

Design decisions that read as prescient:

- **"Window manipulation controls appear over a window banner when the user points to
  it"**, Add to Selection, Loose Stack, Maximize, Move, Bring Forward, Send Back, Ordered
  Stack, Close. **This is the Horizon OS control bar, twenty-four years early, and it is the
  frame-is-the-handle model from the architecture document.**
- **"Task frames are tilted outward so that they are more legible from a distance."**
- Windows "mounted on stands to visually ground them to the stage", a depth cue.
- Navigation deliberately **constrained**: jump controls to back / forward / home /
  bird's-eye rather than free flight, because "users (especially non-gamers) tend to get
  lost in many 3D systems that require them to navigate," each jump a one-second camera
  animation. Their studies found users **did not become disoriented** using these controls.

**Measured (n=11):** participants placed **significantly more tasks on the left and right
walls than on the ceiling or floor, 4.18 versus 2.18 on average (t(10) = 2.54, p < .05)**,
despite legibility being equal on all surfaces. They spatially grouped related tasks: things
that "went together" were placed close together on the same surface.

**What this costs Control Center 3D to ignore:** the existing arc layout is already
wall-like and therefore right. Adding ceiling or floor placement will be used less than the
geometry suggests. And free-flight locomotion in `XrNavigation` is the thing Task Gallery
explicitly designed against, worth revisiting whether jump-to-target beats flying.

### 6.2 The Heisenberg Effect of Spatial Interaction (CHI 2020)

This is the single most actionable paper in the entire literature for this project.

**FACT**, Wolf, Gugenheimer, Combosch, Rukzio. The effect: *a discrete input such as a
button press disturbs the position of the tracker, producing a different selection point
than the one the user was aiming at.*

**Measured, n=16, Fitts's-Law-style study on HTC Vive:**

| Finding | Value |
|---|---|
| Share of all selection errors caused by the effect | **30.45%** |
| Direction of the error | **A systematic upward shift** |
| Hypothesised cause of the direction | The **position of the trigger button** on the controller |
| Error reduction from a correction function | **25.4%** |
| Error reduction with the full compensation set | **down to ~8.8%** |
| Angular error vs target size | **Increases with larger targets and longer click duration** |
| Arm position | Influences click duration; a stretched arm posture behaves differently |
| Body position (sitting/standing) | **No significant difference**, it does not affect the pointing arm |

**FACT**, Their concrete mitigation: accepting a click at a **trigger press value of 0.83**
rather than at full depression reduces the average Heisenberg Magnitude, because a shorter
click duration means less time for the controller to drift. Values above that begin to
reintroduce the error; below it, false positives.

**What this means for Control Center 3D, precisely:**

1. The "I clicked and it moved" problem is **~30% caused by physics, not by your code.**
   No amount of hit-target tuning removes it.
2. The error is **systematically upward**, so a fixed downward offset applied at the moment
   of press is a legitimate, cheap correction, and it is the published one.
3. **Fire `SELECT` at trigger ≈ 0.83, not at 1.0.** This is a one-line change to the
   coercion layer in §6.5 of the architecture document, and it is the highest
   value-per-line change available.
4. Because the effect grows with **click duration**, a long-press gesture is the *worst*
   possible binding for a precision action. Long-press for context menu should be on a
   large target only.

### 6.3 Virtual monitors vs physical monitors (Pavanatto & Bowman, IEEE VR 2021 and after)

**FACT**, "Do we still need physical monitors?" concluded that virtual monitors are a
feasible approach for serious productivity work, but are **currently constrained by
technical limitations that lead to inferior usability and performance compared to physical
monitors.**

**FACT, the specific failure mode, and it is the one this project will hit:** virtual
monitors perform worse **when the system must scale the virtual content up to enable
readability**, because scaling up leads to **more head movement and less awareness of
content in the periphery.**

**FACT**, Their recommendation at the time was a **hybrid**: physical monitors for
familiarity and trust, virtual for extra space. A later study comparing three physical
monitors, a laptop with virtual desktops, and three virtual monitors found the physical
workstation still the gold standard on all metrics, but the **virtual condition beat the
laptop condition** and was rated easier to use and more intuitive.

**What this costs Control Center 3D to ignore:** the temptation, when panel text is soft, is
to make panels bigger. That is the documented wrong move, it trades legibility for head
movement and peripheral loss. The right move is the one this project already measured:
**quad compositor layers, which raise legibility without changing angular size.**

### 6.4 Spatial Bar (IEEE VR 2025)

**FACT**, Pavanatto, Grubert, Bowman. Studied window switching on large virtual displays.
Their apparatus is worth copying as a test harness: a Unity display background **curved at
1 m radius** from the user, **20 windows** each **1536×864 px (one fifth of display size)**,
curved at the same depth, **custom shaders to set rendering order**, a simulated cursor
always rendered on top and **mapped onto the curved surface** so movement follows the pixels
of the virtual screen, with a **raycast from the cursor** to select.

**Measured findings:**

| Comparison | Result |
|---|---|
| Overall thumbnail selection | **GAZE faster than CURSOR** |
| At **large** distance | **GAZE faster than CURSOR** |
| At **short** distance | **CURSOR faster than GAZE** |
| Physical demand | **Cursor TELEPORT rated lower than STAY** |
| Subjective speed | Participants favoured GAZE for "I could switch between windows quickly" |

**What this means:** the correct pointing modality is **distance-dependent**, and that is a
measured result, not a preference. For a workspace with windows placed around the user, a
gaze-assisted acquisition for distant panels plus ray/cursor for near ones is the
evidence-backed design. It also means **cursor teleportation**, snapping the pointer to a
newly focused window rather than making the user drag it there, measurably reduces physical
demand.

### 6.5 Personal Cockpit, SpaceTop, Handows, DuoZone

**FACT**, **SpaceTop** (CHI 2013) tackled occlusion and z-order confusion with a
see-through desktop that **distributes windows in depth above the keyboard**, blending 2D
and 3D. Depth placement avoids overlap and supports focus-plus-context.

**FACT**, **Personal Cockpit** (CHI 2014) reduces visual clutter by organising windows on a
**body-centric "cockpit" scaffold** around the user, an egocentric layout that exploits
spatial memory and **small head or body movements** for quick access and task switching.

**FACT**, **Handows** (TVCG 2025) anchors **miniature window interfaces to the user's palm**
for stable, touch-based manipulation in a consistent body-relative reference frame.

**FACT**, **DuoZone** (2025) is the current state of the art in automated placement: an
Apple Vision Pro client built in **Unity with PolySpatial**, using **arrangement zones** and
**recommendation zones**, with a **host PC (RTX 4050) handling real-time AI assistance**
over the local network. Its baseline was **visionOS's own native gaze + pinch manual
adjustment**.

**FACT, the field's stated core problem, from DuoZone's own framing:** *spatial layouts
overload users when too many windows exist in the workspace, with windows occluding each
other and harming task efficiency.*

**What this costs Control Center 3D to ignore:** the product concept is "10, 20, 50 windows."
The literature's consistent finding is that **more windows is the problem, not the feature.**
Every serious system in this section is a mechanism for *reducing* how many windows compete
for attention at once, depth separation, body-centric scaffolds, palm miniatures, automated
zones. The existing `BrowserQualityDirector` attention model is the right instinct applied
to rendering; the same instinct is needed for *layout*.

---

## 7. What nobody has built

Stated plainly, because it is the strategic finding.

**Nobody has built a WebXR spatial window manager that runs arbitrary live web content and
real programs.** Not as open source, not commercially. The reasons are specific and each one
is a wall documented elsewhere in these docs:

1. **The web platform forbids output redirection across origins.** You cannot read another
   origin's pixels. This is deliberate and permanent.
2. **The DOM does not composite inside an immersive session**, so the one escape hatch a web
   page normally has, put a real iframe on top, does not exist in a headset.
3. **A headset cannot run the browsers.** Quest hardware cannot host ten Chromium instances,
   so the compositor has to live elsewhere and stream, which reintroduces every problem of
   the commercial streamers plus network.
4. **The platforms are actively occupying the space natively.** Horizon OS, visionOS and
   Android XR all ship panel systems, and they own the compositor.

**Where that leaves the opportunity.** The thing Control Center 3D can do that none of the
native systems can is the thing it already has and they do not: **a connector graph and AI
agents between windows**, plus **a deployment model that is a URL**. Horizon OS gives you
twelve panels; it does not let you draw a data pipe from one to another and put an agent on
it. That is the defensible part, and the panel plumbing is the tax you pay to get there.

**ASSUMPTION**, I think the strategic error available here is spending the project's effort
on being a better panel manager than Horizon OS, which is a race against a platform owner
who controls the compositor. The differentiated surface is everything above the panel.

---

## 8. Findings that should change Control Center 3D

Ranked by value per unit of work.

### 8.1 Fire SELECT at ~0.83 trigger, and apply a downward correction

`REQUIRED NOW` · Source: Heisenberg Effect, CHI 2020 (§6.2)

The single highest-leverage change in this entire document. About **30% of selection errors
are caused by the trigger press itself moving the controller**, the shift is **systematically
upward**, and firing the click earlier in the trigger travel measurably reduces it. Combined
with a fixed corrective offset, published results take error from ~30% down to ~8.8%.

This belongs in the coercion layer (architecture §6.5) alongside the hysteresis
recommendation, and it directly serves the requirement that clicking must not disturb a
panel.

### 8.2 Adopt the hinge, not a "group" checkbox

`RECOMMENDED NOW` · Source: Horizon OS (§5.3)

Horizon OS's grouping primitive is two or three panels **joined at their edges, moved as a
unit by one manipulation handle.** It is physical, discoverable, and needs no UI beyond a
handle. It is a better first grouping feature than the `groupId` label proposed in
architecture §13.7, and the two are compatible, the hinge is the spatial form, `groupId`
is the semantic one.

### 8.3 Angular scaling and outward tilt, not bigger panels

`RECOMMENDED NOW` · Sources: Task Gallery (§6.1), Pavanatto (§6.3), Meta design guidance

Task Gallery tilted task frames outward for distance legibility in 2000. Pavanatto measured
that **scaling content up to fix readability costs head movement and peripheral awareness**.
The project's own hardware measurement already found the right lever: quad compositor
layers improve legibility without changing angular size. So: **tilt panels toward the viewer
as a function of position in the arc, angularly scale the chrome, and resist the urge to
enlarge.**

### 8.4 Reconsider "50 windows" as a goal

`RECOMMENDED NOW` · Sources: DuoZone, Personal Cockpit, SpaceTop (§6.5); visionOS, Immersed (§5.2)

Two independent lines of evidence point the same way. The research consensus is that many
simultaneous windows **overload attention and harm task efficiency**, and every serious
system is a mechanism for reducing competition rather than raising the count. And the
commercial answer to "many windows" is **fewer, larger surfaces**, visionOS's ultrawide Mac
Virtual Display is two 4K monitors merged into one, because one encoded stream is far
cheaper than N captures.

For a streaming architecture this is also an economic argument: one browser per panel means
ten panels is ten browsers.

**ASSUMPTION**, I would treat 50 windows as a *capacity* the architecture must not preclude,
and 5–10 as the *designed-for* case that gets the tuning. That is a product decision, not an
engineering one, which is why it is flagged rather than assumed.

### 8.5 Distance-dependent pointing, and cursor teleport on focus

`FUTURE` · Source: Spatial Bar, IEEE VR 2025 (§6.4)

Gaze wins at long range, cursor wins at short range, and teleporting the cursor to a newly
focused window measurably lowers physical demand. Eye tracking is not available on Quest 3
via WebXR, so the gaze half is `FUTURE`, but **cursor teleport on focus is available today**
and costs almost nothing.

### 8.6 Constrained navigation may beat free flight

`RECOMMENDED NOW` to evaluate · Source: Task Gallery (§6.1)

Task Gallery deliberately rejected general egocentric navigation and provided jump controls
with one-second animations, and measured that users did not get disoriented. Control Center
3D's `XrNavigation` implements free flight, thumbstick strafe, turn, altitude, squeeze
boost, which is the design Task Gallery argued against for non-gamers. The existing
`focusCamera` action is already the jump primitive; it may deserve to be the primary
mechanism with flight as the fallback rather than the reverse.

Meta's own mixed-reality guidance points the same way for a different reason: **do not
teleport or move the user in passthrough**, because they are in a real room.

### 8.7 Study xrdesktop's library split and WayVR's crate split

`RECOMMENDED NOW` to read · Source: §5.1

Two independent projects converged on the same decomposition the architecture document
proposes:

- **xrdesktop** separated **GXR** (runtime abstraction, swappable OpenVR/OpenXR) from
  **libinputsynth** (input synthesis, swappable xdo/XI2/Clutter backends), then proved the
  value by swapping the runtime in a point release.
- **WayVR** separated **`wlx-capture`** (content acquisition per source type) from the
  overlay from **`wayvr-dashboard`** (launcher, over IPC).

Both are `src/xr-core/` and `src/windows/backends/` with different names. Reading them is
cheaper than rediscovering their boundaries.

---

## 9. Repository index

Everything worth cloning, in rough order of relevance to this project.

| Repository | Language | Why |
|---|---|---|
| `github.com/wayvr-org/wayvr` | Rust | Closest analogue: capture backends + embedded compositor + IPC launcher |
| `github.com/galister/wlx-overlay-s` | Rust | The overlay it extends; capture and input injection |
| `github.com/olekolek1000/wayvr-dashboard` | TypeScript | Launcher UI over IPC, the command layer, shipping |
| `github.com/SimulaVR/Simula` | Haskell | Wayland compositor inside a game engine, end to end |
| `github.com/SimulaVR/gdwlroots` | C | The compositor↔engine seam, isolated |
| xrdesktop (Collabora, freedesktop GitLab) | C | GXR runtime abstraction + libinputsynth |
| `github.com/StardustXR/server` | Rust | XR-native display server; input as protocol |
| `github.com/StardustXR/stardust-xr` | Rust | The client/protocol core |
| `github.com/Igalia/wolvic` | Java/C++ | Production XR browser, multi-backend, multi-device |
| `codeberg.org/xrsh/xrsh` | JS | The only WebXR project running real programs in-session |
| `github.com/m1k1o/neko` | Go | Apache-2.0 WebRTC remote browser, the streaming reference |
| `github.com/MolotovCherry/virtual-display-rs` | Rust | Virtual monitor driver, the streamers' foundation |
| `github.com/jbaicoianu/janusweb` | JS | The road not taken: 3D-native web markup |
| `github.com/exokitxr/exokit` | JS/C++ | Historical: JS-native XR engine running web pages (dormant) |
| `github.com/mbucchia/VirtualDesktop-OpenXR` | C++ | OpenXR runtime implementation; compositor-layer patterns |
| `github.com/kalegd/DigitalBacon-UI` | JS | three.js 3D UI supporting touch, mouse and XR inputs |
| `github.com/facebook/immersive-web-sdk` | TS | Meta's own WebXR framework: ECS + uikit spatial UI |
| `github.com/pmndrs/uikit` | TS | The spatial UI runtime Meta adopted |

---

## 10. Sources

**Research papers**
- Feiner, MacIntyre, Haupt, Solomon. *Windows on the World: 2D Windows for 3D Augmented Reality.* UIST '93. https://dl.acm.org/doi/10.1145/168642.168657 · project page http://www.cs.columbia.edu/graphics/projects/wotw/wotw.html
- Robertson, van Dantzich, Robbins, Czerwinski, Hinckley, Risden, Thiel, Gorokhovsky. *The Task Gallery: a 3D window manager.* CHI '00. https://dl.acm.org/doi/10.1145/332040.332482 · PDF https://www.microsoft.com/en-us/research/wp-content/uploads/2000/01/taskgallery-submitted.pdf
- Robertson et al. *Scalable Fabric: flexible task management.* AVI '04.
- Lee, Olwal, Ishii, Boulanger. *SpaceTop: integrating 2D and spatial 3D interactions in a see-through desktop environment.* CHI '13.
- Ens, Finnegan, Irani. *The Personal Cockpit: a spatial interface for effective task switching on head-worn displays.* CHI '14.
- Ens, Hincapié-Ramos, Irani. *Ethereal Planes: a design framework for 2D information space in 3D mixed reality environments.* SUI '14. https://dl.acm.org/doi/10.1145/2659766.2659769 · https://hci.cs.umanitoba.ca/Publications/details/ethereal-planes
- Lee, An, Kim, Bae. *Projective Windows: arranging windows in space using projective geometry.* UIST '17 Adjunct.
- Wolf, Gugenheimer, Combosch, Rukzio. *Understanding the Heisenberg Effect of Spatial Interaction.* CHI '20. https://dl.acm.org/doi/abs/10.1145/3313831.3376876 · PDF https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.100/institut/mitarbeiterbereiche/wolf/HeisenbergCHI20.pdf
- Pavanatto, North, Bowman, Badea, Stoakley. *Do we still need physical monitors?* IEEE VR '21. https://ieeexplore.ieee.org/document/9417776/ · https://wordpress.cs.vt.edu/3digroup/2020/12/02/ar-virtual-monitors/
- Pavanatto, Lu, North, Bowman. *Multiple monitors or single canvas?* TVCG 31(3), 2024.
- Pavanatto, Grubert, Bowman. *Spatial Bar: Exploring Window Switching Techniques for Large Virtual Displays.* IEEE VR '25. https://arxiv.org/pdf/2501.11754
- Wang, Zhou, Ren, Kristensson, Li. *Handows: A palm-based interactive multi-window management system in VR.* TVCG 2025.
- Trovato et al. *DuoZone: A User-Centric, LLM-Guided Mixed-Initiative XR Window Management System.* 2025. https://arxiv.org/pdf/2511.15676
- Li, Gebhardt, Inglin, Steck, Streli, Holz. *SituationAdapt: Contextual UI optimization in MR with situation awareness via LLM reasoning.* UIST '24.
- Cheng, Yan, Yi, Shi, Lindlbauer. *SemanticAdapt.* UIST '21.
- Lindlbauer, Feit, Hilliges. *Context-aware online adaptation of mixed reality interfaces.* UIST '19.
- Evangelista Belo et al. *XRgonomics.* CHI '21 · *AUIT: the adaptive user interfaces toolkit for XR.* UIST '22.

**Open source**
- Simula https://github.com/SimulaVR/Simula · stack overview https://simulavr.com/blog/software-overview/
- xrdesktop https://www.collabora.com/news-and-blog/news-and-events/moving-the-linux-desktop-to-another-reality.html · OpenXR release https://www.collabora.com/news-and-blog/news-and-events/xrdesktop-014-with-openxr-support-released.html
- Stardust XR https://github.com/StardustXR/server · https://stardustxr.org/docs/dive-deeper/deep-overview
- WayVR https://github.com/wayvr-org/wayvr · dashboard https://github.com/olekolek1000/wayvr-dashboard · https://wayvr.org/
- wlx-overlay-s https://github.com/galister/wlx-overlay-s
- Wolvic https://github.com/Igalia/wolvic
- JanusWeb https://github.com/jbaicoianu/janusweb
- Exokit https://github.com/exokitxr/exokit
- XRSH https://codeberg.org/xrsh/xrsh · https://xrsh.isvery.ninja
- awesome-webxr https://github.com/msub2/awesome-webxr
- virtual-display-rs https://github.com/MolotovCherry/virtual-display-rs
- neko https://github.com/m1k1o/neko

**Platform documentation**
- Horizon OS panels https://developers.meta.com/horizon/design/panels/ · windows https://developers.meta.com/horizon/design/windows/ · panel sizing https://developers.meta.com/horizon/essentials/horizon-os-panel-sizing/
- Quest v67 multi-window https://www.meta.com/blog/meta-quest-v67-update-new-window-layout-creator-content-horizon-feed/
- visionOS Mac Virtual Display https://support.apple.com/guide/apple-vision-pro/use-mac-virtual-display-tan357ede966/visionos
- Android XR spatial UI https://developer.android.com/develop/xr/jetpack-xr-sdk/ui-compose · SceneCore https://developer.android.com/jetpack/androidx/releases/xr-scenecore

**Commercial and embedded**
- Ultralight https://ultralig.ht/
- Coherent Labs on CEF in games https://coherent-labs.com/posts/what-developers-should-consider-when-using-chromium-embedded-framework-cef-in-their-games/
- Bigscreen Remote Desktop https://bigscreenvr.com/remotedesktop/
- Varjo Workspace https://varjo.com/blog/introducing-a-dimensional-interface-varjo-workspace/

**Field reports**
- three.js forum, iframe into a WebXR quad layer https://discourse.threejs.org/t/issue-with-rendering-html-iframe-in-webxr-quad-layer-with-three-js/81761

---

*Compiled 2026-09-03. Sections 6 and 8 carry the measured results; §3 carries the
reverse-engineering table. Where a paper's PDF could not be text-extracted, the claim is
sourced to the publisher's own abstract or the authors' institutional listing and marked
accordingly.*
