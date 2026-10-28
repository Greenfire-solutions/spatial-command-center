'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JpegFrameTransport, encodeFrameMessage } = require('../host/jpeg-frame-transport.cjs');

const fakeImage = (bytes = 512) => ({
  toJPEG: () => Buffer.alloc(bytes, 0x7f)
});

const frame = (overrides = {}) => ({
  sourceId: 'browser-1',
  image: fakeImage(),
  width: 1280,
  height: 800,
  logicalWidth: 1280,
  logicalHeight: 800,
  deviceScaleFactor: 1,
  ...overrides
});

const readMessage = (buffer) => {
  const headerLength = buffer.readUInt32LE(0);
  const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  return { header, body: buffer.subarray(4 + headerLength) };
};

test('a paint is encoded once and framed with its own metadata', () => {
  const sent = [];
  const transport = new JpegFrameTransport({ send: (data) => sent.push(data) });

  assert.equal(transport.publish(frame()), true);
  assert.equal(sent.length, 1);

  const { header, body } = readMessage(sent[0]);
  assert.equal(header.sourceId, 'browser-1');
  assert.equal(header.width, 1280);
  assert.equal(header.encoding, 'jpeg');
  assert.equal(body.byteLength, 512, 'the JPEG payload survives framing intact');
});

test('the header length prefix locates the payload exactly', () => {
  const message = encodeFrameMessage({ sourceId: 'a', frameId: 1 }, Buffer.from([1, 2, 3]));
  const { header, body } = readMessage(message);
  assert.equal(header.sourceId, 'a');
  assert.deepEqual([...body], [1, 2, 3]);
});

test('paints faster than the ceiling are dropped rather than queued', () => {
  const sent = [];
  const transport = new JpegFrameTransport({ send: (data) => sent.push(data), maxFps: 1 });

  assert.equal(transport.publish(frame()), true);
  assert.equal(transport.publish(frame()), false, 'the second paint within the interval is skipped');
  assert.equal(transport.publish(frame()), false);

  assert.equal(sent.length, 1);
  assert.equal(transport.stats.encoded, 1);
  assert.equal(transport.stats.skipped, 2, 'dropping is recorded, not silent');
});

test('a per-source frame rate overrides the default ceiling', () => {
  const sent = [];
  let clock = 0;
  const transport = new JpegFrameTransport({
    send: (data) => sent.push(data),
    maxFps: 1,
    now: () => clock
  });

  // The default ceiling is one frame per second; this source is allowed ten.
  transport.setSourceFrameRate('browser-1', 10);
  assert.equal(transport.publish(frame()), true);

  clock = 50;
  assert.equal(transport.publish(frame()), false, 'still inside the 100ms interval');

  clock = 100;
  assert.equal(transport.publish(frame()), true, 'the raised ceiling admits the next paint');
  assert.equal(sent.length, 2);
});

test('clearing a per-source rate returns it to the default ceiling', () => {
  const transport = new JpegFrameTransport({ send: () => {}, maxFps: 4 });
  transport.setSourceFrameRate('browser-1', 20);
  assert.equal(transport.intervalFor('browser-1'), 50);
  transport.setSourceFrameRate('browser-1', 0);
  assert.equal(transport.intervalFor('browser-1'), 250, 'falls back to the transport default');
});

test('pacing is tracked per source, so one busy page cannot starve another', () => {
  const sent = [];
  const transport = new JpegFrameTransport({ send: (data) => sent.push(data), maxFps: 1 });

  assert.equal(transport.publish(frame({ sourceId: 'a' })), true);
  assert.equal(transport.publish(frame({ sourceId: 'b' })), true);
  assert.equal(transport.publish(frame({ sourceId: 'a' })), false);
  assert.equal(sent.length, 2);
});

test('an encoder failure is reported rather than thrown at the manager', () => {
  const warnings = [];
  const transport = new JpegFrameTransport({
    send: () => {},
    logger: { warn: (message) => warnings.push(message) }
  });

  const broken = frame({ image: { toJPEG: () => { throw new Error('encoder gone'); } } });
  assert.equal(transport.publish(broken), false);
  assert.equal(warnings.length, 1);
});

test('a closed transport stops publishing', () => {
  const sent = [];
  const transport = new JpegFrameTransport({ send: (data) => sent.push(data) });
  transport.close();
  assert.equal(transport.publish(frame()), false);
  assert.equal(sent.length, 0);
});

test('the transport implements every method BrowserSourceManager calls', () => {
  const transport = new JpegFrameTransport({ send: () => {} });
  for (const method of ['publish', 'acknowledge', 'requestLatest', 'releaseSource', 'close']) {
    assert.equal(typeof transport[method], 'function', `${method} is part of the transport contract`);
  }
});

test('releasing a source forgets its pacing state', () => {
  const transport = new JpegFrameTransport({ send: () => {}, maxFps: 4 });
  transport.setSourceFrameRate('browser-1', 20);
  assert.equal(transport.intervalFor('browser-1'), 50);
  transport.releaseSource('browser-1');
  assert.equal(transport.intervalFor('browser-1'), 250);
});

test('requestLatest admits the next paint immediately', () => {
  const sent = [];
  let clock = 1000;
  const transport = new JpegFrameTransport({
    send: (data) => sent.push(data),
    maxFps: 1,
    now: () => clock
  });

  assert.equal(transport.publish(frame()), true);
  assert.equal(transport.publish(frame()), false, 'paced out');
  transport.requestLatest('browser-1');
  assert.equal(transport.publish(frame()), true, 'the gate reopened for the resumed source');
  assert.equal(sent.length, 2);
});
