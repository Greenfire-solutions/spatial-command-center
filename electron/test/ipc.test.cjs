'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { registerBrowserSourceIpc } = require('../ipc.cjs');
const { IPC_CHANNELS } = require('../constants.cjs');

class FakeIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }
  handle(channel, handler) { this.handlers.set(channel, handler); }
  removeHandler(channel) { this.handlers.delete(channel); }
}

test('IPC operations accept only the exact trusted spatial webContents sender', async () => {
  const ipcMain = new FakeIpcMain();
  const trusted = { id: 42, isDestroyed: () => false, send() {} };
  const manager = new EventEmitter();
  manager.listSources = () => [{ id: 'browser-s5' }];
  manager.createSource = () => { throw new Error('not used'); };
  for (const name of [
    'destroySource', 'getSource', 'navigate', 'back', 'forward', 'reload', 'stop',
    'resize', 'focus', 'blur', 'sendPointerEvent', 'sendWheelEvent', 'sendKeyboardEvent', 'insertText'
  ]) manager[name] = () => ({ accepted: true });
  const frameTransport = { acknowledge() {}, requestLatest() {} };
  const dispose = registerBrowserSourceIpc({
    ipcMain,
    manager,
    frameTransport,
    getTrustedWebContents: () => trusted
  });

  const listHandler = ipcMain.handlers.get(IPC_CHANNELS.SOURCE_LIST);
  assert.throws(
    () => listHandler({ sender: { id: 41 } }),
    /restricted to the trusted spatial renderer/
  );
  assert.deepEqual(listHandler({ sender: { id: 42 } }), [{ id: 'browser-s5' }]);
  dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test('external opens are restricted to the trusted sender and to HTTP(S) URLs', async () => {
  const ipcMain = new FakeIpcMain();
  const trusted = { id: 7, isDestroyed: () => false, send() {} };
  const opened = [];
  const manager = new EventEmitter();
  manager.createSource = () => { throw new Error('not used'); };
  const dispose = registerBrowserSourceIpc({
    ipcMain,
    manager,
    frameTransport: { acknowledge() {}, requestLatest() {} },
    getTrustedWebContents: () => trusted,
    shell: { openExternal: async (url) => opened.push(url) }
  });

  const handler = ipcMain.handlers.get(IPC_CHANNELS.OPEN_EXTERNAL);
  assert.ok(handler, 'the open-external channel is registered');

  await assert.rejects(
    async () => handler({ sender: { id: 8 } }, 'https://example.com/'),
    /restricted to the trusted spatial renderer/
  );

  assert.deepEqual(
    await handler({ sender: { id: 7 } }, 'https://example.com/page'),
    { opened: true, url: 'https://example.com/page' }
  );

  for (const hostile of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings',
    'https://user:secret@example.com/',
    'example.com',
    ''
  ]) {
    await assert.rejects(
      async () => handler({ sender: { id: 7 } }, hostile),
      (error) => ['INVALID_URL', 'UNSUPPORTED_URL_SCHEME'].includes(error.code),
      `rejects ${JSON.stringify(hostile)}`
    );
  }

  assert.deepEqual(opened, ['https://example.com/page'], 'only the safe URL reached the operating system');
  dispose();
});
