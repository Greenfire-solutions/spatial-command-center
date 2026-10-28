import React, { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { roundedRectGeometry } from './geometry.js';
import { iconTexture } from './icon-texture.js';
import { SPATIAL_THEME } from './theme.js';

/*
 * An icon button that lives in the scene rather than in the DOM.
 *
 * It is driven entirely by ray intersections, so the same component responds
 * to a desktop mouse ray today and to a controller ray or a hand pinch later
 * without modification. No pixel coordinates appear anywhere in it.
 *
 * State is intentionally legible at a glance and at distance: the plate
 * brightens on hover, the icon goes to full white when active, and a disabled
 * control fades rather than disappearing so the layout never shifts.
 */
export const SpatialButton = ({
  icon,
  label,
  size = SPATIAL_THEME.size.buttonSize,
  position = [0, 0, 0],
  active = false,
  disabled = false,
  danger = false,
  onSelect,
  renderOrder = 12,
  testId
}) => {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);

  const plateGeometry = useMemo(
    () => roundedRectGeometry(size, size, size * 0.26),
    [size]
  );
  const texture = useMemo(() => iconTexture(icon), [icon]);

  const plateColor = disabled
    ? SPATIAL_THEME.color.panel
    : danger && hovered
      ? SPATIAL_THEME.color.dangerSoft
      : active || hovered
        ? SPATIAL_THEME.color.accentSoft
        : SPATIAL_THEME.color.panelRaised;

  const plateOpacity = disabled
    ? SPATIAL_THEME.opacity.disabled
    : active || hovered
      ? 0.95
      : 0.0;

  const iconColor = disabled
    ? SPATIAL_THEME.color.iconDisabled
    : danger && hovered
      ? SPATIAL_THEME.color.danger
      : active || hovered
        ? SPATIAL_THEME.color.iconActive
        : SPATIAL_THEME.color.icon;

  const stop = (event) => event.stopPropagation();

  /* Capture the pointer while pressed. Without it, any ray movement between
   * press and release delivers the release to a different object and the
   * activation is silently lost — the spatial equivalent of a button that
   * only works if your finger never trembles. */
  const handleDown = useCallback((event) => {
    event.stopPropagation();
    if (disabled) return;
    pressedRef.current = true;
    setPressed(true);
    try {
      if (event.target && typeof event.target.setPointerCapture === 'function') {
        event.target.setPointerCapture(event.pointerId);
      }
    } catch {
      // Capture is an optimisation; the handlers below still work without it.
    }
  }, [disabled]);

  const handleUp = useCallback((event) => {
    event.stopPropagation();
    const wasPressed = pressedRef.current;
    pressedRef.current = false;
    setPressed(false);
    try {
      if (event.target && typeof event.target.releasePointerCapture === 'function') {
        event.target.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The capture may already have been released.
    }
    if (!disabled && wasPressed && onSelect) onSelect();
  }, [disabled, onSelect]);

  const iconScale = size * (1 - SPATIAL_THEME.size.iconInset * 2) * (pressed ? 0.92 : 1);

  return (
    <group
      position={position}
      name={`spatial-button-${icon}`}
      userData={{ role: 'spatial-button', icon, label, testId, disabled }}
      onPointerOver={(event) => {
        stop(event);
        if (!disabled) setHovered(true);
      }}
      onPointerOut={(event) => {
        stop(event);
        setHovered(false);
        pressedRef.current = false;
        setPressed(false);
      }}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onLostPointerCapture={() => {
        pressedRef.current = false;
        setPressed(false);
      }}
    >
      {/* Always-present hit plate. It stays invisible until hovered so the
          bar reads as a row of glyphs, but the ray target never moves. */}
      <mesh geometry={plateGeometry} renderOrder={renderOrder}>
        <meshBasicMaterial
          color={plateColor}
          transparent
          opacity={plateOpacity}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {texture && (
        <mesh position={[0, 0, 0.001]} renderOrder={renderOrder + 1}>
          <planeGeometry args={[iconScale, iconScale]} />
          <meshBasicMaterial
            map={texture}
            color={iconColor}
            transparent
            opacity={disabled ? SPATIAL_THEME.opacity.disabled : 1}
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
};

export default SpatialButton;
