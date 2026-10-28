/*
 * Frame delivery is described, not assumed.
 *
 * The Electron provider delivers CPU bitmaps today. A remote provider will
 * deliver decoded video, and a future local provider may deliver a GPU shared
 * texture. Rather than letting raw BGRA byte arrays leak into the scene, every
 * provider emits a frame descriptor carrying an explicit `format`, and the
 * renderer picks a texture surface that can consume that format.
 *
 * This is the seam that lets a VideoTexture provider exist later without
 * touching the spatial scene, the interaction system, or the store.
 */

export const FRAME_FORMATS = Object.freeze({
  /* Packed 8-bit BGRA bytes, row 0 at the top. What Electron's OSR paint path
   * produces via NativeImage.toBitmap(). */
  BGRA8_BITMAP: 'bgra8-bitmap',
  /* Packed 8-bit RGBA bytes, row 0 at the top. */
  RGBA8_BITMAP: 'rgba8-bitmap',
  /* A WebCodecs VideoFrame. Reserved for the WebRTC/remote provider. */
  VIDEO_FRAME: 'video-frame',
  /* An HTMLVideoElement already decoding a stream. Reserved for the remote
   * provider's simplest path. */
  VIDEO_ELEMENT: 'video-element',
  /* A decoded ImageBitmap. What the WebSocket host's JPEG frames become after
   * createImageBitmap(). Already in the renderer's colour space, so it needs
   * no channel reorder, and it is directly usable as a WebXR layer source. */
  IMAGE_BITMAP: 'image-bitmap',
  /* A platform GPU handle shared without a CPU round trip. Reserved for
   * Electron's useSharedTexture path. */
  SHARED_TEXTURE: 'shared-texture'
});

export const BITMAP_FORMATS = Object.freeze([
  FRAME_FORMATS.BGRA8_BITMAP,
  FRAME_FORMATS.RGBA8_BITMAP
]);

export const isBitmapFormat = (format) => BITMAP_FORMATS.includes(format);

const finite = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/*
 * Normalize a provider's raw payload into a frame descriptor.
 *
 * The shape is intentionally small:
 *   { sourceId, frameId, width, height, format, frame, ...presentation }
 *
 * `frame` is the payload whose meaning is defined by `format`: bytes for a
 * bitmap, a VideoFrame for video, an opaque handle for a shared texture.
 * `width`/`height` are always the physical pixel dimensions of that payload,
 * while `logicalWidth`/`logicalHeight` are the CSS-pixel viewport that input
 * coordinates are expressed in. On a HiDPI source the two differ.
 */
export const describeBitmapFrame = (raw, format = FRAME_FORMATS.BGRA8_BITMAP) => {
  const width = Math.max(1, Math.round(finite(raw.width, 1)));
  const height = Math.max(1, Math.round(finite(raw.height, 1)));
  return {
    sourceId: raw.sourceId,
    frameId: finite(raw.frameId, 0),
    format,
    width,
    height,
    logicalWidth: Math.max(1, Math.round(finite(raw.logicalWidth, width))),
    logicalHeight: Math.max(1, Math.round(finite(raw.logicalHeight, height))),
    deviceScaleFactor: finite(raw.deviceScaleFactor, 1),
    stride: Math.max(width * 4, Math.round(finite(raw.stride, width * 4))),
    premultipliedAlpha: Boolean(raw.premultipliedAlpha),
    colorSpace: raw.colorSpace || 'srgb',
    dirtyRect: raw.dirtyRect || null,
    capturedAt: finite(raw.capturedAt, 0),
    frame: raw.buffer ?? raw.bitmap ?? raw.pixels ?? raw.data ?? null,

    /* Compatibility view. validateRawFrame() and the texture surface read
     * these directly; keeping them avoids a second copy of the payload. */
    get buffer() { return this.frame; },
    pixelFormat: format === FRAME_FORMATS.RGBA8_BITMAP ? 'RGBA' : 'BGRA'
  };
};
