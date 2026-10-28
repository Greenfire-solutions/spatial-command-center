import React, { useMemo } from 'react';
import * as THREE from 'three';
import { roundedRectGeometry } from './geometry.js';
import { SPATIAL_THEME } from './theme.js';

/*
 * A flat, soft-cornered surface used as the ground for spatial chrome.
 *
 * Panels are unlit on purpose. Chrome that responds to scene lighting reads as
 * an object in the room rather than as an instrument surface, and it becomes
 * unreadable when a screen is angled away from the key light. Depth comes from
 * layering and a hairline border instead.
 */
export const SpatialPanel = ({
  width,
  height,
  radius = SPATIAL_THEME.size.barRadius,
  color = SPATIAL_THEME.color.panel,
  opacity = SPATIAL_THEME.opacity.panel,
  border = SPATIAL_THEME.color.border,
  borderOpacity = SPATIAL_THEME.opacity.hairline,
  position = [0, 0, 0],
  renderOrder = 10,
  children,
  ...rest
}) => {
  const geometry = useMemo(() => roundedRectGeometry(width, height, radius), [width, height, radius]);
  const borderGeometry = useMemo(
    () => roundedRectGeometry(width + 0.003, height + 0.003, radius + 0.0015),
    [width, height, radius]
  );

  return (
    <group position={position} {...rest}>
      {border && (
        <mesh geometry={borderGeometry} renderOrder={renderOrder - 1} position={[0, 0, -0.0006]}>
          <meshBasicMaterial
            color={border}
            transparent
            opacity={borderOpacity}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      )}
      <mesh geometry={geometry} renderOrder={renderOrder}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {children}
    </group>
  );
};

export default SpatialPanel;
