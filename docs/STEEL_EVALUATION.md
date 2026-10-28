# Steel Browser evaluation

Research date: 2026-09-01

Steel was evaluated first because its interactive Live View is a good conceptual match for a spatial browser. The current self-hosted release does not, however, satisfy this workspace's core requirement: several independent browser screens at the same time.

## Current official behavior

| Capability | Steel Cloud | Self-hosted Steel 0.5.4-beta |
| --- | --- | --- |
| Concurrent isolated sessions | Supported by plan | One active session per container |
| Live view | Headful WebRTC/H.264, 25 fps | Headless CDP JPEG screencast |
| Viewer URL | Per-session debug URL | Global `/v1/sessions/debug` URL |
| CDP URL | Per-session authenticated URL | Global root WebSocket |
| API authentication | `steel-api-key` | None built in |
| Persistent Profiles API | Available | Not available |

The self-hosted service owns one singleton `CDPService` and one `activeSession`. Creating another session reconfigures that singleton. Its `debugUrl` and CDP WebSocket do not contain a session ID, and release/context/live-details operations address the current global browser. Supporting five spatial screens would therefore require five separately port-mapped and independently protected Steel containers plus a routing layer. That is substantially heavier and less reliable than the project's existing per-screen Electron Chromium source manager.

## Backend decision

The application uses Electron's local Chromium offscreen rendering as its Full Browser provider:

- one real Chromium `webContents` per Full Browser screen;
- independent URL, history, loading state, viewport, focus, and lifecycle;
- a shared persistent local browser partition so local login cookies survive restarts;
- no public proxy, API token, CDP port, or unauthenticated viewer URL;
- pixels rendered directly as a Three.js texture, so rotation, scale, depth, and occlusion remain native to the 3D scene;
- validated, trusted-renderer-only IPC for navigation and input;
- explicit destruction when a screen closes or returns to Direct mode.

This is the fallback architecture requested in the project brief, not a frontend workaround for CSP or `X-Frame-Options`. Remote sites are loaded as top-level pages by real Chromium and their security headers are left intact.

## Future Steel provider seam

Steel can be added later as another screen-source provider without replacing the 3D workspace. The existing provider boundary supports create, navigate, back, forward, reload, focus, input, status, and destroy operations. A future Steel provider should only be enabled when self-hosted Steel offers genuinely isolated concurrent sessions and authenticated per-session Live View URLs. Until then, running a container per screen would add avoidable ports, memory use, profile routing, and attack surface.

## Official sources

- [Steel Local vs Steel Cloud](https://docs.steel.dev/overview/self-hosting/steel-local-vs-steel-cloud)
- [Steel self-hosting with Docker](https://docs.steel.dev/overview/self-hosting/docker)
- [Steel Live Sessions](https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions)
- [Steel session lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle)
- [Steel Profiles API](https://docs.steel.dev/overview/profiles-api/overview)
- [Self-hosted session service at the evaluated release](https://github.com/steel-dev/steel-browser/blob/3fe2410ad0861303cc06d4aabdb20d0a6a60d888/api/src/services/session.service.ts)
- [Self-hosted session routes](https://github.com/steel-dev/steel-browser/blob/3fe2410ad0861303cc06d4aabdb20d0a6a60d888/api/src/modules/sessions/sessions.routes.ts)
- [Steel Browser v0.5.4-beta](https://github.com/steel-dev/steel-browser/releases/tag/v0.5.4-beta)
