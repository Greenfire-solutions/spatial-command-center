import React, { useMemo } from 'react';
import { SPATIAL_THEME, SpatialButton, SpatialPanel } from '../../spatial-ui/index.js';

/*
 * The in-scene equivalent of the DOM screen control bar.
 *
 * This is the interface that must survive the move to immersive WebXR. Drei's
 * <Html> renders into a DOM layer that does not exist inside an XR session, so
 * anything essential that lives only there disappears the moment a headset
 * enters immersive mode. Move, rotate, face, resize, lock, duplicate and close
 * are all essential, so they exist here as real geometry driven by rays.
 *
 * The DOM bar remains available on the desktop as a convenience surface; this
 * one is the source of truth for what the workspace can actually do.
 */

const BUTTON = SPATIAL_THEME.size.buttonSize;
const GAP = SPATIAL_THEME.size.buttonGap;
const PADDING = SPATIAL_THEME.size.barPadding;

export const SpatialScreenControls = ({
  screen,
  visible,
  editable,
  onMove,
  onRotateLeft,
  onRotateRight,
  onFaceCamera,
  onToggleResize,
  onToggleLock,
  onDuplicate,
  onClose,
  resizeActive,
  moveActive,
  position = [0, 0, 0]
}) => {
  const controls = useMemo(() => [
    { id: 'move', icon: 'move', label: 'Move screen', onSelect: onMove, active: moveActive, disabled: !editable },
    { id: 'rotate-left', icon: 'rotate-left', label: 'Rotate left', onSelect: onRotateLeft, disabled: !editable },
    { id: 'rotate-right', icon: 'rotate-right', label: 'Rotate right', onSelect: onRotateRight, disabled: !editable },
    { id: 'face', icon: 'face', label: 'Face me', onSelect: onFaceCamera, disabled: !editable },
    { id: 'scale', icon: 'scale', label: 'Resize screen', onSelect: onToggleResize, active: resizeActive, disabled: !editable },
    { id: 'divider', divider: true },
    {
      id: 'lock',
      icon: screen.locked ? 'lock' : 'unlock',
      label: screen.locked ? 'Unlock screen' : 'Lock screen',
      onSelect: onToggleLock,
      active: screen.locked
    },
    { id: 'copy', icon: 'copy', label: 'Duplicate screen', onSelect: onDuplicate },
    { id: 'close', icon: 'close', label: 'Close screen', onSelect: onClose, danger: true }
  ], [
    screen.locked, editable, moveActive, resizeActive,
    onMove, onRotateLeft, onRotateRight, onFaceCamera,
    onToggleResize, onToggleLock, onDuplicate, onClose
  ]);

  const layout = useMemo(() => {
    let cursor = 0;
    const placed = controls.map((control) => {
      const width = control.divider ? SPATIAL_THEME.size.dividerWidth + GAP * 2 : BUTTON;
      const entry = { ...control, offset: cursor + width / 2, width };
      cursor += width + GAP;
      return entry;
    });
    const contentWidth = Math.max(0, cursor - GAP);
    return { placed, contentWidth };
  }, [controls]);

  if (!visible) return null;

  const barWidth = layout.contentWidth + PADDING * 2;
  const barHeight = BUTTON + PADDING * 2;
  const origin = -layout.contentWidth / 2;

  return (
    <group position={position} name={`spatial-screen-controls-${screen.id}`}>
      <SpatialPanel
        width={barWidth}
        height={barHeight}
        radius={SPATIAL_THEME.size.barRadius}
        color={SPATIAL_THEME.color.panel}
        opacity={SPATIAL_THEME.opacity.panel}
        border={SPATIAL_THEME.color.borderStrong}
        renderOrder={20}
      />
      {layout.placed.map((control, index) => (
        control.divider ? (
          <mesh key={`divider-${index}`} position={[origin + control.offset, 0, 0.002]} renderOrder={22}>
            <planeGeometry args={[SPATIAL_THEME.size.dividerWidth, SPATIAL_THEME.size.dividerHeight]} />
            <meshBasicMaterial
              color={SPATIAL_THEME.color.borderStrong}
              transparent
              opacity={0.7}
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
            />
          </mesh>
        ) : (
          <SpatialButton
            key={control.id}
            icon={control.icon}
            label={control.label}
            position={[origin + control.offset, 0, 0.002]}
            active={control.active}
            disabled={control.disabled}
            danger={control.danger}
            onSelect={control.onSelect}
            renderOrder={22}
            testId={`spatial-${control.icon}`}
          />
        )
      ))}
    </group>
  );
};

export default SpatialScreenControls;
