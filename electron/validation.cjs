'use strict';

const { BrowserSourceError } = require('./errors.cjs');
const {
  DEFAULT_FRAME_RATE,
  DEFAULT_SOURCE_SIZE,
  DEFAULT_SOURCE_URL
} = require('./constants.cjs');

const MAX_URL_LENGTH = 4096;
const MAX_TEXT_LENGTH = 8192;
const MIN_VIEWPORT_WIDTH = 320;
const MIN_VIEWPORT_HEIGHT = 200;
const MAX_VIEWPORT_WIDTH = 4096;
const MAX_VIEWPORT_HEIGHT = 4096;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_MODIFIERS = new Set([
  'shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd', 'iskeypad',
  'isautorepeat', 'leftbuttondown', 'middlebuttondown', 'rightbuttondown',
  'capslock', 'numlock', 'left', 'right'
]);
const ALLOWED_BUTTONS = new Set(['left', 'middle', 'right']);
const POINTER_TYPES = new Map([
  ['move', 'mouseMove'],
  ['down', 'mouseDown'],
  ['up', 'mouseUp'],
  ['enter', 'mouseEnter'],
  ['leave', 'mouseLeave'],
  ['contextmenu', 'contextMenu'],
  ['mouseMove', 'mouseMove'],
  ['mouseDown', 'mouseDown'],
  ['mouseUp', 'mouseUp'],
  ['mouseEnter', 'mouseEnter'],
  ['mouseLeave', 'mouseLeave'],
  ['contextMenu', 'contextMenu']
]);
const KEYBOARD_TYPES = new Set(['rawKeyDown', 'keyDown', 'keyUp', 'char']);

const requireRecord = (value, name = 'value') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserSourceError('INVALID_ARGUMENT', `${name} must be an object.`);
  }
  return value;
};

const requireSourceId = (value) => {
  if (typeof value !== 'string' || !SOURCE_ID_PATTERN.test(value)) {
    throw new BrowserSourceError(
      'INVALID_SOURCE_ID',
      'sourceId must contain 1–128 letters, numbers, dots, underscores, colons, or hyphens.'
    );
  }
  return value;
};

const finiteNumber = (value, name, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new BrowserSourceError('INVALID_ARGUMENT', `${name} is outside its supported range.`);
  }
  return number;
};

const normalizeViewport = (width, height) => ({
  width: finiteNumber(width ?? DEFAULT_SOURCE_SIZE.width, 'width', {
    min: MIN_VIEWPORT_WIDTH,
    max: MAX_VIEWPORT_WIDTH,
    integer: true
  }),
  height: finiteNumber(height ?? DEFAULT_SOURCE_SIZE.height, 'height', {
    min: MIN_VIEWPORT_HEIGHT,
    max: MAX_VIEWPORT_HEIGHT,
    integer: true
  })
});

const normalizeFrameRate = (value) => finiteNumber(value ?? DEFAULT_FRAME_RATE, 'frameRate', {
  min: 1,
  max: 60,
  integer: true
});

const normalizeDeviceScaleFactor = (value) => finiteNumber(value ?? 1, 'deviceScaleFactor', {
  min: 0.5,
  max: 4
});

/* Address classification, mirrored from src/url-normalization.js.
 *
 * These two copies exist only because the main process is CommonJS and the
 * renderer is an ES module. They must agree exactly: the renderer normalizes
 * what a user types, and the main process re-validates it before Chromium
 * loads it. electron/test/url-agreement.test.cjs loads both implementations
 * and fails if they ever diverge on a shared corpus of addresses. */
const isIpv4Address = (hostname) => {
  const parts = String(hostname || '').split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
};

const isPrivateIpv4Address = (hostname) => {
  if (!isIpv4Address(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
};

const isPrivateIpv6Address = (hostname) => {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
};

const isLocalDevelopmentHost = (hostname, hasPort) => {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    isPrivateIpv4Address(value) ||
    isPrivateIpv6Address(value) ||
    Boolean(hasPort && value && !value.includes('.') && !value.includes(':'));
};

const hostCandidate = (raw) => {
  const withoutProtocolSlashes = raw.startsWith('//') ? raw.slice(2) : raw;
  const authority = withoutProtocolSlashes.split(/[/?#]/, 1)[0];
  if (!authority || /\s/.test(authority) || authority.includes('@')) return null;

  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    const hostname = authority.slice(0, end + 1);
    const remainder = authority.slice(end + 1);
    if (remainder && !/^:\d+$/.test(remainder)) return null;
    return { hostname, hasPort: Boolean(remainder) };
  }

  const portMatch = authority.match(/:(\d+)$/);
  const hostname = portMatch ? authority.slice(0, -portMatch[0].length) : authority;
  if (!hostname) return null;
  const urlLike = hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.includes('.') ||
    isIpv4Address(hostname) ||
    Boolean(portMatch && /^[a-z0-9-]+$/i.test(hostname));
  return urlLike ? { hostname, hasPort: Boolean(portMatch) } : null;
};

const normalizeNavigationUrl = (value = DEFAULT_SOURCE_URL) => {
  if (typeof value !== 'string') {
    throw new BrowserSourceError('INVALID_URL', 'url must be a string.');
  }

  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new BrowserSourceError('INVALID_URL', 'url must contain between 1 and 4096 characters.');
  }

  const looksLikeHostWithPort = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(?:[/?#]|$)/i.test(raw);
  const explicitScheme = looksLikeHostWithPort ? null : raw.match(/^([A-Za-z][A-Za-z\d+.-]*):/);
  if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) {
    throw new BrowserSourceError('UNSUPPORTED_URL_SCHEME', 'Only HTTP and HTTPS browser destinations are supported.');
  }

  const host = explicitScheme ? null : hostCandidate(raw);
  let candidate;
  if (explicitScheme) {
    candidate = raw;
  } else if (host) {
    candidate = (isLocalDevelopmentHost(host.hostname, host.hasPort) ? 'http://' : 'https://') +
      (raw.startsWith('//') ? raw.slice(2) : raw);
  } else {
    candidate = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserSourceError('INVALID_URL', 'url is not a valid web address.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new BrowserSourceError('INVALID_URL', 'url must be an HTTP(S) address without embedded credentials.');
  }

  return parsed.href;
};

/* Strict validator for URLs handed to the operating system.
 * shell.openExternal will happily launch non-web schemes, so this boundary
 * deliberately refuses scheme inference, search fallbacks, and credentials:
 * only an explicit, complete HTTP(S) URL is accepted. */
const normalizeExternalUrl = (value) => {
  if (typeof value !== "string") {
    throw new BrowserSourceError("INVALID_URL", "url must be a string.");
  }
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new BrowserSourceError("INVALID_URL", "url must contain between 1 and 4096 characters.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserSourceError("INVALID_URL", "url must be an absolute HTTP(S) address.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new BrowserSourceError("UNSUPPORTED_URL_SCHEME", "Only HTTP and HTTPS destinations can be opened externally.");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new BrowserSourceError("INVALID_URL", "url must have a host and cannot contain embedded credentials.");
  }
  return parsed.href;
};

const normalizeModifiers = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new BrowserSourceError('INVALID_INPUT', 'modifiers must be a short array.');
  }
  const normalized = value.map((modifier) => String(modifier).toLowerCase());
  if (normalized.some((modifier) => !ALLOWED_MODIFIERS.has(modifier))) {
    throw new BrowserSourceError('INVALID_INPUT', 'One or more input modifiers are unsupported.');
  }
  return [...new Set(normalized)];
};

const inputPoint = (payload, size) => ({
  // A ray hit at uv=1 maps to exactly width/height by the public formula.
  // Accept that closed edge and clamp it onto Chromium's final pixel.
  x: Math.min(size.width - 1, Math.round(finiteNumber(payload.x, 'x', { min: 0, max: size.width }))),
  y: Math.min(size.height - 1, Math.round(finiteNumber(payload.y, 'y', { min: 0, max: size.height })))
});

const normalizePointerEvent = (value, size) => {
  const payload = requireRecord(value, 'pointerEvent');
  const type = POINTER_TYPES.get(payload.type);
  if (!type) throw new BrowserSourceError('INVALID_INPUT', 'Unsupported pointer event type.');
  const point = inputPoint(payload, size);
  const button = payload.button === undefined ? 'left' : String(payload.button).toLowerCase();
  if (!ALLOWED_BUTTONS.has(button)) {
    throw new BrowserSourceError('INVALID_INPUT', 'Pointer button must be left, middle, or right.');
  }
  const event = {
    type,
    ...point,
    button,
    modifiers: normalizeModifiers(payload.modifiers)
  };
  if (payload.clickCount !== undefined) {
    event.clickCount = finiteNumber(payload.clickCount, 'clickCount', { min: 1, max: 3, integer: true });
  }
  if (payload.movementX !== undefined) event.movementX = finiteNumber(payload.movementX, 'movementX', { min: -8192, max: 8192 });
  if (payload.movementY !== undefined) event.movementY = finiteNumber(payload.movementY, 'movementY', { min: -8192, max: 8192 });
  return event;
};

const normalizeWheelEvent = (value, size) => {
  const payload = requireRecord(value, 'wheelEvent');
  const point = inputPoint(payload, size);
  const deltaX = finiteNumber(payload.deltaX ?? 0, 'deltaX', { min: -10000, max: 10000 });
  const deltaY = finiteNumber(payload.deltaY ?? 0, 'deltaY', { min: -10000, max: 10000 });
  const wheelTicksX = Number.isFinite(payload.wheelTicksX)
    ? finiteNumber(payload.wheelTicksX, 'wheelTicksX', { min: -100, max: 100, integer: true })
    : Math.round(deltaX / 120);
  const wheelTicksY = Number.isFinite(payload.wheelTicksY)
    ? finiteNumber(payload.wheelTicksY, 'wheelTicksY', { min: -100, max: 100, integer: true })
    : Math.round(deltaY / 120);
  const normalized = {
    type: 'mouseWheel',
    ...point,
    deltaX,
    deltaY,
    wheelTicksX,
    wheelTicksY,
    hasPreciseScrollingDeltas: payload.hasPreciseScrollingDeltas !== false,
    canScroll: payload.canScroll !== false,
    modifiers: normalizeModifiers(payload.modifiers)
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'button')) {
    const button = String(payload.button).toLowerCase();
    if (!ALLOWED_BUTTONS.has(button)) {
      throw new BrowserSourceError('INVALID_INPUT', 'Wheel button must be left, middle, or right when supplied.');
    }
    normalized.button = button;
  }
  if (Number.isFinite(payload.buttons)) normalized.buttons = Math.max(0, Number(payload.buttons));
  return normalized;
};

const normalizeKeyboardEvent = (value) => {
  const payload = requireRecord(value, 'keyboardEvent');
  const type = String(payload.type || '');
  if (!KEYBOARD_TYPES.has(type)) {
    throw new BrowserSourceError('INVALID_INPUT', 'Unsupported keyboard event type.');
  }
  if (typeof payload.keyCode !== 'string' || !payload.keyCode || payload.keyCode.length > 64) {
    throw new BrowserSourceError('INVALID_INPUT', 'keyCode must be a non-empty string no longer than 64 characters.');
  }
  return {
    type,
    keyCode: payload.keyCode,
    modifiers: normalizeModifiers(payload.modifiers)
  };
};

const normalizeText = (value) => {
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT_LENGTH) {
    throw new BrowserSourceError('INVALID_INPUT', 'text must contain between 1 and 8192 characters.');
  }
  return value;
};

const normalizeCreateOptions = (value = {}) => {
  const payload = requireRecord(value, 'options');
  const size = normalizeViewport(payload.width, payload.height);
  return {
    id: payload.id === undefined ? null : requireSourceId(payload.id),
    url: normalizeNavigationUrl(payload.url ?? DEFAULT_SOURCE_URL),
    ...size,
    deviceScaleFactor: normalizeDeviceScaleFactor(payload.deviceScaleFactor),
    frameRate: normalizeFrameRate(payload.frameRate)
  };
};

module.exports = {
  finiteNumber,
  normalizeCreateOptions,
  normalizeDeviceScaleFactor,
  normalizeExternalUrl,
  normalizeFrameRate,
  normalizeKeyboardEvent,
  normalizeNavigationUrl,
  normalizePointerEvent,
  normalizeText,
  normalizeViewport,
  normalizeWheelEvent,
  requireRecord,
  requireSourceId
};
