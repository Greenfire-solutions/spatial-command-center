import * as THREE from 'three';
import { DEG, ROTATION_ORDER } from '../constants.js';
import { objectTransform } from '../systems/scene-runtime.js';
import {
  viewpointForwardHorizontal,
  viewpointPosition,
  yawTowardViewpoint
} from '../systems/viewpoint.js';
import { useStore } from '../store/workspace-store.js';
import {
  MAX_GRAB_DISTANCE,
  MIN_GRAB_DISTANCE,
  clampWorldDistance
} from './screen-interaction.js';

/*
 * Every discrete thing a user can do to a spatial screen, in one place.
 *
 * These are deliberately free of any input or presentation assumption: no
 * pixels, no DOM events, no React. They operate on the live Object3D and the
 * store, so the DOM control bar, the in-scene spatial control bar, and a
 * future controller or hand gesture all drive identical behaviour rather than
 * three subtly different implementations of "rotate left".
 */
export const createScreenActions = ({ screen, objectRef, setShowResize }) => {
  const editable = () => !screen.locked;

  const commit = () => {
    const object = objectRef.current;
    if (!object) return;
    const transform = objectTransform(object);
    useStore.getState().commitScreenTransform(
      screen.id,
      transform.position,
      transform.rotation,
      transform.scale
    );
  };

  const rotateStep = (direction) => {
    const object = objectRef.current;
    if (!object || !editable()) return;
    useStore.getState().setSelectedScreen(screen.id);
    const snap = useStore.getState().rotationSnap || 15;
    const step = snap * DEG;
    object.rotation.y = Math.round((object.rotation.y + direction * step) / step) * step;
  };

  const faceCamera = () => {
    const object = objectRef.current;
    if (!object || !editable()) return;
    object.rotation.set(0, yawTowardViewpoint(object.position), 0, ROTATION_ORDER);
    commit();
  };

  const nudgeDepth = (amount) => {
    const object = objectRef.current;
    if (!object || !editable()) return;
    const viewer = viewpointPosition(new THREE.Vector3());
    const direction = object.position.clone().sub(viewer);
    direction.y = 0;
    if (direction.lengthSq() < 0.0001) viewpointForwardHorizontal(direction);
    direction.normalize();
    const candidate = object.position.clone().addScaledVector(direction, amount);
    clampWorldDistance(candidate, viewer, MIN_GRAB_DISTANCE, MAX_GRAB_DISTANCE);
    object.position.copy(candidate);
    commit();
  };

  const resetPose = () => {
    const object = objectRef.current;
    if (!object || !editable()) return;
    object.scale.set(1, 1, 1);
    object.rotation.set(0, yawTowardViewpoint(object.position), 0, ROTATION_ORDER);
    if (setShowResize) setShowResize(false);
    commit();
    useStore.getState().showToast('Screen pose reset');
  };

  const duplicate = () => {
    const object = objectRef.current;
    if (!object) return;
    useStore.getState().duplicateScreen(screen.id, objectTransform(object));
  };

  const beginMove = () => {
    useStore.getState().setSelectedScreen(screen.id);
    useStore.getState().setInteractionMode('arrange');
    if (setShowResize) setShowResize(false);
  };

  const toggleResize = (nextValue) => {
    useStore.getState().setSelectedScreen(screen.id);
    useStore.getState().setInteractionMode('arrange');
    if (setShowResize) setShowResize(nextValue);
  };

  const toggleLock = () => {
    if (setShowResize) setShowResize(false);
    useStore.getState().toggleScreenLock(screen.id);
  };

  const close = () => useStore.getState().removeScreen(screen.id);
  const focusCamera = () => useStore.getState().focusCameraOnScreen(screen.id);

  return {
    commit,
    rotateStep,
    faceCamera,
    nudgeDepth,
    resetPose,
    duplicate,
    beginMove,
    toggleResize,
    toggleLock,
    close,
    focusCamera
  };
};
