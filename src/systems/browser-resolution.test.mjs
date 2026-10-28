import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FRAME_BYTE_BUDGET,
  frameBytesFor,
  resolveDeviceScaleFactor
} from './browser-resolution.js';

test('a standard surface stays at 1x on the bitmap transport', () => {
  const factor = resolveDeviceScaleFactor({
    logicalWidth: 1280,
    logicalHeight: 800,
    displayPixelRatio: 2
  });
  assert.equal(factor, 1, '1280x800 already consumes the whole frame budget');
});

test('a smaller surface spends the same budget on sharpness', () => {
  const factor = resolveDeviceScaleFactor({
    logicalWidth: 640,
    logicalHeight: 400,
    displayPixelRatio: 2
  });
  assert.equal(factor, 2, 'a quarter-area surface can afford twice the density');
  assert.ok(
    frameBytesFor(640, 400, factor) <= DEFAULT_FRAME_BYTE_BUDGET,
    'and still fits the budget'
  );
});

test('the display ratio is a ceiling, not a target', () => {
  assert.equal(
    resolveDeviceScaleFactor({ logicalWidth: 320, logicalHeight: 200, displayPixelRatio: 1 }),
    1,
    'never render detail the display cannot resolve'
  );
  assert.equal(
    resolveDeviceScaleFactor({ logicalWidth: 320, logicalHeight: 200, displayPixelRatio: 1.5 }),
    1.5
  );
});

test('a larger budget sharpens every surface without touching call sites', () => {
  const factor = resolveDeviceScaleFactor({
    logicalWidth: 1280,
    logicalHeight: 800,
    displayPixelRatio: 2,
    byteBudget: DEFAULT_FRAME_BYTE_BUDGET * 4
  });
  assert.equal(factor, 2, 'this is the one number a better transport changes');
});

test('the result is always a scale factor Chromium accepts', () => {
  for (const ratio of [0, 0.5, 1, 1.25, 2, 3, 4, NaN, undefined]) {
    const factor = resolveDeviceScaleFactor({
      logicalWidth: 800,
      logicalHeight: 600,
      displayPixelRatio: ratio
    });
    assert.ok(factor >= 0.5 && factor <= 4, `${ratio} produced an out-of-range factor: ${factor}`);
  }
});
