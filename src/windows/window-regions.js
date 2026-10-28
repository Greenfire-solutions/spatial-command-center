/*
 * Where a window can be grabbed, as geometry rather than as a mode.
 *
 * THE BUG THIS FILE EXISTS TO FIX.
 *
 * A screen used to be one mesh with the page drawn across almost all of it.
 * The content surface was `width - 0.01` wide, so the only part of the panel
 * that was not page was a strip 5 mm across. Five millimetres at a two metre
 * viewing distance subtends about 0.14 degrees. Published measurement of
 * spatial pointing error — the Heisenberg Effect study, n=16 — puts the error
 * introduced by the act of pressing the trigger well above that, and finds that
 * 30% of all selection errors come from the press itself rather than from aim.
 * So the grab target was smaller than the noise floor of the input device. It
 * was not hard to grab a window by accident of tuning; it was unhittable by
 * construction, and no amount of tuning was ever going to fix it.
 *
 * The second half of the same bug: manipulation was gated on the workspace
 * being in `arrange` mode, and entering XR forces `browse`. So in a headset the
 * only way to move a window was a controller grip, which is why the grip is the
 * only thing that ever worked there.
 *
 * THE RULE THIS FILE IMPLEMENTS.
 *
 *   Manipulation and content never share a surface. The content region is
 *   always live. The frame is always the handle. Geometry does the
 *   disambiguation, in every mode, for every input device.
 *
 * That is what Horizon OS and visionOS both do — a panel is moved by grabbing
 * its edge or its control bar, and "panels do not contain any UI elements; they
 * are solely for displaying content" — so it is also what a user's hands
 * already expect.
 *
 * The visible bezel is modest. The collider is not: it extends outward past the
 * panel edge, where there is nothing to compete with, so the hit target is
 * roughly twice what the design shows. Elegant to look at, forgiving to hit.
 *
 * Pure geometry. No React, no three.js, no store — so every number in here is
 * checked by a test rather than by eye in a headset.
 */

/* The visible frame around the page. Sized from Meta's guidance that a panel is
 * grabbed by its edge, and large enough to be a real target rather than a hint
 * of one. */
export const BEZEL_WORLD = 0.055;

/* How far the invisible collider reaches beyond the panel's outer edge. This is
 * free target area: there is nothing out there to click, so overshoot costs
 * nothing and buys a great deal of forgiveness. */
export const GRAB_OVERSHOOT = 0.045;

/* Corner boxes for scaling. Deliberately larger than the bezel is thick,
 * because a corner is a two-axis gesture and the least precise thing anyone
 * asks a controller to do. */
export const CORNER_GRAB = 0.13;

/* Colliders sit in front of the content surface so nothing can steal from them.
 * The content mesh is at z = 0.035; the panel body is 0.055 deep. */
export const COLLIDER_Z = 0.062;

/* The smallest a content area is allowed to become. A panel dragged very small
 * should lose bezel rather than lose page. */
const MIN_CONTENT = 0.18;

export const REGION = Object.freeze({
  CONTENT: 'content',
  HEADER: 'header',
  BEZEL_LEFT: 'bezel-left',
  BEZEL_RIGHT: 'bezel-right',
  BEZEL_BOTTOM: 'bezel-bottom',
  CORNER_BL: 'corner-bl',
  CORNER_BR: 'corner-br'
});

/* What each region does when it is grabbed. Corners scale, everything else
 * moves. Nothing here rotates: wrist-twist and the dedicated handle cover that,
 * and a rotation you can trigger by grabbing an edge is a rotation you will
 * trigger by accident. */
export const REGION_GESTURE = Object.freeze({
  [REGION.HEADER]: 'move',
  [REGION.BEZEL_LEFT]: 'move',
  [REGION.BEZEL_RIGHT]: 'move',
  [REGION.BEZEL_BOTTOM]: 'move',
  [REGION.CORNER_BL]: 'scale',
  [REGION.CORNER_BR]: 'scale'
});

const rect = (id, x, y, w, h) => Object.freeze({ id, x, y, width: w, height: h });

/**
 * Lay out one window's regions in panel-local metres, origin at the centre.
 *
 * @param {object} input
 * @param {number} input.width        panel width
 * @param {number} input.height       panel height
 * @param {number} input.headerHeight the control-bar strip along the top
 * @returns {{content: object, grabs: object[]}}
 */
export const computeWindowRegions = ({
  width,
  height,
  headerHeight = 0,
  bezel = BEZEL_WORLD,
  overshoot = GRAB_OVERSHOOT,
  corner = CORNER_GRAB
}) => {
  const halfW = width / 2;
  const halfH = height / 2;

  /* Shrink the bezel rather than the page when a panel is small, so a tiny
   * window is still mostly window. */
  const usableW = Math.max(0, width - MIN_CONTENT);
  const usableH = Math.max(0, height - headerHeight - MIN_CONTENT);
  const side = Math.max(0, Math.min(bezel, usableW / 2));
  const bottom = Math.max(0, Math.min(bezel, usableH));

  const contentWidth = Math.max(MIN_CONTENT, width - side * 2);
  const contentHeight = Math.max(MIN_CONTENT, height - headerHeight - bottom);
  /* The content sits below the header and above the bottom bezel, so its centre
   * is offset from the panel's by half the difference between the two. */
  const contentY = (bottom - headerHeight) / 2;

  const contentTop = contentY + contentHeight / 2;
  const contentBottom = contentY - contentHeight / 2;
  const contentLeft = -contentWidth / 2;
  const contentRight = contentWidth / 2;

  const content = rect(REGION.CONTENT, 0, contentY, contentWidth, contentHeight);

  /* Every collider reaches `overshoot` past the panel's outer edge. Inward it
   * stops exactly at the content, so it can never take a click from the page. */
  const outerTop = halfH + overshoot;
  const outerBottom = -halfH - overshoot;
  const outerLeft = -halfW - overshoot;
  const outerRight = halfW + overshoot;

  const strip = (id, left, right, low, high) => rect(
    id,
    (left + right) / 2,
    (low + high) / 2,
    Math.max(0, right - left),
    Math.max(0, high - low)
  );

  const grabs = [
    /* The control bar strip, full width, from the top of the content to beyond
     * the top edge. The largest and most obvious handle on the window, and the
     * one a user reaches for first because every desktop has taught them to. */
    strip(REGION.HEADER, outerLeft, outerRight, contentTop, outerTop),
    strip(REGION.BEZEL_LEFT, outerLeft, contentLeft, contentBottom, contentTop),
    strip(REGION.BEZEL_RIGHT, contentRight, outerRight, contentBottom, contentTop),
    strip(REGION.BEZEL_BOTTOM, outerLeft, outerRight, outerBottom, contentBottom)
  ];

  /*
   * Scale corners are the bottom two only, and they grow OUTWARD from the
   * content corner rather than being centred on the panel corner.
   *
   * Centring them on the panel corner is the obvious thing and it is wrong
   * twice over. It puts a scale target on top of the page, so a click near the
   * corner of a web page resizes the window — which is the precise bug this
   * whole change exists to remove, reintroduced in a different place. And at
   * the top it puts a scale target under the control bar, where it competes
   * with the close button.
   *
   * So: bottom corners scale, the top strip moves, and neither ever reaches
   * over the page. Anchoring outward also means a corner is never clipped by a
   * small panel — it simply hangs further into the empty space around it.
   */
  const corners = [
    [REGION.CORNER_BL, contentLeft - corner, contentLeft, contentBottom - corner, contentBottom],
    [REGION.CORNER_BR, contentRight, contentRight + corner, contentBottom - corner, contentBottom]
  ].map(([id, left, right, low, high]) => strip(id, left, right, low, high));

  return Object.freeze({ content, grabs: Object.freeze([...grabs, ...corners]) });
};

/** Does a panel-local point fall inside a region rect? */
export const hitsRegion = (region, x, y) => (
  Math.abs(x - region.x) <= region.width / 2 && Math.abs(y - region.y) <= region.height / 2
);

/**
 * The region under a panel-local point, corners first.
 *
 * Used by tests and by any input path that has a UV rather than a mesh hit.
 * Returns null for the content area, which is not a grab surface — the absence
 * is the answer, and it is what keeps a click on the page a click on the page.
 */
export const regionAt = (regions, x, y) => {
  const corners = regions.grabs.filter((region) => region.id.startsWith('corner'));
  for (const region of corners) if (hitsRegion(region, x, y)) return region;
  for (const region of regions.grabs) {
    if (region.id.startsWith('corner')) continue;
    if (hitsRegion(region, x, y)) return region;
  }
  return null;
};

/**
 * The smallest angular size of a window's grab surface, in degrees, at a given
 * viewing distance.
 *
 * Exists so a test can assert the target is hittable rather than a person
 * discovering in a headset that it is not. Roughly one degree is the floor for
 * comfortable ray pointing; the 5 mm margin this replaced was 0.14 degrees.
 */
export const grabAngularSizeDeg = (regions, distanceMetres) => {
  let smallest = Infinity;
  for (const region of regions.grabs) {
    smallest = Math.min(smallest, region.width, region.height);
  }
  return (2 * Math.atan(smallest / 2 / distanceMetres) * 180) / Math.PI;
};
