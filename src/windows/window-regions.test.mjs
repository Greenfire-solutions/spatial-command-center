import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEZEL_WORLD,
  GRAB_OVERSHOOT,
  REGION,
  REGION_GESTURE,
  computeWindowRegions,
  grabAngularSizeDeg,
  hitsRegion,
  regionAt
} from './window-regions.js';

/* The default panel, and the header strip the browser bar occupies. */
const HEADER = 42 / 400;
const panel = (width = 2.2, height = 1.35) => computeWindowRegions({ width, height, headerHeight: HEADER });

test('the grab surface is a target a person can actually hit', () => {
  /* The regression this is here to prevent. The previous geometry left a 5 mm
     margin around the page — 0.14 degrees at two metres, below the measured
     error that the act of pressing a trigger introduces. */
  const regions = panel();
  const previousMargin = (2 * Math.atan(0.005 / 2 / 2) * 180) / Math.PI;
  assert.ok(previousMargin < 0.2, `sanity: the old margin was ${previousMargin.toFixed(2)} deg`);

  const now = grabAngularSizeDeg(regions, 2);
  assert.ok(now > 1.5, `grab surface is ${now.toFixed(2)} deg at 2 m, needs to clear ~1 deg`);
  assert.ok(now > previousMargin * 10, 'and is an order of magnitude better than what it replaces');
});

test('the collider reaches past the panel edge, where nothing competes for it', () => {
  const regions = panel();
  const left = regions.grabs.find((region) => region.id === REGION.BEZEL_LEFT);
  assert.ok(left.x - left.width / 2 < -2.2 / 2, 'extends beyond the left edge');
  assert.ok(left.width > BEZEL_WORLD + GRAB_OVERSHOOT - 1e-9, 'so the target is wider than the visible bezel');
});

test('no grab region ever overlaps the content area', () => {
  /* The governing rule: manipulation and content never share a surface. If this
     fails, a click on the page can move the window, which is the exact
     complaint this whole change exists to answer. */
  for (const [w, h] of [[2.2, 1.35], [1.0, 0.6], [4.0, 2.4], [0.5, 0.4]]) {
    const regions = computeWindowRegions({ width: w, height: h, headerHeight: HEADER });
    const { content } = regions;
    const samples = 40;
    for (let ix = 0; ix <= samples; ix += 1) {
      for (let iy = 0; iy <= samples; iy += 1) {
        /* Strictly inside, so touching edges are not counted as overlap. */
        const x = content.x + (ix / samples - 0.5) * content.width * 0.98;
        const y = content.y + (iy / samples - 0.5) * content.height * 0.98;
        const region = regionAt(regions, x, y);
        assert.equal(region, null, `${w}x${h}: point ${x.toFixed(3)},${y.toFixed(3)} hit ${region?.id}`);
      }
    }
  }
});

test('the content area is still most of the window', () => {
  const regions = panel();
  const area = regions.content.width * regions.content.height;
  assert.ok(area / (2.2 * 1.35) > 0.75, 'a bezel worth grabbing has not eaten the page');
});

test('the header strip is the biggest handle, because it is the one people reach for', () => {
  const regions = panel();
  const header = regions.grabs.find((region) => region.id === REGION.HEADER);
  assert.ok(header.width > 2.2, 'full width, and then some');
  assert.ok(header.height >= HEADER, 'at least the control bar strip');
  assert.equal(REGION_GESTURE[REGION.HEADER], 'move');
});

test('corners scale, and sit outside the page rather than over it', () => {
  const regions = panel();
  const corner = regions.grabs.find((region) => region.id === REGION.CORNER_BR);
  const { content } = regions;

  /* Just outside the bottom-right of the page is a scale target. */
  const x = content.x + content.width / 2 + 0.02;
  const y = content.y - content.height / 2 - 0.02;
  assert.ok(hitsRegion(corner, x, y));
  assert.equal(regionAt(regions, x, y).id, REGION.CORNER_BR);
  assert.equal(REGION_GESTURE[REGION.CORNER_BR], 'scale');

  /* Just inside it is the page, and stays the page. */
  assert.equal(regionAt(regions, content.x + content.width / 2 - 0.02, content.y - content.height / 2 + 0.02), null);
});

test('no scale target hides under the control bar', () => {
  /* The top strip is the move handle and carries the close button. A resize
     corner up there competes with it, and loses the user a window. */
  const regions = panel();
  for (const region of regions.grabs) {
    if (!region.id.startsWith('corner')) continue;
    assert.ok(region.y < 0, `${region.id} is in the lower half`);
  }
});

test('every grab region maps to a gesture, and content maps to none', () => {
  const regions = panel();
  for (const region of regions.grabs) {
    assert.ok(REGION_GESTURE[region.id], `${region.id} has no gesture`);
  }
  assert.equal(REGION_GESTURE[REGION.CONTENT], undefined, 'content is not a grab surface');
});

test('a very small panel keeps its page and gives up its bezel', () => {
  const regions = computeWindowRegions({ width: 0.34, height: 0.34, headerHeight: HEADER });
  assert.ok(regions.content.width >= 0.18, 'the page survives');
  assert.ok(regions.content.height >= 0.18);
  /* The colliders still exist, because a small window is the one you most need
     to be able to grab. */
  assert.ok(regions.grabs.every((region) => region.width > 0 && region.height > 0));
});

test('regions are frozen, so nothing can quietly resize a hit target at runtime', () => {
  const regions = panel();
  assert.throws(() => { regions.content.width = 99; }, TypeError);
  assert.throws(() => { regions.grabs.push({}); }, TypeError);
});
