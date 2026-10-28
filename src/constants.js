import * as THREE from 'three';

export const STORAGE_KEY = 'spatial-command-center-layout-v1';

/*
 * Bump WORKSPACE_VERSION whenever the persisted shape changes, and add the
 * matching step to MIGRATIONS in store/persistence.js. Saved workspaces are
 * migrated forward; anything that cannot be migrated is archived rather than
 * discarded. See store/persistence.js for the contract.
 */
export const WORKSPACE_VERSION = 5;

export const SOURCE_TYPES = new Set([
  'mock',
  'iframe',
  'chromium',
  'chrome-tab',
  'desktop-window',
  'stream'
]);

export const ROTATION_ORDER = 'YXZ';
export const DEG = Math.PI / 180;
export const Y_AXIS = new THREE.Vector3(0, 1, 0);

/* World-space height of the DOM browser header above a screen's content area. */
export const BROWSER_HEADER_WORLD_HEIGHT = 42 / 400;

export const SCREEN_SIZE_LIMITS = Object.freeze({
  minWidth: 0.6,
  maxWidth: 5,
  minHeight: 0.4,
  maxHeight: 3.5,
  minScale: 0.35,
  maxScale: 3
});

export const DEFAULT_SCREEN_SIZE = Object.freeze([2.2, 1.35]);

/*
 * Where a screen points when nothing else says.
 *
 * Every screen carries a real browser, so every screen needs a real address.
 * The panel `type` survives as the thing that picks an icon and a sensible
 * starting page; it no longer decides whether there is anything behind the
 * glass. Shared by the presets and by the migration that repairs workspaces
 * saved before that was true.
 */
export const DEFAULT_URL_FOR_TYPE = Object.freeze({
  browser: 'https://www.google.com',
  code: 'https://github.com',
  docs: 'https://developer.mozilla.org/en-US/',
  terminal: 'https://news.ycombinator.com',
  chat: 'https://claude.ai'
});

export const defaultUrlForType = (type) =>
  DEFAULT_URL_FOR_TYPE[type] || DEFAULT_URL_FOR_TYPE.browser;
