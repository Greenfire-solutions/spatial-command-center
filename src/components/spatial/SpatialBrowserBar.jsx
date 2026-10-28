import React, { useMemo } from 'react';
import {
  SPATIAL_THEME,
  SpatialButton,
  SpatialLabel,
  SpatialPanel,
  roundedRectGeometry
} from '../../spatial-ui/index.js';

/*
 * The in-scene browser chrome: history, reload, the current address, source
 * mode, and connection status.
 *
 * Together with SpatialScreenControls this is the other interface that has to
 * exist as geometry rather than DOM, because navigating a browser surface is
 * the workspace's core workflow and it cannot depend on an HTML overlay that
 * vanishes inside an immersive session.
 *
 * Text entry is deliberately not solved here. The address is displayed and the
 * field is activatable; on the desktop that hands focus to the DOM field, and
 * a headset will need a spatial keyboard, which belongs with the XR input
 * work rather than with this layout. What matters now is that the affordance
 * and the state readout are real scene objects.
 */

const BUTTON = SPATIAL_THEME.size.buttonSize * 0.78;
const GAP = SPATIAL_THEME.size.buttonGap;
const PADDING = SPATIAL_THEME.size.barPadding * 0.8;

const displayAddress = (url) => {
  if (!url) return 'Search or enter website';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}`;
  } catch {
    return url;
  }
};

export const SpatialBrowserBar = ({
  width,
  url,
  title,
  loading,
  canGoBack,
  canGoForward,
  fullBrowser,
  statusMessage,
  interactive,
  onBack,
  onForward,
  onReload,
  onActivateAddress,
  onToggleSource,
  position = [0, 0, 0]
}) => {
  const barHeight = SPATIAL_THEME.size.browserBarHeight;
  const navigationWidth = BUTTON * 3 + GAP * 2;
  const modeWidth = BUTTON * 1.9;
  const addressWidth = Math.max(
    0.12,
    width - PADDING * 2 - navigationWidth - modeWidth - GAP * 3
  );

  const addressGeometry = useMemo(
    () => roundedRectGeometry(addressWidth, SPATIAL_THEME.size.addressHeight, SPATIAL_THEME.size.addressRadius),
    [addressWidth]
  );

  const left = -width / 2 + PADDING;
  const backX = left + BUTTON / 2;
  const forwardX = backX + BUTTON + GAP;
  const reloadX = forwardX + BUTTON + GAP;
  const addressX = reloadX + BUTTON / 2 + GAP + addressWidth / 2;
  const modeX = addressX + addressWidth / 2 + GAP + modeWidth / 2;

  return (
    <group position={position} name="spatial-browser-bar">
      <SpatialPanel
        width={width}
        height={barHeight}
        radius={SPATIAL_THEME.size.browserBarRadius}
        color={SPATIAL_THEME.color.panelRaised}
        opacity={SPATIAL_THEME.opacity.panel}
        border={SPATIAL_THEME.color.border}
        renderOrder={20}
      />

      <SpatialButton
        icon="back"
        label="Back"
        size={BUTTON}
        position={[backX, 0, 0.002]}
        disabled={!interactive || !canGoBack}
        onSelect={onBack}
        renderOrder={22}
      />
      <SpatialButton
        icon="forward"
        label="Forward"
        size={BUTTON}
        position={[forwardX, 0, 0.002]}
        disabled={!interactive || !canGoForward}
        onSelect={onForward}
        renderOrder={22}
      />
      <SpatialButton
        icon="reload"
        label="Reload"
        size={BUTTON}
        position={[reloadX, 0, 0.002]}
        disabled={!interactive || !url}
        onSelect={onReload}
        renderOrder={22}
      />

      {/* Address field. A real ray target, not a label. */}
      <group
        position={[addressX, 0, 0.002]}
        name="spatial-address-field"
        onPointerDown={(event) => {
          event.stopPropagation();
          if (interactive && onActivateAddress) onActivateAddress();
        }}
      >
        <mesh geometry={addressGeometry} renderOrder={22}>
          <meshBasicMaterial
            color="#0d1015"
            transparent
            opacity={0.9}
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
          />
        </mesh>
        <SpatialLabel
          position={[-addressWidth / 2 + 0.018, 0, 0.002]}
          anchorX="left"
          size={SPATIAL_THEME.size.captionSize}
          color={url ? SPATIAL_THEME.color.text : SPATIAL_THEME.color.textMuted}
          maxWidth={addressWidth - 0.036}
          clipRect={[0, -SPATIAL_THEME.size.addressHeight / 2, addressWidth - 0.036, SPATIAL_THEME.size.addressHeight / 2]}
          renderOrder={24}
        >
          {displayAddress(url)}
        </SpatialLabel>
      </group>

      {/* Source mode. Reads as a state readout that can also be actuated. */}
      <group
        position={[modeX, 0, 0.002]}
        name="spatial-source-mode"
        onPointerDown={(event) => {
          event.stopPropagation();
          if (interactive && onToggleSource) onToggleSource();
        }}
      >
        <mesh
          geometry={useMemo(
            () => roundedRectGeometry(modeWidth, SPATIAL_THEME.size.addressHeight, SPATIAL_THEME.size.addressRadius),
            [modeWidth]
          )}
          renderOrder={22}
        >
          <meshBasicMaterial
            color={fullBrowser ? SPATIAL_THEME.color.accentSoft : '#171b22'}
            transparent
            opacity={0.92}
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
          />
        </mesh>
        <SpatialLabel
          position={[0, 0, 0.002]}
          size={SPATIAL_THEME.size.captionSize * 0.82}
          color={fullBrowser ? SPATIAL_THEME.color.accentGlow : SPATIAL_THEME.color.textMuted}
          renderOrder={24}
        >
          {fullBrowser ? 'FULL' : 'DIRECT'}
        </SpatialLabel>
      </group>

      {/* Title and connection status sit above the bar, where they inform
          without competing with the controls. */}
      <SpatialLabel
        position={[-width / 2 + PADDING, barHeight / 2 + 0.028, 0.002]}
        anchorX="left"
        size={SPATIAL_THEME.size.captionSize}
        color={SPATIAL_THEME.color.textMuted}
        maxWidth={width * 0.62}
        renderOrder={24}
      >
        {title || 'Untitled screen'}
      </SpatialLabel>

      {(loading || statusMessage) && (
        <SpatialLabel
          position={[width / 2 - PADDING, barHeight / 2 + 0.028, 0.002]}
          anchorX="right"
          size={SPATIAL_THEME.size.captionSize * 0.9}
          color={loading ? SPATIAL_THEME.color.accent : SPATIAL_THEME.color.warning}
          renderOrder={24}
        >
          {loading ? 'LOADING' : statusMessage}
        </SpatialLabel>
      )}
    </group>
  );
};

export default SpatialBrowserBar;
