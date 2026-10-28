import * as THREE from 'three';

/*
 * Rounded-rectangle plane geometry, cached by shape.
 *
 * Spatial chrome uses the same soft-cornered rectangles the DOM overlay does.
 * Building them from a THREE.Shape keeps a single triangulated plane per
 * distinct size, which matters because a workspace can hold many screens and
 * each screen carries several panels.
 */
const geometryCache = new Map();

const buildRoundedRect = (width, height, radius) => {
  const clampedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const shape = new THREE.Shape();

  shape.moveTo(-halfWidth + clampedRadius, -halfHeight);
  shape.lineTo(halfWidth - clampedRadius, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + clampedRadius);
  shape.lineTo(halfWidth, halfHeight - clampedRadius);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - clampedRadius, halfHeight);
  shape.lineTo(-halfWidth + clampedRadius, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - clampedRadius);
  shape.lineTo(-halfWidth, -halfHeight + clampedRadius);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + clampedRadius, -halfHeight);

  const geometry = new THREE.ShapeGeometry(shape, 8);
  geometry.computeBoundingBox();

  // ShapeGeometry does not emit usable UVs for a rounded rect, so derive them
  // from the bounding box. Panels that carry a texture depend on this.
  const { min, max } = geometry.boundingBox;
  const spanX = max.x - min.x || 1;
  const spanY = max.y - min.y || 1;
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    uv[index * 2] = (position.getX(index) - min.x) / spanX;
    uv[index * 2 + 1] = (position.getY(index) - min.y) / spanY;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
};

export const roundedRectGeometry = (width, height, radius) => {
  const key = `${width.toFixed(4)}:${height.toFixed(4)}:${radius.toFixed(4)}`;
  let geometry = geometryCache.get(key);
  if (!geometry) {
    geometry = buildRoundedRect(width, height, radius);
    geometryCache.set(key, geometry);
  }
  return geometry;
};

export const disposeGeometryCache = () => {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
};
