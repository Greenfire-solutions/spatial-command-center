import test from 'node:test';
import assert from 'node:assert/strict';

import {
  domButtonToElectronButton,
  domWheelDeltaToElectron,
  electronKeyCode,
  framePixelView,
  isChromiumInputEnabled,
  keyboardModifiers,
  pointerModifiers,
  printableTextForKeyboardEvent,
  tightlyPackFrameRows,
  uvToBrowserPixels,
  uvToChromiumInputPoint,
  validateRawFrame
} from './chromium-texture-utils.js';

test('UV coordinates map from Three bottom-left to Chromium top-left', () => {
  assert.deepEqual(uvToBrowserPixels({ x: 0, y: 1 }, 1280, 800), { x: 0, y: 0 });
  assert.deepEqual(uvToBrowserPixels({ x: 0.5, y: 0.5 }, 1280, 800), { x: 640, y: 400 });
  assert.deepEqual(uvToBrowserPixels({ x: 1, y: 0 }, 1280, 800), { x: 1280, y: 800 });
  assert.deepEqual(uvToChromiumInputPoint({ x: 1, y: 0 }, 1280, 800), { x: 1279, y: 799 });
  assert.deepEqual(uvToChromiumInputPoint({ x: 0.1239, y: 0.4321 }, 100, 100), { x: 12, y: 56 });
});

test('browser input is exclusive to Browse Mode except intentionally locked screens', () => {
  assert.equal(isChromiumInputEnabled({ interactionMode: 'browse' }), true);
  assert.equal(isChromiumInputEnabled({ interactionMode: 'arrange' }), false);
  assert.equal(isChromiumInputEnabled({ interactionMode: 'arrange', locked: true }), true);
  assert.equal(isChromiumInputEnabled({ interactionMode: 'browse', enabled: false }), false);
});

test('DOM mouse buttons and keyboard values map to Electron input names', () => {
  assert.equal(domButtonToElectronButton(0), 'left');
  assert.equal(domButtonToElectronButton(1), 'middle');
  assert.equal(domButtonToElectronButton(2), 'right');
  assert.equal(electronKeyCode({ key: 'ArrowLeft' }), 'Left');
  assert.equal(electronKeyCode({ key: 'x', code: 'KeyX' }), 'x');
  assert.equal(printableTextForKeyboardEvent({ key: 'x' }), 'x');
  assert.equal(printableTextForKeyboardEvent({ key: 'x', metaKey: true }), '');
  assert.deepEqual(keyboardModifiers({ shiftKey: true, ctrlKey: true }), ['shift', 'control']);
  assert.deepEqual(pointerModifiers({ buttons: 3, altKey: true }), ['alt', 'leftbuttondown', 'rightbuttondown']);
});

test('raw Electron frame validation preserves a zero-copy tight pixel view', () => {
  const buffer = new ArrayBuffer(4 * 2 * 2);
  const source = new Uint8Array(buffer);
  source[0] = 42;
  assert.equal(framePixelView({ buffer })[0], 42);
  const validated = validateRawFrame({ width: 2, height: 2, stride: 8, pixelFormat: 'BGRA', buffer });
  assert.equal(validated.ok, true);
  assert.equal(validated.pixelFormat, 'bgra');
  assert.equal(tightlyPackFrameRows(validated), validated.pixels);
});

test('padded frame rows are repacked without CPU channel swapping', () => {
  const pixels = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99,
    9, 10, 11, 12, 13, 14, 15, 16, 99, 99, 99, 99
  ]);
  const validated = validateRawFrame({ width: 2, height: 2, stride: 12, buffer: pixels });
  const packed = tightlyPackFrameRows(validated);
  assert.deepEqual(Array.from(packed), [
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16
  ]);
});

test('wheel events include scroll ticks expected by Electron', () => {
  assert.equal(domWheelDeltaToElectron(420), -420);
  assert.equal(domWheelDeltaToElectron(-28), 28);
  assert.equal(domWheelDeltaToElectron(0), 0);
  const payload = {
    type: 'mouseWheel',
    x: 123,
    y: 456,
    deltaX: 0,
    deltaY: domWheelDeltaToElectron(420),
    wheelTicksX: 0,
    wheelTicksY: -3,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers: []
  };
  assert.deepEqual(payload, {
    type: 'mouseWheel',
    x: 123,
    y: 456,
    deltaX: 0,
    deltaY: -420,
    wheelTicksX: 0,
    wheelTicksY: -3,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers: []
  });
});
