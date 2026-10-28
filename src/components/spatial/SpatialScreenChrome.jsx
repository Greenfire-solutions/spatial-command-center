import React, { useCallback, useMemo } from 'react';
import { BROWSER_HEADER_WORLD_HEIGHT } from '../../constants.js';
import { computeWindowRegions } from '../../windows/window-regions.js';
import { SPATIAL_THEME, SpatialLabel } from '../../spatial-ui/index.js';
import { createScreenActions } from '../../interaction/screen-actions.js';
import { useStore } from '../../store/workspace-store.js';
import { openKeyboard } from '../../xr/keyboard-state.js';
import { resolveBrowserProvider } from '../../providers/index.js';
import SpatialScreenControls from './SpatialScreenControls.jsx';
import SpatialBrowserBar from './SpatialBrowserBar.jsx';

/*
 * Binds the in-scene chrome to the workspace.
 *
 * This component is the spatial counterpart of ScreenControls plus the DOM
 * browser header. It exists so that every essential interaction — arranging a
 * screen and navigating its page — is reachable without any HTML overlay, and
 * therefore survives the transition into an immersive session where drei's
 * <Html> renders nothing at all.
 *
 * It shares createScreenActions with the DOM bar, so the two surfaces cannot
 * drift apart in behaviour.
 */
export const SpatialScreenChrome = ({
  screen,
  objectRef,
  hovered,
  isSelected,
  showResize,
  setShowResize,
  width,
  height,
  isChromium,
  chromiumState,
  connectionView
}) => {
  const interactionMode = useStore((state) => state.interactionMode);
  const showToast = useStore((state) => state.showToast);
  const switchScreenSource = useStore((state) => state.switchScreenSource);
  const requestUrlFocus = useStore((state) => state.requestUrlFocus);

  const actions = useMemo(
    () => createScreenActions({ screen, objectRef, setShowResize }),
    [screen, objectRef, setShowResize]
  );

  const editable = !screen.locked;
  const visible = isSelected || hovered;
  const interactive = interactionMode === 'browse' || screen.locked;

  const provider = resolveBrowserProvider();
  const url = (isChromium ? chromiumState?.url : null) || screen.source.url || screen.url || '';
  const title = (isChromium ? chromiumState?.title : null) || screen.title;

  const navigate = useCallback((method) => {
    if (!isChromium) {
      showToast('Spatial history controls apply to Full Browser screens.');
      return;
    }
    if (!provider.available) {
      showToast('Local Chromium is offline.');
      return;
    }
    Promise.resolve(provider[method](screen.source.sourceId)).catch((error) => {
      showToast(error?.message || 'Browser navigation failed.');
    });
  }, [isChromium, provider, screen.source.sourceId, showToast]);

  /* Text entry still needs a keyboard. On the desktop the spatial address
   * field hands focus to the DOM field; a headset will need a spatial
   * keyboard, which belongs with the XR input work rather than here. */
  /*
   * Tapping the address field opens the spatial keyboard, seeded with the
   * current address. The DOM field is focused as well, so the same tap does the
   * right thing on a desktop where the overlay is what you can see.
   */
  const activateAddress = useCallback(() => {
    useStore.getState().setSelectedScreen(screen.id);
    requestUrlFocus(screen.id);
    openKeyboard({ mode: 'address', screenId: screen.id, buffer: screen.url || '' });
  }, [requestUrlFocus, screen.id, screen.url]);

  /* One source of truth for where the page sits, shared with the panel itself,
   * so the bar cannot drift away from the content it belongs to. */
  const regions = computeWindowRegions({ width, height, headerHeight: BROWSER_HEADER_WORLD_HEIGHT });
  const contentHeight = regions.content.height;
  const barY = regions.content.y + contentHeight / 2 + SPATIAL_THEME.size.browserBarHeight / 2;

  return (
    <group name={`spatial-chrome-${screen.id}`}>
      <SpatialBrowserBar
        width={Math.max(0.4, width - 0.02)}
        url={url}
        title={title}
        loading={Boolean(chromiumState?.loading)}
        canGoBack={Boolean(chromiumState?.canGoBack)}
        canGoForward={Boolean(chromiumState?.canGoForward)}
        fullBrowser={isChromium}
        statusMessage={connectionView && connectionView.kind !== 'ready' ? connectionView.message : ''}
        interactive={interactive}
        onBack={() => navigate('back')}
        onForward={() => navigate('forward')}
        onReload={() => navigate('reload')}
        onActivateAddress={activateAddress}
        onToggleSource={() => switchScreenSource(screen.id, isChromium ? 'iframe' : 'chromium')}
        position={[0, barY, SPATIAL_THEME.size.surfaceOffset + 0.03]}
      />

      <SpatialScreenControls
        screen={screen}
        visible={visible}
        editable={editable}
        moveActive={interactionMode === 'arrange' && !showResize}
        resizeActive={showResize}
        onMove={actions.beginMove}
        onRotateLeft={() => { actions.rotateStep(1); actions.commit(); }}
        onRotateRight={() => { actions.rotateStep(-1); actions.commit(); }}
        onFaceCamera={actions.faceCamera}
        onToggleResize={() => actions.toggleResize(!showResize)}
        onToggleLock={actions.toggleLock}
        onDuplicate={actions.duplicate}
        onClose={actions.close}
        position={[0, height / 2 + 0.11, SPATIAL_THEME.size.surfaceOffset + 0.06]}
      />

      {screen.locked && (
        <SpatialLabel
          position={[width / 2 - 0.1, -height / 2 + 0.06, SPATIAL_THEME.size.surfaceOffset + 0.04]}
          anchorX="right"
          size={SPATIAL_THEME.size.captionSize * 0.85}
          color={SPATIAL_THEME.color.textMuted}
          renderOrder={24}
        >
          LOCKED
        </SpatialLabel>
      )}
    </group>
  );
};

export default SpatialScreenChrome;
