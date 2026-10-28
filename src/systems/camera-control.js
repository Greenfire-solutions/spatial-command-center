import { useStore } from '../store/workspace-store.js';

/*
 * One authority for whether camera movement is allowed.
 *
 * Previously three parties wrote `orbitControls.enabled` directly — the drag
 * handler, the Chromium surface's hover suppression, and the OrbitControls
 * `enabled` prop — so a React re-render could silently re-enable orbiting in
 * the middle of a gesture, and a hover suppression could be clobbered by an
 * unrelated state change.
 *
 * Instead, anything that needs to hold the camera still claims a named lock.
 * The camera system is the only writer, and it derives `enabled` from whether
 * any lock is held. Locks are named so a leak is diagnosable rather than
 * mysterious, and so releasing one holder cannot release another's.
 */

const holders = new Set();
const listeners = new Set();

const notify = () => {
  for (const listener of listeners) listener();
};

export const acquireCameraLock = (holder) => {
  if (!holder || holders.has(holder)) return;
  holders.add(holder);
  notify();
};

export const releaseCameraLock = (holder) => {
  if (!holders.delete(holder)) return;
  notify();
};

export const setCameraLock = (holder, held) => {
  if (held) acquireCameraLock(holder);
  else releaseCameraLock(holder);
};

export const releaseAllCameraLocks = () => {
  if (!holders.size) return;
  holders.clear();
  notify();
};

/* True when nothing is holding the camera still. */
export const cameraMovementAllowed = () => holders.size === 0;

export const cameraLockHolders = () => [...holders];

export const subscribeToCameraLocks = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/*
 * Applies the derived state to a controls instance. Called by the camera
 * system on every frame, which makes it immune to React re-render ordering:
 * whatever a prop or a stray write did, the next frame restores the truth.
 *
 * In an immersive session the desktop locomotion controls are inert — the
 * user moves their head instead — so the system disables them wholesale.
 */
export const applyCameraControlState = (controls, { presenting = false } = {}) => {
  if (!controls) return false;
  const enabled = !presenting && cameraMovementAllowed() && !useStore.getState().isManipulatingScreen;
  if (controls.enabled !== enabled) controls.enabled = enabled;
  return enabled;
};
