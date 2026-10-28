/*
 * An in-scene diagnostics panel.
 *
 * Two jobs, both of which only matter inside a headset:
 *
 *   1. It is the control. If this panel is visible and the workspace is not,
 *      the renderer, the XR session, and the camera are all working and the
 *      fault is in the workspace content. If this panel is also invisible, the
 *      fault is upstream of the scene graph entirely. Either answer removes
 *      most of the search space.
 *
 *   2. It reports live state where a DOM overlay cannot, because <Html>
 *      renders nothing inside an immersive session.
 *
 * Deliberately built from primitives that cannot themselves fail: unlit
 * materials, no environment map, no textures, no suspending resource. If
 * anything in the scene is going to draw, this will.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/workspace-store.js';
import { useFrame, useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { Box3, Vector3 } from 'three';
import { useXR } from '@react-three/xr';

import { captureScene } from './scene-capture.js';
import { collectSourceInventory } from './source-inventory.js';
import {
  diagnosticsSnapshot,
  noteFrame,
  recordEvent,
  recordFact,
  recordRendererFacts
} from './diagnostics.js';

const LINE_HEIGHT = 0.052;
const PANEL_WIDTH = 1.35;

const Line = ({ index, children, color = '#d8e6ff' }) => (
  <Text
    position={[-PANEL_WIDTH / 2 + 0.05, 0.30 - index * LINE_HEIGHT, 0.002]}
    fontSize={0.038}
    color={color}
    anchorX="left"
    anchorY="middle"
    maxWidth={PANEL_WIDTH - 0.1}
    outlineWidth={0.002}
    outlineColor="#000000"
  >
    {children}
  </Text>
);

const captureEnabled = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('view');

export const DiagnosticsHud = ({ visible = true, mask = '' }) => {
  const { gl, scene, camera } = useThree();
  const session = useXR((state) => state.session);
  const presenting = Boolean(session);
  const [tick, setTick] = useState(0);
  const frames = useRef(0);
  const lastReport = useRef(0);
  const reportedRenderer = useRef(false);
  const liveSummary = useRef(null);
  const lastCapture = useRef(0);
  const bounds = useRef(new Box3());
  const centroid = useRef(new Vector3());
  const camWorld = useRef(new Vector3());
  const camForward = useRef(new Vector3());
  const toContent = useRef(new Vector3());
  const hudGroup = useRef(null);

  /*
   * Session transitions are recorded the moment they happen. The per-second
   * fact sampler missed a session that began and ended inside one interval,
   * which read as "never started" and cost a headset trip.
   */
  useEffect(() => {
    recordEvent(presenting ? 'xr:presenting' : 'xr:not-presenting', {
      mode: session ? session.environmentBlendMode : null
    });
  }, [presenting, session]);

  useFrame(() => {
    frames.current += 1;
    noteFrame();

    if (!reportedRenderer.current && gl) {
      reportedRenderer.current = true;
      recordRendererFacts(gl);
    }

    /*
     * Head-lock the panel.
     *
     * World-space placement assumes the runtime hands us the origin we expect,
     * and it demonstrably does not: head height has been reported anywhere from
     * -0.14 to 1.28 across sessions. Parenting the panel to the viewer removes
     * placement from the experiment entirely. If a head-locked panel drawn from
     * unlit primitives is still invisible, the fault is the framebuffer, not
     * where anything sits.
     */
    if (hudGroup.current) {
      const activeCam = (gl.xr && gl.xr.isPresenting && gl.xr.getCamera()) || camera;
      activeCam.getWorldPosition(camWorld.current);
      activeCam.getWorldDirection(camForward.current);
      hudGroup.current.position
        .copy(camWorld.current)
        .addScaledVector(camForward.current, 1.2);
      hudGroup.current.quaternion.copy(activeCam.quaternion);
    }

    const now = Date.now();
    if (now - lastReport.current < 1000) return;
    lastReport.current = now;

    /* One report per second, not per frame: the point is to observe the
     * session, not to become the reason it drops frames. */
    let meshes = 0;
    let visibleMeshes = 0;
    scene.traverse((object) => {
      if (!object.isMesh) return;
      meshes += 1;
      if (object.visible) visibleMeshes += 1;
    });

    const activeCamera = (gl.xr && gl.xr.isPresenting && gl.xr.getCamera()) || camera;
    /* getWorldPosition, not .position: the XR camera's local transform is not
     * the whole story once the origin group has been moved. */
    activeCamera.getWorldPosition(camWorld.current);
    const p = camWorld.current;

    /*
     * Where is the workspace relative to the viewer?
     *
     * "Black in every direction" and "the content is behind or above me" look
     * identical through a headset, so measure it: the bounding box of the real
     * content, its centroid, how far away it is, and the angle between where
     * the user is looking and where the content actually is. An angle near 0
     * means they are looking straight at it.
     */
    bounds.current.makeEmpty();
    scene.traverse((object) => {
      if (!object.isMesh) return;
      const name = object.name || '';
      const parentName = (object.parent && object.parent.name) || '';
      if (name.startsWith('diagnostics') || parentName.startsWith('diagnostics')) return;
      if (name.startsWith('chromium-texture-') || parentName.startsWith('spatial-screen')) {
        bounds.current.expandByObject(object);
      }
    });

    if (!bounds.current.isEmpty()) {
      bounds.current.getCenter(centroid.current);
      toContent.current.copy(centroid.current).sub(camWorld.current);
      const distance = toContent.current.length();
      activeCamera.getWorldDirection(camForward.current);
      const angle = toContent.current.lengthSq() > 0
        ? (camForward.current.angleTo(toContent.current) * 180) / Math.PI
        : 0;
      const c = centroid.current;
      recordFact('content.centroid', `${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}`);
      recordFact('content.distance', distance.toFixed(2));
      recordFact('content.angleFromGaze', `${angle.toFixed(0)} deg`);
      recordFact('content.heightAboveHead', (c.y - p.y).toFixed(2));
    } else {
      recordFact('content.centroid', 'no screens in scene');
    }

    /*
     * Direct evidence for the framebuffer hypothesis.
     *
     * Inside a session three.js draws into session.renderState.baseLayer's
     * framebuffer. A component that renders to its own target and restores by
     * binding null leaves the canvas default framebuffer bound instead, and
     * every later draw goes somewhere the headset never reads. Comparing the
     * live binding against the session's own is the measurement that separates
     * "drew nothing" from "drew into the wrong place".
     */
    try {
      const context = gl.getContext();
      const session = gl.xr && gl.xr.getSession && gl.xr.getSession();
      const baseLayer = session && session.renderState && session.renderState.baseLayer;
      recordFact('xr.isPresenting', Boolean(gl.xr && gl.xr.isPresenting));
      recordFact('xr.enabledLive', Boolean(gl.xr && gl.xr.enabled));
      recordFact('xr.hasBaseLayer', Boolean(baseLayer));
      recordFact('xr.baseLayerFbo', baseLayer ? String(Boolean(baseLayer.framebuffer)) : 'none');
      const bound = context.getParameter(context.FRAMEBUFFER_BINDING);
      recordFact('gl.boundFramebuffer', bound === null ? 'null (canvas default)' : 'an fbo');
      recordFact('gl.boundIsXrLayer',
        baseLayer && bound === baseLayer.framebuffer ? 'yes' : 'no');
      recordFact('gl.renderTarget', gl.getRenderTarget() ? 'set' : 'null');
    } catch (error) {
      recordFact('gl.framebufferProbe', `threw: ${error && error.message}`);
    }

    /*
     * The inventory is the answer to "is this surface actually live", which no
     * other reading gives. A socket can be connected, a provider can report
     * available, and every source can still be receiving nothing.
     */
    try {
      const inventory = collectSourceInventory();
      recordFact('sources.provider', `${inventory.provider}${inventory.providerAvailable ? '' : ' (unavailable)'}`);
      recordFact('sources.live', `${inventory.live}/${inventory.screens}`);
      if (inventory.providerError) recordFact('sources.error', inventory.providerError);
      for (const entry of inventory.sources) {
        recordFact(
          `source.${entry.name.slice(0, 16)}`,
          `${entry.type} ${entry.status} ${entry.frames}f ${entry.lastFrameAgo === null ? 'never' : entry.lastFrameAgo + 's'} ${entry.texture || '-'}`
        );
      }
      liveSummary.current = inventory;
    } catch { /* diagnostics must never break a frame */ }

    /*
     * Post a picture of the scene every couple of seconds. Rate-limited hard,
     * because it costs a full extra render: enough to answer "what does it look
     * like", nowhere near enough to matter to the frame budget.
     */
    if (captureEnabled && now - lastCapture.current > 2000) {
      lastCapture.current = now;
      const activeCam = (gl.xr && gl.xr.isPresenting && gl.xr.getCamera()) || camera;
      Promise.resolve(captureScene(gl, scene, activeCam))
        .then((blob) => blob && fetch('/__view', { method: 'POST', body: blob, keepalive: true }))
        .catch(() => {});
    }

    recordFact('frames', frames.current);
    recordFact('presenting', presenting);
    recordFact('scene.meshes', meshes);
    recordFact('scene.visibleMeshes', visibleMeshes);
    recordFact('scene.children', scene.children.length);

    /*
     * The live transform of every screen, straight off the object in the scene.
     *
     * A panel showing its back is reported from the headset and reasoned about
     * from the preset, and those two disagreed: the preset shipped one yaw and
     * the session appeared to render another. Persisted workspace state can win
     * over ?layout=, so what the source says is not evidence of what is on
     * screen. This reports the yaw actually in the scene graph, in degrees,
     * which is the only number that settles it.
     */
    for (const screen of useStore.getState().screens) {
      const yaw = Math.round(((screen.rotation?.[1] ?? 0) * 180) / Math.PI);
      const at = (screen.position || []).map((v) => Number(v).toFixed(2)).join(',');
      recordFact(`screen.${screen.id}`, `yaw ${yaw}deg at ${at} size ${(screen.size || []).map((v) => Number(v).toFixed(3)).join('x')} ${screen.url || ''}`);
    }
    recordFact('camera.position', `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
    recordFact('scene.background', scene.background ? 'set' : 'none');
    setTick((value) => value + 1);
  });

  const snapshot = useMemo(() => diagnosticsSnapshot(), [tick]);
  const facts = snapshot.facts || {};

  useMemo(() => {
    recordEvent('hud-mounted');
  }, []);

  /* Reporting runs whether or not the panel is drawn, so a session that
   * shows nothing still produces evidence. */
  if (!visible) return null;

  return (
    <group ref={hudGroup} name="diagnostics-hud">
      <mesh>
        <planeGeometry args={[PANEL_WIDTH, 0.84]} />
        <meshBasicMaterial color="#0a1020" transparent opacity={0.86} />
      </mesh>

      <Line index={0} color="#7dd3fc">{`DIAGNOSTICS   mask ${mask}   hud env shdw scrn qual`}</Line>
      <Line index={1}>{`frames ${frames.current}   presenting ${presenting ? 'YES' : 'no'}`}</Line>
      <Line index={2}>{`meshes ${facts['scene.meshes'] ?? '?'}  visible ${facts['scene.visibleMeshes'] ?? '?'}  children ${facts['scene.children'] ?? '?'}`}</Line>
      <Line index={3}>{`camera ${facts['camera.position'] ?? '?'}`}</Line>
      <Line index={4}>{`gl ${String(facts['gl.renderer'] ?? '?').slice(0, 42)}`}</Line>
      <Line index={5}>{`ctxLost ${facts['gl.contextLost'] ?? '?'}   bg ${facts['scene.background'] ?? '?'}`}</Line>
      <Line index={6} color={(liveSummary.current?.live ?? 0) > 0 ? '#86efac' : '#fca5a5'}>
        {liveSummary.current
          ? `sources ${liveSummary.current.live}/${liveSummary.current.screens} live via ${liveSummary.current.provider}`
          : 'sources: none'}
      </Line>
      <Line index={7} color="#fbbf24">
        {`content ${facts['content.centroid'] ?? '?'}  ${facts['content.distance'] ?? '?'}m  ${facts['content.angleFromGaze'] ?? '?'}`}
      </Line>
      <Line index={8} color={snapshot.lastError ? '#fca5a5' : '#86efac'}>
        {snapshot.lastError
          ? `ERR ${String(snapshot.lastError.message).slice(0, 46)}`
          : 'no errors recorded'}
      </Line>

      {/* A moving element proves the render loop is live even if every number
        * above were somehow stale. */}
      <mesh position={[PANEL_WIDTH / 2 - 0.08, 0.30, 0.003]}>
        <circleGeometry args={[0.016, 16]} />
        <meshBasicMaterial color={frames.current % 60 < 30 ? '#22c55e' : '#134e2a'} />
      </mesh>
    </group>
  );
};

export default DiagnosticsHud;
