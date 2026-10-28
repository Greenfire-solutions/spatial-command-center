import * as THREE from 'three';
import { clamp } from '../utils/math.js';
import { viewpointForwardHorizontal, viewpointPosition } from '../systems/viewpoint.js';

/* The reachable shell around the viewer, in metres. Anything a user grabs
 * stays inside it, whether they drag it across the view or push it away. */
const MIN_GRAB_DISTANCE = 0.9;
const MAX_GRAB_DISTANCE = 14;
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;

const clampWorldDistance = (candidate, viewerPosition, minDistance, maxDistance) => {
  const offset = candidate.clone().sub(viewerPosition);
  const distance = offset.length();
  if (distance < 0.0001) return candidate;
  if (distance < minDistance || distance > maxDistance) {
    offset.setLength(clamp(distance, minDistance, maxDistance));
    candidate.copy(viewerPosition).add(offset);
  }
  return candidate;
};

/*
 * Spatial manipulation, expressed only in spatial terms.
 *
 * Every action here takes a ray and returns a transform. Nothing reads client
 * pixels, screen-space deltas, or a viewport size, because those concepts do
 * not exist for a tracked controller or a pinching hand. A desktop mouse, an
 * XR controller, and a hand are all just ray sources feeding the same maths.
 *
 * The two gestures that used to be pixel-based are now derived from the ray
 * itself:
 *
 *   rotate — from the azimuth of the ray in the horizontal plane. Sweeping a
 *            mouse sideways and sweeping a controller sideways both change
 *            that angle, so both rotate the screen by a comparable amount.
 *
 *   scale  — from the ratio between the current and initial distance from the
 *            screen's centre to the ray's hit point. Pulling the pointer away
 *            from a screen grows it; this is also the natural degenerate case
 *            of a future two-handed pinch, where the ratio comes from the
 *            distance between hands instead.
 *
 *   depth  — from a scalar push/pull delta supplied by whatever axis the input
 *            device offers: a wheel, a shift-drag, or a thumbstick. The action
 *            stores a grab distance along the viewer's forward axis rather
 *            than a pixel offset.
 */

const rayAzimuth = (ray) => Math.atan2(ray.direction.x, ray.direction.z);

const ScreenInteraction = {
  beginGrab({ object, ray, depthMode }) {
    const viewerPosition = viewpointPosition(new THREE.Vector3());
    const viewerForward = viewpointForwardHorizontal(new THREE.Vector3());
    /* The object's WORLD position, not its local one.
     *
     * Every other quantity in this session — the ray, the viewer, the plane —
     * is world-space. Reading `object.position` mixed a local value into that,
     * which was invisible while every screen was a direct child of the scene
     * and silently wrong the moment they hung from a workspace root that
     * rotates. The caller converts back to local when it assigns. */
    const startPosition = object.getWorldPosition(new THREE.Vector3());

    const session = {
      kind: 'move',
      depthMode: Boolean(depthMode),
      startPosition,
      viewerPosition,
      viewerForward,
      startDistance: Math.max(MIN_GRAB_DISTANCE, viewerPosition.distanceTo(startPosition)),
      depthDelta: 0,
      plane: new THREE.Plane(),
      offset: new THREE.Vector3(),
      hit: new THREE.Vector3()
    };

    if (!session.depthMode) {
      // A plane through the screen, facing the viewer: dragging along it keeps
      // the screen at a stable distance while it tracks the ray.
      const planeNormal = viewerPosition.clone().sub(startPosition).normalize();
      session.plane.setFromNormalAndCoplanarPoint(planeNormal, startPosition);
      if (!ray.intersectPlane(session.plane, session.hit)) return null;
      session.offset.copy(startPosition).sub(session.hit);
    }
    return session;
  },

  /*
   * `pushPull` is a normalized scalar in roughly [-1, 1] per update, supplied
   * by whichever axis the active input device offers. It replaces the old
   * clientY pixel delta and carries no assumption about pixels or screens.
   */
  updateGrab(session, { ray, pushPull = 0 }) {
    if (session.depthMode) {
      session.depthDelta += pushPull;
      const distance = clamp(
        session.startDistance + session.depthDelta,
        MIN_GRAB_DISTANCE,
        MAX_GRAB_DISTANCE
      );
      const candidate = session.viewerPosition.clone()
        .addScaledVector(session.viewerForward, distance);
      candidate.y = session.startPosition.y;
      return clampWorldDistance(candidate, session.viewerPosition, MIN_GRAB_DISTANCE, MAX_GRAB_DISTANCE);
    }

    if (!ray.intersectPlane(session.plane, session.hit)) return null;
    /* Clamp the planar grab to the same reachable shell the depth drag uses.
     * Near-grazing rays produce enormous plane intersections, which threw a
     * screen metres away in a single frame and left it outside the view with
     * no obvious way to retrieve it. A grab should never be able to lose a
     * screen. */
    return clampWorldDistance(
      session.hit.clone().add(session.offset),
      session.viewerPosition,
      MIN_GRAB_DISTANCE,
      MAX_GRAB_DISTANCE
    );
  },

  beginRotate({ object, ray }) {
    return {
      kind: 'rotate',
      startYaw: object.rotation.y,
      startAzimuth: rayAzimuth(ray),
      /* Sweeping a ray across a screen covers a small angle, so the gesture is
       * geared up to keep the wrist travel required for a half turn sane. The
       * factor is unitless and therefore identical for every input source. */
      gain: 2.6
    };
  },

  updateRotate(session, { ray, snapDegrees }) {
    let delta = rayAzimuth(ray) - session.startAzimuth;
    // Keep the shortest way round when the azimuth wraps at +/- pi.
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const rawYaw = session.startYaw - delta * session.gain;
    const snap = Number(snapDegrees) * (Math.PI / 180);
    return snap > 0 ? Math.round(rawYaw / snap) * snap : rawYaw;
  },

  beginScale({ object, ray }) {
    const centre = object.getWorldPosition(new THREE.Vector3());
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane();
    const viewerPosition = viewpointPosition(new THREE.Vector3());
    plane.setFromNormalAndCoplanarPoint(viewerPosition.clone().sub(centre).normalize(), centre);
    if (!ray.intersectPlane(plane, hit)) return null;

    const startRadius = hit.distanceTo(centre);
    if (startRadius < 0.0001) return null;

    return {
      kind: 'scale',
      startScale: object.scale.clone(),
      startRadius,
      centre,
      plane,
      hit: new THREE.Vector3()
    };
  },

  updateScale(session, { ray }) {
    if (!ray.intersectPlane(session.plane, session.hit)) return null;
    const radius = session.hit.distanceTo(session.centre);
    if (radius < 0.0001) return null;
    const ratio = radius / session.startRadius;
    const factor = clamp(
      ratio,
      MIN_SCALE / session.startScale.x,
      MAX_SCALE / session.startScale.x
    );
    return session.startScale.clone().multiplyScalar(factor);
  },

  /*
   * Two-handed scale, the XR-native form of the same action. Both hands supply
   * a position; the ratio of their separation drives the scale. Kept alongside
   * the single-ray form because they share the clamp and the session shape.
   */
  beginPinchScale({ object, firstPoint, secondPoint }) {
    const separation = firstPoint.distanceTo(secondPoint);
    if (separation < 0.0001) return null;
    return {
      kind: 'scale',
      startScale: object.scale.clone(),
      startSeparation: separation
    };
  },

  updatePinchScale(session, { firstPoint, secondPoint }) {
    const separation = firstPoint.distanceTo(secondPoint);
    if (separation < 0.0001) return null;
    const factor = clamp(
      separation / session.startSeparation,
      MIN_SCALE / session.startScale.x,
      MAX_SCALE / session.startScale.x
    );
    return session.startScale.clone().multiplyScalar(factor);
  }
};

export {
  ScreenInteraction,
  clampWorldDistance,
  MIN_GRAB_DISTANCE,
  MAX_GRAB_DISTANCE,
  MIN_SCALE,
  MAX_SCALE
};
