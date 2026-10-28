import React, { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import { SPATIAL_THEME, SpatialPanel, SpatialLabel } from '../spatial-ui/index.js';
import { sceneRuntime } from '../systems/scene-runtime.js';
import { viewpointPosition } from '../systems/viewpoint.js';
import { useStore } from '../store/workspace-store.js';
import { CONNECTION_MODE_LIST, CONNECTION_MODES, NODE_KINDS } from './connector-schema.js';

/*
 * "How do you want these connected?"
 *
 * The panel that appears when a connector is drawn. It is in-scene geometry
 * rather than a DOM overlay, because <Html> renders nothing inside an
 * immersive session and this is the moment a connector is created — a headset
 * user drawing a cable must be able to answer the question they just raised.
 *
 * Everything it offers comes from the mode table in connector-schema.js. The
 * list is not written out here, so a mode added to the graph appears in the
 * panel automatically and the panel can never offer something the graph would
 * refuse.
 *
 * It also states what each mode will be allowed to read before the choice is
 * made. Granting access to a page is the consequential half of drawing a line,
 * and it should not be the invisible half.
 */

const PANEL_WIDTH = 1.15;
const PANEL_HEIGHT = 0.86;
const ROW_WIDTH = 0.53;
const ROW_HEIGHT = 0.072;
const COLUMN_GAP = 0.02;
const ROW_GAP = 0.008;

const CAPABILITY_LABELS = {
  title: 'title',
  url: 'address',
  text: 'readable text',
  headings: 'headings',
  links: 'links',
  images: 'images',
  videos: 'videos',
  metadata: 'metadata',
  structuredData: 'structured data',
  selection: 'selection'
};

const describeCapabilities = (capabilities) => {
  if (!capabilities || capabilities.length === 0) return 'Reads nothing until you choose.';
  return 'Reads ' + capabilities.map((c) => CAPABILITY_LABELS[c] || c).join(', ') + '.';
};

const ModeRow = ({ mode, index, selected, onHover, onSelect }) => {
  const [hovered, setHovered] = useState(false);
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = (column === 0 ? -1 : 1) * (ROW_WIDTH + COLUMN_GAP) / 2;
  const y = 0.215 - row * (ROW_HEIGHT + ROW_GAP);

  const active = selected || hovered;

  return (
    <group position={[x, y, 0.002]}>
      <SpatialPanel
        width={ROW_WIDTH}
        height={ROW_HEIGHT}
        radius={0.012}
        color={active ? SPATIAL_THEME.color.accentSoft : SPATIAL_THEME.color.panelRaised}
        opacity={active ? 0.95 : 0.55}
        border={selected ? SPATIAL_THEME.color.accent : SPATIAL_THEME.color.border}
        borderOpacity={selected ? 0.9 : 0.35}
        renderOrder={22}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          onHover(mode.id);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          setHovered(false);
          onHover(null);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(mode.id);
        }}
      />
      <SpatialLabel
        position={[-ROW_WIDTH / 2 + 0.022, 0, 0.004]}
        anchorX="left"
        size={0.026}
        color={active ? SPATIAL_THEME.color.textStrong : SPATIAL_THEME.color.text}
        renderOrder={24}
      >
        {mode.label}
      </SpatialLabel>
    </group>
  );
};

const ActionRow = ({ label, danger, position, onSelect }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <group position={position}>
      <SpatialPanel
        width={0.24}
        height={0.062}
        radius={0.012}
        color={hovered
          ? (danger ? SPATIAL_THEME.color.dangerSoft : SPATIAL_THEME.color.accentSoft)
          : SPATIAL_THEME.color.panelRaised}
        opacity={hovered ? 0.95 : 0.5}
        border={danger ? SPATIAL_THEME.color.danger : SPATIAL_THEME.color.border}
        borderOpacity={hovered ? 0.85 : 0.3}
        renderOrder={22}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={(event) => { event.stopPropagation(); setHovered(false); }}
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
      />
      <SpatialLabel
        position={[0, 0, 0.004]}
        size={0.024}
        color={danger ? SPATIAL_THEME.color.danger : SPATIAL_THEME.color.text}
        renderOrder={24}
      >
        {label}
      </SpatialLabel>
    </group>
  );
};

/* Where a node actually is right now. Windows follow their live Object3D so
 * the panel tracks a screen that is being moved; a non-window node falls back
 * to the stored transform until agent nodes exist in the scene. */
const nodePosition = (target, id, kind, screens, agents = []) => {
  if (kind === NODE_KINDS.AGENT) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (agent) return target.fromArray(agent.position);
    return target.set(0, 1.5, -2);
  }
  const object = sceneRuntime.screenObjects.get(id);
  if (object) return target.copy(object.position);
  const screen = screens.find((candidate) => candidate.id === id);
  if (screen) return target.fromArray(screen.position);
  return target.set(0, 1.5, -2);
};

const nodeName = (id, kind, screens, agents = []) => {
  if (kind === NODE_KINDS.AGENT) {
    const agent = agents.find((candidate) => candidate.id === id);
    return agent ? agent.name : id;
  }
  const screen = screens.find((candidate) => candidate.id === id);
  return screen ? (screen.name || screen.title || id) : id;
};

export const ConnectorConfigPanel = () => {
  const connectors = useStore((state) => state.connections);
  const screens = useStore((state) => state.screens);
  const agents = useStore((state) => state.agents);
  const configuringId = useStore((state) => state.configuringConnectorId);
  const configureConnector = useStore((state) => state.configureConnector);
  const removeConnector = useStore((state) => state.removeConnector);
  const setConfiguringConnector = useStore((state) => state.setConfiguringConnector);

  const [preview, setPreview] = useState(null);
  const groupRef = useRef(null);
  const startRef = useRef(new THREE.Vector3());
  const endRef = useRef(new THREE.Vector3());
  const lookRef = useRef(new THREE.Vector3());

  const connector = useMemo(
    () => connectors.find((candidate) => candidate.id === configuringId) || null,
    [connectors, configuringId]
  );

  /* Sit at the cable's midpoint and face the viewer. Using the viewpoint
   * abstraction rather than the desktop camera means the panel turns to the
   * head pose inside a session with no XR-specific branch here. */
  useFrame(() => {
    const group = groupRef.current;
    if (!group || !connector) return;
    const start = nodePosition(startRef.current, connector.sourceId, connector.sourceKind, screens, agents);
    const end = nodePosition(endRef.current, connector.targetId, connector.targetKind, screens, agents);
    group.position.copy(start).add(end).multiplyScalar(0.5);
    group.position.y += 0.62;
    group.lookAt(viewpointPosition(lookRef.current));
  });

  if (!connector) return null;

  const activeMode = preview || connector.mode;
  const modeDefinition = CONNECTION_MODES[activeMode] || CONNECTION_MODES[connector.mode];
  const sourceName = nodeName(connector.sourceId, connector.sourceKind, screens, agents);
  const targetName = nodeName(connector.targetId, connector.targetKind, screens, agents);
  const rows = Math.ceil(CONNECTION_MODE_LIST.length / 2);

  return (
    <group ref={groupRef} renderOrder={20}>
      <SpatialPanel
        width={PANEL_WIDTH}
        height={PANEL_HEIGHT}
        radius={0.03}
        opacity={SPATIAL_THEME.opacity.panel}
        border={SPATIAL_THEME.color.borderStrong}
        borderOpacity={0.7}
        renderOrder={20}
      >
        <SpatialLabel
          position={[0, PANEL_HEIGHT / 2 - 0.062, 0.004]}
          size={0.032}
          color={SPATIAL_THEME.color.textStrong}
          renderOrder={24}
        >
          How do you want these connected?
        </SpatialLabel>

        <SpatialLabel
          position={[0, PANEL_HEIGHT / 2 - 0.108, 0.004]}
          size={0.026}
          color={SPATIAL_THEME.color.accentGlow}
          renderOrder={24}
        >
          {`${sourceName}  →  ${targetName}`}
        </SpatialLabel>

        {CONNECTION_MODE_LIST.map((mode, index) => (
          <ModeRow
            key={mode.id}
            mode={mode}
            index={index}
            selected={connector.mode === mode.id && !connector.unconfigured}
            onHover={setPreview}
            onSelect={(id) => {
              configureConnector(connector.id, { mode: id });
              setConfiguringConnector(null);
              setPreview(null);
            }}
          />
        ))}

        {/* What the highlighted mode will be permitted to read. Stated before
          * the choice, because this is the half of the decision that matters. */}
        <SpatialLabel
          position={[0, 0.215 - rows * (ROW_HEIGHT + ROW_GAP) - 0.03, 0.004]}
          size={0.023}
          color={SPATIAL_THEME.color.textMuted}
          maxWidth={PANEL_WIDTH - 0.12}
          whiteSpace="normal"
          renderOrder={24}
        >
          {modeDefinition.description}
        </SpatialLabel>

        <SpatialLabel
          position={[0, 0.215 - rows * (ROW_HEIGHT + ROW_GAP) - 0.062, 0.004]}
          size={0.022}
          color={SPATIAL_THEME.color.success}
          maxWidth={PANEL_WIDTH - 0.12}
          whiteSpace="normal"
          renderOrder={24}
        >
          {describeCapabilities(modeDefinition.defaultCapabilities)}
        </SpatialLabel>

        <ActionRow
          label="Cancel"
          position={[-0.145, -PANEL_HEIGHT / 2 + 0.055, 0.004]}
          onSelect={() => { setConfiguringConnector(null); setPreview(null); }}
        />
        <ActionRow
          label="Disconnect"
          danger
          position={[0.145, -PANEL_HEIGHT / 2 + 0.055, 0.004]}
          onSelect={() => {
            removeConnector(connector.id);
            setConfiguringConnector(null);
            setPreview(null);
          }}
        />
      </SpatialPanel>
    </group>
  );
};

export default ConnectorConfigPanel;
