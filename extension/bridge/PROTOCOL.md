# Chrome tab bridge protocol

The service worker accepts messages only from contexts owned by this extension. Every request uses this envelope:

```js
{
  channel: 'spatial-command-center.chrome-tabs',
  version: 1,
  kind: 'request',
  requestId: crypto.randomUUID(),
  action: 'tabs.list',
  payload: {}
}
```

Responses repeat `requestId` and `action`, and contain either `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

## Requests

| Action | Payload | Result |
| --- | --- | --- |
| `tabs.list` | `{ currentWindow?: boolean }` | `{ tabs: TabSnapshot[] }` |
| `tabs.open` | `{ url?: string, active?: boolean }` | `{ tab: TabSnapshot }` |
| `tabs.navigate` | `{ tabId: number, url: string }` | `{ tab: TabSnapshot }` |
| `tabs.close` | `{ tabId: number }` | `{ tabId: number }` |

An omitted URL in `tabs.open` creates Chrome's normal new-tab page. Entering a host such as `wikipedia.org` is normalized to HTTPS. Explicit destinations are limited to `http://` and `https://`; executable, extension, file, data, and privileged Chrome schemes are rejected.

## Events

The service worker emits extension-runtime messages with `kind: 'event'` and one of:

- `tabs.created`: `{ tab }`
- `tabs.updated`: `{ tabId, changes, tab }`
- `tabs.removed`: `{ tabId, windowId, isWindowClosing }`
- `tabs.replaced`: `{ addedTabId, removedTabId }`

`TabSnapshot` contains `id`, `windowId`, `index`, `active`, `pinned`, `audible`, `discarded`, `status`, `title`, `url`, and `favicon`.

## Extension-context example

```js
const response = await chrome.runtime.sendMessage({
  channel: 'spatial-command-center.chrome-tabs',
  version: 1,
  kind: 'request',
  requestId: crypto.randomUUID(),
  action: 'tabs.list',
  payload: {}
});
```

A normal website cannot run this example. A later companion transport must relay these messages from an extension-owned context to the Spatial Command Center app.
