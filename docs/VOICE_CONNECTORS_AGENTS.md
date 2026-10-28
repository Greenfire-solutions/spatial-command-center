# Spatial Command Center, Voice, Semantic Windows, Connectors & Agent Architecture

Status: **proposal, not yet approved for implementation**
Recorded: 2026-09-02

This document is the product and architecture brief for the next phase of the
project. It is checked in as the source of truth for that direction; it does not
describe what the code does today. See `README.md` for the system as it
currently exists.

Continue development of the existing Spatial Command Center. First inspect the
current codebase and preserve all working functionality, especially the existing
React Three Fiber / Three.js scene, movable spatial screens, browser-source
abstraction, Chromium texture/browser companion system, Electron integration,
saved layouts, and future WebXR/Meta Quest direction.

**Do not rebuild the application from scratch.**

The objective of this phase is to evolve the project from a collection of
spatial browser screens into a voice-controllable spatial operating environment
where windows have identities, purposes, relationships, data connections, and
AI/agent capabilities.

---

## 1. Everything must be voice-addressable

Architect all major actions so they can eventually be triggered through:

- mouse
- keyboard
- touch
- Quest controller
- hand tracking
- voice

Do not implement separate business logic for voice commands. Create a
centralized Command System where UI buttons, keyboard shortcuts, XR actions, and
voice commands all invoke the same commands.

Example conceptual architecture:

```
Voice / Mouse / Keyboard / XR → Command Parser → Command Registry → Application Action
```

Examples:

- "Create a new window."
- "Open Claude."
- "Open YouTube."
- "Name this Research."
- "Call this window Finance."
- "Move Research to my left."
- "Focus Code."
- "Bring Finance closer."
- "Make this bigger."
- "Lock this window."
- "Unlock Code."
- "Close Music."
- "Duplicate Research."
- "Arrange everything for work."
- "Switch to Play mode."
- "Connect Research to Claude."
- "Send this window to the research agent."
- "Extract everything from this page."
- "Connect Finance to Analysis."
- "Show me all AI windows."

Voice should be treated as an input layer, not as a special feature bolted onto
components.

---

## 2. Semantic / named spatial windows

Every spatial window should become a persistent semantic entity with fields
similar to:

- `id`
- `name`
- `title`
- `type`
- `theme`
- `tags`
- `purpose`
- `source`
- `position`
- `rotation`
- `scale`
- `size`
- `locked`
- `connections`
- `agentBindings`
- `metadata`
- `createdAt`
- `lastFocusedAt`

Users must be able to rename windows freely.

Example:

```
s5 → display name: Research → source: Wikipedia → theme: Work → tags: research, reference
```

Voice commands should then be able to resolve the window through its name:

> "Focus Research."
> "Move Research next to Claude."
> "Connect Research to Writer."

Names should be unique enough for natural-language addressing. If there are
duplicates, the system should ask the user which one they mean.

---

## 3. Window themes / modes

Add semantic themes/categories such as:

- Work
- Play
- AI
- Finance
- Code
- Research
- Media
- Communication
- Music
- Personal
- Custom

These are not merely visual colors. They should be useful organizational
metadata. A theme may influence:

- visual accent
- default placement
- organization presets
- filtering
- voice selection
- agent interaction behavior

Examples:

> "Show only my Work windows."
> "Arrange my Code windows."
> "Hide Play."
> "Bring all AI windows closer."

Users must also be able to create custom themes.

Keep the visual design restrained and elegant. Do not create a rainbow UI.

---

## 4. Voice organization modes

Create a system where workspace arrangements can be invoked naturally.

Examples:

> "Organize for coding."
> "Set up for research."
> "Put me in work mode."
> "Arrange my music workspace."
> "Create a command arc."
> "Put AI on my left and code in front."

These commands should use the existing saved-layout/preset architecture rather
than creating a second arrangement system.

Eventually the system should allow a user to save a custom arrangement by voice:

> "Save this layout as Morning Studio."

And restore it:

> "Load Morning Studio."

---

## 5. Spatial Connector System

Build a first-class Connector model.

A connector represents a relationship or data flow between:

- window → window
- window → AI
- window → process
- process → destination

The existing visual connection concepts should evolve into this system rather
than being replaced unnecessarily.

Example Connector:

```js
{
  id,
  sourceNodeId,
  targetNodeId,
  type,
  mode,
  direction,
  capabilities,
  extractionConfig,
  transformConfig,
  agentConfig,
  enabled,
  createdAt
}
```

---

## 6. Drawing connectors spatially

Users should be able to create a connector by:

**Mouse**, drag a connector handle from one spatial window to another.

**XR controller**, grab a connector point and stretch it toward another window
or agent node.

**Hand tracking**, pinch and draw a line from one object to another.

**Voice**, say:

> "Connect Research to Claude."
> "Send Finance into Analysis."
> "Connect this page to the summarizer."

All four methods must call the same connector creation API.

The visual connector should feel like a spatial cable / energy line rather than a
traditional flat flowchart arrow. Keep rendering performant enough for future
Quest/WebXR.

---

## 7. Connector configuration popup

When a connection is created, show a compact spatial configuration panel asking:

> How do you want these connected?

Possible connection modes:

- Reference
- Extract
- Send
- Synchronize
- Summarize
- Analyze
- Monitor
- Compare
- Transform
- Agent Context
- Custom

Example, `Research → Claude`, user chooses **Agent Context**: Claude receives
the selected information from Research as usable context.

Another, `Finance → Analysis Agent`, user chooses **Extract + Analyze**.

Another, `Article A → Article B`, user chooses **Compare**.

The connection UI should be extensible rather than hard-coded around these
initial types.

---

## 8. URL / browser information extraction

Browser windows should eventually expose an authorized structured representation
of the content they contain.

A connector should be able to request information such as:

- readable text
- headings
- hyperlinks
- images
- image URLs
- videos
- embedded media
- page title
- page URL
- meta description
- Open Graph metadata
- structured data / JSON-LD
- visible tables
- selected text
- page metadata
- relevant DOM structure

Design this as something like:

```
BrowserSource → ContentExtractor → StructuredPageContent
```

Do not depend on violating browser cross-origin security. Direct iframe DOM
access will not work for arbitrary sites. For Full Browser / Chromium sources,
use the trusted desktop Chromium companion or another explicitly authorized
extraction mechanism to obtain page data. Preserve security boundaries between
remote websites and the trusted Spatial Command Center application.

The extraction API should return structured data that agents and connectors can
consume instead of dumping raw page HTML everywhere.

Example:

```js
{
  url,
  title,
  text,
  headings,
  links,
  images,
  videos,
  metadata,
  structuredData,
  selection,
  capturedAt
}
```

Make the extractor modular because future source types may include:

- browser page
- PDF
- image
- video
- local file
- application window
- terminal
- code editor
- API
- database

---

## 9. Agents as spatial nodes

Architect the connector system so AI systems and agents can eventually exist as
visible spatial objects.

Examples:

- Claude
- Coding Agent
- Research Agent
- Summarizer
- Financial Analyst
- Media Agent
- Search Agent
- Custom Agent

An agent node should have:

- name
- type
- capabilities
- model/provider
- input connectors
- output connectors
- status
- active task
- permissions

Do not hard-code the system around one AI provider. Use an adapter/provider
architecture so Claude, OpenAI, local models, or future systems can plug into the
same agent interface.

---

## 10. Voice-created connectors

Voice should understand spatial references.

Examples:

> "Connect this to Claude.", `this` = currently focused window.
> "Connect the window on my right to Research."
> "Send the article above Code into Claude."
> "Disconnect Research from Claude."
> "Show me what Research is connected to."
> "Turn off this connection."
> "Extract only the links."
> "Send the text and images to the Media Agent."

Maintain a context resolver capable of resolving:

- active/focused window
- spatial direction
- type
- theme
- recent selection

---

## 11. Voice command architecture

Create a centralized registry such as:

```
commands/
    registry
    parser
    resolver
    windowCommands
    layoutCommands
    connectorCommands
    browserCommands
    agentCommands
```

Exact implementation should fit the existing project rather than blindly matching
this folder structure.

Each command should expose something conceptually like:

```js
{
  id: 'window.focus',
  phrases: [...],
  parameters: [...],
  execute()
}
```

The speech-recognition provider must be replaceable. Possible future inputs may
include:

- Web Speech API
- browser speech recognition
- Whisper
- local transcription
- cloud transcription
- Quest microphone

Therefore do not couple core commands directly to a speech API.

---

## 12. Natural language + deterministic commands

The system should have two layers:

**Deterministic.** Commands such as "Close Finance.", "Move Code left.", "Lock
Research." These should not require an LLM when unnecessary.

**AI interpretation.** Ambiguous commands such as:

> "Set up everything I need to work on this project."
> "Connect the useful research to Claude."
> "Organize this so I can compare all three companies."

may use an AI planner that resolves the intention into explicit application
commands.

The AI planner should generate commands for the existing command registry rather
than directly modifying application state. This is important for reliability and
future agent autonomy.

---

## 13. Prepare for Meta Quest / WebXR

Everything implemented in this phase must preserve the goal of turning Spatial
Command Center into a genuine immersive Meta Quest environment. Specifically:

- keep world-space state independent of desktop controls
- avoid essential functionality existing only inside DOM overlays
- keep interaction APIs input-device-independent
- voice commands must work independently of mouse coordinates
- connectors must be actual Three.js spatial objects
- important menus need a path toward WebGL/XR rendering
- preserve browser surfaces as texture sources
- maintain transport independence between browser sources and spatial screens

Desktop mode remains important and must continue working.

---

## 13A. Mixed Reality / Passthrough Mode, windows floating over the real world

The Meta Quest version must support both:

- fully immersive virtual reality
- mixed reality / passthrough mode

In mixed reality mode, the application should be capable of having no rendered
virtual background or room at all. Instead, the user should see the real physical
environment through the Meta Quest headset passthrough cameras, with Spatial
Command Center windows, AI agents, connectors, tools, and interface elements
floating directly in the real world.

Conceptually:

```
Real physical room through Quest passthrough
  + Spatial Command Center windows
  + AI agents
  + connectors
  + spatial controls
```

The user should be able to choose between:

- Virtual Environment
- Passthrough / Reality
- Minimal Environment
- Custom Environment

The passthrough / reality mode should not render a fake skybox, floor, wall,
office, room, or environmental background unless the user explicitly enables one.
The default mixed-reality experience should allow the virtual workspace to appear
as if it physically exists inside the user's actual room.

Examples: a browser window can float above a real desk. Claude can float to the
user's left. Code can remain directly in front of the user. Finance screens can
exist to the user's right. A connector can visually stretch through physical
space between two virtual windows. The user should be able to walk around the
windows naturally in their actual room.

Preserve all existing spatial window behavior:

- move
- rotate
- resize
- focus
- lock
- connect
- organize
- voice address

These behaviors should function identically whether the application is running
inside a virtual environment or over passthrough reality.

Environment mode must therefore remain separate from workspace state.
Conceptually:

**Workspace State** should contain:

- windows
- transforms
- connectors
- agents
- layouts
- names
- themes

while **Environment State** should independently determine:

- Virtual
- Passthrough
- Minimal
- Custom

Switching environments must not move, reset, destroy, or recreate the workspace.

Example voice commands:

> "Turn off the background."
> "Show reality."
> "Enter passthrough."
> "Switch to mixed reality."
> "Hide the environment."
> "Bring back the virtual room."
> "Use reality as the background."
> "Go immersive."

These commands must use the same centralized Command System described elsewhere
in this architecture.

Prepare the WebXR architecture for `immersive-ar` / mixed-reality sessions where
supported, in addition to `immersive-vr`. Do not build critical workspace
behavior around a virtual floor, virtual walls, or a fixed artificial origin.

The system should eventually support anchoring windows relative to the user's
real environment while still maintaining a fallback world-space system on devices
or browsers where persistent spatial anchors are unavailable.

Potential future capabilities:

- placing a window above a physical desk
- placing windows along a real wall
- preserving room-relative workspace placement
- restoring saved spatial layouts in a physical environment
- hand interaction directly in passthrough
- controller interaction directly in passthrough
- voice-driven placement relative to the user
- voice-driven placement relative to physical space

Example:

> "Put Claude above my desk."
> "Place Finance on that wall."
> "Move Research beside this monitor."
> "Arrange my work windows around me."

Do not make these advanced physical-environment features hard dependencies for
the initial WebXR implementation. First preserve a clean separation between
**Spatial Workspace** and **Rendered Environment** so passthrough can later
replace the virtual background without requiring the application itself to be
rebuilt.

**This separation is a core architectural invariant.**

---

## 14. Persistence

Persist:

- window names
- themes
- tags
- layouts
- connector graph
- connector configuration
- custom organization presets
- agent bindings

Design the persistence format with versioning and migration support so future
schema changes do not destroy existing workspaces.

---

## 15. Safety / permissions for connectors and agents

Do not allow a connector or AI agent to automatically receive every piece of
information simply because a visual connection exists. Connector capabilities
should be explicit.

For example, `Research → Claude` might permit `text + links` but not
`password fields + cookies + authentication data`.

Never extract or forward:

- passwords
- authentication tokens
- session cookies
- hidden credentials
- payment-card information

Sensitive operations should require clear authorization. Build the permission
model now so we do not have to retrofit it once agents become powerful.

---

## 16. Implementation strategy

**Do NOT attempt to implement all of these systems in one giant pass.**

First inspect the existing architecture and identify where these systems should
integrate. Then propose an incremental implementation plan. Prefer
approximately:

| Phase | Scope |
| --- | --- |
| 1 | Semantic named windows + themes/tags |
| 2 | Central command registry |
| 3 | Basic voice adapter feeding the command registry |
| 4 | Persistent connector data model |
| 5 | Interactive visual connector creation |
| 6 | Connector configuration panel |
| 7 | Chromium structured-content extraction |
| 8 | Agent-node abstraction |
| 9 | Connector → agent context/data flow |
| 10 | Natural-language intent planner |
| 11 | WebXR controller / hand / voice integration |
| 12 | Mixed-reality / passthrough environment mode, where the Spatial Command Center can appear directly over the user's real physical environment with no virtual background |

Before implementation, tell me if any existing architecture should be refactored
to support these features cleanly.

Once the plan is approved, implement one phase at a time and run tests/build
validation after every major phase.

---

## 17. Create comprehensive project documentation

Create or substantially expand the root `README.md`.

This README should be the architectural guide for Spatial Command Center. Do not
write a shallow marketing README. It should be detailed enough that another
competent developer or AI coding agent can understand the system and continue
development without guessing.

Include all of the following sections.

### Spatial Command Center

Explain the core idea: a spatial computing environment where websites,
applications, AI agents, media, information sources, and workflows exist as
movable and connectable objects in a 3D workspace.

### Product Vision

Explain the progression:

```
Desktop 3D Workspace
      ↓
Semantic Spatial Operating Environment
      ↓
Voice-Controlled Workspace
      ↓
Connected Agent Workspace
      ↓
Meta Quest / WebXR Spatial Computing Environment
```

### Current Architecture

Document: React, React Three Fiber, Three.js, Drei, Zustand, Electron, Chromium
browser source, browser texture rendering, source/screen separation,
persistence, existing interaction architecture.

### Spatial Window Model

Explain position, rotation, scale, source, semantic name, tags, identity, and
persistence.

### Browser Source Architecture

Document Direct iframe vs Full Browser/Chromium behavior and the reasons for
each. Explain that arbitrary websites cannot reliably be embedded through
iframes and why the Chromium texture/browser-companion architecture exists.

### Command System

Explain the principle `Input → Command → Application`. Include mouse, keyboard,
voice, XR controller, and hand tracking.

### Voice System

Explain the speech recognition adapter, command parser, semantic resolver,
deterministic commands, AI intent interpretation, and spatial references.
Include example voice commands.

### Window Naming and Themes

Explain semantic windows, themes, custom tags, filtering, organization and voice
addressing.

### Connector System

Explain connectors as both visual relationships and functional data flows.
Document source, target, direction, connection mode, extraction permissions,
transforms, and agents.

### Connector Creation

Explain drag, controller, hand gesture, and voice.

### Content Extraction

Explain structured browser extraction and the trusted Chromium companion.
Document supported content types and security restrictions.

### AI / Agent Architecture

Explain provider-independent agents, agent nodes, permissions, inputs/outputs,
and connections.

### Example Workflow

Include a concrete example such as:

> "Open three research windows."
> "Name them Solar, Wind and Storage."
> "Theme them Research."
> "Open Claude."
> "Connect all three research windows to Claude."
> "Extract the readable text and important links."
> "Ask Claude to compare them."

The README should explain how this flows internally through:

```
Speech → Command Resolver → Window Registry → Connector Graph
       → Content Extractor → Agent Adapter → Result
```

### WebXR / Meta Quest Roadmap

Explain how the existing Three.js environment transitions to immersive VR/MR
while preserving the same state and command architecture.

### Mixed Reality / Passthrough Mode

Document the ability to run Spatial Command Center with no virtual background,
allowing windows, agents, connectors, and interface elements to float directly
over the user's real physical environment through Meta Quest passthrough.

Explain that the environment rendering system must remain independent from
workspace state so the user can switch between Virtual Environment, Passthrough
/ Reality, Minimal Environment, and Custom Environment without changing window
positions, names, connections, agents, or layouts.

Document future support for mixed-reality spatial placement, room-relative
layouts, physical-environment anchoring, controller input, hand tracking, and
voice commands such as "Show reality.", "Turn off the background.", "Enter
passthrough.", "Bring back the virtual room."

### Performance Considerations

Include browser texture resolution, Chromium frame rates, multiple displays,
future WebRTC transport, Quest GPU constraints and efficient connector
rendering.

### Security Model

Explain trusted renderer, remote page isolation, extraction permissions, agent
permissions, and prohibited credential exposure.

### Development Principles

Document these invariants prominently:

1. A spatial window is independent of the content source displayed inside it.
2. Commands are independent of the input device that triggered them.
3. Connectors describe explicit relationships and permissions.
4. Agents never bypass the command and permission systems.
5. Essential spatial functionality should remain XR-compatible.
6. Working desktop functionality must not be sacrificed for speculative XR
   features.
7. Avoid provider lock-in.
8. Prefer modular adapters over one-off integrations.
9. The spatial workspace is independent of the rendered environment, allowing
   the same workspace to exist inside virtual reality or directly over
   passthrough reality.

### Development Roadmap

Maintain a living checklist showing: implemented, in progress, planned,
experimental.

### Running the Project

Keep all current verified installation/run/test instructions accurate.

### Troubleshooting

Include known Chromium/Electron/browser-source problems and their solutions.

### Architecture Decisions

Add a short section documenting major decisions and why they were made so future
agents do not repeatedly undo deliberate architecture.

---

## Final requirement

Before changing code, analyze this proposal against the actual existing
codebase. Tell me:

1. Which parts already exist.
2. Which existing systems should be extended instead of replaced.
3. What architectural changes are required.
4. What can be implemented safely now.
5. What should remain interfaces/stubs until later.
6. The exact implementation sequence you recommend.

Then wait for approval before beginning major implementation.

---

## Provenance note

This brief was transcribed from the original text as supplied. A number of words
were truncated in transit and have been reconstructed from context. The
reconstructions are listed here so the original intent can be confirmed:

| Section | As received | Written as |
| --- | --- | --- |
| 1 | "a centralize**Command System**" | "a centralized Command System" |
| 2 | "should become a **persds** similar to" | "should become a persistent semantic entity with fields similar to" |
| 3 | "**agtion** behavior" | "agent interaction behavior" *(uncertain, could be "agent selection behavior")* |
| 5 | "window →**cess**" | "window → process" |
| 7 | "Connector configuration **popection is created**, show" | "Connector configuration popup / When a connection is created, show" |
| 8 | "selected text, **etadata**" | "selected text, page metadata" *(uncertain, could be "media metadata")* |
| 9 | "AI **systand** agents" | "AI systems and agents" |
| 10 | "active/**focusial direction**" | "active/focused window, spatial direction" |
| 12 | "AI **interpretatiouous** commands" | "AI interpretation. Ambiguous commands" |
| 13 | "browser surfaces as **tee** sources" | "browser surfaces as texture sources" |
| 13A | "fake **skybo floor**" | "fake skybox, floor" |
| 13A | "Potential future **cacing** a window above a physical desk" | "Potential future capabilities: placing a window above a physical desk" |
| 14 | "custom organization **pindings**" | "custom organization presets, agent bindings" |
| 16 | "**Phas1**" | "Phase 1" |
| 17 | "This **READMErchitectural** guide" | "This README should be the architectural guide" |
| 17 | "Content **Extractixplain** structured" | "Content Extraction / Explain structured" |
| 17 | "no virtual **baonnectors**" | "no virtual background, allowing windows, agents, connectors" |
| 17 | "credential **expment Principles**" | "credential exposure. / Development Principles" |
