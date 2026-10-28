import React, { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import { useStore } from '../store/workspace-store.js';
import { viewpointPosition, viewpointForwardHorizontal } from './viewpoint.js';
import { createFollowState, stepFollow } from './follow-behaviour.js';
import { fitWorkspaceToView } from './workspace-fit.js';

/*
 * The node every window hangs from, and the only node that knows about the two
 * workspace modes.
 *
 * WORLD and FOLLOW are not two ways of moving windows. They are one transform
 * on one parent, and they differ in exactly one thing: what that transform is
 * anchored to.
 *
 *   The FIT decides where the workspace sits relative to a person — turned to
 *   face them, at a comfortable distance, scaled so the whole layout reads like
 *   a desk rather than a room. It is expressed as an offset in the viewer's own
 *   frame, not as world coordinates, which is what makes the next line work.
 *
 *   WORLD freezes the anchor at the moment of the fit. The workspace stays in
 *   the room; you walk around it.
 *
 *   FOLLOW tracks the anchor to the live viewer, lazily. The workspace comes
 *   with you, holding exactly the same shape.
 *
 * One relationship, two anchors. No window transform is ever rewritten, so
 * switching modes cannot reload a page or disturb an arrangement, and it costs
 * one matrix write per frame rather than one per window.
 *
 * Deliberately NOT under XROrigin: locomotion moves the origin, and parenting
 * the workspace to it would drag the windows along when you fly, which is the
 * opposite of WORLD.
 */

const scratchViewer = new THREE.Vector3();
const scratchForward = new THREE.Vector3();

export const WORKSPACE_ROOT_NAME = 'workspace-root';

/* Compose an anchor (a yaw and a position in the world) with an offset
 * expressed in that anchor's frame. */
const place = (group, anchorYaw, anchorPosition, offset) => {
  const cos = Math.cos(anchorYaw);
  const sin = Math.sin(anchorYaw);
  group.position.set(
    anchorPosition[0] + offset.position[0] * cos + offset.position[2] * sin,
    anchorPosition[1] + offset.position[1],
    anchorPosition[2] - offset.position[0] * sin + offset.position[2] * cos
  );
  group.rotation.set(0, anchorYaw + offset.yaw, 0);
  group.scale.setScalar(offset.scale);
};

export const WorkspaceRoot = ({ children }) => {
  const groupRef = useRef(null);
  const followRef = useRef(createFollowState());
  const offsetRef = useRef(null);
  const anchorRef = useRef(null);
  const modeRef = useRef(null);
  const nonceRef = useRef(-1);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const state = useStore.getState();
    const mode = state.workspaceMode === 'follow' ? 'follow' : 'world';

    viewpointPosition(scratchViewer);
    viewpointForwardHorizontal(scratchForward);
    const viewerYaw = Math.atan2(scratchForward.x, scratchForward.z);
    const viewer = [scratchViewer.x, scratchViewer.y, scratchViewer.z];

    /*
     * Refit.
     *
     * Requested on entering a session, and by the "Bring to me" control — which
     * has to exist, because a workspace that has ended up behind you is
     * otherwise unrecoverable without leaving the headset.
     *
     * The layout is authored in world coordinates around -Z. Which way the
     * wearer is facing when a session opens is decided by the runtime and by
     * where they happened to be standing, so roughly half the time the authored
     * front points away from them. No preset can fix that; only a fit at
     * session time can.
     */
    if (nonceRef.current !== state.workspaceFitNonce) {
      nonceRef.current = state.workspaceFitNonce;
      const fit = fitWorkspaceToView({ screens: state.screens, viewerPosition: viewer, viewerYaw });
      if (fit) {
        /* Store the fit as an offset in the VIEWER's frame rather than as world
         * coordinates. That single choice is what lets WORLD and FOLLOW share
         * it: one freezes the frame, the other tracks it. */
        const cos = Math.cos(-viewerYaw);
        const sin = Math.sin(-viewerYaw);
        const dx = fit.position[0] - viewer[0];
        const dy = fit.position[1] - viewer[1];
        const dz = fit.position[2] - viewer[2];
        offsetRef.current = {
          position: [dx * cos + dz * sin, dy, -dx * sin + dz * cos],
          yaw: fit.yaw - viewerYaw,
          scale: fit.scale
        };
        anchorRef.current = { yaw: viewerYaw, position: [...viewer] };
        followRef.current = createFollowState({ yaw: viewerYaw, position: [...viewer] });
        modeRef.current = null;
      }
    }

    const offset = offsetRef.current;
    if (!offset) return;

    if (mode === 'world') {
      /* Frozen at the anchor captured when the workspace was fitted. Written
       * once on entering the mode, then left entirely alone — a workspace
       * nobody is moving should cost nothing at all. */
      if (modeRef.current !== 'world') {
        modeRef.current = 'world';
        place(group, anchorRef.current.yaw, anchorRef.current.position, offset);
      }
      return;
    }

    if (modeRef.current !== 'follow') {
      /* Entering FOLLOW snaps rather than eases: gliding the whole workspace
       * across the room in front of somebody is the one motion guaranteed to be
       * unpleasant. */
      modeRef.current = 'follow';
      followRef.current = createFollowState({ yaw: viewerYaw, position: [...viewer] });
      place(group, viewerYaw, viewer, offset);
      return;
    }

    followRef.current = stepFollow(followRef.current, {
      viewerYaw,
      viewerPosition: viewer,
      delta,
      /* A workspace that slides while a window is being dragged moves the frame
       * of reference mid-gesture. Manipulation wins; following waits. */
      frozen: state.isManipulatingScreen
    });

    const follow = followRef.current;
    if (!follow.moved) return;
    place(group, follow.yaw, follow.position, offset);
  });

  return <group ref={groupRef} name={WORKSPACE_ROOT_NAME}>{children}</group>;
};

export default WorkspaceRoot;
