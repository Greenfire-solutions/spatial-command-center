'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron/main');
const { BrowserSourceManager } = require('../browser-source-manager.cjs');

const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'browser-source-test.html'));
const server = http.createServer((_request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': fixture.byteLength
  });
  response.end(fixture);
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

class InspectionFrameTransport {
  constructor() {
    this.frames = [];
    /* A monotonic count of every frame ever published. this.frames is capped
     * for memory, so its length says nothing about throughput. */
    this.published = 0;
    this.publishedBySource = new Map();
  }
  publish(frame) {
    this.published += 1;
    this.publishedBySource.set(frame.sourceId, (this.publishedBySource.get(frame.sourceId) || 0) + 1);
    this.frames.push(frame);
    if (this.frames.length > 5) this.frames.shift();
  }
  countFor(sourceId) { return this.publishedBySource.get(sourceId) || 0; }
  releaseSource() {}
  close() {}
}

const click = (manager, x, y, clickCount = 1, sourceId = 'browser-s5') => {
  manager.sendPointerEvent(sourceId, { type: 'down', x, y, button: 'left', clickCount });
  manager.sendPointerEvent(sourceId, { type: 'up', x, y, button: 'left', clickCount });
};

const run = async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/`;
  const frameTransport = new InspectionFrameTransport();
  const manager = new BrowserSourceManager({ BrowserWindow, frameTransport });

  manager.createSource({
    id: 'browser-s5',
    url: fixtureUrl,
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    frameRate: 30
  });
  const record = manager.getRecord('browser-s5');
  const contents = record.window.webContents;
  if (record.window.isVisible()) throw new Error('Offscreen source window must remain hidden.');
  if (!contents.isOffscreen()) throw new Error('Browser source WebContents is not offscreen.');

  await waitFor(() => !contents.isLoading() && contents.getURL() === fixtureUrl, 'fixture navigation');
  const firstFrame = await waitFor(
    () => frameTransport.frames.find((frame) => frame.width === 1280 && frame.height === 800),
    '1280×800 offscreen paint'
  );
  const bitmap = firstFrame.image.toBitmap({ scaleFactor: 1 });
  if (bitmap.byteLength !== 1280 * 800 * 4) {
    throw new Error(`Unexpected raw bitmap length: ${bitmap.byteLength}.`);
  }
  if (!contents.isPainting()) throw new Error('Offscreen source stopped painting.');

  click(manager, 180, 210);
  await waitFor(
    () => contents.executeJavaScript('document.hasFocus()'),
    'offscreen render-widget focus'
  );
  if (record.window.isFocused() || BrowserWindow.getFocusedWindow() === record.window) {
    throw new Error('Offscreen source took native operating-system focus.');
  }
  await waitFor(
    () => contents.executeJavaScript("document.getElementById('status').value === 'clicked'"),
    'synthetic pointer click'
  );

  click(manager, 260, 300);
  await manager.insertText('browser-s5', 'spatial');
  manager.sendKeyboardEvent('browser-s5', { type: 'keyDown', keyCode: 'A' });
  manager.sendKeyboardEvent('browser-s5', { type: 'char', keyCode: 'a' });
  manager.sendKeyboardEvent('browser-s5', { type: 'keyUp', keyCode: 'A' });
  await waitFor(
    () => contents.executeJavaScript("document.getElementById('input').value.includes('spatial')"),
    'focused text input'
  );

  click(manager, 180, 395);
  await waitFor(() => contents.getURL().includes('navigated=1'), 'link navigation from pointer click');
  await waitFor(() => contents.navigationHistory.canGoBack(), 'navigation history entry');
  manager.back('browser-s5');
  await waitFor(() => contents.getURL() === fixtureUrl, 'navigationHistory.goBack()');

  manager.reload('browser-s5');
  await waitFor(() => !contents.isLoading(), 'reload');
  manager.sendWheelEvent('browser-s5', { x: 640, y: 400, deltaY: -420 });
  await waitFor(
    () => contents.executeJavaScript('window.scrollY > 0'),
    'synthetic wheel scroll'
  );
  manager.resize('browser-s5', 960, 600, 1);
  await waitFor(
    () => frameTransport.frames.find((frame) => frame.width === 960 && frame.height === 600),
    'resized offscreen paint'
  );

  /*
   * Adaptive quality. A workspace with several browser surfaces cannot afford
   * to paint all of them at full rate, so verify against real Chromium that
   * both levers work: the paint rate changes, and painting can be stopped and
   * resumed without losing the page.
   */
  await contents.executeJavaScript("window.scrollTo(0, 240); true");
  const scrollBeforePause = await contents.executeJavaScript('window.scrollY');

  manager.setQuality('browser-s5', { painting: false });
  if (contents.isPainting()) throw new Error('setQuality({painting:false}) did not stop painting.');
  const framesAtPause = frameTransport.countFor('browser-s5');
  await delay(600);
  if (frameTransport.countFor('browser-s5') !== framesAtPause) {
    throw new Error('A paused browser source kept producing frames.');
  }

  manager.setQuality('browser-s5', { painting: true, frameRate: 12 });
  if (!contents.isPainting()) throw new Error('setQuality({painting:true}) did not resume painting.');
  if (manager.getSource('browser-s5').frameRate !== 12) {
    throw new Error('setQuality did not apply the requested frame rate.');
  }
  await waitFor(
    () => frameTransport.countFor('browser-s5') > framesAtPause,
    'painting to resume after a pause'
  );
  const scrollAfterResume = await contents.executeJavaScript('window.scrollY');
  if (scrollAfterResume !== scrollBeforePause) {
    throw new Error('Pausing a browser source lost its page state.');
  }

  manager.createSource({
    id: 'browser-s6',
    url: `${fixtureUrl}?screen=2`,
    width: 800,
    height: 500,
    deviceScaleFactor: 1,
    frameRate: 20
  });
  const secondContents = manager.getRecord('browser-s6').window.webContents;
  await waitFor(
    () => !secondContents.isLoading() && secondContents.getURL().includes('screen=2'),
    'second independent browser navigation'
  );
  await waitFor(
    () => frameTransport.frames.find((frame) => frame.sourceId === 'browser-s6' && frame.width === 800 && frame.height === 500),
    'second independent browser paint'
  );
  click(manager, 260, 300, 1, 'browser-s6');
  await manager.insertText('browser-s6', 'second-screen');
  await waitFor(
    () => secondContents.executeJavaScript("document.getElementById('input').value.includes('second-screen')"),
    'second browser input'
  );
  if (!contents.getURL().startsWith(fixtureUrl)) throw new Error('First browser navigation was replaced by the second source.');
  if (manager.listSources().length !== 2) throw new Error('Expected two simultaneous browser sources.');

  manager.destroySource('browser-s5');
  if (manager.listSources().length !== 1 || manager.listSources()[0].id !== 'browser-s6') {
    throw new Error('Destroying one source affected the other browser source.');
  }
  manager.destroySource('browser-s6');
  if (manager.listSources().length !== 0) throw new Error('Sources were not destroyed.');
  manager.close();
  console.log(JSON.stringify({
    ok: true,
    fixtureUrl,
    initialFrame: { width: 1280, height: 800, bytes: bitmap.byteLength },
    tested: ['hidden-window', 'paint', 'render-widget-focus', 'pointer', 'text', 'keyboard', 'wheel', 'link', 'back', 'reload', 'resize', 'quality-pause-resume', 'multi-source', 'destroy']
  }));
};

app.whenReady().then(run).then(() => {
  server.close(() => app.exit(0));
}).catch((error) => {
  console.error(error.stack || error);
  server.close(() => app.exit(1));
});

setTimeout(() => {
  console.error('Electron offscreen smoke test exceeded 45 seconds.');
  server.close(() => app.exit(1));
}, 45000).unref();
