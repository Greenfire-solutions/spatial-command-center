/*
 * A picture of the scene, sent to the terminal.
 *
 * Telemetry can say a surface is receiving frames and cannot say those frames
 * are upside down. That gap cost an hour: every number read healthy while the
 * picture was inverted, and the only person who could see it was wearing the
 * headset. This closes it from the app side.
 *
 * The honest limitation, stated up front because it is the one that matters:
 * this renders the WebGL scene and therefore CANNOT see compositor layers.
 * A browser surface promoted to an XRLayer is composited by the runtime outside
 * the WebGL frame, so it will appear here as empty space. Passthrough and
 * system dialogs are invisible for the same reason.
 *
 * So this is a view of the scene graph, not of the display. `adb exec-out
 * screencap` is the faithful one. This exists because it needs no cable, no
 * developer mode, and no account, and because "where is the keyboard facing"
 * and "did the workspace land behind me" are answerable without layers.
 */

import { WebGLRenderTarget, LinearFilter, RGBAFormat } from 'three';

const DEFAULT_WIDTH = 640;

let target = null;
let scratch = null;

const ensureTarget = (width, height) => {
  if (target && target.width === width && target.height === height) return target;
  target?.dispose();
  target = new WebGLRenderTarget(width, height, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    format: RGBAFormat
  });
  return target;
};

/**
 * Render the scene from the viewer's pose and return a JPEG data URL.
 *
 * @param {import('three').WebGLRenderer} gl
 * @param {import('three').Scene} scene
 * @param {import('three').Camera} camera the XR camera while presenting
 * @param {number} width capture width; height follows the camera aspect
 */
export const captureScene = (gl, scene, camera, width = DEFAULT_WIDTH) => {
  if (!gl || !scene || !camera) return null;

  /*
   * An XR ArrayCamera cannot be rendered to an ordinary target, and its
   * projection belongs to the headset. Borrow its world pose onto a plain
   * perspective camera instead, which is what makes this work mid-session.
   */
  const viewer = camera.isArrayCamera && camera.cameras?.length ? camera.cameras[0] : camera;
  const height = Math.round(width * 0.62);
  const buffer = ensureTarget(width, height);

  const previousTarget = gl.getRenderTarget();
  const wasXrEnabled = gl.xr.enabled;

  try {
    /*
     * XR must be disabled for the duration. Rendering to a target with
     * xr.enabled true drives the headset's own frame loop and would either
     * throw or steal the session's frame.
     */
    gl.xr.enabled = false;
    gl.setRenderTarget(buffer);
    gl.render(scene, viewer);

    const pixels = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(buffer, 0, 0, width, height, pixels);

    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    }
    const context = scratch.getContext('2d');
    const image = context.createImageData(width, height);

    /* readRenderTargetPixels returns bottom-row-first; a canvas expects
     * top-row-first. Copying row by row in reverse is the flip. */
    const stride = width * 4;
    for (let row = 0; row < height; row += 1) {
      const source = (height - 1 - row) * stride;
      image.data.set(pixels.subarray(source, source + stride), row * stride);
    }
    context.putImageData(image, 0, 0);

    return scratch.convertToBlob
      ? scratch.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      : Promise.resolve(null);
  } catch {
    return null;
  } finally {
    /* Restore before returning, always. Leaving xr.enabled false would end the
     * session's rendering entirely, which is a far worse bug than a missing
     * screenshot. */
    gl.setRenderTarget(previousTarget);
    gl.xr.enabled = wasXrEnabled;
  }
};
