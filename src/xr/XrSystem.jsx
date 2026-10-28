import React, { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';

import { setXrViewpoint } from '../systems/viewpoint.js';
import { useStore } from '../store/workspace-store.js';
import { recordEvent, recordFact } from './diagnostics.js';

/*
 * Bridges an XR session into the rest of the workspace.
 *
 * Deliberately small. Everything XR-specific that the application needs is
 * expressed through two existing abstractions rather than sprinkled through
 * the scene:
 *
 *   - the viewpoint, so face-me, the arc, depth, and focus framing follow the
 *     head pose instead of the desktop camera;
 *   - the chrome surface, so essential controls switch to in-scene geometry,
 *     because drei's <Html> renders nothing inside an immersive session.
 *
 * The workspace itself is not duplicated for XR. The same scene, the same
 * screens, and the same interaction system serve both.
 */
export const XrSystem = () => {
  const { gl } = useThree();
  const session = useXR((state) => state.session);
  const presenting = Boolean(session);

  // Point the viewpoint abstraction at the XR camera for the session's life.
  useEffect(() => {
    if (!gl || !gl.xr) return undefined;
    if (presenting) {
      setXrViewpoint(gl.xr.getCamera(), true);
    } else {
      setXrViewpoint(null, false);
    }
    return () => setXrViewpoint(null, false);
  }, [gl, presenting]);

  /*
   * Force spatial chrome while presenting, and restore the user's desktop
   * preference on exit. Without this a headset would show bezels and browser
   * textures with no controls at all, because every HTML overlay is invisible
   * inside the session.
   */
  useEffect(() => {
    if (!presenting) return undefined;
    const previousSurface = useStore.getState().uiSurface;
    useStore.getState().setUiSurface('spatial');
    useStore.getState().setInteractionMode('browse');
    /* Ask how the workspace should behave, once, at the start of each session.
     * It is a question about now rather than a stored preference: the answer
     * depends on whether the wearer is at a desk or standing in a room. */
    useStore.getState().setWorkspaceModeChosen(false);
    /* Place the workspace in front of the wearer. The layout is authored around
     * -Z, and which way they are facing when the session opens has nothing to
     * do with that, so without this it is behind them about half the time. */
    useStore.getState().refitWorkspace();
    return () => useStore.getState().setUiSurface(previousSurface);
  }, [presenting]);

  /*
   * What the session thinks it is holding.
   *
   * Controller rays are what every in-scene control is driven by, so when
   * nothing responds to pointing, the first question is whether the runtime is
   * reporting input sources at all and whether they are ray-targeted. A wearer
   * cannot answer that, and it separates "the ray never arrives" from "the ray
   * arrives and something rejects it" — which need opposite fixes.
   */
  useEffect(() => {
    if (!session) return undefined;
    const report = () => {
      const sources = Array.from(session.inputSources || []);
      recordFact('xr.inputSourceCount', sources.length);
      recordFact('xr.inputSources', sources
        .map((s) => `${s.handedness}:${s.targetRayMode}${s.gamepad ? '+pad' : ''}`)
        .join(',') || 'none');
      recordFact('ui.surface', useStore.getState().uiSurface);
      recordFact('ui.interactionMode', useStore.getState().interactionMode);
      recordFact('workspace.screenCount', useStore.getState().screens.length);
    };
    report();
    session.addEventListener('inputsourceschange', report);
    recordEvent('xr-session:begin', { mode: session.mode || null });
    return () => session.removeEventListener('inputsourceschange', report);
  }, [session]);

  return null;
};

export default XrSystem;
