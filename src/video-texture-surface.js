import * as THREE from 'three';
import { FRAME_FORMATS, isBitmapFormat } from './providers/frame-formats.js';
import { BrowserImageBitmapSurface } from './image-bitmap-surface.js';

/*
 * A browser surface backed by decoded video rather than uploaded pixels.
 *
 * This is the surface a headset uses. A remote provider delivers one media
 * track per browser source; the track's video element is sampled directly by
 * a THREE.VideoTexture, so no frame ever crosses JavaScript. The CPU cost per
 * screen is effectively zero, which is the whole reason the remote path can
 * carry several surfaces where the bitmap path cannot.
 *
 * It presents the same interface as ChromiumDataTextureSurface — a `material`
 * to attach and an `update(frame)` that takes a frame descriptor — so the
 * scene selects between them on the frame's declared format and needs no other
 * knowledge of where the browser is running.
 */

const VERTEX_SHADER = `
  varying vec2 vBrowserUv;

  void main() {
    vBrowserUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* Video arrives as ordinary RGB in the renderer's working colour space, so
 * unlike the bitmap path there is no swizzle or un-premultiply to undo. */
const FRAGMENT_SHADER = `
  uniform sampler2D browserTexture;
  varying vec2 vBrowserUv;

  void main() {
    gl_FragColor = texture2D(browserTexture, vBrowserUv);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

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

export class BrowserVideoTextureSurface {
  constructor() {
    this.placeholder = placeholderTexture();
    this.videoTexture = null;
    this.element = null;
    this.width = 0;
    this.height = 0;
    this.frameId = 0;
    this.disposed = false;

    this.material = new THREE.ShaderMaterial({
      name: 'BrowserVideoTextureMaterial',
      uniforms: { browserTexture: { value: this.placeholder } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      side: THREE.FrontSide,
      toneMapped: false
    });
  }

  /*
   * Bind a video-backed frame descriptor.
   *
   * Called once per track rather than per frame: a VideoTexture samples the
   * element on every render by itself. Re-binding the same element is a no-op
   * so a repeated descriptor cannot churn GPU resources.
   */
  update(frame) {
    if (this.disposed) return { ok: false, error: 'Video surface is disposed.' };
    if (!frame) return { ok: false, error: 'No frame descriptor supplied.' };
    if (isBitmapFormat(frame.format)) {
      return { ok: false, error: `A video surface cannot present ${frame.format} frames.` };
    }

    const element = frame.frame;
    if (!element) return { ok: false, error: 'The frame descriptor carries no video source.' };

    if (element !== this.element) {
      this.releaseTexture();
      this.element = element;
      this.videoTexture = new THREE.VideoTexture(element);
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.generateMipmaps = false;
      this.videoTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.videoTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.material.uniforms.browserTexture.value = this.videoTexture;
    }

    this.width = frame.width || element.videoWidth || this.width;
    this.height = frame.height || element.videoHeight || this.height;
    this.frameId = Number(frame.frameId) || this.frameId + 1;

    return {
      ok: true,
      width: this.width,
      height: this.height,
      frameId: this.frameId,
      pixelFormat: 'video'
    };
  }

  /* The decoded element, for handing to a WebXR composition layer as its src.
   * Matches BrowserImageBitmapSurface so the scene can ask any surface the
   * same question without knowing which it holds. */
  get layerSource() {
    return this.element;
  }

  releaseTexture() {
    if (this.videoTexture) {
      this.videoTexture.dispose();
      this.videoTexture = null;
    }
    this.material.uniforms.browserTexture.value = this.placeholder;
    this.element = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseTexture();
    this.placeholder.dispose();
    this.material.dispose();
  }
}

/*
 * Choose a surface for a provider's frame format.
 *
 * This is the seam that lets the same spatial screen present a locally
 * rendered bitmap or a remotely decoded video without knowing which it has.
 */
export const SURFACE_KINDS = Object.freeze({ BITMAP: 'bitmap', VIDEO: 'video', IMAGE: 'image' });

/*
 * Which surface a format needs.
 *
 * Callers key their surface on this rather than on the format string: an
 * absent provider and a local Electron provider both mean "bitmap", and
 * treating them as different would tear down and rebuild a live texture the
 * moment the bridge resolved.
 */
export const surfaceKindForFormat = (format) => {
  if (!format || isBitmapFormat(format)) return SURFACE_KINDS.BITMAP;
  if (format === FRAME_FORMATS.IMAGE_BITMAP) return SURFACE_KINDS.IMAGE;
  return SURFACE_KINDS.VIDEO;
};

export const createSurfaceForKind = (kind, { BitmapSurface }) => {
  if (kind === SURFACE_KINDS.VIDEO) return new BrowserVideoTextureSurface();
  if (kind === SURFACE_KINDS.IMAGE) return new BrowserImageBitmapSurface();
  return new BitmapSurface();
};

export const createSurfaceForFormat = (format, { BitmapSurface }) => (
  createSurfaceForKind(surfaceKindForFormat(format), { BitmapSurface })
);
