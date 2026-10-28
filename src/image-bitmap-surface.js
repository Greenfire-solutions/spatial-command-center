import * as THREE from 'three';

/*
 * A browser surface backed by decoded images rather than raw channel bytes.
 *
 * The remote JPEG transport delivers compressed frames; the client decodes
 * each one with createImageBitmap(), which runs off the main thread and hands
 * back a GPU-uploadable object. three.js accepts an ImageBitmap as a texture
 * source directly, so there is no channel swizzle and no un-premultiply to
 * undo — unlike the Electron bitmap path, whose shader exists precisely to
 * correct for BGRA premultiplied bytes.
 *
 * It presents the same interface as the other two surfaces — a `material` to
 * attach and an `update(frame)` taking a frame descriptor — so the scene
 * selects between them on the declared format and needs no other knowledge of
 * where the browser is running.
 *
 * An ImageBitmap is also a valid XRLayerSrc, which is why this surface is the
 * one worth having on a headset: the same decoded frame can be handed to a
 * WebXR composition layer without a second copy.
 */

const placeholderTexture = () => {
  const texture = new THREE.DataTexture(
    new Uint8Array([14, 18, 25, 255, 18, 25, 35, 255, 18, 25, 35, 255, 14, 18, 25, 255]),
    2,
    2,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const configureTexture = (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  /*
   * Deliberately false, and deliberately not the mechanism.
   *
   * three.js ignores flipY for an ImageBitmap — WebGL2's UNPACK_FLIP_Y_WEBGL
   * does nothing on an ImageBitmap upload — so setting it true here would read
   * like a fix while changing nothing, which is how the frames ended up
   * upside down with a flag in the code that appeared to say otherwise.
   * Orientation is settled at decode instead, by the `imageOrientation:
   * 'flipY'` passed to createImageBitmap in websocket-browser-provider.js.
   * Leaving this explicitly false keeps the two from fighting.
   */
  texture.flipY = false;
  return texture;
};

export class BrowserImageBitmapSurface {
  constructor() {
    this.placeholder = placeholderTexture();
    this.texture = null;
    this.bitmap = null;
    this.width = 0;
    this.height = 0;
    this.frameId = 0;
    this.disposed = false;

    /* A plain basic material is enough here. The bitmap path needs a shader to
     * reorder channels; a decoded image arrives already correct. */
    this.material = new THREE.MeshBasicMaterial({
      name: 'BrowserImageBitmapMaterial',
      map: this.placeholder,
      toneMapped: false,
      transparent: false,
      side: THREE.FrontSide
    });
  }

  /*
   * Present a decoded frame.
   *
   * `frame.frame` is expected to be an ImageBitmap. Each frame is a new
   * object, so the previous one is closed explicitly — an ImageBitmap holds
   * memory until close() is called, and at 15fps a leak is measured in
   * hundreds of megabytes per minute rather than being a slow drift.
   */
  update(frame) {
    if (this.disposed) return { ok: false, error: 'Image surface is disposed.' };
    if (!frame) return { ok: false, error: 'No frame descriptor supplied.' };

    const bitmap = frame.frame;
    if (!bitmap) return { ok: false, error: 'The frame descriptor carries no image.' };
    if (typeof ImageBitmap !== 'undefined' && !(bitmap instanceof ImageBitmap)) {
      return { ok: false, error: 'An image surface requires a decoded ImageBitmap.' };
    }

    const previous = this.bitmap;

    /* Reuse the texture object and swap its source. Allocating a new
     * THREE.Texture per frame would discard the GPU allocation every time and
     * force a full re-upload path rather than a sub-image update. */
    if (!this.texture) {
      this.texture = configureTexture(new THREE.Texture(bitmap));
      this.material.map = this.texture;
      this.material.needsUpdate = true;
    } else {
      this.texture.image = bitmap;
    }
    this.texture.needsUpdate = true;
    this.bitmap = bitmap;

    if (previous && previous !== bitmap) previous.close?.();

    this.width = frame.width || bitmap.width || this.width;
    this.height = frame.height || bitmap.height || this.height;
    this.frameId = Number(frame.frameId) || this.frameId + 1;

    return {
      ok: true,
      width: this.width,
      height: this.height,
      frameId: this.frameId,
      pixelFormat: 'image-bitmap'
    };
  }

  /*
   * Deliberately null: a live stream cannot be a composition layer's `src`.
   *
   * This getter used to return the current bitmap, and on a desktop that looks
   * harmless. In a session it produced a window frozen on one frame — or worse,
   * garbage — for two reasons that compound.
   *
   * `update()` closes the previous bitmap the moment the next frame lands
   * (~66 ms at 15 fps), while @pmndrs/xr's image-layer path redraws
   * asynchronously, awaiting a frame and responding to the compositor's own
   * `redraw` event. So it reads a detached ImageBitmap and uploads it. And the
   * frame it holds is stale anyway: the frame subscription updates the surface
   * imperatively without setState, so React never re-renders and `layerSource`
   * keeps whichever bitmap existed at the last render — usually the first.
   *
   * Forcing a per-frame re-render would be worse, not better: `src` sits in the
   * layer's effect dependencies, so a new bitmap identity every frame would
   * destroy and rebuild the XRQuadLayer, and call updateRenderState({layers}),
   * fifteen to thirty times a second per window.
   *
   * The static-canvas probe in docs/WEBXR_HEADSET_FINDINGS.md measured a quad
   * layer beating a mesh and concluded "use the layer". That conclusion is
   * right and this does not abandon it — but the path it validated was the
   * static-image path, which is not the path a moving picture takes. A live
   * surface reaches a layer by being *drawn into* it as a render target
   * (`<XRLayer>` with children), not by being handed to it. Until that is
   * implemented and measured on hardware, a mesh that is live and correct beats
   * a layer that is sharp and frozen.
   *
   * `BrowserVideoTextureSurface` keeps its layerSource: a video element is a
   * persistent object the compositor may hold, and is never freed per frame.
   */
  get layerSource() {
    return null;
  }

  releaseTexture() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    if (this.bitmap) {
      this.bitmap.close?.();
      this.bitmap = null;
    }
    this.material.map = this.placeholder;
    this.material.needsUpdate = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseTexture();
    this.placeholder.dispose();
    this.material.dispose();
  }
}

export default BrowserImageBitmapSurface;
