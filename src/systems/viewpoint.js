import * as THREE from 'three';
import { sceneRuntime } from './scene-runtime.js';

/*
 * Where the user actually is.
 *
 * Outside XR the desktop camera is the viewpoint. Inside an immersive session
 * it is not: three keeps the desktop camera untouched and drives an
 * ArrayCamera from the headset pose, so anything that reads
 * `sceneRuntime.camera.position` to mean "where the user is looking from"
 * silently reads a stale value the moment a session starts.
 *
 * Every system that needs the user's viewpoint — face-me, arc layout, depth
 * nudging, focus framing, grab distance — goes through here, so the XR switch
 * happens in exactly one place instead of being scattered as `if (isPresenting)`
 * checks through unrelated components.
 */

const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchForward = new THREE.Vector3();

/* Set by the XR system when a session begins. Kept as a plain reference rather
 * than React state because it is read inside useFrame at frame rate. */
export const viewpointRuntime = {
  xrCamera: null,
  presenting: false
};

export const setXrViewpoint = (camera, presenting) => {
  viewpointRuntime.xrCamera = camera || null;
  viewpointRuntime.presenting = Boolean(presenting && camera);
};

/*
 * The camera object representing the current viewpoint.
 *
 * In an immersive session this is renderer.xr.getCamera(), whose world matrix
 * tracks the head pose. It is an ArrayCamera without a meaningful `fov`, so
 * callers that need projection maths should use viewpointFov() rather than
 * reading `.fov` directly.
 */
export const viewpointCamera = () => (
  viewpointRuntime.presenting && viewpointRuntime.xrCamera
    ? viewpointRuntime.xrCamera
    : sceneRuntime.camera
);

export const isPresenting = () => viewpointRuntime.presenting;

/* World-space position of the viewer's head. */
export const viewpointPosition = (target = new THREE.Vector3()) => {
  const camera = viewpointCamera();
  if (!camera) return target.set(0, 1.6, 0);
  camera.updateMatrixWorld?.();
  return target.setFromMatrixPosition(camera.matrixWorld);
};

/* Unit vector the viewer is facing. */
export const viewpointForward = (target = new THREE.Vector3()) => {
  const camera = viewpointCamera();
  if (!camera) return target.set(0, 0, -1);
  camera.updateMatrixWorld?.();
  scratchQuaternion.setFromRotationMatrix(camera.matrixWorld);
  return target.set(0, 0, -1).applyQuaternion(scratchQuaternion).normalize();
};

/* Forward direction flattened onto the horizontal plane, which is what layout
 * and depth operations want: a screen pushed "away" should not also rise. */
export const viewpointForwardHorizontal = (target = new THREE.Vector3()) => {
  viewpointForward(target);
  target.y = 0;
  if (target.lengthSq() < 0.0001) target.set(0, 0, -1);
  return target.normalize();
};

/* Vertical field of view in radians, valid in and out of a session. */
export const viewpointFov = () => {
  const camera = viewpointCamera();
  if (camera && Number.isFinite(camera.fov)) return camera.fov * (Math.PI / 180);
  // XR ArrayCameras expose projection rather than fov; recover it.
  if (camera && camera.projectionMatrix) {
    const projected = camera.projectionMatrix.elements[5];
    if (Number.isFinite(projected) && projected !== 0) return 2 * Math.atan(1 / projected);
  }
  return 55 * (Math.PI / 180);
};

export const viewpointAspect = () => {
  const camera = viewpointCamera();
  if (camera && Number.isFinite(camera.aspect) && camera.aspect > 0) return camera.aspect;
  const renderer = sceneRuntime.renderer;
  if (renderer && renderer.domElement && renderer.domElement.clientHeight > 0) {
    return renderer.domElement.clientWidth / renderer.domElement.clientHeight;
  }
  return 16 / 9;
};

/* Yaw that points an object's +Z face at the viewer. */
export const yawTowardViewpoint = (position) => {
  viewpointPosition(scratchPosition);
  return Math.atan2(scratchPosition.x - position.x, scratchPosition.z - position.z);
};

export { scratchForward };
