import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { setXrViewpoint } from '../systems/viewpoint.js';
import { sceneRuntime } from '../systems/scene-runtime.js';
import {
  MAX_GRAB_DISTANCE,
  MIN_GRAB_DISTANCE,
  ScreenInteraction
} from './screen-interaction.js';

/* A stand-in viewpoint. The interaction module must not care whether this is a
 * desktop camera or an XR head pose. */
const useViewpointAt = (position, lookAt = new THREE.Vector3(0, 1.5, -2)) => {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld(true);
  sceneRuntime.camera = camera;
  setXrViewpoint(null, false);
  return camera;
};

const screenAt = (position) => {
  const object = new THREE.Object3D();
  object.position.copy(position);
  object.updateMatrixWorld(true);
  return object;
};

const rayThrough = (origin, target) => new THREE.Ray(
  origin.clone(),
  target.clone().sub(origin).normalize()
);

test('a grab tracks the ray without any notion of pixels', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.6, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));

  const session = ScreenInteraction.beginGrab({
    object,
    ray: rayThrough(viewer.position, object.position),
    depthMode: false
  });
  assert.ok(session, 'a grab begins from a ray alone');

  // Aim the ray to the right of where the screen currently is.
  const moved = ScreenInteraction.updateGrab(session, {
    ray: rayThrough(viewer.position, new THREE.Vector3(1.2, 1.5, -1))
  });
  assert.ok(moved, 'the grab produces a position');
  assert.ok(moved.x > object.position.x, 'the screen follows the ray to the right');
});

test('a grab can never push a screen outside the reachable shell', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.6, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  const session = ScreenInteraction.beginGrab({
    object,
    ray: rayThrough(viewer.position, object.position),
    depthMode: false
  });

  // A near-grazing ray previously produced an enormous plane intersection.
  const grazing = new THREE.Ray(viewer.position.clone(), new THREE.Vector3(1, 0, -0.001).normalize());
  const moved = ScreenInteraction.updateGrab(session, { ray: grazing });
  if (moved) {
    const distance = moved.distanceTo(viewer.position);
    assert.ok(
      distance <= MAX_GRAB_DISTANCE + 0.001,
      `a grazing ray must stay within reach, got ${distance}`
    );
    assert.ok(distance >= MIN_GRAB_DISTANCE - 0.001, 'and never inside the viewer');
  }
});

test('rotation is driven by ray azimuth, not screen-space travel', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.6, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  object.rotation.y = 0;

  const startRay = rayThrough(viewer.position, object.position);
  const session = ScreenInteraction.beginRotate({ object, ray: startRay });

  const unmoved = ScreenInteraction.updateRotate(session, { ray: startRay, snapDegrees: 0 });
  assert.ok(Math.abs(unmoved - 0) < 1e-9, 'no ray movement means no rotation');

  const sweptRight = rayThrough(viewer.position, new THREE.Vector3(1.5, 1.5, -1));
  const rotated = ScreenInteraction.updateRotate(session, { ray: sweptRight, snapDegrees: 0 });
  assert.ok(Math.abs(rotated) > 0.05, 'sweeping the ray sideways rotates the screen');

  const sweptLeft = rayThrough(viewer.position, new THREE.Vector3(-1.5, 1.5, -1));
  const rotatedOther = ScreenInteraction.updateRotate(session, { ray: sweptLeft, snapDegrees: 0 });
  assert.ok(
    Math.sign(rotated) !== Math.sign(rotatedOther),
    'opposite sweeps rotate in opposite directions'
  );
});

test('rotation snapping quantizes the result', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.6, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  const session = ScreenInteraction.beginRotate({
    object,
    ray: rayThrough(viewer.position, object.position)
  });
  const snapped = ScreenInteraction.updateRotate(session, {
    ray: rayThrough(viewer.position, new THREE.Vector3(1.5, 1.5, -1)),
    snapDegrees: 15
  });
  const step = 15 * (Math.PI / 180);
  assert.ok(
    Math.abs(snapped / step - Math.round(snapped / step)) < 1e-9,
    'a snapped yaw lands on a multiple of the snap angle'
  );
});

test('scale is the ratio of ray distances from the screen centre', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.5, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  object.scale.set(1, 1, 1);

  const session = ScreenInteraction.beginScale({
    object,
    ray: rayThrough(viewer.position, new THREE.Vector3(0.5, 1.5, -1))
  });
  assert.ok(session, 'a scale gesture begins from a ray alone');

  const grown = ScreenInteraction.updateScale(session, {
    ray: rayThrough(viewer.position, new THREE.Vector3(1.0, 1.5, -1))
  });
  assert.ok(grown && grown.x > 1, 'pulling away from the centre grows the screen');

  const shrunk = ScreenInteraction.updateScale(session, {
    ray: rayThrough(viewer.position, new THREE.Vector3(0.25, 1.5, -1))
  });
  assert.ok(shrunk && shrunk.x < 1, 'moving toward the centre shrinks it');
});

test('scale stays inside its limits however far the ray travels', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.5, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  const session = ScreenInteraction.beginScale({
    object,
    ray: rayThrough(viewer.position, new THREE.Vector3(0.05, 1.5, -1))
  });
  const huge = ScreenInteraction.updateScale(session, {
    ray: rayThrough(viewer.position, new THREE.Vector3(40, 1.5, -1))
  });
  assert.ok(huge.x <= 3.0001, `scale is clamped, got ${huge.x}`);
});

test('two-handed pinch scale is the same action from a different input', () => {
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));
  const session = ScreenInteraction.beginPinchScale({
    object,
    firstPoint: new THREE.Vector3(-0.2, 1.5, -1),
    secondPoint: new THREE.Vector3(0.2, 1.5, -1)
  });
  assert.ok(session, 'a pinch begins from two hand positions');

  const spread = ScreenInteraction.updatePinchScale(session, {
    firstPoint: new THREE.Vector3(-0.4, 1.5, -1),
    secondPoint: new THREE.Vector3(0.4, 1.5, -1)
  });
  assert.ok(Math.abs(spread.x - 2) < 1e-6, 'doubling the separation doubles the scale');
});

test('depth is a scalar push/pull axis that any device can supply', () => {
  const viewer = useViewpointAt(new THREE.Vector3(0, 1.6, 3));
  const object = screenAt(new THREE.Vector3(0, 1.5, -1));

  const session = ScreenInteraction.beginGrab({
    object,
    ray: rayThrough(viewer.position, object.position),
    depthMode: true
  });
  assert.ok(session, 'a depth grab begins without a ray intersection');

  const pushed = ScreenInteraction.updateGrab(session, { ray: null, pushPull: 1.5 });
  const pulled = ScreenInteraction.updateGrab(session, { ray: null, pushPull: -3 });
  assert.ok(pushed && pulled, 'depth updates need no ray at all');
  assert.ok(
    pushed.distanceTo(viewer.position) > pulled.distanceTo(viewer.position),
    'pushing moves the screen further away than pulling'
  );
  assert.ok(
    pulled.distanceTo(viewer.position) >= MIN_GRAB_DISTANCE - 0.001,
    'pulling cannot drag a screen into the viewer'
  );
});
