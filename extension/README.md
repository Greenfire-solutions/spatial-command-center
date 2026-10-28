# Spatial Command Center Chrome tab bridge

This directory is the first, deliberately small Manifest V3 companion for representing real Chrome tabs as future `chrome-tab` screen sources. It can enumerate tabs, open an HTTP(S) tab, navigate an existing tab, close a tab, and publish tab lifecycle/navigation events.

It does **not** capture tab pixels, inject scripts, simulate input, expose messages to arbitrary websites, or use the Chrome debugger. Those capabilities need separate designs and explicit user authorization.

## Load it locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension/` directory.
5. Use the extension's service-worker inspector to view errors while developing an extension-owned bridge client.

There is intentionally no popup or content script yet. The current browser app cannot call `chrome.runtime` directly, so loading this extension alone does not connect `index.html` to Chrome. See `bridge/PROTOCOL.md` for the extension-side contract.

## Permission rationale

The manifest requests only:

- `tabs`: required to enumerate every open tab and read its title, URL, and favicon, and to manage the selected tab.

There are no host permissions, content scripts, remotely hosted extension code, `externally_connectable` origins, native-messaging access, tab-capture access, or debugger access.

## Security boundaries

- Runtime requests are accepted only when `sender.id` matches this extension.
- Open and navigate requests accept only HTTP(S) URLs. Values such as `javascript:`, `data:`, `file:`, `chrome:`, and `chrome-extension:` are rejected.
- URL credentials are rejected.
- Incoming payloads and tab IDs are validated before a Chrome API is called.
- Tab events expose metadata only; they do not expose page contents.

These safeguards do not make an extension-owned context automatically safe to expose to a web page. Any future app transport should authenticate its peer, bind only to an explicitly approved origin, validate this protocol again at the boundary, and make its connection state visible to the user.

## Deliberately deferred capabilities

### Live pixels

`chrome.tabCapture` requires an additional permission and a user gesture. A later capture implementation should request that capability explicitly, show a persistent capture indicator in the app, stop streams predictably, and avoid retaining frames. It is not included here.

### Remote input

Normal tab APIs do not provide synthetic pointer/keyboard input. Chrome DevTools Protocol access through `chrome.debugger` is highly privileged and must not be silently added. A future implementation needs explicit permissions, a clear per-tab attach/detach flow, visible authorization and status, coordinate validation, and a reliable emergency disconnect. It is not included here.

### App transport

The next safe milestone is an extension-owned page or another narrowly scoped, user-approved transport that relays the documented messages to the app. Do not add a broad content script, wildcard host permission, public proxy, or unauthenticated localhost bridge merely to bypass iframe restrictions.
