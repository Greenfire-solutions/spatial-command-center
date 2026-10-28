import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FIT_DISTANCE,
  MAX_FIT_SCALE,
  MIN_FIT_SCALE,
  angleFromForward,
  applyFit,
  fitWorkspaceToView,
  layoutBounds
} from './workspace-fit.js';

/* The Developer preset's shape: an arc of wide panels authored around -Z. */
const preset = () => [
  { id: 's1', position: [0, 1.55, -2.15], size: [2.5, 1.55], scale: [1, 1, 1] },
  { id: 's2', position: [0, 0.42, -1.92], size: [2.35, 0.62], scale: [1, 1, 1] },
  { id: 's3', position: [0, 2.82, -2.18], size: [1.55, 0.82], scale: [1, 1, 1] },
  { id: 's4', position: [-2.28, 1.55, -1.48], size: [1.45, 1.55], scale: [1, 1, 1] },
  { id: 's5', position: [2.38, 1.55, -1.42], size: [1.9, 1.3], scale: [1, 1, 1] }
];

/* A viewer facing whichever way they happened to be standing. */
const viewer = (yaw, position = [0, 1.6, 0]) => ({ viewerPosition: position, viewerYaw: yaw });

test('the workspace lands in front of the viewer, whichever way they face', () => {
  /* The complaint: "it is usually always behind me". Which way the wearer faces
     when a session opens has nothing to do with the authored coordinates, so
     roughly half the time the layout is behind them. */
  for (const yaw of [0, 0.7, Math.PI / 2, Math.PI, -2.2, -Math.PI / 2, 3.0]) {
    const fit = fitWorkspaceToView({ screens: preset(), ...viewer(yaw) });
    assert.ok(fit, 'a fit was produced');

    for (const screen of preset()) {
      const world = applyFit(fit, screen.position);
      const offAxis = Math.abs(angleFromForward([0, 1.6, 0], yaw, world));
      assert.ok(offAxis < 75, `yaw ${yaw.toFixed(2)}: ${screen.id} is ${offAxis.toFixed(0)} deg off-axis`);
    }
  }
});

test('nothing ends up behind the viewer', () => {
  for (const yaw of [0, 1.1, -1.1, Math.PI, -2.8]) {
    const fit = fitWorkspaceToView({ screens: preset(), ...viewer(yaw) });
    for (const screen of preset()) {
      const world = applyFit(fit, screen.position);
      const offAxis = Math.abs(angleFromForward([0, 1.6, 0], yaw, world));
      assert.ok(offAxis < 90, `${screen.id} is ${offAxis.toFixed(0)} deg off-axis — behind the viewer`);
    }
  }
});

test('the whole layout reads like a desk, not a room', () => {
  /* Roughly a triple-monitor spread. Wide enough to be a workspace, narrow
     enough to take in without hunting for a window. */
  const fit = fitWorkspaceToView({ screens: preset(), ...viewer(0.4) });
  let widest = 0;
  for (const screen of preset()) {
    const world = applyFit(fit, screen.position);
    widest = Math.max(widest, Math.abs(angleFromForward([0, 1.6, 0], 0.4, world)));
  }
  assert.ok(widest < 60, `layout spans +/-${widest.toFixed(0)} deg`);
  assert.ok(widest > 15, 'and is not squashed into a single point');
});

test('the middle of the workspace sits at a comfortable distance', () => {
  const fit = fitWorkspaceToView({ screens: preset(), ...viewer(1.3) });
  const bounds = layoutBounds(preset());
  const centre = applyFit(fit, bounds.center);
  const distance = Math.hypot(centre[0] - 0, centre[2] - 0);
  assert.ok(Math.abs(distance - DEFAULT_FIT_DISTANCE) < 0.05, `centre is ${distance.toFixed(2)} m away`);
  assert.ok(Math.abs(centre[1] - 1.6) < 0.01, 'and at eye level');
});

test('a sprawling workspace is pulled in rather than left surrounding you', () => {
  /* Eight screens wrapped around, which is what a real saved workspace looks
     like after a while. */
  const sprawl = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    sprawl.push({
      id: `w${index}`,
      position: [Math.sin(angle) * 3.2, 1.5, Math.cos(angle) * 3.2],
      size: [2.2, 1.35],
      scale: [1, 1, 1]
    });
  }
  const fit = fitWorkspaceToView({ screens: sprawl, ...viewer(0) });
  assert.ok(fit.scale < 0.6, `a ring of eight is scaled down, got ${fit.scale.toFixed(2)}`);
});

test('scale is clamped at both ends', () => {
  const tiny = [{ id: 'a', position: [0, 1.5, -0.4], size: [0.1, 0.1], scale: [1, 1, 1] },
    { id: 'b', position: [0.15, 1.5, -0.4], size: [0.1, 0.1], scale: [1, 1, 1] }];
  assert.ok(fitWorkspaceToView({ screens: tiny, ...viewer(0) }).scale <= MAX_FIT_SCALE);

  const huge = [];
  for (let index = 0; index < 6; index += 1) {
    huge.push({ id: `h${index}`, position: [index * 40, 1.5, -2], size: [4, 3], scale: [1, 1, 1] });
  }
  assert.ok(fitWorkspaceToView({ screens: huge, ...viewer(0) }).scale >= MIN_FIT_SCALE);
});

test('a modest workspace is never inflated to fill the envelope', () => {
  /* The fit exists to rescue a layout that has sprawled. Someone who sized a
     panel chose that size, and it has no business overruling them upward. */
  const one = [{ id: 'a', position: [0, 1.5, -2], size: [2.2, 1.35], scale: [1, 1, 1] }];
  assert.equal(fitWorkspaceToView({ screens: one, ...viewer(0) }).scale, 1);

  const two = [
    { id: 'a', position: [-0.6, 1.5, -1.8], size: [1.1, 0.7], scale: [1, 1, 1] },
    { id: 'b', position: [0.6, 1.5, -1.8], size: [1.1, 0.7], scale: [1, 1, 1] }
  ];
  assert.ok(fitWorkspaceToView({ screens: two, ...viewer(0) }).scale <= 1);
});

test('depth counts toward width, so a wrapped layout is not mismeasured', () => {
  const wrapped = [
    { id: 'a', position: [0, 1.5, -3], size: [1, 1], scale: [1, 1, 1] },
    { id: 'b', position: [0, 1.5, 3], size: [1, 1], scale: [1, 1, 1] }
  ];
  assert.ok(layoutBounds(wrapped).width >= 6, 'a layout that wraps front to back is six metres across');
});

test('a workspace with nothing in it produces no fit rather than a NaN one', () => {
  assert.equal(fitWorkspaceToView({ screens: [], ...viewer(0) }), null);
  assert.equal(layoutBounds([]), null);
  assert.equal(layoutBounds(null), null);
});

test('a garbled pose is refused rather than throwing the workspace somewhere', () => {
  assert.equal(fitWorkspaceToView({ screens: preset(), viewerPosition: [0, 1.6, 0], viewerYaw: NaN }), null);
  assert.equal(fitWorkspaceToView({ screens: preset(), viewerPosition: [NaN, 1.6, 0], viewerYaw: 0 }), null);
});

test('screens with broken transforms are skipped, not allowed to poison the bounds', () => {
  const mixed = [...preset(), { id: 'bad', position: [NaN, 0, 0], size: [1, 1], scale: [1, 1, 1] }];
  const bounds = layoutBounds(mixed);
  assert.equal(bounds.count, 5);
  assert.ok(Number.isFinite(bounds.width));
});
