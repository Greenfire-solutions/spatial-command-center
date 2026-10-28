export const DEFAULT_CHROMIUM_VIEWPORT = Object.freeze({
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  frameRate: 30
});

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const clamp = (value, minimum, maximum) => Math.min(
  maximum,
  Math.max(minimum, finiteNumber(value, minimum))
);

/*
 * R3F plane UVs use a bottom-left origin. Chromium input coordinates use a
 * top-left origin, hence the deliberate Y inversion.
 */
export const uvToBrowserPixels = (uv, width, height) => {
  const browserWidth = Math.max(1, finiteNumber(width, DEFAULT_CHROMIUM_VIEWPORT.width));
  const browserHeight = Math.max(1, finiteNumber(height, DEFAULT_CHROMIUM_VIEWPORT.height));
  const u = clamp(uv && uv.x, 0, 1);
  const v = clamp(uv && uv.y, 0, 1);
  return {
    x: u * browserWidth,
    y: (1 - v) * browserHeight
  };
};

/* Electron's sendInputEvent expects integer pixel coordinates. Keep the exact
 * UV mapping above independently testable, then constrain the boundary pixel
 * here so UV 1 never produces an out-of-range array coordinate. */
export const uvToChromiumInputPoint = (uv, width, height) => {
  const browserWidth = Math.max(1, Math.round(finiteNumber(width, DEFAULT_CHROMIUM_VIEWPORT.width)));
  const browserHeight = Math.max(1, Math.round(finiteNumber(height, DEFAULT_CHROMIUM_VIEWPORT.height)));
  const point = uvToBrowserPixels(uv, browserWidth, browserHeight);
  return {
    x: clamp(Math.floor(point.x), 0, browserWidth - 1),
    y: clamp(Math.floor(point.y), 0, browserHeight - 1)
  };
};

/* Locked screens intentionally remain browsable in Arrange Mode in the
 * existing workspace: lock prevents physical edits, rather than page input. */
export const isChromiumInputEnabled = ({
  enabled = true,
  interactionMode = 'browse',
  locked = false
} = {}) => Boolean(enabled) && (interactionMode === 'browse' || Boolean(locked));

export const domButtonToElectronButton = (button) => {
  if (Number(button) === 1) return 'middle';
  if (Number(button) === 2) return 'right';
  return 'left';
};

export const keyboardModifiers = (event = {}) => {
  const modifiers = [];
  if (event.shiftKey) modifiers.push('shift');
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');
  if (typeof event.getModifierState === 'function') {
    if (event.getModifierState('CapsLock')) modifiers.push('capsLock');
    if (event.getModifierState('NumLock')) modifiers.push('numLock');
  }
  return modifiers;
};

export const pointerModifiers = (event = {}) => {
  const modifiers = keyboardModifiers(event);
  const buttons = Number(event.buttons) || 0;
  if (buttons & 1) modifiers.push('leftbuttondown');
  if (buttons & 4) modifiers.push('middlebuttondown');
  if (buttons & 2) modifiers.push('rightbuttondown');
  return modifiers;
};

/* DOM WheelEvent deltas are positive when the page should move down/right.
 * Electron's MouseWheelInputEvent follows the native wheel direction, which
 * is the inverse. Keeping the conversion at the renderer boundary also makes
 * direct BrowserSourceManager callers use Electron-native values. */
export const domWheelDeltaToElectron = (value) => {
  const delta = finiteNumber(value, 0);
  return delta === 0 ? 0 : -delta;
};

const ELECTRON_KEY_NAMES = Object.freeze({
  ' ': 'Space',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Backspace: 'Backspace',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Escape: 'Escape',
  Home: 'Home',
  Insert: 'Insert',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Tab: 'Tab'
});

export const electronKeyCode = (event = {}) => {
  const key = String(event.key || '');
  if (ELECTRON_KEY_NAMES[key]) return ELECTRON_KEY_NAMES[key];
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (key.length === 1) return key;
  const code = String(event.code || '');
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return key || code || 'Unidentified';
};

export const printableTextForKeyboardEvent = (event = {}) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return '';
  const key = String(event.key || '');
  return key.length === 1 ? key : '';
};

export const isEditableDomTarget = (target) => {
  if (!target || typeof target !== 'object') return false;
  const tagName = String(target.tagName || '').toLowerCase();
  return tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(target.isContentEditable);
};

export const framePixelView = (frame) => {
  if (!frame || typeof frame !== 'object') return null;
  const value = frame.buffer ?? frame.bitmap ?? frame.pixels ?? frame.data;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

export const normalizePixelFormat = (format) => {
  const normalized = String(format || 'BGRA').toLowerCase();
  return normalized.startsWith('bgra') ? 'bgra' : 'rgba';
};

export const validateRawFrame = (frame) => {
  const width = Math.max(1, Math.round(finiteNumber(frame && frame.width, 0)));
  const height = Math.max(1, Math.round(finiteNumber(frame && frame.height, 0)));
  const pixels = framePixelView(frame);
  const tightStride = width * 4;
  const stride = Math.max(tightStride, Math.round(finiteNumber(frame && frame.stride, tightStride)));
  const requiredBytes = stride * height;
  if (!pixels || pixels.byteLength < requiredBytes) {
    return {
      ok: false,
      error: 'Chromium frame does not contain enough bitmap data.',
      width,
      height,
      stride,
      pixels
    };
  }
  return {
    ok: true,
    width,
    height,
    stride,
    pixels,
    pixelFormat: normalizePixelFormat(frame.pixelFormat),
    premultipliedAlpha: Boolean(frame.premultipliedAlpha)
  };
};

/* Electron currently provides tight BGRA frames for this prototype. This
 * fallback only repacks padded rows; channel correction remains in the GPU. */
export const tightlyPackFrameRows = (validated, reusable) => {
  const tightStride = validated.width * 4;
  if (validated.stride === tightStride) {
    return validated.pixels.byteLength === tightStride * validated.height
      ? validated.pixels
      : validated.pixels.subarray(0, tightStride * validated.height);
  }
  const byteLength = tightStride * validated.height;
  const output = reusable && reusable.byteLength === byteLength
    ? reusable
    : new Uint8Array(byteLength);
  for (let row = 0; row < validated.height; row += 1) {
    const sourceStart = row * validated.stride;
    output.set(validated.pixels.subarray(sourceStart, sourceStart + tightStride), row * tightStride);
  }
  return output;
};
