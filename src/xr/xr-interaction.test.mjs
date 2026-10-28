import assert from 'node:assert/strict';
import test from 'node:test';

import {
  XR_INTERACTION_MAP,
  thumbstickToPushPull,
  thumbstickToWheelDelta
} from './xr-interaction.js';

test('every XR gesture routes into an action that already exists', () => {
  for (const [name, entry] of Object.entries(XR_INTERACTION_MAP)) {
    assert.ok(entry.sources.length > 0, `${name} declares at least one input source`);
    assert.ok(entry.action, `${name} names the action it drives`);
    assert.ok(
      entry.sources.some((source) => source.startsWith('mouse:')),
      `${name} must also be reachable from the desktop, or the two input models have diverged`
    );
  }
});

test('a resting thumbstick never moves anything', () => {
  assert.equal(thumbstickToPushPull(0), 0);
  assert.equal(thumbstickToPushPull(0.1), 0, 'inside the deadzone');
  assert.equal(thumbstickToPushPull(-0.1), 0);
  assert.equal(thumbstickToWheelDelta(0.12), 0);
});

test('thumbstick response is signed, monotonic, and eased', () => {
  const small = thumbstickToPushPull(0.4);
  const large = thumbstickToPushPull(0.9);
  assert.ok(small > 0 && large > small, 'larger deflection pushes further');
  assert.ok(
    large / small > 0.5 / 0.25,
    'the response is eased rather than linear, so small deflections stay precise'
  );
  assert.equal(Math.sign(thumbstickToPushPull(-0.9)), -1, 'the axis is signed');
  assert.ok(Math.abs(thumbstickToPushPull(1)) <= 0.06 + 1e-9, 'full deflection is bounded by the gain');
});

test('thumbstick scrolling matches the wheel convention', () => {
  assert.ok(thumbstickToWheelDelta(1) > 0);
  assert.ok(thumbstickToWheelDelta(-1) < 0);
  assert.equal(thumbstickToWheelDelta(0), 0);
});
