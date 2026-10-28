import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { sceneRuntime } from './scene-runtime.js';
import { setXrViewpoint } from './viewpoint.js';
import {
  BrowserQualityController,
  QUALITY_TIERS,
  TIER_SETTINGS,
  evaluateQuality
} from './browser-quality.js';

const makeCamera = () => {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.6, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  sceneRuntime.camera = camera;
  setXrViewpoint(null, false);
  return camera;
};

const chromiumScreen = (id, position) => {
  const object = new THREE.Object3D();
  object.position.set(...position);
  object.updateMatrixWorld(true);
  sceneRuntime.screenObjects.set(id, object);
  return {
    id,
    size: [2.2, 1.35],
    scale: [1, 1, 1],
    source: { type: 'chromium', sourceId: `browser-${id}` }
  };
};

test('attention decides quality, not a global setting', () => {
  makeCamera();
  sceneRuntime.screenObjects.clear();

  const screens = [
    chromiumScreen('focused', [0, 1.6, -2]),
    chromiumScreen('near', [1.2, 1.6, -3]),
    chromiumScreen('far', [2, 1.6, -8]),
    chromiumScreen('behind', [0, 1.6, 6])
  ];

  const decisions = evaluateQuality({
    screens,
    screenObjects: sceneRuntime.screenObjects,
    focusedScreenId: 'focused'
  });

  assert.equal(decisions.get('browser-focused').tier, QUALITY_TIERS.FOCUSED);
  assert.equal(decisions.get('browser-near').tier, QUALITY_TIERS.NEAR);
  assert.equal(decisions.get('browser-far').tier, QUALITY_TIERS.FAR);
  assert.equal(
    decisions.get('browser-behind').tier,
    QUALITY_TIERS.HIDDEN,
    'a screen behind the viewer stops painting'
  );
});

test('the focused screen always runs at full rate, wherever it is', () => {
  makeCamera();
  sceneRuntime.screenObjects.clear();
  const screens = [chromiumScreen('a', [0, 1.6, 30])];

  const decisions = evaluateQuality({
    screens,
    screenObjects: sceneRuntime.screenObjects,
    focusedScreenId: 'a'
  });
  assert.equal(decisions.get('browser-a').tier, QUALITY_TIERS.FOCUSED);
  assert.equal(TIER_SETTINGS[QUALITY_TIERS.FOCUSED].frameRate, 30);
  assert.equal(TIER_SETTINGS[QUALITY_TIERS.FOCUSED].painting, true);
});

test('non-chromium screens are never asked to change quality', () => {
  makeCamera();
  sceneRuntime.screenObjects.clear();
  const object = new THREE.Object3D();
  sceneRuntime.screenObjects.set('mock', object);
  const decisions = evaluateQuality({
    screens: [{ id: 'mock', size: [2, 1], scale: [1, 1, 1], source: { type: 'mock', sourceId: '' } }],
    screenObjects: sceneRuntime.screenObjects,
    focusedScreenId: null
  });
  assert.equal(decisions.size, 0);
});

test('quality requests are only sent when a tier actually changes', () => {
  const calls = [];
  const provider = {
    available: true,
    setQuality: (sourceId, options) => {
      calls.push([sourceId, options.frameRate, options.painting]);
      return Promise.resolve(null);
    }
  };
  const controller = new BrowserQualityController({ provider });

  const decisions = new Map([['browser-a', { tier: QUALITY_TIERS.NEAR }]]);
  assert.equal(controller.apply(decisions), 1, 'the first decision is sent');
  assert.equal(controller.apply(decisions), 0, 'an unchanged tier sends nothing');
  assert.equal(controller.apply(decisions), 0);
  assert.equal(calls.length, 1, 'exactly one request reached the provider');

  const changed = new Map([['browser-a', { tier: QUALITY_TIERS.HIDDEN }]]);
  assert.equal(controller.apply(changed), 1, 'a changed tier is sent');
  assert.deepEqual(calls[1], ['browser-a', 2, false], 'a hidden screen stops painting');
});

test('a vanished source is forgotten so a recreated id starts clean', () => {
  const provider = { available: true, setQuality: () => Promise.resolve(null) };
  const controller = new BrowserQualityController({ provider });

  controller.apply(new Map([['browser-a', { tier: QUALITY_TIERS.NEAR }]]));
  assert.equal(controller.appliedTier('browser-a'), QUALITY_TIERS.NEAR);

  controller.apply(new Map());
  assert.equal(controller.appliedTier('browser-a'), null, 'the stale entry is dropped');

  assert.equal(
    controller.apply(new Map([['browser-a', { tier: QUALITY_TIERS.NEAR }]])),
    1,
    'a recreated source is configured again rather than assumed'
  );
});

test('an unavailable provider is a no-op rather than an error', () => {
  const controller = new BrowserQualityController({ provider: { available: false, setQuality: () => {} } });
  assert.equal(controller.apply(new Map([['browser-a', { tier: QUALITY_TIERS.FAR }]])), 0);
});
