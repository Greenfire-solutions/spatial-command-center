/*
 * The control half of the Chrome tab bridge.
 *
 * Speaks the same wire protocol as electron/host/remote-host.cjs, so the
 * workspace treats a real Chrome tab exactly as it treats an Electron browser
 * source. Pointing ?host= at the relay is the whole integration.
 *
 * The division of labour is forced by Manifest V3: only this context can reach
 * chrome.tabs and chrome.debugger, and only an offscreen document can hold a
 * MediaStream without being evicted. So this file answers requests and drives
 * tabs, and the offscreen document moves pixels.
 *
 * Input is dispatched through the debugger protocol. That is deliberate and it
 * has a visible cost: Chrome shows a "being debugged" banner while attached.
 * The alternative, synthetic events from a content script, is refused by many
 * sites and silently does nothing on others, which is worse than a banner.
 */

const RELAY_URL_KEY = 'scc.relayUrl';
/* The relay only ever listens on loopback, so the extension can find it without
 * being configured. Storage remains an override for a non-default port. */
const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8788/?role=host';
const DEFAULT_VIEWPORT = { width: 1280, height: 800, frameRate: 12 };

/** sourceId -> { tabId, attached, url, title } */
const sources = new Map();

const respond = (request, result) => ({
  channel: 'spatial-command-center.browser-control',
  version: 1,
  kind: 'response',
  requestId: request.requestId,
  ok: true,
  result
});

const respondError = (request, code, message) => ({
  channel: 'spatial-command-center.browser-control',
  version: 1,
  kind: 'response',
  requestId: request.requestId,
  ok: false,
  error: { code, message }
});

const notify = (type, sourceId, data) => ({
  channel: 'spatial-command-center.browser-control',
  version: 1,
  kind: 'notification',
  type,
  sourceId,
  data
});

const pushToRelay = (message) => chrome.runtime.sendMessage({
  scope: 'scc-offscreen',
  type: 'push',
  detail: message
}).catch(() => {});

const snapshot = (sourceId) => {
  const entry = sources.get(sourceId);
  if (!entry) return null;
  return {
    id: sourceId,
    url: entry.url || '',
    title: entry.title || '',
    favicon: entry.favicon || '',
    loading: Boolean(entry.loading),
    canGoBack: true,
    canGoForward: true,
    width: entry.width,
    height: entry.height,
    deviceScaleFactor: 1,
    frameRate: entry.frameRate,
    focused: false,
    state: 'ready',
    crashed: false
  };
};

const ensureOffscreen = async () => {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/capture.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab pixels for a spatial screen.'
  });
};

/*
 * Attach the debugger once per tab and keep it attached.
 *
 * Attaching per event would flash the banner constantly and lose the input
 * focus state between keystrokes.
 */
const ensureDebugger = async (tabId) => {
  const entry = [...sources.values()].find((source) => source.tabId === tabId);
  if (entry && entry.attached) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    if (entry) entry.attached = true;
    return true;
  } catch (error) {
    /* Already attached is success for our purposes. */
    if (String(error?.message || '').includes('Another debugger')) {
      if (entry) entry.attached = true;
      return true;
    }
    return false;
  }
};

const dispatchPointer = async (tabId, event, viewport) => {
  if (!(await ensureDebugger(tabId))) return;
  const typeMap = {
    mouseDown: 'mousePressed',
    mouseUp: 'mouseReleased',
    mouseMove: 'mouseMoved',
    mouseEnter: 'mouseMoved',
    mouseLeave: 'mouseMoved'
  };
  const type = typeMap[event.type] || 'mouseMoved';
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type,
    x: Math.max(0, Math.min(viewport.width - 1, Math.round(event.x || 0))),
    y: Math.max(0, Math.min(viewport.height - 1, Math.round(event.y || 0))),
    button: event.button === 'right' ? 'right' : (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : (event.clickCount || 1)
  }).catch(() => {});
};

const dispatchWheel = async (tabId, event, viewport) => {
  if (!(await ensureDebugger(tabId))) return;
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.max(0, Math.min(viewport.width - 1, Math.round(event.x || 0))),
    y: Math.max(0, Math.min(viewport.height - 1, Math.round(event.y || 0))),
    deltaX: -(event.deltaX || 0),
    deltaY: -(event.deltaY || 0)
  }).catch(() => {});
};

const dispatchKey = async (tabId, event) => {
  if (!(await ensureDebugger(tabId))) return;
  const type = event.type === 'keyUp' ? 'keyUp' : (event.type === 'char' ? 'char' : 'keyDown');
  const payload = type === 'char'
    ? { type: 'char', text: event.text || event.keyCode || '' }
    : {
      type,
      key: event.keyCode,
      windowsVirtualKeyCode: event.keyCode === 'Return' ? 13 : undefined,
      modifiers: (event.modifiers || []).reduce((mask, name) => mask
        | (name === 'alt' ? 1 : 0) | (name === 'control' ? 2 : 0)
        | (name === 'meta' ? 4 : 0) | (name === 'shift' ? 8 : 0), 0)
    };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', payload).catch(() => {});
};

const handle = async (request) => {
  const { action, sourceId, payload = {} } = request;

  switch (action) {
    case 'createSource': {
      const width = payload.width || DEFAULT_VIEWPORT.width;
      const height = payload.height || DEFAULT_VIEWPORT.height;
      const frameRate = payload.frameRate || DEFAULT_VIEWPORT.frameRate;

      /* A source can adopt the active tab, which is how "show me what I am
       * already looking at" works, or open a new one for a given address. */
      let tab;
      if (payload.url) {
        tab = await chrome.tabs.create({ url: payload.url, active: false });
      } else {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      }
      if (!tab) return respondError(request, 'NO_TAB', 'No tab to capture.');

      sources.set(sourceId, {
        tabId: tab.id, width, height, frameRate,
        url: tab.url, title: tab.title, attached: false
      });

      await ensureOffscreen();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      return {
        forward: respond(request, snapshot(sourceId)),
        startCapture: { sourceId, streamId, width, height, frameRate }
      };
    }

    case 'destroySource': {
      const entry = sources.get(sourceId);
      if (entry?.attached) await chrome.debugger.detach({ tabId: entry.tabId }).catch(() => {});
      sources.delete(sourceId);
      return { forward: respond(request, { id: sourceId, destroyed: true }), stopCapture: sourceId };
    }

    case 'getSource':
      return { forward: respond(request, snapshot(sourceId)) };

    case 'listSources':
      return { forward: respond(request, [...sources.keys()].map(snapshot)) };

    case 'navigate': {
      const entry = sources.get(sourceId);
      if (!entry) return { forward: respondError(request, 'NO_SOURCE', 'Unknown source.') };
      await chrome.tabs.update(entry.tabId, { url: payload.url });
      return { forward: respond(request, snapshot(sourceId)) };
    }

    case 'back':
    case 'forward':
    case 'reload': {
      const entry = sources.get(sourceId);
      if (!entry) return { forward: respondError(request, 'NO_SOURCE', 'Unknown source.') };
      if (action === 'reload') await chrome.tabs.reload(entry.tabId);
      else await chrome.tabs[action === 'back' ? 'goBack' : 'goForward'](entry.tabId).catch(() => {});
      return { forward: respond(request, snapshot(sourceId)) };
    }

    case 'sendPointerEvent':
    case 'sendWheelEvent':
    case 'sendKeyboardEvent':
    case 'insertText': {
      const entry = sources.get(sourceId);
      if (!entry) return { forward: respondError(request, 'NO_SOURCE', 'Unknown source.') };
      const viewport = { width: entry.width, height: entry.height };
      if (action === 'sendPointerEvent') await dispatchPointer(entry.tabId, payload, viewport);
      else if (action === 'sendWheelEvent') await dispatchWheel(entry.tabId, payload, viewport);
      else if (action === 'sendKeyboardEvent') await dispatchKey(entry.tabId, payload);
      else await dispatchKey(entry.tabId, { type: 'char', text: payload.text });
      return { forward: respond(request, true) };
    }

    case 'focus':
    case 'blur':
    case 'resize':
    case 'stop':
    case 'setQuality':
      return { forward: respond(request, snapshot(sourceId) ?? true) };

    default:
      return { forward: respondError(request, 'UNSUPPORTED', `${action} is not supported by the tab bridge.`) };
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.scope !== 'scc-bridge') return undefined;
  if (message.type === 'protocol') {
    handle(message.detail).then(sendResponse).catch((error) => sendResponse({
      forward: respondError(message.detail, 'HOST_ERROR', String(error?.message || error))
    }));
    return true;
  }
  if (message.type === 'relay-state') {
    chrome.action.setTitle({
      title: message.detail.connected ? 'Bridge connected' : 'Bridge waiting for relay'
    });
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

/* Keep the workspace's metadata honest as the user navigates in Chrome itself:
 * a tab driven from the browser should update the spatial screen's title bar. */
chrome.tabs.onUpdated.addListener((tabId, change) => {
  for (const [sourceId, entry] of sources) {
    if (entry.tabId !== tabId) continue;
    if (change.url) entry.url = change.url;
    if (change.title) entry.title = change.title;
    entry.loading = change.status === 'loading';
    pushToRelay(notify('metadata', sourceId, snapshot(sourceId)));
  }
});

/** Called from the popup-less action click, and on startup, to dial the relay. */
const start = async () => {
  const stored = await chrome.storage.local.get(RELAY_URL_KEY);
  const url = stored[RELAY_URL_KEY] || DEFAULT_RELAY_URL;
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ scope: 'scc-offscreen', type: 'connect', detail: { url } })
    .catch(() => {});
};

chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
chrome.action.onClicked.addListener(start);

/* Set the relay URL from the console:
 *   chrome.storage.local.set({ 'scc.relayUrl': 'ws://127.0.0.1:8788/?role=host&token=…' })
 * then click the extension's toolbar icon. */
