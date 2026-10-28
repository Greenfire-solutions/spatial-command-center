import {
  BROWSER_HEADER_WORLD_HEIGHT,
  DEFAULT_SCREEN_SIZE,
  ROTATION_ORDER,
  SCREEN_SIZE_LIMITS,
  SOURCE_TYPES
} from '../constants.js';
import { clamp, makeId, normalizeRotation, normalizeVec3 } from '../utils/math.js';
import { normalizeBrowserInput } from '../url-normalization.js';

/*
 * A screen's spatial transform and its content source are deliberately separate
 * concerns. The screen owns position/rotation/scale/size; the source owns type,
 * URL, source id, and browser viewport. Nothing in this module may make the
 * source depend on the transform, because that coupling is what would cause a
 * Chromium webContents to be recreated when a monitor merely moves.
 *
 * @typedef {Object} ScreenSource
 * @property {string} id
 * @property {'mock'|'iframe'|'chromium'|'chrome-tab'|'desktop-window'|'stream'} type
 * @property {string} title
 * @property {string=} url
 * @property {string=} favicon
 * @property {string=} sourceId
 */

export const sourceFromScreen = (screen) => {
  const legacyUrl = normalizeBrowserInput(screen.url || (screen.source && screen.source.url) || '').url;
  const legacyType = legacyUrl || screen.type === 'browser' ? 'iframe' : 'mock';
  const candidate = screen.source || {};
  const sourceType = SOURCE_TYPES.has(candidate.type) ? candidate.type : legacyType;
  const hasExplicitViewport = typeof candidate.browserViewportExplicit === 'boolean'
    ? candidate.browserViewportExplicit
    : sourceType === 'chromium' && Number.isFinite(Number(candidate.browserWidth)) && Number.isFinite(Number(candidate.browserHeight));
  return {
    id: candidate.id || 'source-' + screen.id,
    type: sourceType,
    title: candidate.title || screen.title || 'Untitled Screen',
    url: legacyUrl,
    favicon: candidate.favicon || '',
    sourceId: candidate.sourceId || (sourceType === 'chromium' || sourceType === 'iframe' ? 'browser-' + screen.id : ''),
    browserWidth: clamp(Number(candidate.browserWidth) || 1280, 640, 2560),
    browserHeight: clamp(Number(candidate.browserHeight) || 800, 400, 1600),
    browserViewportExplicit: hasExplicitViewport
  };
};

export const normalizeScreen = (rawScreen) => {
  const raw = rawScreen || {};
  const id = raw.id || makeId('screen');
  const size = Array.isArray(raw.size) && raw.size.length >= 2
    ? [
        clamp(Number(raw.size[0]) || DEFAULT_SCREEN_SIZE[0], SCREEN_SIZE_LIMITS.minWidth, SCREEN_SIZE_LIMITS.maxWidth),
        clamp(Number(raw.size[1]) || DEFAULT_SCREEN_SIZE[1], SCREEN_SIZE_LIMITS.minHeight, SCREEN_SIZE_LIMITS.maxHeight)
      ]
    : DEFAULT_SCREEN_SIZE.slice();
  const normalized = {
    ...raw,
    id,
    title: raw.title || 'New Browser',
    /* The name its owner gave it, if any. Distinct from `title`, which follows
     * the page: renaming a window must survive navigating it. */
    name: typeof raw.name === 'string' ? raw.name : '',
    type: raw.type || 'browser',
    position: normalizeVec3(raw.position, [0, 1.5, -2]),
    rotation: normalizeRotation(raw.rotation),
    scale: normalizeVec3(raw.scale, [1, 1, 1])
      .map((value) => clamp(value, SCREEN_SIZE_LIMITS.minScale, SCREEN_SIZE_LIMITS.maxScale)),
    size,
    url: normalizeBrowserInput(raw.url || (raw.source && raw.source.url) || '').url,
    locked: Boolean(raw.locked),
    _browserRetryNonce: Number.isSafeInteger(raw._browserRetryNonce) ? raw._browserRetryNonce : 0
  };
  normalized.source = sourceFromScreen(normalized);
  return normalized;
};

export const serializeScreen = (screen) => {
  const clean = { ...screen };
  delete clean._transition;
  delete clean._browserRetryNonce;
  return {
    ...clean,
    position: clean.position.slice(0, 3),
    rotation: normalizeRotation(clean.rotation),
    scale: clean.scale.slice(0, 3),
    size: clean.size.slice(0, 2),
    source: { ...clean.source }
  };
};

export const browserViewportForScreen = (screen) => {
  const browserWidth = 1280;
  const rawWidth = Number(screen.size && screen.size[0]);
  const rawHeight = Number(screen.size && screen.size[1]);
  const contentWidth = Math.max(0.2, (Number.isFinite(rawWidth) ? rawWidth : DEFAULT_SCREEN_SIZE[0]) - 0.01);
  const contentHeight = Math.max(
    0.2,
    (Number.isFinite(rawHeight) ? rawHeight : DEFAULT_SCREEN_SIZE[1]) - BROWSER_HEADER_WORLD_HEIGHT - 0.01
  );
  return {
    browserWidth,
    browserHeight: clamp(Math.round(browserWidth * contentHeight / contentWidth), 400, 1600)
  };
};

export { ROTATION_ORDER };
