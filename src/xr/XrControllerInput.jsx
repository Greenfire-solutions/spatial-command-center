import React, { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';

import { useStore } from '../store/workspace-store.js';
import { sceneRuntime, objectTransform } from '../systems/scene-runtime.js';
import { viewpointPosition } from '../systems/viewpoint.js';
import { resolveBrowserProvider } from '../providers/index.js';
import {
  MAX_GRAB_DISTANCE,
  MIN_GRAB_DISTANCE,
  ScreenInteraction,
  clampWorldDistance
} from '../interaction/screen-interaction.js';
import { thumbstickToPushPull, thumbstickToWheelDelta } from './xr-interaction.js';
import { recordEvent } from './diagnostics.js';

/*
 * Controller input for an immersive session.
 *
 * Trigger and pinch need no code here: @react-three/xr synthesizes pointer
 * events from controller rays and hand pinches, so the spatial buttons and the
 * browser surfaces already respond to them through the same handlers a mouse
 * uses. That is the payoff from making interaction ray-based in Phase 4.
 *
 * What does need implementing is everything the mouse expressed through
 * modifiers and a wheel, because a controller expresses it through a grip
 * button and a thumbstick instead:
 *
 *   squeeze              grab the screen the ray is pointing at
 *   squeeze + move       move it, at the distance it was grabbed
 *   thumbstick Y         scroll the page under the ray, or in Arrange Mode
 *                        push the held screen away and pull it closer
 *   both squeezes        resize, from the distance between the controllers
 *
 * Everything routes into the same ScreenInteraction actions the desktop uses.
 * There is no XR-specific transform maths anywhere in this file.
 */

const SCROLL_INTERVAL_MS = 50;

const controllerRay = (state, target) => {
  const object = state?.object;
  if (!object) return null;
  object.updateMatrixWorld();
  const origin = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(object.matrixWorld))
    .normalize();
  return target.set(origin, direction);
};

/* Which screen a ray is pointing at, and where it hits. */
const pickScreen = (ray, raycaster) => {
  raycaster.set(ray.origin, ray.direction);
  raycaster.far = MAX_GRAB_DISTANCE;
  const candidates = [];
  for (const [screenId, object] of sceneRuntime.screenObjects) candidates.push({ screenId, object });
  let best = null;
  for (const candidate of candidates) {
    const hits = raycaster.intersectObject(candidate.object, true);
    if (hits.length && (!best || hits[0].distance < best.distance)) {
      best = { screenId: candidate.screenId, object: candidate.object, distance: hits[0].distance, point: hits[0].point, uv: hits[0].uv };
    }
  }
  return best;
};

const isPressed = (component) => component?.state === 'pressed';

/* A transform is only worth writing if every component of it is a real number.
 *
 * A single NaN reaching the store is permanent: commitScreenTransform persists it,
 * persistence.js serializes it, and the screen is gone across restarts with no way
 * to retrieve it. Refusing the write costs one frame of staleness instead.
 *
 * Note the shape being checked. objectTransform returns arrays, and its rotation
 * carries the Euler order as a fourth element: [x, y, z, 'YXZ']. Testing .x/.y/.z
 * on those is always false, which turns every guarded commit into a silent no-op —
 * the window stops being stuck but never records where it got to, and snaps back on
 * the next store sync. */
const transformIsFinite = (transform) => Boolean(transform)
  && [transform.position, transform.scale].every(
    (part) => Array.isArray(part) && part.length >= 3 && part.slice(0, 3).every(Number.isFinite)
  )
  && Array.isArray(transform.rotation)
  && transform.rotation.slice(0, 3).every(Number.isFinite);

/* Whether a tracked input is presently giving us a pose we can act on.
 *
 * @react-three/xr keeps rendering a controller object whose matrix simply stops
 * updating when the runtime stops reporting a pose, so "the object exists" is not
 * the same question as "the pose is good". */
const poseIsUsable = (controller) => {
  const object = controller?.object;
  if (!object) return false;
  object.updateMatrixWorld();
  return object.matrixWorld.elements.every(Number.isFinite);
};

export const XrControllerInput = () => {
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const xrSession = useXR((store) => store.session);

  const grabRef = useRef(null);
  const pinchRef = useRef(null);
  const rayRef = useRef(new THREE.Ray());
  const otherRayRef = useRef(new THREE.Ray());
  const raycasterRef = useRef(new THREE.Raycaster());
  const lastScrollRef = useRef(0);

  /* Every gesture leaves through here, whether the user released it or the device
   * carrying it disappeared.
   *
   * Tracking loss deliberately has no cleanup path of its own. A second path is a
   * second thing to forget, and forgetting it was exactly the defect this replaced:
   * a controller vanishing mid-drag left the window held forever, and because
   * XrNavigation stands down while a manipulation is in flight, locomotion died
   * with it. Only leaving the session recovered.
   *
   * The transform written is the last one observed while the pose was good — not
   * whatever the object happens to hold now, which may have been computed from a
   * ray that was already stale. */
  const settleGesture = (reason) => {
    const commit = (session) => {
      if (!session) return;
      const { screenId, object, lastValid } = session;
      const transform = transformIsFinite(lastValid)
        ? lastValid
        : (object ? objectTransform(object) : null);
      if (!transformIsFinite(transform)) return;
      if (object) {
        object.position.fromArray(transform.position);
        object.rotation.set(
          transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]
        );
        object.scale.fromArray(transform.scale);
      }
      useStore.getState().commitScreenTransform(
        screenId, transform.position, transform.rotation, transform.scale
      );
    };

    const settled = grabRef.current || pinchRef.current;
    const had = Boolean(settled);
    commit(pinchRef.current);
    commit(grabRef.current);
    pinchRef.current = null;
    grabRef.current = null;
    if (had) {
      useStore.getState().setManipulatingScreen(false);
      /* Reported, because in a headset an unwind is otherwise invisible: the window
       * simply stops following the hand and there is nothing to read. This is the
       * one line that turns "it let go and I don't know why" into a cause. */
      recordEvent('gesture.unwind', {
        reason,
        screenId: settled.screenId ?? null,
        committedFromLastValid: transformIsFinite(settled.lastValid)
      });
    }
    return had;
  };

  useFrame(() => {
    const session = xrSession;

    /* Per the WebXR specification, input is not processed while the session is
     * blurred or hidden and every input-source pose reports null. On Quest that is
     * every system menu, permission prompt and keyboard. Reading buttons through it
     * would process input the user never gave. */
    if (session && session.visibilityState !== 'visible') {
      settleGesture('session-not-visible');
      return;
    }

    /* A device that is holding something and has stopped reporting a usable pose is
     * the tracking-loss case, and it is a state that drives the unwind rather than a
     * condition that skips it. */
    const usable = { left: poseIsUsable(left), right: poseIsUsable(right) };
    const holder = grabRef.current?.handedness;
    if (holder && !usable[holder]) {
      settleGesture('holder-lost');
    }
    if (pinchRef.current && !(usable.left && usable.right)) {
      settleGesture('pinch-partner-lost');
    }

    const controllers = [left, right].filter((controller) => controller && poseIsUsable(controller));
    if (!controllers.length) {
      settleGesture('no-controllers');
      return;
    }

    const state = useStore.getState();
    const arranging = state.interactionMode === 'arrange';

    const leftSqueeze = usable.left && isPressed(left?.gamepad?.['xr-standard-squeeze']);
    const rightSqueeze = usable.right && isPressed(right?.gamepad?.['xr-standard-squeeze']);

    // ---- two-handed resize -------------------------------------------------
    const pinching = leftSqueeze && rightSqueeze && usable.left && usable.right;
    if (pinching) {
      const leftPoint = new THREE.Vector3().setFromMatrixPosition(left.object.matrixWorld);
      const rightPoint = new THREE.Vector3().setFromMatrixPosition(right.object.matrixWorld);

      if (!pinchRef.current) {
        /* Resize whatever is already held, or whatever the right ray points at. The
         * held grab is handed over rather than abandoned, so its transform is
         * committed exactly once and by the same path as any other release. */
        const held = grabRef.current?.screenId
          || pickScreen(controllerRay(right, rayRef.current) || rayRef.current, raycasterRef.current)?.screenId;
        const object = held ? sceneRuntime.screenObjects.get(held) : null;
        const screen = held ? state.screens.find((candidate) => candidate.id === held) : null;
        if (object && screen && !screen.locked) {
          settleGesture('handover-to-pinch');
          pinchRef.current = {
            screenId: held,
            object,
            lastValid: objectTransform(object),
            session: ScreenInteraction.beginPinchScale({ object, firstPoint: leftPoint, secondPoint: rightPoint })
          };
          useStore.getState().setSelectedScreen(held);
          useStore.getState().setManipulatingScreen(true, 'scale');
        }
      } else if (pinchRef.current.session) {
        const next = ScreenInteraction.updatePinchScale(pinchRef.current.session, {
          firstPoint: leftPoint,
          secondPoint: rightPoint
        });
        if (next) {
          pinchRef.current.object.scale.copy(next);
          const observed = objectTransform(pinchRef.current.object);
          if (transformIsFinite(observed)) pinchRef.current.lastValid = observed;
        }
      }
    } else if (pinchRef.current) {
      settleGesture('pinch-released');
    }

    // ---- single-handed grab and move --------------------------------------
    /* Skipped while both hands are pinching, but no longer by returning early: the
     * releases below must still run on the frame a pinch ends. */
    if (!pinching) {
      for (const controller of controllers) {
        const handedness = controller.inputSource?.handedness || 'right';
        const squeezing = isPressed(controller.gamepad?.['xr-standard-squeeze']);
        const ray = controllerRay(controller, rayRef.current);
        if (!ray) continue;

        const grab = grabRef.current;

        if (squeezing && !grab) {
          const hit = pickScreen(ray, raycasterRef.current);
          if (hit) {
            const screen = state.screens.find((candidate) => candidate.id === hit.screenId);
            if (screen && !screen.locked) {
              const grabSession = ScreenInteraction.beginGrab({ object: hit.object, ray, depthMode: false });
              if (grabSession) {
                grabRef.current = {
                  handedness,
                  screenId: hit.screenId,
                  object: hit.object,
                  session: grabSession,
                  /* The fallback if the very first update arrives already invalid. */
                  lastValid: objectTransform(hit.object)
                };
                useStore.getState().setSelectedScreen(hit.screenId);
                useStore.getState().setManipulatingScreen(true, 'move');
              }
            }
          }
        } else if (grab && grab.handedness === handedness) {
          if (squeezing) {
            const next = ScreenInteraction.updateGrab(grab.session, { ray, pushPull: 0 });
            if (next && [next.x, next.y, next.z].every(Number.isFinite)) {
              grab.object.position.copy(next);
              const observed = objectTransform(grab.object);
              if (transformIsFinite(observed)) grab.lastValid = observed;
            }
          } else {
            settleGesture('released');
          }
        }
      }
    }

    // ---- thumbstick: scroll a page, or push/pull a held screen -------------
    for (const controller of controllers) {
      const stick = controller.gamepad?.['xr-standard-thumbstick'];
      const axis = Number(stick?.yAxis) || 0;
      if (!axis) continue;

      const grab = grabRef.current;
      if (arranging || grab) {
        // Push and pull along the viewer's forward axis.
        const target = grab?.object
          || (state.selectedScreen ? sceneRuntime.screenObjects.get(state.selectedScreen) : null);
        if (!target) continue;
        const screen = state.screens.find((candidate) => (
          candidate.id === (grab?.screenId || state.selectedScreen)
        ));
        if (!screen || screen.locked) continue;

        const pushPull = thumbstickToPushPull(axis);
        if (!pushPull) continue;
        /* The viewpoint abstraction exists so this is the head pose in a session and
         * the orbit camera on the desktop. Reading sceneRuntime.camera directly
         * bypassed it and pushed screens away from wherever the desktop camera
         * happened to be, which is not where the user is standing. */
        const viewer = viewpointPosition(new THREE.Vector3());
        const direction = target.position.clone().sub(viewer);
        direction.y = 0;
        if (direction.lengthSq() < 0.0001) continue;
        direction.normalize();
        const candidate = target.position.clone().addScaledVector(direction, pushPull * 12);
        clampWorldDistance(candidate, viewer, MIN_GRAB_DISTANCE, MAX_GRAB_DISTANCE);
        target.position.copy(candidate);
        continue;
      }

      // Otherwise scroll the browser surface under this controller's ray.
      const now = performance.now();
      if (now - lastScrollRef.current < SCROLL_INTERVAL_MS) continue;
      const ray = controllerRay(controller, otherRayRef.current);
      if (!ray) continue;
      const hit = pickScreen(ray, raycasterRef.current);
      if (!hit || !hit.uv) continue;
      const screen = state.screens.find((candidate) => candidate.id === hit.screenId);
      if (!screen || screen.source.type !== 'chromium' || !screen.source.sourceId) continue;

      const provider = resolveBrowserProvider();
      if (!provider.available) continue;

      const deltaY = thumbstickToWheelDelta(axis);
      if (!deltaY) continue;
      lastScrollRef.current = now;

      const width = screen.source.browserWidth || 1280;
      const height = screen.source.browserHeight || 800;
      Promise.resolve(provider.sendWheelEvent(screen.source.sourceId, {
        type: 'mouseWheel',
        x: Math.min(width - 1, Math.max(0, Math.round(hit.uv.x * width))),
        y: Math.min(height - 1, Math.max(0, Math.round((1 - hit.uv.y) * height))),
        deltaX: 0,
        deltaY,
        wheelTicksX: 0,
        wheelTicksY: Math.round(deltaY / 120),
        hasPreciseScrollingDeltas: true,
        canScroll: true,
        modifiers: []
      })).catch(() => {
        // A scroll that misses is not worth surfacing to the user.
      });
    }
  });

  return null;
};

export default XrControllerInput;
