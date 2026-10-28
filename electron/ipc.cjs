'use strict';

const { IPC_CHANNELS } = require('./constants.cjs');
const { normalizeExternalUrl, requireSourceId } = require('./validation.cjs');

const registerBrowserSourceIpc = ({
  ipcMain,
  manager,
  frameTransport,
  getTrustedWebContents,
  shell,
  /* Optional: without one, extraction reports that it is unavailable rather
   * than the channel simply not existing, which is easier to diagnose. */
  contentExtractor = null,
  /* Agent adapters live here, in the main process, because they hold API keys.
   * The renderer sends a task and receives a result; it never sees a
   * credential. */
  agentAdapters = [],
  runtimeInfo = {}
}) => {
  const handledChannels = [];
  const listeners = [];

  const assertTrusted = (event) => {
    const trusted = getTrustedWebContents();
    if (!trusted || trusted.isDestroyed() || event.sender.id !== trusted.id) {
      throw new Error('Browser source IPC is restricted to the trusted spatial renderer.');
    }
  };

  const handle = (channel, operation) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrusted(event);
      return operation(...args);
    });
    handledChannels.push(channel);
  };

  handle(IPC_CHANNELS.RUNTIME_INFO, () => ({
    protocolVersion: 1,
    transport: 'electron-ipc-native-bitmap',
    maxFramesInFlightPerSource: 1,
    ...runtimeInfo
  }));
  // The spatial window denies renderer-initiated window creation, so an
  // "open in a real tab" affordance has to travel through the main process.
  // The URL is re-validated here: the renderer is trusted, the URL is not.
  handle(IPC_CHANNELS.OPEN_EXTERNAL, async (url) => {
    const externalUrl = normalizeExternalUrl(url);
    if (!shell || typeof shell.openExternal !== 'function') {
      throw new Error('External browser opening is unavailable in this runtime.');
    }
    await shell.openExternal(externalUrl);
    return { opened: true, url: externalUrl };
  });
  handle(IPC_CHANNELS.SOURCE_CREATE, (options) => manager.createSource(options));
  handle(IPC_CHANNELS.SOURCE_DESTROY, (id) => manager.destroySource(id));
  handle(IPC_CHANNELS.SOURCE_GET, (id) => manager.getSource(id));
  handle(IPC_CHANNELS.SOURCE_LIST, () => manager.listSources());
  handle(IPC_CHANNELS.NAVIGATE, (id, url) => manager.navigate(id, url));
  handle(IPC_CHANNELS.BACK, (id) => manager.back(id));
  handle(IPC_CHANNELS.FORWARD, (id) => manager.forward(id));
  handle(IPC_CHANNELS.RELOAD, (id) => manager.reload(id));
  handle(IPC_CHANNELS.STOP, (id) => manager.stop(id));
  handle(IPC_CHANNELS.RESIZE, (id, width, height, scaleFactor) => manager.resize(id, width, height, scaleFactor));
  handle(IPC_CHANNELS.QUALITY, (id, options) => manager.setQuality(id, options));
  handle(IPC_CHANNELS.FOCUS, (id) => manager.focus(id));
  handle(IPC_CHANNELS.BLUR, (id) => manager.blur(id));
  handle(IPC_CHANNELS.POINTER, (id, input) => manager.sendPointerEvent(id, input));
  handle(IPC_CHANNELS.WHEEL, (id, input) => manager.sendWheelEvent(id, input));
  handle(IPC_CHANNELS.KEYBOARD, (id, input) => manager.sendKeyboardEvent(id, input));
  handle(IPC_CHANNELS.INSERT_TEXT, (id, text) => manager.insertText(id, text));

  handle(IPC_CHANNELS.AGENT_LIST, () => agentAdapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    available: adapter.available,
    capabilities: adapter.capabilities
  })));

  handle(IPC_CHANNELS.AGENT_RUN, (adapterId, task) => {
    const adapter = agentAdapters.find((candidate) => candidate.id === adapterId);
    if (!adapter) {
      return { ok: false, code: 'NO_ADAPTER', message: `No agent adapter called ${adapterId}.` };
    }
    return adapter.run({
      mode: typeof task?.mode === 'string' ? task.mode : 'agent-context',
      instruction: typeof task?.instruction === 'string' ? task.instruction : '',
      inputs: Array.isArray(task?.inputs) ? task.inputs : []
    });
  });

  /* Reading a page's content. The capability list arrives from the renderer
   * and is enforced here, in the main process: a permission checked only on
   * the client is a suggestion. */
  handle(IPC_CHANNELS.EXTRACT, (id, options) => {
    if (!contentExtractor) {
      return { ok: false, code: 'EXTRACTION_UNAVAILABLE', message: 'Content extraction is not enabled.' };
    }
    return contentExtractor.extract(requireSourceId(id), {
      capabilities: Array.isArray(options?.capabilities) ? options.capabilities : []
    });
  });

  const onFrameAck = (event, sourceId, frameId) => {
    try {
      assertTrusted(event);
      const id = requireSourceId(sourceId);
      if (!Number.isSafeInteger(frameId) || frameId < 1) return;
      frameTransport.acknowledge(id, frameId);
    } catch {
      // One-way messages from an untrusted/destroyed renderer are ignored.
    }
  };
  const onFrameRequest = (event, sourceId) => {
    try {
      assertTrusted(event);
      frameTransport.requestLatest(sourceId === null || sourceId === undefined ? null : requireSourceId(sourceId));
    } catch {
      // Requesting a cached frame is best-effort.
    }
  };
  ipcMain.on(IPC_CHANNELS.FRAME_ACK, onFrameAck);
  ipcMain.on(IPC_CHANNELS.FRAME_REQUEST, onFrameRequest);
  listeners.push([IPC_CHANNELS.FRAME_ACK, onFrameAck], [IPC_CHANNELS.FRAME_REQUEST, onFrameRequest]);

  const sendToTrustedRenderer = (channel, payload) => {
    const target = getTrustedWebContents();
    if (!target || target.isDestroyed()) return;
    target.send(channel, payload);
  };
  const onMetadata = (metadata) => sendToTrustedRenderer(IPC_CHANNELS.METADATA, metadata);
  const onEvent = (payload) => sendToTrustedRenderer(IPC_CHANNELS.EVENT, payload);
  manager.on('metadata', onMetadata);
  manager.on('event', onEvent);

  return () => {
    for (const channel of handledChannels) ipcMain.removeHandler(channel);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
    manager.removeListener('metadata', onMetadata);
    manager.removeListener('event', onEvent);
  };
};

module.exports = { registerBrowserSourceIpc };
