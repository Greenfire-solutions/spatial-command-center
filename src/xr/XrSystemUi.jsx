import React, { useCallback, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import { useStore } from '../store/workspace-store.js';
import { viewpointForwardHorizontal, viewpointPosition } from '../systems/viewpoint.js';
import { alignToViewer, createFollowState, stepFollow } from '../systems/follow-behaviour.js';
import { SPATIAL_THEME, SpatialLabel, SpatialPanel, roundedRectGeometry } from '../spatial-ui/index.js';

/*
 * The controls that must never be unreachable.
 *
 * The failure this exists to end: entering a session removed every control,
 * because they were DOM and the DOM is not composited into a headset. A wearer
 * could not tell whether they were arranging or browsing, could not change it,
 * and had to leave the session to fix it. An application you must take off a
 * headset to operate is not an application.
 *
 * Two decisions carry most of the weight.
 *
 * It hangs from its OWN follow root, not the workspace's. If system controls
 * inherited WORLD behaviour they would stay behind when the user turned round —
 * which is the correct behaviour for a window and exactly wrong for a control.
 * Windows are content and belong to the room; controls belong to the person.
 *
 * It follows lazily, with the same deadzone the workspace uses but tighter.
 * A control bar that answers every head movement is the HUD-glued-to-the-eyes
 * failure, and it is worse for a small bar than for a whole workspace because
 * the eye tracks small moving things involuntarily. It sits below the centre of
 * vision so it never covers the page being read.
 */

/*
 * Sized in DEGREES of field of view, then converted, rather than picked in
 * metres and hoped for.
 *
 * The first version of this was chosen in metres: a 1.16 m chooser at 0.85 m,
 * which is 69 degrees across — twice the angular size of a 27 inch monitor at
 * desk distance, hanging 24 degrees below the eyeline across the whole
 * workspace. It read as the application being broken, and it was: a metre is
 * not a size in a headset, it is a size at a distance.
 *
 * Meta's guidance is a comfortable vertical range of about 30 degrees either
 * side, and roughly a metre for indirect pointing. These numbers come from
 * that, and the arithmetic is in the file so the next person changing them
 * cannot repeat the mistake.
 */
const degToMetres = (deg, distance) => 2 * distance * Math.tan((deg * Math.PI) / 360);

const BAR_DISTANCE = 1.15;
/* 15 degrees below the eyeline: clear of what is being read, well inside the
 * comfortable range, and still an easy reach. */
const BAR_DROP = degToMetres(15, BAR_DISTANCE) / 2 + 0.16;

/* 34 degrees — about one monitor. 26 for the persistent bar, which carries
 * three controls and should never compete with the workspace. */
const CHOOSER_WIDTH = degToMetres(34, BAR_DISTANCE);
const BAR_WIDTH = degToMetres(32, BAR_DISTANCE);

/* Tighter than the workspace, because a control should be reachable sooner
 * than a room needs to reorient — but still wide enough that reading does not
 * drag it around. */
const UI_YAW_DEADZONE = 0.35;
const UI_POSITION_DEADZONE = 0.45;

const scratchViewer = new THREE.Vector3();
const scratchForward = new THREE.Vector3();

/*
 * A wide, forgiving, text-labelled button.
 *
 * SpatialButton is icon-sized and square, which is right for a browser bar and
 * wrong here: these are the two most important controls in the application and
 * they need words, not glyphs. The collider is deliberately larger than the
 * plate — pointing precision in a headset is not good enough to justify making
 * someone hit exactly what they can see.
 */
const ModeButton = ({
  label,
  caption,
  active,
  width,
  height = 0.11,
  position,
  onSelect,
  testId
}) => {
  const [hovered, setHovered] = React.useState(false);
  const plate = useMemo(() => roundedRectGeometry(width, height, 0.022), [width, height]);

  return (
    <group position={position}>
      <mesh geometry={plate} renderOrder={11}>
        <meshBasicMaterial
          color={active ? SPATIAL_THEME.color.accentSoft : hovered ? SPATIAL_THEME.color.panelRaised : SPATIAL_THEME.color.panel}
          transparent
          opacity={active ? 0.98 : 0.9}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* The active mode has to be legible in under a second, so it gets a
          filled plate AND an accent rule rather than only a colour shift. */}
      {active && (
        <mesh position={[0, -height / 2 + 0.008, 0.002]} renderOrder={12}>
          <planeGeometry args={[width * 0.72, 0.005]} />
          <meshBasicMaterial color={SPATIAL_THEME.color.accentGlow} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      )}

      <SpatialLabel
        position={[0, caption ? height * 0.14 : 0, 0.004]}
        size={height * 0.26}
        color={active ? SPATIAL_THEME.color.textStrong : SPATIAL_THEME.color.text}
      >
        {label}
      </SpatialLabel>
      {caption && (
        <SpatialLabel position={[0, -height * 0.2, 0.004]} size={height * 0.17} color={SPATIAL_THEME.color.textMuted}>
          {caption}
        </SpatialLabel>
      )}

      {/* The collider. Invisible, and larger than the plate in both axes. */}
      <mesh
        position={[0, 0, 0.012]}
        userData={{ role: 'xr-system-control', testId }}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
      >
        <planeGeometry args={[width + 0.05, height + 0.05]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
};

/*
 * The first thing a wearer sees.
 *
 * One question, two answers, both in front of them. Not a settings screen, not
 * a toggle: how the workspace behaves is an operating decision and it is asked
 * once, plainly, in words that need no XR vocabulary to understand.
 */
const ModeChooser = ({ onChoose }) => (
  <group position={[0, 0.16, 0]}>
    <SpatialPanel width={CHOOSER_WIDTH} height={CHOOSER_WIDTH * 0.42} radius={0.026} opacity={0.96}>
      <SpatialLabel
        position={[0, CHOOSER_WIDTH * 0.145, 0.006]}
        size={0.026}
        color={SPATIAL_THEME.color.textStrong}
      >
        How should your workspace behave?
      </SpatialLabel>

      <group position={[-CHOOSER_WIDTH * 0.245, -CHOOSER_WIDTH * 0.035, 0.006]}>
        <ModeButton
          label="WORLD"
          caption="Screens stay put"
          width={CHOOSER_WIDTH * 0.44}
          height={CHOOSER_WIDTH * 0.17}
          active={false}
          onSelect={() => onChoose('world')}
          testId="choose-world"
        />
      </group>
      <group position={[CHOOSER_WIDTH * 0.245, -CHOOSER_WIDTH * 0.035, 0.006]}>
        <ModeButton
          label="FOLLOW"
          caption="They come with you"
          width={CHOOSER_WIDTH * 0.44}
          height={CHOOSER_WIDTH * 0.17}
          active={false}
          onSelect={() => onChoose('follow')}
          testId="choose-follow"
        />
      </group>
    </SpatialPanel>
  </group>
);

/*
 * The persistent bar. Three controls, and only three.
 *
 * ARRANGE and BROWSE decide what a gesture does to a window. WORLD and FOLLOW
 * decide where the workspace lives. They are different questions and they are
 * kept visibly apart by a divider, because conflating them is how an
 * application ends up with modes nobody can name.
 */
const ControlBar = ({ interactionMode, workspaceMode, onInteraction, onWorkspace, onRefit }) => {
  /*
   * Laid out from a list rather than by hand-placed offsets, so adding a
   * control cannot leave the others silently overlapping.
   */
  const controls = [
    { key: 'arrange', label: 'ARRANGE', active: interactionMode === 'arrange', onSelect: () => onInteraction('arrange'), testId: 'mode-arrange' },
    { key: 'browse', label: 'BROWSE', active: interactionMode === 'browse', onSelect: () => onInteraction('browse'), testId: 'mode-browse' },
    { key: 'divider' },
    {
      key: 'workspace',
      label: workspaceMode === 'follow' ? 'FOLLOW' : 'WORLD',
      caption: workspaceMode === 'follow' ? 'comes with you' : 'stays put',
      active: true,
      onSelect: () => onWorkspace(workspaceMode === 'follow' ? 'world' : 'follow'),
      testId: 'mode-workspace'
    },
    {
      /* The escape hatch. A workspace that has ended up behind you — which is
       * what happens whenever the authored coordinates disagree with the way
       * the wearer happened to be facing — is otherwise unrecoverable without
       * taking the headset off. */
      key: 'refit',
      label: 'BRING TO ME',
      active: false,
      onSelect: onRefit,
      testId: 'refit-workspace'
    }
  ];

  const gap = BAR_WIDTH * 0.02;
  const dividerWidth = BAR_WIDTH * 0.012;
  const buttons = controls.filter((control) => control.key !== 'divider');
  const buttonWidth = (BAR_WIDTH - gap * (controls.length + 1) - dividerWidth) / buttons.length;
  const height = BAR_WIDTH * 0.1;

  let cursor = -BAR_WIDTH / 2 + gap;
  const placed = controls.map((control) => {
    const width = control.key === 'divider' ? dividerWidth : buttonWidth;
    const x = cursor + width / 2;
    cursor += width + gap;
    return { ...control, x, width };
  });

  return (
    <SpatialPanel width={BAR_WIDTH} height={height * 1.5} radius={0.02} opacity={0.94}>
      {placed.map((control) => (control.key === 'divider' ? (
        <mesh key="divider" position={[control.x, 0, 0.006]} renderOrder={11}>
          <planeGeometry args={[control.width, height * 0.7]} />
          <meshBasicMaterial
            color={SPATIAL_THEME.color.borderStrong}
            transparent
            opacity={0.6}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ) : (
        <ModeButton
          key={control.key}
          label={control.label}
          caption={control.caption}
          width={control.width}
          height={height}
          position={[control.x, 0, 0.006]}
          active={control.active}
          onSelect={control.onSelect}
          testId={control.testId}
        />
      )))}
    </SpatialPanel>
  );
};

export const XrSystemUi = ({ presenting }) => {
  const groupRef = useRef(null);
  const followRef = useRef(createFollowState());
  const startedRef = useRef(false);

  const interactionMode = useStore((state) => state.interactionMode);
  const workspaceMode = useStore((state) => state.workspaceMode);
  const chosen = useStore((state) => state.workspaceModeChosen);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group || !presenting) return;

    viewpointPosition(scratchViewer);
    viewpointForwardHorizontal(scratchForward);
    const viewerYaw = Math.atan2(scratchForward.x, scratchForward.z);
    const viewer = [scratchViewer.x, scratchViewer.y, scratchViewer.z];

    if (!startedRef.current) {
      startedRef.current = true;
      /* Snap on the first frame so the controls are already in front of the
       * wearer when the session opens, rather than sliding into place. */
      followRef.current = alignToViewer({ viewerYaw, viewerPosition: viewer });
      applyTransform(group, followRef.current, viewerYaw);
      return;
    }

    followRef.current = stepFollow(followRef.current, {
      viewerYaw,
      viewerPosition: viewer,
      delta,
      yawDeadzone: UI_YAW_DEADZONE,
      positionDeadzone: UI_POSITION_DEADZONE
      /* Deliberately NOT frozen during manipulation. The workspace holds still
       * while a window is being dragged; the controls must stay reachable
       * throughout, which is the entire point of them. */
    });

    if (followRef.current.moved) applyTransform(group, followRef.current, viewerYaw);
  });

  const setInteraction = useCallback((mode) => {
    const state = useStore.getState();
    /* Finish any transform before the mode changes, so a gesture cannot survive
     * into a mode where its handlers no longer run. */
    if (state.isManipulatingScreen) state.setManipulatingScreen(false);
    state.setInteractionMode(mode);
  }, []);

  const refit = useCallback(() => useStore.getState().refitWorkspace(), []);

  const setWorkspace = useCallback((mode) => {
    const state = useStore.getState();
    if (state.isManipulatingScreen) state.setManipulatingScreen(false);
    state.setWorkspaceMode(mode);
  }, []);

  if (!presenting) return null;

  return (
    <group ref={groupRef} name="xr-system-ui">
      {/*
        * The bar is ALWAYS present, and the chooser sits above it rather than
        * replacing it. If the first-run prompt ever fails to draw, or is
        * dismissed, or the wearer simply never notices it, the WORLD/FOLLOW
        * control still exists — there must be no state in which a session
        * offers no way to change how the workspace behaves.
        */}
      <ControlBar
        interactionMode={interactionMode}
        workspaceMode={workspaceMode}
        onInteraction={setInteraction}
        onWorkspace={setWorkspace}
        onRefit={refit}
      />
      {chosen ? null : <ModeChooser onChoose={setWorkspace} />}
    </group>
  );
};

/* The bar sits ahead of and below the wearer, facing them. Yaw only: a control
 * that pitches with the head is a control that swings when you look at your
 * hands. */
function applyTransform(group, follow, viewerYaw) {
  const yaw = follow.yaw;
  group.position.set(
    follow.position[0] - Math.sin(yaw) * BAR_DISTANCE,
    follow.position[1] - BAR_DROP,
    follow.position[2] - Math.cos(yaw) * BAR_DISTANCE
  );
  group.rotation.set(0, yaw, 0);
  /* A slight upward tilt, because the bar is below eye level and a flat panel
   * seen from above is harder to read and harder to hit. */
  group.rotateX(0.28);
  void viewerYaw;
}

export default XrSystemUi;
