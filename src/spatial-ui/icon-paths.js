/*
 * One icon vocabulary, two renderers.
 *
 * These primitives are drawn as SVG in the DOM overlay and rasterized to a
 * canvas texture for in-scene spatial controls. Keeping a single definition
 * means a control looks identical whether it is being read on a monitor or
 * through a headset, and an icon can never drift between the two surfaces.
 *
 * Coordinates use the same 24x24 viewBox the DOM icons already assumed.
 */

export const ICON_VIEWBOX = 24;

const path = (d) => ({ kind: 'path', d });
const circle = (cx, cy, r, filled = false) => ({ kind: 'circle', cx, cy, r, filled });
const rect = (x, y, width, height, radius) => ({ kind: 'rect', x, y, width, height, radius });

export const ICON_PATHS = Object.freeze({
  move: [
    path('M12 2v20M2 12h20'),
    path('m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4')
  ],
  'rotate-left': [path('M3 12a9 9 0 1 0 3-6.7'), path('M3 3v6h6')],
  'rotate-right': [path('M21 12a9 9 0 1 1-3-6.7'), path('M21 3v6h-6')],
  face: [circle(12, 12, 3), path('M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z')],
  scale: [
    path('M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5'),
    path('m3 8 5-5m8 0 5 5M3 16l5 5m8 0 5-5')
  ],
  lock: [rect(5, 10, 14, 11, 2), path('M8 10V7a4 4 0 0 1 8 0v3')],
  unlock: [rect(5, 10, 14, 11, 2), path('M8 10V7a4 4 0 0 1 7.5-2')],
  copy: [rect(8, 8, 12, 12, 2), path('M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3')],
  close: [path('m6 6 12 12M18 6 6 18')],
  more: [circle(5, 12, 1, true), circle(12, 12, 1, true), circle(19, 12, 1, true)],
  focus: [path('M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5'), circle(12, 12, 3)],
  reset: [path('M3 12a9 9 0 1 0 3-6.7'), path('M3 3v6h6')],
  back: [path('m15 18-6-6 6-6')],
  forward: [path('m9 18 6-6-6-6')],
  reload: [path('M20 11a8 8 0 1 0-2.35 5.65'), path('M20 4v7h-7')],
  external: [
    path('M14 4h6v6M20 4l-9 9'),
    path('M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6')
  ],
  globe: [circle(12, 12, 9), path('M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18')],
  plus: [path('M12 5v14M5 12h14')],
  save: [path('M5 3h12l4 4v14H3V3h2Z'), path('M7 3v6h10V3M8 21v-7h8v7')],
  arc: [
    path('M3 17c4-8 14-8 18 0'),
    circle(5, 14, 1.5),
    circle(12, 9, 1.5),
    circle(19, 14, 1.5)
  ],
  info: [circle(12, 12, 9), path('M12 11v6M12 7h.01')],
  'depth-in': [path('M12 3v14M7 12l5 5 5-5'), path('M5 21h14')],
  'depth-out': [path('M12 21V7M7 12l5-5 5 5'), path('M5 3h14')],
  fallback: [circle(12, 12, 8)]
});

export const iconPrimitives = (name) => ICON_PATHS[name] || ICON_PATHS.fallback;
