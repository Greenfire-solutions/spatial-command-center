'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeCreateOptions,
  normalizeKeyboardEvent,
  normalizeNavigationUrl,
  normalizePointerEvent,
  normalizeViewport,
  normalizeWheelEvent,
  requireSourceId
} = require('../validation.cjs');

test('normalizes source defaults and address-bar values', () => {
  assert.deepEqual(normalizeCreateOptions({ id: 'browser-s5' }), {
    id: 'browser-s5',
    url: 'https://example.com/',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    frameRate: 30
  });
  assert.equal(normalizeNavigationUrl('example.org'), 'https://example.org/');
  assert.equal(normalizeNavigationUrl('localhost:4173/test'), 'http://localhost:4173/test');
  assert.match(normalizeNavigationUrl('spatial browser'), /^https:\/\/www\.google\.com\/search\?q=/);
});

test('rejects privileged URL schemes, credentials, invalid ids, and oversized viewports', () => {
  assert.throws(() => normalizeNavigationUrl('javascript:alert(1)'), { code: 'UNSUPPORTED_URL_SCHEME' });
  assert.throws(() => normalizeNavigationUrl('https://user:pass@example.com'), { code: 'INVALID_URL' });
  assert.throws(() => requireSourceId('../escape'), { code: 'INVALID_SOURCE_ID' });
  assert.throws(() => normalizeViewport(20000, 800), { code: 'INVALID_ARGUMENT' });
});

test('maps and bounds supported Chromium input structures', () => {
  assert.deepEqual(normalizePointerEvent({
    type: 'down', x: 1279, y: 799, button: 'right', clickCount: 2, modifiers: ['Shift']
  }, { width: 1280, height: 800 }), {
    type: 'mouseDown', x: 1279, y: 799, button: 'right', clickCount: 2, modifiers: ['shift']
  });
  assert.deepEqual(normalizeWheelEvent({ x: 640, y: 400, deltaY: -120 }, { width: 1280, height: 800 }), {
    type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: -120,
    wheelTicksX: 0, wheelTicksY: -1,
    hasPreciseScrollingDeltas: true, canScroll: true, modifiers: []
  });
  assert.deepEqual(normalizeKeyboardEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['cmd'] }), {
    type: 'keyDown', keyCode: 'A', modifiers: ['cmd']
  });
  assert.equal(
    normalizePointerEvent({ type: 'move', x: 1280, y: 800 }, { width: 1280, height: 800 }).x,
    1279
  );
});
