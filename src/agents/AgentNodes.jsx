import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import { SPATIAL_THEME, SpatialLabel } from '../spatial-ui/index.js';
import { useStore } from '../store/workspace-store.js';
import { viewpointPosition } from '../systems/viewpoint.js';
import { AGENT_STATUS } from './agent-provider.js';
import { getAgentProvider } from './agent-provider.js';

/*
 * Agents as objects in the room.
 *
 * A window is a surface you read; an agent is something you hand things to.
 * They are drawn as an octahedron rather than a plane so the difference is
 * legible at a glance and from any angle — a headset user circling the
 * workspace should never have to face an agent head-on to recognise it.
 *
 * Deliberately not a panel. Panels are for surfaces with content; an agent's
 * state is its shape, its colour, and one label. Anything more would be chrome
 * competing with the browser windows, which are the brightest thing in the
 * scene by design.
 */

const STATUS_COLOR = {
  [AGENT_STATUS.IDLE]: SPATIAL_THEME.color.accent,
  [AGENT_STATUS.WORKING]: SPATIAL_THEME.color.success,
  [AGENT_STATUS.ERROR]: SPATIAL_THEME.color.danger,
  [AGENT_STATUS.OFFLINE]: SPATIAL_THEME.color.iconDisabled
};

const AgentNode = ({ agent }) => {
  const selected = useStore((state) => state.selectedScreen) === agent.id;
  const draft = useStore((state) => state.connectorDraft);
  const setSelectedScreen = useStore((state) => state.setSelectedScreen);
  const beginConnectorDraft = useStore((state) => state.beginConnectorDraft);
  const updateConnectorDraft = useStore((state) => state.updateConnectorDraft);

  const groupRef = useRef(null);
  const coreRef = useRef(null);
  const labelRef = useRef(null);
  const lookRef = useRef(new THREE.Vector3());
  const worldRef = useRef(new THREE.Vector3());

  /* An adapter that is registered but unavailable, or none at all, reads as
   * offline regardless of what the stored status says. The node should not
   * claim to be idle-and-ready when nothing is behind it. */
  const backed = agent.providerId ? getAgentProvider(agent.providerId) : null;
  const effectiveStatus = backed && backed.available ? agent.status : AGENT_STATUS.OFFLINE;
  const color = STATUS_COLOR[effectiveStatus] || SPATIAL_THEME.color.accent;

  const drafting = Boolean(draft);
  const isSource = draft?.sourceId === agent.id;
  const isHovered = draft?.hoverTargetId === agent.id;

  const geometry = useMemo(() => new THREE.OctahedronGeometry(0.17, 0), []);

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;

    /* A slow idle rotation, faster while working. Motion is the cheapest way
     * to say "this is thinking" without a progress bar that would need to face
     * the viewer and would read as chrome. */
    const speed = effectiveStatus === AGENT_STATUS.WORKING ? 1.4 : 0.22;
    if (coreRef.current) {
      coreRef.current.rotation.y += delta * speed;
      coreRef.current.rotation.x += delta * speed * 0.35;
    }
    /* The label always faces the viewer, through the same abstraction the rest
     * of the workspace uses, so it turns to the head pose inside a session. */
    if (labelRef.current) labelRef.current.lookAt(viewpointPosition(lookRef.current));
  });

  return (
    <group ref={groupRef} position={agent.position}>
      <mesh
        ref={coreRef}
        geometry={geometry}
        renderOrder={16}
        onPointerDown={(event) => {
          event.stopPropagation();
          setSelectedScreen(agent.id);
        }}
        onPointerMove={(event) => {
          /* While a cable is being drawn, an agent is a drop target like any
           * window — which is the whole point of it being a node. */
          if (!drafting || isSource) return;
          event.stopPropagation();
          updateConnectorDraft({
            point: event.point.toArray(),
            hoverTargetId: agent.id,
            hoverTargetKind: 'agent'
          });
        }}
      >
        <meshBasicMaterial
          color={color}
          transparent
          opacity={isHovered ? 1 : 0.85}
          toneMapped={false}
          wireframe={effectiveStatus === AGENT_STATUS.OFFLINE}
        />
      </mesh>

      {/* A soft shell, so the node reads as a presence rather than a solid. */}
      <mesh geometry={geometry} scale={isHovered ? 1.9 : 1.55} renderOrder={15}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={isHovered ? 0.22 : 0.1}
          toneMapped={false}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>

      {/* The handle a cable is pulled from, matching the one beside a window. */}
      <mesh
        position={[0.28, 0, 0]}
        renderOrder={18}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.target?.setPointerCapture?.(event.pointerId);
          groupRef.current?.getWorldPosition(worldRef.current);
          beginConnectorDraft({
            sourceId: agent.id,
            sourceKind: 'agent',
            point: worldRef.current.toArray()
          });
        }}
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

      <group ref={labelRef} position={[0, 0.3, 0]}>
        <SpatialLabel
          size={0.05}
          color={selected ? SPATIAL_THEME.color.textStrong : SPATIAL_THEME.color.text}
          renderOrder={20}
        >
          {agent.name}
        </SpatialLabel>
        {effectiveStatus === AGENT_STATUS.OFFLINE ? (
          <SpatialLabel
            position={[0, -0.055, 0]}
            size={0.032}
            color={SPATIAL_THEME.color.textMuted}
            renderOrder={20}
          >
            no model connected
          </SpatialLabel>
        ) : null}
      </group>
    </group>
  );
};

export const AgentNodes = () => {
  const agents = useStore((state) => state.agents);
  if (!agents || agents.length === 0) return null;
  return (
    <group>
      {agents.map((agent) => <AgentNode key={agent.id} agent={agent} />)}
    </group>
  );
};

export default AgentNodes;
