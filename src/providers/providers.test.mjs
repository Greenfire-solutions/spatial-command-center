import assert from 'node:assert/strict';
import test from 'node:test';

import { FRAME_FORMATS, describeBitmapFrame, isBitmapFormat } from './frame-formats.js';
import { BrowserSourceProvider, UnavailableBrowserProvider } from './browser-provider.js';
import { ElectronChromiumProvider } from './electron-chromium-provider.js';
import { RemoteChromiumProvider } from './remote-chromium-provider.js';
import { WebSocketBrowserProvider } from './remote/websocket-browser-provider.js';
import { createRequest, validateRequest } from './remote/protocol.js';
import { resetBrowserProviderCache, resolveBrowserProvider, resolveRemoteConfig } from './index.js';

/* Every operation the spatial scene performs on a browser source. A provider
 * that cannot answer all of these cannot be substituted for another. */
const REQUIRED_OPERATIONS = [
  'createSource', 'destroySource', 'getSource', 'listSources',
  'navigate', 'back', 'forward', 'reload', 'stop',
  'resize', 'focus', 'blur',
  'sendPointerEvent', 'sendWheelEvent', 'sendKeyboardEvent', 'insertText',
  'onFrame', 'onMetadata', 'onEvent'
];

const fakeBridge = () => {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve({ ok: name });
  };
  return {
    calls,
    available: true,
    runtimeInfo: record('runtimeInfo'),
    createSource: record('createSource'),
    destroySource: record('destroySource'),
    getSource: record('getSource'),
    listSources: record('listSources'),
    navigate: record('navigate'),
    back: record('back'),
    forward: record('forward'),
    reload: record('reload'),
    stop: record('stop'),
    resize: record('resize'),
    focus: record('focus'),
    blur: record('blur'),
    sendPointerEvent: record('sendPointerEvent'),
    sendWheelEvent: record('sendWheelEvent'),
    sendKeyboardEvent: record('sendKeyboardEvent'),
    insertText: record('insertText'),
    openExternal: record('openExternal'),
    onFrame: (sourceId, listener) => { calls.push(['onFrame', sourceId]); fakeBridge.lastFrameListener = listener; return () => calls.push(['offFrame']); },
    onMetadata: (sourceId) => { calls.push(['onMetadata', sourceId]); return () => {}; },
    onEvent: (sourceId) => { calls.push(['onEvent', sourceId]); return () => {}; }
  };
};

test('every provider implements the full source contract', () => {
  const bridge = fakeBridge();
  for (const provider of [
    new ElectronChromiumProvider(bridge),
    new UnavailableBrowserProvider(),
    new RemoteChromiumProvider()
  ]) {
    for (const operation of REQUIRED_OPERATIONS) {
      assert.equal(
        typeof provider[operation],
        'function',
        `${provider.id} must implement ${operation}()`
      );
    }
  }
  assert.equal(typeof new BrowserSourceProvider().id, 'string');
});

test('the Electron provider forwards operations to its bridge unchanged', async () => {
  const bridge = fakeBridge();
  const provider = new ElectronChromiumProvider(bridge);

  assert.equal(provider.id, 'electron-chromium');
  assert.equal(provider.available, true);
  assert.equal(provider.frameFormat, FRAME_FORMATS.BGRA8_BITMAP);

  await provider.navigate('browser-s5', 'https://example.com/');
  await provider.sendPointerEvent('browser-s5', { type: 'mouseDown', x: 4, y: 8 });
  await provider.resize('browser-s5', 800, 600, 1);

  assert.deepEqual(bridge.calls[0], ['navigate', 'browser-s5', 'https://example.com/']);
  assert.deepEqual(bridge.calls[1], ['sendPointerEvent', 'browser-s5', { type: 'mouseDown', x: 4, y: 8 }]);
  assert.deepEqual(bridge.calls[2], ['resize', 'browser-s5', 800, 600, 1]);
});

test('raw bridge frames become format-tagged descriptors', () => {
  const bridge = fakeBridge();
  const provider = new ElectronChromiumProvider(bridge);
  const received = [];
  provider.onFrame('browser-s5', (frame) => received.push(frame));

  const pixels = new Uint8Array(4 * 2 * 2);
  fakeBridge.lastFrameListener({
    sourceId: 'browser-s5',
    frameId: 7,
    width: 2,
    height: 2,
    logicalWidth: 2,
    logicalHeight: 2,
    deviceScaleFactor: 1,
    stride: 8,
    premultipliedAlpha: true,
    buffer: pixels.buffer
  });

  assert.equal(received.length, 1);
  const frame = received[0];
  assert.equal(frame.format, FRAME_FORMATS.BGRA8_BITMAP, 'the format travels with the frame');
  assert.equal(isBitmapFormat(frame.format), true);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 2);
  assert.equal(frame.frameId, 7);
  assert.equal(frame.premultipliedAlpha, true);
  assert.ok(frame.frame, 'the payload is carried in a format-neutral `frame` field');
  assert.equal(frame.buffer, frame.frame, 'the legacy accessor still reads the same payload');
});

test('a descriptor can describe a non-bitmap format without a bitmap payload', () => {
  assert.equal(isBitmapFormat(FRAME_FORMATS.VIDEO_FRAME), false);
  assert.equal(isBitmapFormat(FRAME_FORMATS.VIDEO_ELEMENT), false);
  assert.equal(isBitmapFormat(FRAME_FORMATS.SHARED_TEXTURE), false);
  assert.equal(isBitmapFormat(FRAME_FORMATS.RGBA8_BITMAP), true);

  const rgba = describeBitmapFrame(
    { sourceId: 'x', width: 4, height: 4, buffer: new ArrayBuffer(64) },
    FRAME_FORMATS.RGBA8_BITMAP
  );
  assert.equal(rgba.pixelFormat, 'RGBA', 'the surface shader is told the channel order');
});

test('an absent runtime resolves to an honest unavailable provider', async () => {
  resetBrowserProviderCache();
  const provider = resolveBrowserProvider();
  assert.equal(provider.available, false);
  assert.equal(provider.id, 'unavailable');
  assert.deepEqual(await provider.listSources(), []);
  assert.equal(typeof provider.onFrame('any', () => {}), 'function', 'subscriptions are inert, not fatal');
  await assert.rejects(() => provider.navigate('any', 'https://example.com/'));
});

test('an explicitly supplied provider always wins over detection', () => {
  resetBrowserProviderCache();
  const injected = new ElectronChromiumProvider(fakeBridge());
  assert.equal(resolveBrowserProvider(injected), injected);
});

test('the resolved provider is stable while its bridge is unchanged', () => {
  resetBrowserProviderCache();
  const bridge = fakeBridge();
  globalThis.window = { spatialBrowser: bridge };
  try {
    const first = resolveBrowserProvider();
    const second = resolveBrowserProvider();
    assert.equal(first, second, 'identity is stable so effect dependencies do not thrash');
    assert.equal(first.id, 'electron-chromium');

    globalThis.window = { spatialBrowser: fakeBridge() };
    assert.notEqual(resolveBrowserProvider(), first, 'a new bridge yields a new adapter');
  } finally {
    delete globalThis.window;
    resetBrowserProviderCache();
  }
});


test('the remote provider satisfies the same contract without a transport', async () => {
  const provider = new RemoteChromiumProvider();
  assert.equal(provider.id, 'remote-chromium');
  assert.equal(provider.available, false, 'it is offline until a peer connection exists');
  assert.equal(
    provider.frameFormat,
    FRAME_FORMATS.VIDEO_ELEMENT,
    'remote frames are decoded video, not pixel buffers'
  );

  // An operation attempted while disconnected must fail loudly, never no-op.
  await assert.rejects(
    () => provider.navigate('browser-a', 'https://example.com/'),
    /not connected/,
    'a disconnected remote provider reports itself'
  );

  // Subscriptions stay inert so a screen can mount and show an offline state.
  assert.equal(typeof provider.onFrame('browser-a', () => {}), 'function');
});

test('remote control messages carry a versioned, addressable envelope', () => {
  const message = createRequest('navigate', 'browser-a', { url: 'https://example.com/' });
  assert.equal(message.channel, 'spatial-command-center.browser-control');
  assert.equal(message.version, 1);
  assert.equal(message.kind, 'request');
  assert.equal(message.action, 'navigate');
  assert.equal(message.sourceId, 'browser-a');
  assert.deepEqual(message.payload, { url: 'https://example.com/' });
  assert.equal(validateRequest(message).ok, true, 'what the client sends, the host accepts');
});

/*
 * Configuration reaching the page without a query string.
 *
 * This is the regression that mattered most in practice. A headset that opened
 * the workspace from a bookmark, a restored tab, or the bare origin lost
 * `?host=`, fell through to UnavailableBrowserProvider, and reported that local
 * Chromium was offline — on a device that cannot run Electron, while the host
 * and the transport were both healthy. The server now injects the address ahead
 * of the module graph; these pin the precedence from both ends.
 *
 * Resolution is asserted rather than provider construction, because
 * constructing the remote provider opens a real socket.
 */
const withWindow = (value, body) => {
  const prior = globalThis.window;
  globalThis.window = value;
  try {
    resetBrowserProviderCache();
    body();
  } finally {
    globalThis.window = prior;
    resetBrowserProviderCache();
  }
};

test('an injected host configures the page with no query string', () => {
  withWindow({
    location: { search: '' },
    __SCC_REMOTE__: { url: 'ws://192.168.1.28:8787', token: 'injected' }
  }, () => {
    const config = resolveRemoteConfig();
    assert.ok(config, 'the bare origin still finds its host');
    assert.equal(config.url, 'ws://192.168.1.28:8787');
    assert.equal(config.token, 'injected');
  });
});

test('an explicit host in the query string outranks the injected one', () => {
  withWindow({
    location: { search: '?host=ws://10.0.0.5:9999&token=explicit' },
    __SCC_REMOTE__: { url: 'ws://192.168.1.28:8787', token: 'injected' }
  }, () => {
    const config = resolveRemoteConfig();
    assert.equal(config.url, 'ws://10.0.0.5:9999', 'a session can be pointed elsewhere');
    assert.equal(config.token, 'explicit');
  });
});

test('a malformed injected host is refused rather than trusted', () => {
  withWindow({
    location: { search: '' },
    __SCC_REMOTE__: { url: 'http://192.168.1.28:8787', token: 'x' }
  }, () => {
    assert.equal(resolveRemoteConfig(), null, 'only ws:// and wss:// name a browser host');
  });
});

test('no configuration at all still resolves to nothing rather than throwing', () => {
  withWindow({ location: { search: '' } }, () => {
    assert.equal(resolveRemoteConfig(), null);
  });
});

/*
 * Frame orientation, pinned at the only place it takes effect.
 *
 * On a headset the remote path renders a decoded JPEG, and three.js ignores
 * Texture.flipY for an ImageBitmap — WebGL2's UNPACK_FLIP_Y_WEBGL does nothing
 * on an ImageBitmap upload. So the flag on the surface cannot fix orientation
 * and quietly reads as though it had. The decode option is the mechanism.
 *
 * Getting it wrong is not cosmetic. `uvToBrowserPixels` maps plane UV.y=1 to
 * browser row 0, and input travels through those same UVs, so an unflipped
 * frame shows the page upside down *and* mirrors every click about the
 * horizontal centre line — which presents as broken hit-testing rather than as
 * an orientation bug, and cost a real headset session to find.
 */
test('remote frames are decoded with the orientation the UV mapping assumes', async () => {
  const priorCreate = globalThis.createImageBitmap;
  const priorBlob = globalThis.Blob;
  const calls = [];
  try {
    globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
    globalThis.createImageBitmap = async (blob, options) => {
      calls.push(options);
      return { width: 4, height: 4, close() {} };
    };

    const socket = { addEventListener() {}, send() {}, close() {}, readyState: 1 };
    const provider = new WebSocketBrowserProvider({ socket });

    let delivered = null;
    provider.onFrame('browser-a', (frame) => { delivered = frame; });

    const header = new TextEncoder().encode(JSON.stringify({ sourceId: 'browser-a', width: 4, height: 4 }));
    const buffer = new ArrayBuffer(4 + header.length + 2);
    new DataView(buffer).setUint32(0, header.length, true);
    new Uint8Array(buffer).set(header, 4);

    await provider.receive(buffer);

    assert.equal(calls.length, 1, 'the frame was decoded');
    assert.deepEqual(calls[0], { imageOrientation: 'flipY' },
      'row 0 must land at UV.y=1, matching uvToBrowserPixels and the Electron path');
    assert.ok(delivered, 'and the decoded frame reaches the surface');
  } finally {
    globalThis.createImageBitmap = priorCreate;
    globalThis.Blob = priorBlob;
  }
});
