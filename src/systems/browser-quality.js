import * as THREE from 'three';
import { viewpointCamera, viewpointPosition } from './viewpoint.js';

/*
 * Adaptive quality for browser surfaces.
 *
 * A workspace can hold many live browser sources. Painting all of them at full
 * rate spends CPU on screens nobody is reading, and once frames cross a
 * network it spends bandwidth too. The policy here is deliberately about
 * attention rather than about global quality: the screen you are working on
 * stays at full rate, and everything else degrades in proportion to how little
 * you can currently see of it.
 *
 * Nothing here reduces resolution or visual fidelity of what the user is
 * actually looking at. A distant screen simply updates less often, and a
 * screen behind you stops painting until it comes back into view — the page
 * keeps running and resumes instantly, because pausing is not destruction.
 */

export const QUALITY_TIERS = Object.freeze({
  FOCUSED: 'focused',
  NEAR: 'near',
  FAR: 'far',
  HIDDEN: 'hidden'
});

export const TIER_SETTINGS = Object.freeze({
  [QUALITY_TIERS.FOCUSED]: { frameRate: 30, painting: true },
  [QUALITY_TIERS.NEAR]: { frameRate: 20, painting: true },
  [QUALITY_TIERS.FAR]: { frameRate: 8, painting: true },
  [QUALITY_TIERS.HIDDEN]: { frameRate: 2, painting: false }
});

const NEAR_DISTANCE = 4;
const FAR_DISTANCE = 9;

const frustum = new THREE.Frustum();
const viewProjection = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const worldPosition = new THREE.Vector3();
const viewer = new THREE.Vector3();

/*
 * Decide a tier for one screen.
 *
 * `object` is the live Object3D; `radius` is a generous bounding radius so a
 * partially visible screen still counts as visible.
 */
export const qualityTierFor = ({ object, radius, isFocused, isVisible, distance }) => {
  if (isFocused) return QUALITY_TIERS.FOCUSED;
  if (!isVisible) return QUALITY_TIERS.HIDDEN;
  if (distance <= NEAR_DISTANCE) return QUALITY_TIERS.NEAR;
  if (distance <= FAR_DISTANCE) return QUALITY_TIERS.FAR;
  return QUALITY_TIERS.FAR;
};

/*
 * Evaluate every live browser surface and return the tier each one should be
 * in. Pure apart from reading the scene graph, so the policy is testable
 * without a renderer.
 */
export const evaluateQuality = ({ screens, screenObjects, focusedScreenId }) => {
  const camera = viewpointCamera();
  const decisions = new Map();
  if (!camera) return decisions;

  camera.updateMatrixWorld?.();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProjection);
  viewpointPosition(viewer);

  for (const screen of screens) {
    if (screen.source.type !== 'chromium') continue;
    const object = screenObjects.get(screen.id);
    if (!object) continue;

    object.getWorldPosition(worldPosition);
    const radius = Math.max(screen.size[0] * object.scale.x, screen.size[1] * object.scale.y) * 0.75;
    sphere.set(worldPosition, radius);

    const isVisible = frustum.intersectsSphere(sphere);
    const distance = worldPosition.distanceTo(viewer);
    const isFocused = screen.id === focusedScreenId;

    decisions.set(screen.source.sourceId, {
      screenId: screen.id,
      tier: qualityTierFor({ object, radius, isFocused, isVisible, distance }),
      distance,
      isVisible
    });
  }
  return decisions;
};

/*
 * Applies decisions through a provider, sending a request only when a source's
 * tier actually changes. Without this the policy would issue an IPC call per
 * source per evaluation, which would cost more than it saves.
 */
export class BrowserQualityController {
  constructor({ provider, onError } = {}) {
    this.provider = provider;
    this.onError = onError;
    this.applied = new Map();
  }

  setProvider(provider) {
    if (this.provider === provider) return;
    this.provider = provider;
    this.applied.clear();
  }

  apply(decisions) {
    if (!this.provider || !this.provider.available) return 0;
    let changes = 0;

    for (const [sourceId, decision] of decisions) {
      if (this.applied.get(sourceId) === decision.tier) continue;
      const settings = TIER_SETTINGS[decision.tier];
      if (!settings) continue;
      this.applied.set(sourceId, decision.tier);
      changes += 1;
      try {
        const result = this.provider.setQuality(sourceId, settings);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this.onError && this.onError(error));
        }
      } catch (error) {
        if (this.onError) this.onError(error);
      }
    }

    // Forget sources that no longer exist so a recreated id starts clean.
    for (const sourceId of [...this.applied.keys()]) {
      if (!decisions.has(sourceId)) this.applied.delete(sourceId);
    }
    return changes;
  }

  appliedTier(sourceId) {
    return this.applied.get(sourceId) || null;
  }

  reset() {
    this.applied.clear();
  }
}
