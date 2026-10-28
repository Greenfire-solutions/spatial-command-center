import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LAYER_BUDGET,
  MESH_REASONS,
  environmentAllowed,
  needsTransparentBaseLayer,
  planLayers,
  reduceBudget
} from './layer-policy.js';

const browser = (id, position, extra = {}) => ({
  id,
  position,
  source: { type: 'chromium' },
  hasContent: true,
  ...extra
});

const tiersFor = (entries) => new Map(Object.entries(entries));

const base = {
  presenting: true,
  layersSupported: true,
  viewerPosition: [0, 1.6, 0]
};

test('nothing becomes a layer outside a session', () => {
  const plan = planLayers({
    ...base,
    presenting: false,
    screens: [browser('a', [0, 1.5, -2])],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.deepEqual(plan.layers, []);
  assert.equal(plan.meshes[0].reason, MESH_REASONS.NO_SESSION);
});

test('a runtime without layer support keeps every screen a mesh', () => {
  const plan = planLayers({
    ...base,
    layersSupported: false,
    screens: [browser('a', [0, 1.5, -2])],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.equal(plan.layers.length, 0);
  assert.equal(plan.meshes[0].reason, MESH_REASONS.LAYERS_UNSUPPORTED);
});

test('a focused browser screen becomes a layer', () => {
  const plan = planLayers({
    ...base,
    screens: [browser('a', [0, 1.5, -2])],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.deepEqual(plan.order, ['a']);
  assert.equal(plan.meshes.length, 0);
});

test('layers are submitted back to front, so a near screen occludes a far one', () => {
  const plan = planLayers({
    ...base,
    screens: [
      browser('near', [0, 1.6, -1]),
      browser('far', [0, 1.6, -6]),
      browser('mid', [0, 1.6, -3])
    ],
    tiers: tiersFor({ near: 'focused', far: 'near', mid: 'near' })
  });
  assert.deepEqual(
    plan.order,
    ['far', 'mid', 'near'],
    'layers have no depth test, so submission order is the occlusion'
  );
});

test('far and hidden screens stay meshes, because that is where the budget is not worth spending', () => {
  const plan = planLayers({
    ...base,
    screens: [browser('a', [0, 1.6, -2]), browser('b', [0, 1.6, -9]), browser('c', [0, 1.6, -30])],
    tiers: tiersFor({ a: 'focused', b: 'far', c: 'hidden' })
  });
  assert.deepEqual(plan.order, ['a']);
  const reasons = Object.fromEntries(plan.meshes.map((mesh) => [mesh.id, mesh.reason]));
  assert.equal(reasons.b, MESH_REASONS.TIER);
  assert.equal(reasons.c, MESH_REASONS.TIER);
});

test('the budget caps the count, and the nearest screens win it', () => {
  const screens = [
    browser('d4', [0, 1.6, -8]),
    browser('d1', [0, 1.6, -1]),
    browser('d3', [0, 1.6, -6]),
    browser('d2', [0, 1.6, -3])
  ];
  const plan = planLayers({
    ...base,
    budget: 2,
    screens,
    tiers: tiersFor({ d1: 'focused', d2: 'near', d3: 'near', d4: 'near' })
  });

  assert.equal(plan.layers.length, 2);
  assert.deepEqual(plan.order, ['d2', 'd1'], 'the two nearest, ordered far to near');
  const dropped = plan.meshes.filter((mesh) => mesh.reason === MESH_REASONS.BUDGET).map((m) => m.id);
  assert.deepEqual(dropped.sort(), ['d3', 'd4']);
});

test('a budget of zero is a valid state, not a crash', () => {
  const plan = planLayers({
    ...base,
    budget: 0,
    screens: [browser('a', [0, 1.6, -2])],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.deepEqual(plan.layers, []);
  assert.equal(plan.meshes[0].reason, MESH_REASONS.BUDGET);
});

test('a surface that has never painted is not promoted to a transparent hole', () => {
  const plan = planLayers({
    ...base,
    screens: [browser('a', [0, 1.6, -2], { hasContent: false })],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.equal(plan.layers.length, 0);
  assert.equal(plan.meshes[0].reason, MESH_REASONS.NO_CONTENT);
});

test('a non-browser screen is not a layer candidate', () => {
  const plan = planLayers({
    ...base,
    screens: [{ id: 'a', position: [0, 1.6, -2], source: { type: 'mock' } }],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.equal(plan.meshes[0].reason, MESH_REASONS.NOT_A_BROWSER);
});

test('every screen lands in exactly one list', () => {
  const screens = [
    browser('a', [0, 1.6, -1]),
    browser('b', [0, 1.6, -2]),
    browser('c', [0, 1.6, -20]),
    { id: 'd', position: [0, 1.6, -2], source: { type: 'iframe' } }
  ];
  const plan = planLayers({
    ...base,
    budget: 1,
    screens,
    tiers: tiersFor({ a: 'focused', b: 'near', c: 'hidden', d: 'focused' })
  });

  const accounted = [...plan.order, ...plan.meshes.map((mesh) => mesh.id)].sort();
  assert.deepEqual(accounted, ['a', 'b', 'c', 'd']);
});

test('turning layers off is distinguishable from the runtime lacking them', () => {
  const plan = planLayers({
    ...base,
    enabled: false,
    screens: [browser('a', [0, 1.6, -2])],
    tiers: tiersFor({ a: 'focused' })
  });
  assert.equal(plan.meshes[0].reason, MESH_REASONS.LAYERS_DISABLED);
});

test('a refused budget backs off by one and never below zero', () => {
  assert.equal(reduceBudget(DEFAULT_LAYER_BUDGET), DEFAULT_LAYER_BUDGET - 1);
  assert.equal(reduceBudget(1), 0);
  assert.equal(reduceBudget(0), 0);
});

/* ---- the constraints the base layer imposes ---- */

test('a transparent base layer is required wherever a layer might be drawn', () => {
  assert.equal(needsTransparentBaseLayer({ layersEnabled: true }), true);
  assert.equal(needsTransparentBaseLayer({ layersEnabled: false, probe: true }), true);
  assert.equal(needsTransparentBaseLayer({ layersEnabled: false, probe: false }), false);
});

test('the environment may not draw while layers are live', () => {
  assert.equal(
    environmentAllowed({ presenting: true, layersActive: true }),
    false,
    'the base layer composites on top, so a room would hide every layer'
  );
  assert.equal(environmentAllowed({ presenting: true, layersActive: false }), true);
  assert.equal(environmentAllowed({ presenting: false, layersActive: true }), true, 'desktop is unaffected');
});
