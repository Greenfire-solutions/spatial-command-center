import * as THREE from 'three';

/*
 * Imperative handles to live scene objects.
 *
 * React state describes the workspace; these are the actual Object3D instances
 * being manipulated each frame. Keeping them out of React state is deliberate:
 * a drag must mutate a transform at frame rate without re-rendering the tree,
 * and a browser surface must keep painting while its monitor moves.
 *
 * Treat this as a registry, not as application state. Anything durable belongs
 * in the store.
 */
export const sceneRuntime = {
  camera: null,
  orbitControls: null,
  screenObjects: new Map(),
  browserSurfaces: new Map(),
  renderer: null
};

/* Why the most recent manipulation attempt started or was rejected. Written
 * on every pointer-down against a screen and read by the QA hook. */
export const manipulationDiagnostics = { last: null };

export const recordManipulationAttempt = (detail) => {
  manipulationDiagnostics.last = { ...detail, at: Date.now() };
};

/*
 * A world-space point, expressed in the space the object's transform is
 * actually written in.
 *
 * Manipulation maths is world-space: rays, the viewer, and intersection planes
 * all are. `object.position` is not — it is relative to the parent. While every
 * screen was a direct child of the scene the two were identical and the
 * distinction never surfaced. Under a workspace root that rotates to follow the
 * user they differ, and writing a world value into a local slot puts the window
 * somewhere nobody asked for.
 */
export const worldToLocal = (object, worldPoint) => (
  object && object.parent ? object.parent.worldToLocal(worldPoint.clone()) : worldPoint.clone()
);

/* The inverse, for reading a stored transform back out into world terms. */
export const localToWorld = (object, localPoint) => (
  object && object.parent ? object.parent.localToWorld(localPoint.clone()) : localPoint.clone()
);

export const objectTransform = (object) => ({
  position: object.position.toArray(),
  rotation: [object.rotation.x, object.rotation.y, object.rotation.z, object.rotation.order],
  scale: object.scale.toArray()
});

export const faceYaw = (position, cameraPosition) => Math.atan2(
  cameraPosition.x - position.x,
  cameraPosition.z - position.z
);

export { THREE };
