'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Keep these literal in the preload. It intentionally cannot import project
// files in Electron's sandboxed preload environment.
const CHANNELS = Object.freeze({
  runtimeInfo: 'spatial-browser:runtime-info',
  openExternal: 'spatial-browser:open-external',
  create: 'spatial-browser:source-create',
  destroy: 'spatial-browser:source-destroy',
  get: 'spatial-browser:source-get',
  list: 'spatial-browser:source-list',
  navigate: 'spatial-browser:navigate',
  back: 'spatial-browser:back',
  forward: 'spatial-browser:forward',
  reload: 'spatial-browser:reload',
  stop: 'spatial-browser:stop',
  resize: 'spatial-browser:resize',
  quality: 'spatial-browser:quality',
  focus: 'spatial-browser:focus',
  blur: 'spatial-browser:blur',
  pointer: 'spatial-browser:pointer',
  wheel: 'spatial-browser:wheel',
  keyboard: 'spatial-browser:keyboard',
  insertText: 'spatial-browser:insert-text',
  extract: 'spatial-browser:extract',
  agentList: 'spatial-browser:agent-list',
  agentRun: 'spatial-browser:agent-run',
  frame: 'spatial-browser:frame',
  frameAck: 'spatial-browser:frame-ack',
  frameRequest: 'spatial-browser:frame-request',
  metadata: 'spatial-browser:metadata',
  event: 'spatial-browser:event'
});

const frameListeners = new Set();
const metadataListeners = new Set();
const eventListeners = new Set();

const subscribe = (set, sourceOrListener, possibleListener, requestFrame = false) => {
  const sourceId = typeof sourceOrListener === 'string' ? sourceOrListener : null;
  const listener = sourceId ? possibleListener : sourceOrListener;
  if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
  const subscription = { sourceId, listener };
  set.add(subscription);
  if (requestFrame) ipcRenderer.send(CHANNELS.frameRequest, sourceId);
  return () => set.delete(subscription);
};

ipcRenderer.on(CHANNELS.frame, (_event, frame) => {
  try {
    for (const subscription of [...frameListeners]) {
      if (!subscription.sourceId || subscription.sourceId === frame.sourceId) {
        subscription.listener(frame);
      }
    }
  } finally {
    // This acknowledgement drives the one-frame-in-flight backpressure gate.
    ipcRenderer.send(CHANNELS.frameAck, frame.sourceId, frame.frameId);
  }
});

ipcRenderer.on(CHANNELS.metadata, (_event, metadata) => {
  for (const subscription of [...metadataListeners]) {
    if (!subscription.sourceId || subscription.sourceId === metadata.id) subscription.listener(metadata);
  }
});

ipcRenderer.on(CHANNELS.event, (_event, payload) => {
  for (const subscription of [...eventListeners]) {
    if (!subscription.sourceId || subscription.sourceId === payload.sourceId) subscription.listener(payload);
  }
});

contextBridge.exposeInMainWorld('spatialBrowser', Object.freeze({
  available: true,
  transport: 'electron-ipc-native-bitmap',
  runtimeInfo: () => ipcRenderer.invoke(CHANNELS.runtimeInfo),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  createSource: (options) => ipcRenderer.invoke(CHANNELS.create, options),
  destroySource: (sourceId) => ipcRenderer.invoke(CHANNELS.destroy, sourceId),
  getSource: (sourceId) => ipcRenderer.invoke(CHANNELS.get, sourceId),
  listSources: () => ipcRenderer.invoke(CHANNELS.list),
  navigate: (sourceId, url) => ipcRenderer.invoke(CHANNELS.navigate, sourceId, url),
  back: (sourceId) => ipcRenderer.invoke(CHANNELS.back, sourceId),
  forward: (sourceId) => ipcRenderer.invoke(CHANNELS.forward, sourceId),
  reload: (sourceId) => ipcRenderer.invoke(CHANNELS.reload, sourceId),
  stop: (sourceId) => ipcRenderer.invoke(CHANNELS.stop, sourceId),
  resize: (sourceId, width, height, deviceScaleFactor) => (
    ipcRenderer.invoke(CHANNELS.resize, sourceId, width, height, deviceScaleFactor)
  ),
  setQuality: (sourceId, options) => ipcRenderer.invoke(CHANNELS.quality, sourceId, options),
  focus: (sourceId) => ipcRenderer.invoke(CHANNELS.focus, sourceId),
  blur: (sourceId) => ipcRenderer.invoke(CHANNELS.blur, sourceId),
  sendPointerEvent: (sourceId, input) => ipcRenderer.invoke(CHANNELS.pointer, sourceId, input),
  sendWheelEvent: (sourceId, input) => ipcRenderer.invoke(CHANNELS.wheel, sourceId, input),
  sendKeyboardEvent: (sourceId, input) => ipcRenderer.invoke(CHANNELS.keyboard, sourceId, input),
  insertText: (sourceId, text) => ipcRenderer.invoke(CHANNELS.insertText, sourceId, text),
  extract: (sourceId, options) => ipcRenderer.invoke(CHANNELS.extract, sourceId, options),
  listAgents: () => ipcRenderer.invoke(CHANNELS.agentList),
  runAgent: (adapterId, task) => ipcRenderer.invoke(CHANNELS.agentRun, adapterId, task),
  requestFrame: (sourceId = null) => ipcRenderer.send(CHANNELS.frameRequest, sourceId),
  onFrame: (sourceOrListener, possibleListener) => (
    subscribe(frameListeners, sourceOrListener, possibleListener, true)
  ),
  onMetadata: (sourceOrListener, possibleListener) => (
    subscribe(metadataListeners, sourceOrListener, possibleListener)
  ),
  onEvent: (sourceOrListener, possibleListener) => (
    subscribe(eventListeners, sourceOrListener, possibleListener)
  )
}));
