'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { BrowserSourceManager } = require('../browser-source-manager.cjs');
const { PERSISTENT_PARTITION } = require('../constants.cjs');

class FakeHistory {
  constructor() {
    this.back = false;
    this.forward = false;
    this.calls = [];
  }
  canGoBack() { return this.back; }
  canGoForward() { return this.forward; }
  goBack() { this.calls.push('back'); }
  goForward() { this.calls.push('forward'); }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.navigationHistory = new FakeHistory();
    this.url = '';
    this.title = '';
    this.loading = false;
    this.inputEvents = [];
    this.destroyed = false;
    this.focused = false;
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  setFrameRate(value) { this.frameRate = value; }
  setAudioMuted(value) { this.audioMuted = value; }
  loadURL(url) { this.url = url; this.loading = true; return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  sendInputEvent(event) { this.inputEvents.push(event); }
  insertText(text) { this.insertedText = text; return Promise.resolve(); }
  reload() { this.reloaded = true; }
  stop() { this.stopped = true; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.focused = false;
    this.webViewFocused = false;
    this.webViewFocusCalls = 0;
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  focusOnWebView() { this.webViewFocusCalls += 1; this.webViewFocused = true; this.webContents.focus(); }
  blurWebView() { this.webViewFocused = false; this.webContents.blur(); }
  setContentSize(width, height) { this.contentSize = [width, height]; }
  destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
}

const createManager = () => {
  FakeBrowserWindow.instances.length = 0;
  const frameTransport = {
    frames: [], released: [],
    publish(frame) { this.frames.push(frame); },
    releaseSource(id) { this.released.push(id); },
    close() { this.closed = true; }
  };
  return {
    frameTransport,
    manager: new BrowserSourceManager({
      BrowserWindow: FakeBrowserWindow,
      frameTransport,
      logger: { warn() {} },
      now: () => new Date('2026-09-01T12:00:00.000Z')
    })
  };
};

test('creates an idempotent hidden, sandboxed, persistent offscreen source', () => {
  const { manager } = createManager();
  const source = manager.createSource({ id: 'browser-s5', url: 'https://example.com' });
  const duplicate = manager.createSource({ id: 'browser-s5', url: 'https://other.example' });
  assert.equal(FakeBrowserWindow.instances.length, 1);
  assert.equal(source.id, 'browser-s5');
  assert.equal(duplicate.id, source.id);
  const options = FakeBrowserWindow.instances[0].options;
  assert.equal(options.show, false);
  assert.equal(options.x, -4096);
  assert.equal(options.y, -4096);
  assert.equal(options.width, 1280);
  assert.equal(options.height, 800);
  assert.deepEqual(options.webPreferences.offscreen, { useSharedTexture: false, deviceScaleFactor: 1 });
  assert.equal(options.webPreferences.partition, PERSISTENT_PARTITION);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.preload, undefined);
  assert.equal(FakeBrowserWindow.instances[0].focused, false);
});

test('uses navigationHistory and updates the independent browser viewport', () => {
  const { manager } = createManager();
  manager.createSource({ id: 'browser-s5' });
  const window = FakeBrowserWindow.instances[0];
  window.webContents.navigationHistory.back = true;
  window.webContents.navigationHistory.forward = true;
  manager.back('browser-s5');
  manager.forward('browser-s5');
  assert.deepEqual(window.webContents.navigationHistory.calls, ['back', 'forward']);
  manager.navigate('browser-s5', 'localhost:9000/test');
  assert.equal(window.webContents.url, 'http://localhost:9000/test');
  manager.resize('browser-s5', 960, 600, 1);
  assert.deepEqual(window.contentSize, [960, 600]);
  assert.deepEqual(manager.getSource('browser-s5').width, 960);
});

test('focuses on pointer down and gates keyboard and text input to that source', async () => {
  const { manager } = createManager();
  manager.createSource({ id: 'browser-s5' });
  assert.throws(
    () => manager.sendKeyboardEvent('browser-s5', { type: 'keyDown', keyCode: 'A' }),
    { code: 'SOURCE_NOT_FOCUSED' }
  );
  manager.sendPointerEvent('browser-s5', { type: 'down', x: 640, y: 400, button: 'left' });
  manager.sendPointerEvent('browser-s5', { type: 'up', x: 640, y: 400, button: 'left' });
  manager.sendWheelEvent('browser-s5', { x: 640, y: 400, deltaY: -120 });
  manager.focus('browser-s5');
  manager.sendKeyboardEvent('browser-s5', { type: 'keyDown', keyCode: 'A' });
  await manager.insertText('browser-s5', 'hello');
  const contents = FakeBrowserWindow.instances[0].webContents;
  assert.equal(contents.focused, true);
  assert.equal(FakeBrowserWindow.instances[0].focused, false);
  assert.equal(FakeBrowserWindow.instances[0].webViewFocused, true);
  assert.equal(FakeBrowserWindow.instances[0].webViewFocusCalls, 1);
  assert.equal(contents.inputEvents[0].type, 'mouseDown');
  assert.deepEqual(
    contents.inputEvents.map((event) => event.type),
    ['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel', 'keyDown']
  );
  assert.equal(contents.insertedText, 'hello');
  manager.blur('browser-s5');
  assert.equal(contents.focused, false);
  assert.equal(FakeBrowserWindow.instances[0].webViewFocused, false);
  assert.throws(
    () => manager.sendKeyboardEvent('browser-s5', { type: 'keyDown', keyCode: 'A' }),
    { code: 'SOURCE_NOT_FOCUSED' }
  );
});

test('publishes actual bitmap size and cleans frame/browser resources on destroy', () => {
  const { manager, frameTransport } = createManager();
  manager.createSource({ id: 'browser-s5' });
  const window = FakeBrowserWindow.instances[0];
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1280, height: 800 })
  };
  window.webContents.emit('paint', {}, { x: 2, y: 3, width: 8, height: 9 }, image);
  assert.equal(frameTransport.frames.length, 1);
  assert.equal(frameTransport.frames[0].width, 1280);
  assert.equal(frameTransport.frames[0].logicalWidth, 1280);
  manager.destroySource('browser-s5');
  assert.deepEqual(frameTransport.released, ['browser-s5']);
  assert.equal(window.destroyed, true);
  assert.equal(manager.listSources().length, 0);
  assert.deepEqual(manager.destroySource('browser-s5'), { id: 'browser-s5', destroyed: false });
});
