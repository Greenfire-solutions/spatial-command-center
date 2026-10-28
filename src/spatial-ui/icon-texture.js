import * as THREE from 'three';
import { ICON_VIEWBOX, iconPrimitives } from './icon-paths.js';

/*
 * Rasterize the shared icon vocabulary into textures for in-scene controls.
 *
 * Troika renders text, but the workspace's icons are line art. Drawing them
 * once into a canvas at a generous resolution gives crisp, tintable glyphs
 * that cost a single texture lookup per control and behave correctly under
 * the wide field of view and close viewing distances of a headset.
 *
 * Icons are drawn white so a material can tint them to any state colour
 * without a second rasterization.
 */
const RESOLUTION = 128;
const textureCache = new Map();

const drawPrimitive = (context, primitive, scale) => {
  if (primitive.kind === 'path') {
    const shape = new Path2D(primitive.d);
    const scaled = new Path2D();
    const matrix = typeof DOMMatrix === 'function' ? new DOMMatrix([scale, 0, 0, scale, 0, 0]) : null;
    if (matrix) {
      scaled.addPath(shape, matrix);
      context.stroke(scaled);
    } else {
      context.save();
      context.scale(scale, scale);
      context.stroke(shape);
      context.restore();
    }
    return;
  }

  if (primitive.kind === 'circle') {
    context.beginPath();
    context.arc(primitive.cx * scale, primitive.cy * scale, primitive.r * scale, 0, Math.PI * 2);
    if (primitive.filled) context.fill();
    else context.stroke();
    return;
  }

  if (primitive.kind === 'rect') {
    const radius = (primitive.radius || 0) * scale;
    context.beginPath();
    context.roundRect(
      primitive.x * scale,
      primitive.y * scale,
      primitive.width * scale,
      primitive.height * scale,
      radius
    );
    context.stroke();
  }
};

const rasterize = (name) => {
  const canvas = document.createElement('canvas');
  canvas.width = RESOLUTION;
  canvas.height = RESOLUTION;
  const context = canvas.getContext('2d');
  const scale = RESOLUTION / ICON_VIEWBOX;

  context.clearRect(0, 0, RESOLUTION, RESOLUTION);
  context.strokeStyle = '#ffffff';
  context.fillStyle = '#ffffff';
  context.lineWidth = 1.8 * scale;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (const primitive of iconPrimitives(name)) drawPrimitive(context, primitive, scale);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
};

export const iconTexture = (name) => {
  if (typeof document === 'undefined') return null;
  let texture = textureCache.get(name);
  if (!texture) {
    texture = rasterize(name);
    textureCache.set(name, texture);
  }
  return texture;
};

export const disposeIconTextures = () => {
  for (const texture of textureCache.values()) texture.dispose();
  textureCache.clear();
};
