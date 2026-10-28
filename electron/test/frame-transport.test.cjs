'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { IpcBitmapFrameTransport } = require('../frame-transport.cjs');
const { IPC_CHANNELS } = require('../constants.cjs');

const image = (value) => ({
  toBitmap: () => Buffer.from([value, 2, 3, 4])
});

test('raw bitmap transport allows one frame in flight and keeps only the newest pending paint', () => {
  const sent = [];
  const target = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload })
  };
  const transport = new IpcBitmapFrameTransport({ getTargetWebContents: () => target });
  const frame = (value) => ({
    sourceId: 'browser-s5', image: image(value), width: 1, height: 1,
    logicalWidth: 1280, logicalHeight: 800, deviceScaleFactor: 1,
    dirtyRect: { x: 0, y: 0, width: 1, height: 1 }
  });

  assert.equal(transport.publish(frame(1)), true);
  assert.equal(transport.publish(frame(5)), false);
  assert.equal(transport.publish(frame(9)), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, IPC_CHANNELS.FRAME);
  assert.equal(sent[0].payload.pixelFormat, 'BGRA');
  assert.equal(new Uint8Array(sent[0].payload.buffer)[0], 1);

  assert.equal(transport.acknowledge('browser-s5', sent[0].payload.frameId), true);
  assert.equal(sent.length, 2);
  assert.equal(new Uint8Array(sent[1].payload.buffer)[0], 9);
  assert.equal(transport.inFlight.size, 1);
  assert.equal(transport.pending.size, 0);
});

test('releases cached and queued frames with the source', () => {
  const transport = new IpcBitmapFrameTransport({ getTargetWebContents: () => null });
  transport.publish({
    sourceId: 'browser-s5', image: image(1), width: 1, height: 1,
    logicalWidth: 1, logicalHeight: 1, deviceScaleFactor: 1,
    dirtyRect: { x: 0, y: 0, width: 1, height: 1 }
  });
  assert.equal(transport.latest.size, 1);
  transport.releaseSource('browser-s5');
  assert.equal(transport.latest.size, 0);
});
