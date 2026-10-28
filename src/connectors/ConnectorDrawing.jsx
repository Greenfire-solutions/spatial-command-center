import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import { SPATIAL_THEME } from '../spatial-ui/index.js';
import { sceneRuntime } from '../systems/scene-runtime.js';
import { useStore } from '../store/workspace-store.js';
import { NODE_KINDS } from './connector-schema.js';

/*
 * Drawing a connector by hand.
 *
 * Three pieces, kept together because they only make sense as one gesture:
 *
 *   ConnectorHandle   a grabbable node beside each window. Pulling from it
 *                     starts a draft.
 *   DraftCable        the line that follows the pointer while dragging, drawn
 *                     with the same Bézier curve as a real connector so what
 *                     you are making looks like what you will get.
 *   DropTarget        an invisible plane over each other window, live only
 *                     while a draft exists, which is what the cable snaps to.
 *
 * Nothing here reads a pixel coordinate. Everything works from the ray and the
 * world-space point R3F reports, which is why the same component will serve a
 * controller ray and a hand pinch without modification — the pattern
 * xr-interaction.js already establishes for grab, resize and scroll.
 */

const CURVE_SEGMENTS = 24;

/* The same arc a finished connector uses, so a draft reads as the same object.
 * Lifting the midpoint keeps the cable clear of the windows it spans. */
const shapeCurve = (curve, start, end) => {
  curve.v0.copy(start);
  curve.v2.copy(end);
  curve.v1.copy(start).add(end).multiplyScalar(0.5);
  curve.v1.y += 0.45;
  curve.v1.z -= 0.32;
  return curve;
};

const screenPosition = (target, screen) => {
  const object = sceneRuntime.screenObjects.get(screen.id);
  if (object) return target.copy(object.position);
  return target.fromArray(screen.position);
};

/* Half-extents of a screen in world units, used to size its drop target and
 * to place its handle at the right-hand edge. */
const screenExtent = (screen) => {
  const scale = Array.isArray(screen.scale) ? screen.scale : [1, 1, 1];
  const size = Array.isArray(screen.size) ? screen.size : [2, 1.3];
  return [size[0] * (scale[0] || 1), size[1] * (scale[1] || 1)];
};

const ConnectorHandle = ({ screen }) => {
  const beginConnectorDraft = useStore((state) => state.beginConnectorDraft);
  const draft = useStore((state) => state.connectorDraft);
  const meshRef = useRef(null);
  const hoveredRef = useRef(false);
  const worldRef = useRef(new THREE.Vector3());

  const [width] = screenExtent(screen);
  const drafting = Boolean(draft);
  const isSource = draft?.sourceId === screen.id;

  return (
    <mesh
      ref={meshRef}
      position={[width / 2 + 0.07, 0, 0.02]}
      renderOrder={18}
      onPointerDown={(event) => {
        if (screen.locked) return;
        event.stopPropagation();
        /* Capture so the drag survives the pointer leaving the handle, which
         * it does immediately — the whole gesture happens elsewhere. */
        event.target?.setPointerCapture?.(event.pointerId);
        meshRef.current?.getWorldPosition(worldRef.current);
        beginConnectorDraft({
          sourceId: screen.id,
          sourceKind: NODE_KINDS.WINDOW,
          point: worldRef.current.toArray()
        });
      }}
      onPointerOver={(event) => { event.stopPropagation(); hoveredRef.current = true; }}
      onPointerOut={() => { hoveredRef.current = false; }}
    >
      <sphereGeometry args={[0.036, 16, 12]} />
      <meshBasicMaterial
        color={isSource ? SPATIAL_THEME.color.accentGlow : SPATIAL_THEME.color.accent}
        transparent
        opacity={drafting && !isSource ? 0.35 : 0.9}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
};

/* An invisible catcher far behind everything, so a draft dragged over empty
 * space still has a surface to report a world point from. It is deliberately
 * the last thing the ray can hit: every window sits in front of it. */
const FreeSpaceCatcher = () => {
  const updateConnectorDraft = useStore((state) => state.updateConnectorDraft);
  return (
    <mesh
      position={[0, 0, -40]}
      renderOrder={0}
      onPointerMove={(event) => {
        updateConnectorDraft({ point: event.point.toArray(), hoverTargetId: null, hoverTargetKind: null });
      }}
    >
      <planeGeometry args={[400, 400]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
    </mesh>
  );
};

const DropTarget = ({ screen }) => {
  const updateConnectorDraft = useStore((state) => state.updateConnectorDraft);
  const [width, height] = screenExtent(screen);
  return (
    <mesh
      position={[0, 0, 0.05]}
      renderOrder={19}
      onPointerMove={(event) => {
        /* Stop here so the free-space catcher behind does not immediately
         * clear the target this is setting. */
        event.stopPropagation();
        updateConnectorDraft({
          point: event.point.toArray(),
          hoverTargetId: screen.id,
          hoverTargetKind: NODE_KINDS.WINDOW
        });
      }}
    >
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
};

/* A ring drawn over the window the draft would land on, so the drop point is
 * unambiguous before releasing. */
const DropHighlight = ({ screen }) => {
  const [width, height] = screenExtent(screen);
  return (
    <mesh position={[0, 0, 0.045]} renderOrder={19}>
      <planeGeometry args={[width + 0.06, height + 0.06]} />
      <meshBasicMaterial
        color={SPATIAL_THEME.color.accentGlow}
        transparent
        opacity={0.16}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
};

/*
 * Follows a screen's live Object3D every frame.
 *
 * The store only records a transform when a manipulation commits, so anything
 * anchored from store state alone lags visibly while a screen is being moved.
 * Reading the runtime object is what the connector cable already does.
 */
const ScreenAnchor = ({ screen, children }) => {
  const groupRef = useRef(null);
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const object = sceneRuntime.screenObjects.get(screen.id);
    if (object) {
      group.position.copy(object.position);
      group.quaternion.copy(object.quaternion);
    } else {
      group.position.fromArray(screen.position);
      group.rotation.set(screen.rotation[0], screen.rotation[1], screen.rotation[2]);
    }
  });
  return <group ref={groupRef}>{children}</group>;
};

const DraftCable = () => {
  const draft = useStore((state) => state.connectorDraft);
  const screens = useStore((state) => state.screens);
  const agents = useStore((state) => state.agents);
  const lineRef = useRef(null);
  const positions = useMemo(() => new Float32Array((CURVE_SEGMENTS + 1) * 3), []);
  const curveRef = useRef(new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
  ));
  const startRef = useRef(new THREE.Vector3());
  const endRef = useRef(new THREE.Vector3());
  const pointRef = useRef(new THREE.Vector3());

  /* A draft can start at a window or at an agent. */
  const sourceNode = draft
    ? (draft.sourceKind === NODE_KINDS.AGENT
        ? agents.find((agent) => agent.id === draft.sourceId)
        : screens.find((screen) => screen.id === draft.sourceId))
    : null;
  const sourceScreen = sourceNode;

  useFrame(() => {
    const line = lineRef.current;
    if (!line || !draft || !sourceScreen) return;

    const start = draft.sourceKind === NODE_KINDS.AGENT
      ? startRef.current.fromArray(sourceScreen.position)
      : screenPosition(startRef.current, sourceScreen);
    const end = endRef.current;

    /* Snap to the hovered window's centre rather than the exact hit point, so
     * releasing anywhere on a window reads as connecting to that window. */
    const hovered = draft.hoverTargetId
      ? (draft.hoverTargetKind === NODE_KINDS.AGENT
          ? agents.find((agent) => agent.id === draft.hoverTargetId)
          : screens.find((screen) => screen.id === draft.hoverTargetId))
      : null;
    if (hovered) {
      if (draft.hoverTargetKind === NODE_KINDS.AGENT) end.fromArray(hovered.position);
      else screenPosition(end, hovered);
    }
    else if (draft.point) end.fromArray(draft.point);
    else end.copy(start);

    const curve = shapeCurve(curveRef.current, start, end);
    for (let index = 0; index <= CURVE_SEGMENTS; index += 1) {
      curve.getPoint(index / CURVE_SEGMENTS, pointRef.current);
      pointRef.current.toArray(positions, index * 3);
    }
    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  });

  if (!draft || !sourceScreen) return null;

  return (
    <line ref={lineRef} renderOrder={19} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        color={draft.hoverTargetId ? SPATIAL_THEME.color.success : SPATIAL_THEME.color.accentGlow}
        transparent
        opacity={0.9}
        toneMapped={false}
        depthWrite={false}
      />
    </line>
  );
};

/*
 * The drawing layer.
 *
 * Handles appear in arrange mode, where dragging already means "manipulate the
 * workspace" rather than "interact with the page". In browse mode a drag
 * belongs to the browser surface, so connectors are made by voice instead —
 * the same connectWindows() either way.
 */
export const ConnectorDrawing = () => {
  const screens = useStore((state) => state.screens);
  const draft = useStore((state) => state.connectorDraft);
  const interactionMode = useStore((state) => state.interactionMode);
  const completeConnectorDraft = useStore((state) => state.completeConnectorDraft);
  const cancelConnectorDraft = useStore((state) => state.cancelConnectorDraft);

  const showHandles = interactionMode === 'arrange';
  const drafting = Boolean(draft);

  /* Release ends the gesture wherever it happens, including outside the
   * canvas — otherwise a draft can be left hanging by letting go off-screen. */
  React.useEffect(() => {
    if (!drafting) return undefined;
    const finish = () => completeConnectorDraft();
    const abort = (event) => { if (event.key === 'Escape') cancelConnectorDraft(); };
    window.addEventListener('pointerup', finish);
    window.addEventListener('keydown', abort);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('keydown', abort);
    };
  }, [drafting, completeConnectorDraft, cancelConnectorDraft]);

  return (
    <group>
      {drafting ? <FreeSpaceCatcher /> : null}
      <DraftCable />

      {screens.map((screen) => {
        const isSource = draft?.sourceId === screen.id;
        const isHovered = draft?.hoverTargetId === screen.id;
        if (!showHandles && !drafting && !isHovered) return null;

        return (
          <ScreenAnchor key={screen.id} screen={screen}>
            {showHandles ? <ConnectorHandle screen={screen} /> : null}
            {drafting && !isSource ? <DropTarget screen={screen} /> : null}
            {isHovered ? <DropHighlight screen={screen} /> : null}
          </ScreenAnchor>
        );
      })}
    </group>
  );
};

export default ConnectorDrawing;
