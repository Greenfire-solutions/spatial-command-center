import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSocketBrowserProvider, decodeFrameMessage } from './websocket-browser-provider.js';
import { FRAME_FORMATS } from '../frame-formats.js';
import {
  createNotification,
  createResponse,
  createErrorResponse,
  decode,
  encode
} from './protocol.js';

/*
 * A fake host that speaks the real protocol over a fake socket, so the client
 * is exercised end to end with no network and no Electron. The same approach
 * the WebRTC client is tested with.
 */
class FakeSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    this.binaryType = 'blob';
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatch('close', { code: 1000 }); }

  /* The last request the client sent, decoded. */
  lastRequest() { return decode(this.sent[this.sent.length - 1]); }
}

/* WebSocket.OPEN is read as a global by the provider. */
globalThis.WebSocket = globalThis.WebSocket ?? FakeSocket;

const connected = () => {
  const socket = new FakeSocket();
  const provider = new WebSocketBrowserProvider({ socket, requestTimeout: 50 });
  provider.bind();
  socket.dispatch('open', {});
  return { socket, provider };
};

test('the provider declares the format its frames actually arrive in', () => {
  const { provider } = connected();
  assert.equal(provider.frameFormat, FRAME_FORMATS.IMAGE_BITMAP);
  assert.equal(provider.available, true);
});

test('a request reaches the host as a valid protocol message and resolves on its response', async () => {
  const { socket, provider } = connected();

  const pending = provider.navigate('browser-1', 'https://example.com');
  const request = socket.lastRequest();
  assert.equal(request.action, 'navigate');
  assert.equal(request.sourceId, 'browser-1');
  assert.equal(request.payload.url, 'https://example.com');

  socket.dispatch('message', { data: encode(createResponse(request, { id: 'browser-1', url: 'https://example.com/' })) });
  assert.deepEqual(await pending, { id: 'browser-1', url: 'https://example.com/' });
});

test('an error response rejects with the host\'s reason rather than a generic failure', async () => {
  const { socket, provider } = connected();
  const pending = provider.navigate('browser-1', 'javascript:alert(1)');
  const request = socket.lastRequest();
  socket.dispatch('message', {
    data: encode(createErrorResponse(request, 'INVALID_URL', 'Unsafe scheme refused.'))
  });
  await assert.rejects(pending, /Unsafe scheme refused/);
});

test('a request the host never answers rejects rather than hanging forever', async () => {
  const { provider } = connected();
  await assert.rejects(provider.listSources(), /did not answer listSources in time/);
});

test('closing the socket fails everything outstanding', async () => {
  const { socket, provider } = connected();
  const pending = provider.reload('browser-1');
  socket.close();
  await assert.rejects(pending, /connection closed/);
  assert.equal(provider.available, false);
});

test('a second client is reported as such rather than as a generic disconnect', async () => {
  const { socket, provider } = connected();
  const pending = provider.listSources();
  socket.dispatch('close', { code: 4409 });
  await assert.rejects(pending, /Another client is already connected/);
});

test('metadata and events route to the subscribed source only', () => {
  const { socket, provider } = connected();
  const mine = [];
  const theirs = [];
  provider.onMetadata('browser-1', (data) => mine.push(data));
  provider.onMetadata('browser-2', (data) => theirs.push(data));

  socket.dispatch('message', {
    data: encode(createNotification('metadata', 'browser-1', { title: 'Example' }))
  });

  assert.deepEqual(mine, [{ title: 'Example' }]);
  assert.equal(theirs.length, 0);
});

test('unsubscribing stops delivery', () => {
  const { socket, provider } = connected();
  const seen = [];
  const stop = provider.onEvent('browser-1', (data) => seen.push(data));
  stop();
  socket.dispatch('message', {
    data: encode(createNotification('event', 'browser-1', { type: 'crashed' }))
  });
  assert.equal(seen.length, 0);
});

test('a malformed inbound message is ignored rather than breaking the loop', async () => {
  const { socket, provider } = connected();
  socket.dispatch('message', { data: 'not json at all' });
  socket.dispatch('message', { data: encode({ channel: 'wrong', version: 1, kind: 'response' }) });

  // The client still works afterwards.
  const pending = provider.back('browser-1');
  socket.dispatch('message', { data: encode(createResponse(socket.lastRequest(), { ok: true })) });
  assert.deepEqual(await pending, { ok: true });
});

test('a frame message splits into its header and its JPEG payload', () => {
  const header = JSON.stringify({ sourceId: 'browser-1', frameId: 7, width: 1280, height: 800 });
  const headerBytes = new TextEncoder().encode(header);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  const buffer = new ArrayBuffer(4 + headerBytes.byteLength + jpeg.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.byteLength, true);
  new Uint8Array(buffer, 4).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.byteLength).set(jpeg);

  const parsed = decodeFrameMessage(buffer);
  assert.equal(parsed.header.sourceId, 'browser-1');
  assert.equal(parsed.header.frameId, 7);
  assert.deepEqual([...parsed.body], [0xff, 0xd8, 0xff, 0xd9]);
});

test('a truncated frame message is refused rather than misread', () => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(0, 9999, true);
  assert.equal(decodeFrameMessage(buffer), null);
  assert.equal(decodeFrameMessage(new ArrayBuffer(2)), null);
});

test('a closed provider refuses new work', async () => {
  const { provider } = connected();
  provider.close();
  await assert.rejects(provider.listSources(), /closed/);
});
