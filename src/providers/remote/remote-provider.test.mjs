import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteChromiumProvider } from '../remote-chromium-provider.js';
import { FRAME_FORMATS } from '../frame-formats.js';
import {
  createNotification,
  createResponse,
  createErrorResponse,
  decode,
  validateRequest
} from './protocol.js';

/*
 * A fake host on the other end of the wire. It speaks the real protocol and
 * validates every request exactly as a real host must, so these tests exercise
 * the actual message contract rather than a convenient stand-in for it.
 */
const createFakeTransport = () => {
  const sentRequests = [];
  let channelHandlers = {};
  let signalingHandler = null;
  const signalingSent = [];

  const controlChannel = {
    readyState: 'open',
    send(raw) {
      const message = decode(raw);
      sentRequests.push(message);
      const validation = validateRequest(message);
      if (!validation.ok) {
        // A real host refuses rather than guesses.
        queueMicrotask(() => channelHandlers.onmessage?.({
          data: JSON.stringify(createErrorResponse(message, validation.code, validation.message))
        }));
        return;
      }
      queueMicrotask(() => channelHandlers.onmessage?.({
        data: JSON.stringify(createResponse(message, { echoed: message.action, sourceId: message.sourceId, payload: message.payload }))
      }));
    },
    close() { this.readyState = 'closed'; channelHandlers.onclose?.(); },
    set onmessage(fn) { channelHandlers.onmessage = fn; },
    get onmessage() { return channelHandlers.onmessage; },
    set onclose(fn) { channelHandlers.onclose = fn; },
    get onclose() { return channelHandlers.onclose; }
  };

  const peer = {
    connectionState: 'new',
    localDescription: { type: 'offer', sdp: 'fake' },
    createDataChannel: () => controlChannel,
    createOffer: async () => ({ type: 'offer', sdp: 'fake' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    close() { this.connectionState = 'closed'; }
  };

  const signaling = {
    connect: async () => {},
    send: (message) => signalingSent.push(message),
    onMessage: (handler) => { signalingHandler = handler; },
    close: () => {}
  };

  return {
    peer,
    controlChannel,
    signaling,
    sentRequests,
    signalingSent,
    answer: () => signalingHandler({ kind: 'answer', sdp: { type: 'answer', sdp: 'fake' } }),
    pushNotification: (type, sourceId, data) => channelHandlers.onmessage?.({
      data: JSON.stringify(createNotification(type, sourceId, data))
    }),
    failNext: (code, message) => {
      controlChannel.send = (raw) => {
        const request = decode(raw);
        sentRequests.push(request);
        queueMicrotask(() => channelHandlers.onmessage?.({
          data: JSON.stringify(createErrorResponse(request, code, message))
        }));
      };
    }
  };
};

const connectedProvider = async () => {
  const transport = createFakeTransport();
  const provider = new RemoteChromiumProvider({
    signaling: transport.signaling,
    createPeerConnection: () => transport.peer,
    requestTimeoutMs: 500
  });
  await provider.connect();
  await transport.answer();
  return { provider, transport };
};

test('a remote provider is unavailable until the peer answers', async () => {
  const transport = createFakeTransport();
  const provider = new RemoteChromiumProvider({
    signaling: transport.signaling,
    createPeerConnection: () => transport.peer
  });

  assert.equal(provider.available, false, 'offline before connecting');
  await assert.rejects(() => provider.navigate('browser-a', 'https://example.com/'), /not connected/);

  await provider.connect();
  assert.equal(provider.available, false, 'still offline while the offer is outstanding');

  await transport.answer();
  assert.equal(provider.available, true, 'available once the host answers');
  assert.equal(transport.signalingSent[0].kind, 'offer', 'the client offers first');
});

test('every provider operation becomes a valid protocol request', async () => {
  const { provider, transport } = await connectedProvider();

  await provider.navigate('browser-a', 'https://example.com/');
  await provider.back('browser-a');
  await provider.resize('browser-a', 800, 600, 1);
  await provider.setQuality('browser-a', { frameRate: 8, painting: false });
  await provider.sendPointerEvent('browser-a', { type: 'mouseDown', x: 12, y: 34 });
  await provider.insertText('browser-a', 'spatial');

  const actions = transport.sentRequests.map((request) => request.action);
  assert.deepEqual(actions, [
    'navigate', 'back', 'resize', 'setQuality', 'sendPointerEvent', 'insertText'
  ]);

  for (const request of transport.sentRequests) {
    const validation = validateRequest(request);
    assert.equal(validation.ok, true, `${request.action} produced an invalid request: ${validation.message}`);
  }

  const navigateRequest = transport.sentRequests[0];
  assert.equal(navigateRequest.sourceId, 'browser-a');
  assert.deepEqual(navigateRequest.payload, { url: 'https://example.com/' });
});

test('input arrives already in browser coordinates, unchanged by the transport', async () => {
  const { provider, transport } = await connectedProvider();
  const input = { type: 'mouseDown', x: 640, y: 400, button: 'left', clickCount: 1, modifiers: [] };
  await provider.sendPointerEvent('browser-a', input);
  assert.deepEqual(
    transport.sentRequests[0].payload,
    input,
    'the ray/UV mapping is shared with the local path, so nothing re-maps here'
  );
});

test('a host rejection surfaces as a rejected promise with its code', async () => {
  const { provider, transport } = await connectedProvider();
  transport.failNext('UNSUPPORTED_URL_SCHEME', 'Only HTTP and HTTPS destinations are supported.');
  await assert.rejects(
    () => provider.navigate('browser-a', 'file:///etc/passwd'),
    (error) => error.code === 'UNSUPPORTED_URL_SCHEME'
  );
});

test('a silent host does not leave a request hanging forever', async () => {
  const transport = createFakeTransport();
  transport.controlChannel.send = () => {};
  const provider = new RemoteChromiumProvider({
    signaling: transport.signaling,
    createPeerConnection: () => transport.peer,
    requestTimeoutMs: 120
  });
  await provider.connect();
  await transport.answer();
  await assert.rejects(() => provider.reload('browser-a'), /did not answer reload in time/);
});

test('an inbound track becomes a video frame descriptor for its source', async () => {
  const { provider, transport } = await connectedProvider();
  const frames = [];
  provider.onFrame('browser-a', (frame) => frames.push(frame));

  const track = { addEventListener() {}, stop() {} };
  provider.handleTrack({ streams: [{ id: 'browser-a' }], track });

  assert.equal(frames.length, 1, 'the track publishes one descriptor, not one per frame');
  assert.equal(frames[0].sourceId, 'browser-a');
  assert.equal(
    frames[0].format,
    FRAME_FORMATS.VIDEO_ELEMENT,
    'the scene binds a VideoTexture rather than uploading pixels'
  );
  assert.ok(frames[0].frame, 'the descriptor carries the element to sample');
});

test('metadata and events reach only the subscriber for that source', async () => {
  const { provider, transport } = await connectedProvider();
  const forA = [];
  const forB = [];
  const forAll = [];
  provider.onMetadata('browser-a', (m) => forA.push(m));
  provider.onMetadata('browser-b', (m) => forB.push(m));
  provider.onMetadata(null, (m) => forAll.push(m));

  transport.pushNotification('metadata', 'browser-a', { title: 'Example', loading: false });

  assert.equal(forA.length, 1);
  assert.equal(forB.length, 0, 'a sibling source is not notified');
  assert.equal(forAll.length, 1, 'a wildcard subscriber sees everything');
  assert.equal(forA[0].title, 'Example');
});

test('disconnecting fails outstanding work instead of leaving it pending', async () => {
  const transport = createFakeTransport();
  transport.controlChannel.send = () => {};
  const provider = new RemoteChromiumProvider({
    signaling: transport.signaling,
    createPeerConnection: () => transport.peer,
    requestTimeoutMs: 60000
  });
  await provider.connect();
  await transport.answer();

  const pending = provider.listSources();
  await provider.disconnect();
  await assert.rejects(() => pending, /connection was closed/);
  assert.equal(provider.available, false);
});

test('the host refuses malformed and oversized control messages', () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest({ channel: 'other' }).ok, false);
  assert.equal(validateRequest({ channel: 'spatial-command-center.browser-control', version: 99, kind: 'request' }).ok, false);

  const unsupported = validateRequest({
    channel: 'spatial-command-center.browser-control',
    version: 1,
    kind: 'request',
    requestId: 'r1-abc',
    action: 'executeJavaScript',
    payload: {}
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'UNSUPPORTED_ACTION', 'the action list is an allowlist');

  const oversized = validateRequest({
    channel: 'spatial-command-center.browser-control',
    version: 1,
    kind: 'request',
    requestId: 'r1-abc',
    action: 'insertText',
    sourceId: 'browser-a',
    payload: { text: 'x'.repeat(200000) }
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'PAYLOAD_TOO_LARGE', 'the channel cannot be used as a data pipe');

  const badSource = validateRequest({
    channel: 'spatial-command-center.browser-control',
    version: 1,
    kind: 'request',
    requestId: 'r1-abc',
    action: 'navigate',
    sourceId: '../../etc/passwd',
    payload: {}
  });
  assert.equal(badSource.ok, false);
  assert.equal(badSource.code, 'INVALID_SOURCE_ID');
});
