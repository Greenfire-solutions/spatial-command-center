/*
 * Flight locomotion and session recentering.
 *
 * Both concerns own the same thing, the XR origin, so they live together. The
 * origin maps reference space into the world, which means moving it moves the
 * player while every world coordinate, every screen transform, and all of the
 * ray-based interaction from Phase 4 stay exactly as they are. Nothing here
 * touches the workspace.
 *
 * Controls, chosen so the two sticks split translation from orientation the way
 * a helicopter's collective and cyclic do:
 *
 *   left thumbstick    strafe (X) and forward/back (Y), relative to gaze yaw
 *   right thumbstick   turn (X) and altitude (Y)
 *   either squeeze     boost, for crossing the room rather than nudging
 *
 * With ?locked=1 the viewer is pinned: translation and altitude are dropped and
 * either thumbstick's X axis spins the world about the head.
 *
 * Locomotion yields while a screen is being manipulated. The application binds
 * thumbsticks to page scroll and depth push during a grab, and two systems
 * fighting over one axis is worse than either behaviour alone.
 */

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { XROrigin, useXR, useXRInputSourceState } from '@react-three/xr';
import { Box3, Euler, Quaternion, Vector3 } from 'three';

import { useStore } from '../store/workspace-store.js';
import { sceneRuntime } from '../systems/scene-runtime.js';

/*
 * ?locked=1 pins the viewer in place and turns the sticks into a turntable.
 *
 * For the Ring layout flying is the wrong verb. The panels close a circle
 * around one spot, and that spot is the only place the geometry is correct:
 * drift a metre and the ring is no longer edge to edge from where you sit.
 * Translation and altitude are dropped rather than merely slowed, and both
 * sticks steer, since with nothing to fly there is no reason to reserve a hand.
 *
 * Turning still rotates about the head rather than the world origin, which is
 * what makes it read as the room spinning around you rather than you being
 * swung through an arc.
 */
const isLocked = () => {
  try {
    return new URLSearchParams(window.location.search).get('locked') === '1';
  } catch {
    return false;
  }
};

const DEFAULT_STANDOFF = 2.4;
const DEADZONE = 0.15;
const MOVE_SPEED = 2.0;      // metres per second
const CLIMB_SPEED = 1.4;     // metres per second
const TURN_SPEED = Math.PI * 0.6; // radians per second
const BOOST = 3;
const MIN_ALTITUDE = -3;
const MAX_ALTITUDE = 12;

/* Quadratic response past the deadzone: fine control near centre, full speed at
 * the rim. A linear stick makes precise positioning near a screen unpleasant. */
const axis = (value) => {
  const raw = typeof value === 'number' ? value : 0;
  if (Math.abs(raw) < DEADZONE) return 0;
  const scaled = (Math.abs(raw) - DEADZONE) / (1 - DEADZONE);
  return Math.sign(raw) * scaled * scaled;
};

const stick = (controller) => {
  const pad = controller && controller.gamepad;
  const thumb = pad && pad['xr-standard-thumbstick'];
  return {
    x: axis(thumb && thumb.xAxis),
    y: axis(thumb && thumb.yAxis)
  };
};

const squeezed = (controller) => {
  const pad = controller && controller.gamepad;
  const grip = pad && pad['xr-standard-squeeze'];
  return Boolean(grip && (grip.state === 'pressed' || (grip.button ?? 0) > 0.5));
};

const headYawFrom = (quaternion) => {
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
  return Math.atan2(forward.x, forward.z);
};

export const XrNavigation = ({ standoff = DEFAULT_STANDOFF }) => {
  const originRef = useRef(null);
  const { gl, scene } = useThree();
  const session = useXR((state) => state.session);
  const presenting = Boolean(session);
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const pendingRecentre = useRef(false);

  const headPosition = useRef(new Vector3());
  const headQuaternion = useRef(new Quaternion());
  const move = useRef(new Vector3());
  const lockedRef = useRef(isLocked());
  const pivot = useRef(new Vector3());
  const offset = useRef(new Vector3());

  useEffect(() => {
    /* Deferred by a frame: the XR camera has no pose until one has been drawn. */
    pendingRecentre.current = presenting;
    if (!presenting && originRef.current) {
      originRef.current.position.set(0, 0, 0);
      originRef.current.rotation.set(0, 0, 0);
    }
  }, [presenting]);

  useFrame((_, delta) => {
    const origin = originRef.current;
    if (!origin || !gl.xr || !gl.xr.isPresenting) return;

    const camera = gl.xr.getCamera();
    camera.getWorldPosition(headPosition.current);
    camera.getWorldQuaternion(headQuaternion.current);
    if (headPosition.current.lengthSq() === 0) return;

    /*
     * Recentre once, on entry.
     *
     * The workspace sits at fixed world coordinates while a headset decides
     * your facing from its own guardian, so the arc can begin behind you.
     * Solving for the origin transform that lands the head at a chosen pose
     * fixes it without moving a single screen.
     */
    if (pendingRecentre.current) {
      /*
       * Measure the screens themselves, not their textures.
       *
       * This previously looked for meshes named chromium-texture-*, which only
       * exist once a browser source has painted. With a provider that is slow
       * or offline the bounds stayed empty, the recentre never ran, and the
       * workspace was left wherever the runtime happened to face — measured at
       * 195 degrees behind the viewer, which reads as an empty black room.
       *
       * sceneRuntime.screenObjects is the authoritative list and is populated
       * as soon as a screen exists, painted or not.
       */
      const bounds = new Box3();
      for (const object of sceneRuntime.screenObjects.values()) {
        if (object) bounds.expandByObject(object);
      }
      if (bounds.isEmpty()) return;

      const centre = new Vector3();
      bounds.getCenter(centre);

      /*
       * A layout that surrounds you is entered, not approached.
       *
       * Recentring stands the viewer back by `standoff` so an arc fills the view.
       * That is right for an arc and exactly wrong for a ring: it parks you outside
       * the circle looking at the backs of half the panels, with no obvious way in,
       * which reads as the panels being rotated wrongly rather than as you being
       * outside them.
       *
       * Detected rather than declared, so any surrounding layout benefits: take each
       * screen's bearing from the centre and find the widest gap between neighbours.
       * A ring has no large gap; an arc has one spanning everything behind you.
       */
      const bearings = [];
      for (const object of sceneRuntime.screenObjects.values()) {
        if (!object) continue;
        bearings.push(Math.atan2(object.position.x - centre.x, object.position.z - centre.z));
      }
      bearings.sort((a, b) => a - b);
      let widestGap = 0;
      for (let index = 0; index < bearings.length; index += 1) {
        const next = index + 1 < bearings.length ? bearings[index + 1] : bearings[0] + Math.PI * 2;
        widestGap = Math.max(widestGap, next - bearings[index]);
      }
      const surrounds = bearings.length > 2 && widestGap < (Math.PI * 2) / 3;
      const standoffHere = surrounds ? 0 : standoff;

      /* With origin rotation psi and position p the head sits at
       *   world = p + Ry(psi) * headLocal
       * and looks along (psi + headYaw). Choosing the target pose fixes both. */
      const psi = 0 - headYawFrom(headQuaternion.current);
      const rotated = headPosition.current.clone().applyEuler(new Euler(0, psi, 0));
      origin.rotation.set(0, psi, 0);
      origin.position
        .set(centre.x, headPosition.current.y, centre.z + standoffHere)
        .sub(rotated);
      pendingRecentre.current = false;
      return;
    }

    if (useStore.getState().isManipulatingScreen) return;

    const l = stick(left);
    const r = stick(right);
    if (!l.x && !l.y && !r.x && !r.y) return;

    const boost = squeezed(left) || squeezed(right) ? BOOST : 1;
    const yaw = headYawFrom(headQuaternion.current);
    /* Locked: no translation, no altitude, and either stick spins the world. */
    if (lockedRef.current) {
      const spin = r.x || l.x;
      if (spin) {
        const turn = -spin * TURN_SPEED * boost * delta;
        pivot.current.copy(headPosition.current);
        offset.current.copy(origin.position).sub(pivot.current).applyEuler(new Euler(0, turn, 0));
        origin.position.copy(pivot.current).add(offset.current);
        origin.rotation.y += turn;
      }
      return;
    }

    /* Translate in the horizontal plane relative to where the user is looking,
     * so "forward" always means forward from their point of view. Pushing the
     * stick away from you flies you toward what you are facing. */
    if (l.x || l.y) {
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      /*
       * right = cross(forward, up), which for forward (fx, 0, fz) with Y up is
       * (-fz, 0, fx). Getting that sign backwards sends the player left when
       * the stick goes right, which is what the first version did.
       */
      move.current.set(
        (-l.y * forwardX) - (l.x * forwardZ),
        0,
        (-l.y * forwardZ) + (l.x * forwardX)
      );
      origin.position.addScaledVector(move.current, MOVE_SPEED * boost * delta);
    }

    /* Altitude. This is what makes it a helicopter rather than a walk: the
     * workspace is a wall of screens spanning nearly two and a half metres
     * vertically, and reading the top row means rising to meet it. */
    if (r.y) {
      origin.position.y = Math.min(
        MAX_ALTITUDE,
        Math.max(MIN_ALTITUDE, origin.position.y - r.y * CLIMB_SPEED * boost * delta)
      );
    }

    /* Turn about the viewer, not about the world origin. Rotating the origin
     * alone would swing the user through an arc, which is both disorienting and
     * a reliable way to induce motion sickness. */
    if (r.x) {
      const turn = -r.x * TURN_SPEED * delta;
      pivot.current.copy(headPosition.current);
      offset.current.copy(origin.position).sub(pivot.current).applyEuler(new Euler(0, turn, 0));
      origin.position.copy(pivot.current).add(offset.current);
      origin.rotation.y += turn;
    }
  });

  return <XROrigin ref={originRef} />;
};

export default XrNavigation;
