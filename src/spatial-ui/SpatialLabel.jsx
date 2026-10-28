import React from 'react';
import { Text } from '@react-three/drei';
import { SPATIAL_THEME } from './theme.js';

/*
 * Signed-distance-field text via troika. It stays sharp at any distance and at
 * any angle, which matters more in a headset than on a monitor: a screen
 * three metres away and rotated 40 degrees still has to be readable.
 *
 * Text is unlit and tone-mapping is disabled so a label's contrast against its
 * panel is exactly what the theme specifies, regardless of scene lighting.
 */
export const SpatialLabel = ({
  children,
  size = SPATIAL_THEME.size.labelSize,
  color = SPATIAL_THEME.color.text,
  maxWidth,
  anchorX = 'center',
  anchorY = 'middle',
  opacity = 1,
  renderOrder = 14,
  position = [0, 0, 0],
  ...rest
}) => (
  <Text
    position={position}
    fontSize={size}
    color={color}
    anchorX={anchorX}
    anchorY={anchorY}
    maxWidth={maxWidth}
    overflowWrap="normal"
    whiteSpace="nowrap"
    renderOrder={renderOrder}
    fillOpacity={opacity}
    depthOffset={-1}
    material-toneMapped={false}
    material-depthWrite={false}
    material-depthTest={false}
    {...rest}
  >
    {children}
  </Text>
);

export default SpatialLabel;
