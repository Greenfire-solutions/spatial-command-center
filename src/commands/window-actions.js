import * as THREE from 'three';

import { sceneRuntime } from '../systems/scene-runtime.js';
import { viewpointForwardHorizontal, viewpointPosition } from '../systems/viewpoint.js';
import { applyArcArrangement, createScreenInFront } from '../systems/workspace-actions.js';
import { workspaceIndex } from './workspace-index.js';
import { resolveBrowserProvider } from '../providers/index.js';
import { useStore } from '../store/workspace-store.js';

/*
 * The workspace actions a spoken command needs, bound to the live scene.
 *
 * This is the seam the audit called for and the reason voice can act on a
 * window that is not focused: screen-actions.js closes over a mounted React
 * ref, which a voice command does not have. sceneRuntime.screenObjects already
 * maps an id to its live Object3D, so the resolver exists in practice — this
 * puts a name on it and builds the handful of operations that need it.
 *
 * Movement is expressed relative to the viewer rather than the world, so "to
 * my left" means the same thing whichever way someone is facing, and it works
 * unchanged from a head pose inside a session.
 */

const STEP = 0.55;
const DEPTH_STEP = 0.5;
const MIN_DISTANCE = 0.9;
const MAX_DISTANCE = 9;

const scratchForward = new THREE.Vector3();
const scratchRight = new THREE.Vector3();
const scratchEye = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* A basis that follows the viewer: forward on the horizontal plane, and the
 * right-hand vector derived from it. */
const viewerBasis = () => {
  const forward = viewpointForwardHorizontal(scratchForward).normalize();
  const right = scratchRight.copy(forward).cross(UP).normalize().negate();
  return { forward, right };
};

export const createWorkspaceActions = ({ store = useStore } = {}) => {
  const state = () => store.getState();

  const objectFor = (id) => sceneRuntime.screenObjects.get(id) || null;

  /* Write a live transform back through the store's own commit path, so a
   * spoken move is persisted and undone exactly like a dragged one. */
  const commit = (id, object) => {
    state().commitScreenTransform(
      id,
      object.position.toArray(),
      [object.rotation.x, object.rotation.y, object.rotation.z],
      object.scale.toArray()
    );
  };

  return {
    /* --- windows --- */
    addScreen: (options) => state().addScreen(options),
    removeScreen: (id) => state().removeScreen(id),
    duplicateScreen: (id) => state().duplicateScreen(id),
    toggleScreenLock: (id) => state().toggleScreenLock(id),
    isLocked: (id) => state().isScreenLocked(id),
    renameScreen: (id, name) => state().renameScreen(id, name),
    updateScreenUrl: (id, url) => state().updateScreenUrl(id, url),
    setSelectedScreen: (id) => state().setSelectedScreen(id),
    focusCameraOnScreen: (id) => state().focusCameraOnScreen?.(id),

    moveScreen: (id, direction) => {
      if (state().isScreenLocked(id)) return 'locked';
      const object = objectFor(id);
      if (!object) return 'absent';

      const { forward, right } = viewerBasis();
      switch (direction) {
        case 'left': object.position.addScaledVector(right, -STEP); break;
        case 'right': object.position.addScaledVector(right, STEP); break;
        case 'up': object.position.y += STEP; break;
        case 'down': object.position.y -= STEP; break;
        case 'closer':
        case 'farther': {
          /* Depth is along the line from the viewer to the screen, so pulling
           * something closer brings it toward the person rather than toward an
           * arbitrary world axis. */
          const eye = viewpointPosition(scratchEye);
          const away = object.position.clone().sub(eye);
          const distance = away.length() || 1;
          away.normalize();
          const next = direction === 'closer' ? distance - DEPTH_STEP : distance + DEPTH_STEP;
          const clamped = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, next));
          object.position.copy(eye).addScaledVector(away, clamped);
          break;
        }
        default:
          return false;
      }
      /* Keep it facing the viewer after a move; a screen edge-on to the user
       * is a worse outcome than not moving it. */
      object.lookAt(viewpointPosition(scratchEye));
      commit(id, object);
      return true;
    },

    resizeScreen: (id, factor) => {
      if (state().isScreenLocked(id)) return 'locked';
      const object = objectFor(id);
      if (!object) return 'absent';
      const next = Math.min(3, Math.max(0.35, object.scale.x * factor));
      object.scale.setScalar(next);
      commit(id, object);
      return true;
    },

    /* --- the workspace --- */
    applyPreset: (name) => state().applyPreset(name),
    arrangeWorkspace: () => applyArcArrangement(),
    createInFront: () => createScreenInFront(),
    saveCurrent: () => state().saveCurrent(),
    setInteractionMode: (mode) => state().setInteractionMode(mode),

    /* --- searching what the windows contain --- */
    searchWorkspace: async (query) => {
      const screens = state().screens;
      await workspaceIndex.refresh(screens, { provider: resolveBrowserProvider() });
      return workspaceIndex.search(query, screens);
    }
  };
};

export default createWorkspaceActions;
