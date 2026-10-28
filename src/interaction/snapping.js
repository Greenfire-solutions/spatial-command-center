import * as THREE from 'three';
import { sceneRuntime } from '../systems/scene-runtime.js';
import { useStore } from '../store/workspace-store.js';

const getScreenHalfSize = (screen, object) => ({
  x: (screen.size[0] * (object ? object.scale.x : screen.scale[0])) / 2,
  y: (screen.size[1] * (object ? object.scale.y : screen.scale[1])) / 2
});

const snapScreenPosition = (screenId, rawPosition) => {
  const state = useStore.getState();
  if (!state.positionSnap) return { position: rawPosition, guide: null };
  const screen = state.screens.find((candidate) => candidate.id === screenId);
  const object = sceneRuntime.screenObjects.get(screenId);
  if (!screen) return { position: rawPosition, guide: null };

  const position = rawPosition.clone();
  const ownHalf = getScreenHalfSize(screen, object);
  const threshold = 0.14;
  const depthThreshold = 0.18;
  let bestX = null;
  let bestY = null;
  let bestZ = null;

  const consider = (current, targetValue, currentValue, kind, otherId) => {
    const delta = targetValue - currentValue;
    const distance = Math.abs(delta);
    if (distance > threshold || (current && current.distance <= distance)) return current;
    return { value: targetValue, distance, kind, otherId };
  };

  state.screens.forEach((other) => {
    if (other.id === screenId) return;
    const otherObject = sceneRuntime.screenObjects.get(other.id);
    /* World space, to match the candidate position the grab produces.
     *
     * `object.position` is relative to the parent. While every screen was a
     * direct child of the scene that was the same thing; under a workspace root
     * that rotates to follow the viewer it is not, and comparing a world-space
     * candidate against local neighbours snaps windows to places nobody put
     * anything. */
    const otherPosition = otherObject
      ? otherObject.getWorldPosition(new THREE.Vector3())
      : new THREE.Vector3(...other.position);
    const otherHalf = getScreenHalfSize(other, otherObject);

    bestX = consider(bestX, otherPosition.x, position.x, 'vertical-stack', other.id);
    bestX = consider(bestX, otherPosition.x - otherHalf.x + ownHalf.x, position.x, 'left-edge', other.id);
    bestX = consider(bestX, otherPosition.x + otherHalf.x - ownHalf.x, position.x, 'right-edge', other.id);
    bestX = consider(bestX, otherPosition.x - otherHalf.x - ownHalf.x - 0.12, position.x, 'adjacent-edge', other.id);
    bestX = consider(bestX, otherPosition.x + otherHalf.x + ownHalf.x + 0.12, position.x, 'adjacent-edge', other.id);

    bestY = consider(bestY, otherPosition.y, position.y, 'same-height', other.id);
    bestY = consider(bestY, otherPosition.y - otherHalf.y + ownHalf.y, position.y, 'top-edge', other.id);
    bestY = consider(bestY, otherPosition.y + otherHalf.y - ownHalf.y, position.y, 'bottom-edge', other.id);
    bestY = consider(bestY, otherPosition.y - otherHalf.y - ownHalf.y - 0.12, position.y, 'vertical-stack', other.id);
    bestY = consider(bestY, otherPosition.y + otherHalf.y + ownHalf.y + 0.12, position.y, 'vertical-stack', other.id);

    const depthDistance = Math.abs(otherPosition.z - position.z);
    if (depthDistance <= depthThreshold && (!bestZ || depthDistance < bestZ.distance)) {
      bestZ = { value: otherPosition.z, distance: depthDistance, kind: 'same-depth', otherId: other.id };
    }
  });

  if (bestX) position.x = bestX.value;
  if (bestY) position.y = bestY.value;
  if (bestZ) position.z = bestZ.value;

  if (!bestX) {
    const gridX = Math.round(position.x / 0.25) * 0.25;
    if (Math.abs(gridX - position.x) < 0.045) {
      bestX = { value: gridX, distance: Math.abs(gridX - position.x), kind: 'grid-x', otherId: 'grid' };
      position.x = gridX;
    }
  }
  if (!bestY) {
    const gridY = Math.round(position.y / 0.25) * 0.25;
    if (Math.abs(gridY - position.y) < 0.045) {
      bestY = { value: gridY, distance: Math.abs(gridY - position.y), kind: 'grid-y', otherId: 'grid' };
      position.y = gridY;
    }
  }

  const candidates = [
    bestY && { ...bestY, axis: 'y' },
    bestX && { ...bestX, axis: 'x' },
    bestZ && { ...bestZ, axis: 'z' }
  ].filter(Boolean).sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  const guide = best ? {
    key: best.axis + ':' + best.kind + ':' + best.otherId + ':' + best.value.toFixed(3),
    kind: best.kind,
    axis: best.axis,
    value: best.value,
    position: position.toArray()
  } : null;
  return { position, guide };
};

export { getScreenHalfSize, snapScreenPosition };
