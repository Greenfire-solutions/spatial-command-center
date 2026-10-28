import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Edges,
  Html,
  OrbitControls,
  RoundedBox,
  TransformControls
} from '@react-three/drei';
import {
  ChromiumTextureSource,
  getChromiumSourceRuntime,
  useChromiumSourceState
} from './chromium-texture-source.js';
import { XR, useXR } from '@react-three/xr';
import { normalizeBrowserInput } from './url-normalization.js';
import {
  BROWSER_HEADER_WORLD_HEIGHT,
  DEG,
  ROTATION_ORDER
} from './constants.js';
import { clamp } from './utils/math.js';
import { serializeScreen } from './store/workspace-schema.js';
import { PRESETS } from './presets/workspace-presets.js';
import { useStore } from './store/workspace-store.js';
import {
  manipulationDiagnostics,
  objectTransform, worldToLocal,
  recordManipulationAttempt,
  sceneRuntime
} from './systems/scene-runtime.js';
import {
  COLLIDER_Z,
  REGION_GESTURE,
  computeWindowRegions
} from './windows/window-regions.js';
import { applyArcArrangement, createScreenInFront } from './systems/workspace-actions.js';
import {
  MAX_GRAB_DISTANCE,
  MIN_GRAB_DISTANCE,
  ScreenInteraction,
  clampWorldDistance
} from './interaction/screen-interaction.js';
import { snapScreenPosition } from './interaction/snapping.js';
import StudioEnvironment from './systems/StudioEnvironment.jsx';
import ConnectorConfigPanel from './connectors/ConnectorConfigPanel.jsx';
import ConnectorDrawing from './connectors/ConnectorDrawing.jsx';
import VoiceCommands from './voice/VoiceCommands.jsx';
import BindingsLauncher from './components/BindingsLauncher.jsx';
import XrControllerBindings from './xr/XrControllerBindings.jsx';
import SpatialKeyboard from './xr/SpatialKeyboard.jsx';
import AgentNodes from './agents/AgentNodes.jsx';
import WorkspaceRoot from './systems/WorkspaceRoot.jsx';
import { FRAMING, classifyLoadedFrame, framingMessage, knownFramingPolicy } from './windows/embedding.js';
import XrSystemUi from './xr/XrSystemUi.jsx';
import AgentBootstrap from './agents/AgentBootstrap.jsx';
import LayerDirector from './xr/LayerDirector.jsx';
import { environmentAllowed, needsTransparentBaseLayer } from './xr/layer-policy.js';
import { resolveDeviceScaleFactor } from './systems/browser-resolution.js';
import { xrStore } from './xr/xr-store.js';
import { installDiagnostics } from './xr/diagnostics.js';

/*
 * Telemetry is installed for every entry point, not only xr.html.
 *
 * The headset is now told where its host is by the server, so the workspace is
 * opened at the bare origin — which loads this module, not the probe entry. For
 * a while that meant the one build a headset actually runs was the one build
 * that reported nothing, and a session could only be described rather than
 * measured. It is inert unless a server is listening on /__diag, so it costs
 * nothing anywhere else.
 */
installDiagnostics();
import XrSystem from './xr/XrSystem.jsx';
import XrControllerInput from './xr/XrControllerInput.jsx';
import XrEntryControls from './xr/XrEntryControls.jsx';
import LegibilityProbe from './xr/LegibilityProbe.jsx';
import DiagnosticsHud from './xr/DiagnosticsHud.jsx';
import XrNavigation from './xr/XrNavigation.jsx';

/*
 * The legibility probe is a measurement instrument, not a feature.
 *
 * It compares a browser surface drawn as a textured mesh against the same
 * surface drawn as a WebXR quad layer, to establish whether a mesh can carry
 * readable page text at the Quest 3's roughly 25 pixels per degree. That answer
 * decides whether the remote provider should deliver pixels for a mesh or a
 * source a compositor layer can consume, so it is worth settling before the
 * transport is built.
 *
 * Gated behind ?probe=1, and it hides the workspace while active: the screen
 * arc sits between the camera and the probe, and a partially occluded panel
 * cannot be read. One question at a time.
 */
const searchParam = (name) => (typeof window === 'undefined'
  ? null
  : new URLSearchParams(window.location.search).get(name));

const searchFlag = (name) => typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has(name);

const probeEnabled = searchFlag('probe');
const forceXrUi = searchFlag('xr-ui');

/*
 * Scene layers as a positional mask: ?diag=<digits>
 *
 *   position 1  HUD          the diagnostics panel
 *   position 2  ENV          StudioEnvironment (renders through a CubeCamera)
 *   position 3  SHADOW       ContactShadows (renders through a render target)
 *   position 4  SCREENS      the spatial screens and their connections
 *   position 5  QUALITY      the adaptive browser-quality director
 *
 * A digit of 1 keeps the layer, 0 removes it, and any position left off the end
 * defaults to 1. So ?diag=1 is everything with the panel on, ?diag=100 drops the
 * two render-target components, and ?diag=10000 is the panel alone.
 *
 * This replaces a pile of ?no-this&no-that flags that were long to type on a
 * headset keyboard and easy to get subtly wrong, which already cost one bad
 * test result.
 */
const DIAG_LAYERS = ['hud', 'env', 'shadow', 'screens', 'quality'];

const diagMask = (() => {
  const raw = searchParam('diag');
  if (raw === null) return null;
  const digits = String(raw).replace(/[^01]/g, '');
  return DIAG_LAYERS.map((_, index) => digits[index] !== '0');
})();

const layerOn = (name) => {
  if (!diagMask) return true;
  const index = DIAG_LAYERS.indexOf(name);
  return index < 0 ? true : diagMask[index];
};

const diagEnabled = Boolean(diagMask) && layerOn('hud');
/* ?standoff=2.4 tunes how far you stand from the arc, so the right distance can
 * be found by feel in the headset instead of guessed here. */
/*
 * ?layout=<preset> applies an arrangement on load.
 *
 * Without it a shortcut like /desktop drops you into whatever workspace was
 * last saved, which is usually a five-screen developer arc full of placeholder
 * content. Somebody who asked for the desktop should meet the desktop.
 */
const requestedLayout = searchParam('layout');

const standoffMetres = (() => {
  const raw = Number(searchParam('standoff'));
  return Number.isFinite(raw) && raw > 0.5 && raw < 12 ? raw : 2.4;
})();

const maskLabel = diagMask
  ? DIAG_LAYERS.map((layer) => (layerOn(layer) ? '1' : '0')).join('')
  : '(default)';

/*
 * The headset build sets this global before the app boots, so telemetry is
 * reported from every session rather than only when a flag is remembered. A
 * silent session produces no evidence, which is the one outcome worth
 * engineering away.
 */
const xrProbeBuild = typeof window !== 'undefined' && Boolean(window.__SCC_XR_PROBE__);
import {
  BrowserQualityController,
  evaluateQuality
} from './systems/browser-quality.js';
import { resolveBrowserProvider } from './providers/index.js';
import { createScreenActions } from './interaction/screen-actions.js';
import {
  applyCameraControlState,
  releaseAllCameraLocks,
  setCameraLock
} from './systems/camera-control.js';
import {
  isPresenting,
  viewpointAspect,
  viewpointFov,
  viewpointForwardHorizontal,
  viewpointPosition
} from './systems/viewpoint.js';
import SpatialScreenChrome from './components/spatial/SpatialScreenChrome.jsx';

/* How far a screen travels along the viewer's forward axis per unit of
 * pointer travel during a depth drag. Expressed in metres so that a
 * thumbstick or a pinch can supply the same scalar without conversion. */
const PUSH_PULL_PER_PIXEL = 0.01;

/* React key for a Chromium-backed screen.
 *
 * Changing this key unmounts the ChromiumTextureSource, which destroys the
 * browser source, and mounts a new one, which creates a fresh source. That is
 * the intended recovery path for a crashed or wedged page, and it is a named
 * function so the coupling between the retry nonce and the component lifetime
 * is explicit rather than an unexplained string concatenation. */
const browserSourceKey = (screen) => (
  screen.source.sourceId + ':' + (screen._browserRetryNonce || 0)
);

const Icon = ({ name, size = 15 }) => {
  let content = null;
  switch (name) {
    case 'move':
      content = <><path d="M12 2v20M2 12h20" /><path d="m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4" /></>;
      break;
    case 'rotate-left':
      content = <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></>;
      break;
    case 'rotate-right':
      content = <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>;
      break;
    case 'face':
      content = <><circle cx="12" cy="12" r="3" /><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /></>;
      break;
    case 'scale':
      content = <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><path d="m3 8 5-5m8 0 5 5M3 16l5 5m8 0 5-5" /></>;
      break;
    case 'lock':
      content = <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>;
      break;
    case 'unlock':
      content = <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></>;
      break;
    case 'copy':
      content = <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>;
      break;
    case 'close':
      content = <><path d="m6 6 12 12M18 6 6 18" /></>;
      break;
    case 'more':
      content = <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>;
      break;
    case 'focus':
      content = <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><circle cx="12" cy="12" r="3" /></>;
      break;
    case 'reset':
      content = <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></>;
      break;
    case 'back':
      content = <><path d="m15 18-6-6 6-6" /></>;
      break;
    case 'forward':
      content = <><path d="m9 18 6-6-6-6" /></>;
      break;
    case 'reload':
      content = <><path d="M20 11a8 8 0 1 0-2.35 5.65" /><path d="M20 4v7h-7" /></>;
      break;
    case 'external':
      content = <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>;
      break;
    case 'globe':
      content = <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>;
      break;
    case 'plus':
      content = <><path d="M12 5v14M5 12h14" /></>;
      break;
    case 'save':
      content = <><path d="M5 3h12l4 4v14H3V3h2Z" /><path d="M7 3v6h10V3M8 21v-7h8v7" /></>;
      break;
    case 'arc':
      content = <><path d="M3 17c4-8 14-8 18 0" /><circle cx="5" cy="14" r="1.5" /><circle cx="12" cy="9" r="1.5" /><circle cx="19" cy="14" r="1.5" /></>;
      break;
    case 'info':
      content = <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>;
      break;
    case 'depth-in':
      content = <><path d="M12 3v14M7 12l5 5 5-5" /><path d="M5 21h14" /></>;
      break;
    case 'depth-out':
      content = <><path d="M12 21V7M7 12l5-5 5 5" /><path d="M5 3h14" /></>;
      break;
    default:
      content = <circle cx="12" cy="12" r="8" />;
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
};

const BrowserButton = ({ action, label, disabled, onClick, children }) => (
  <button
    type="button"
    className="browser-icon-button"
    data-browser-action={action}
    aria-label={label}
    title={label}
    disabled={disabled}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      if (!disabled) onClick();
    }}
  >
    {children}
  </button>
);

const SourceModeButton = ({ fullBrowser, onClick }) => (
  <button
    type="button"
    className={'h-[25px] px-2 rounded-lg border text-[8px] font-bold tracking-[0.08em] whitespace-nowrap transition-colors ' + (
      fullBrowser
        ? 'border-blue-400/30 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25'
        : 'border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
    )}
    data-browser-action="switch-source"
    data-source-mode={fullBrowser ? 'full-browser' : 'direct'}
    aria-label={fullBrowser ? 'Switch to Direct iframe mode' : 'Switch to Full Browser mode'}
    title={fullBrowser ? 'Full Browser active: switch to Direct iframe' : 'Direct iframe active: switch to Full Browser'}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    {fullBrowser ? 'FULL BROWSER' : 'DIRECT'}
  </button>
);

/* Electron denies renderer-initiated window creation by design, so window.open
 * is a silent no-op inside the desktop app. Route the request through the
 * trusted main process, and keep window.open only for the plain-browser build. */
const openExternal = (url) => {
  if (!url) return;
  const provider = resolveBrowserProvider();
  if (provider.available && typeof provider.openExternal === 'function') {
    Promise.resolve(provider.openExternal(url)).catch((error) => {
      useStore.getState().showToast(
        (error && error.message) || 'Could not open this address in a real browser tab.'
      );
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

const MockRenderer = ({ screen }) => (
  <div className={screen.type === 'code' ? 'code-text' : 'default-content'}>
    {screen.type === 'code' && (
      <div className="text-[10px]">
        <span className="text-blue-400">import</span>{' '}
        <span className="text-yellow-300">{'* as THREE'}</span>{' '}
        <span className="text-blue-400">from</span>{' '}
        <span className="text-orange-300">'three'</span>;<br /><br />
        <span className="text-purple-400">class</span>{' '}
        <span className="text-blue-300">SpatialBridge</span> {'{'}<br />
        &nbsp;&nbsp;<span className="text-blue-300">connect</span>() {'{'}<br />
        &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-gray-500">// Source-independent monitor renderer</span><br />
        &nbsp;&nbsp;&nbsp;&nbsp;console.log(<span className="text-orange-300">'Bridge active'</span>);<br />
        &nbsp;&nbsp;{'}'}<br />
        {'}'}
        <br /><br />
        <span className="text-gray-500 block mt-4 border-t border-gray-700 pt-4 text-xs italic">
          Enter a web address above to turn this plane into a live browser.
        </span>
      </div>
    )}

    {screen.type === 'terminal' && (
      <div className="text-green-400 font-mono text-[10px]">
        user@spatial-os:~$ pnpm run dev<br />
        &gt; starting spatial environment...<br />
        [OK] Screen source router ready<br />
        [OK] XR-compatible grab actions ready<br />
        Waiting for companion bridge connection...
      </div>
    )}

    {(screen.type === 'docs' || screen.type === 'browser') && (
      <div className="font-sans text-gray-300">
        <h1 className="text-lg font-bold text-white mb-2">Architecture Spec</h1>
        <p className="text-gray-400 text-xs leading-relaxed">
          Each spatial monitor owns its physical transform while a separate source object supplies its pixels.
          Iframe, real Chrome tab, desktop window, and stream sources can share the same interaction system.
        </p>
        <div className="mt-4 p-2 bg-gray-800/50 rounded border border-gray-700">
          <code className="text-blue-300 text-[9px]">
            ScreenRenderer(source) → Iframe | Mock | ChromeTab | Stream
          </code>
        </div>
      </div>
    )}

    {screen.type === 'chat' && (
      <div className="font-sans flex flex-col gap-3 text-xs text-gray-300">
        <div className="bg-gray-800 p-2 rounded-lg ml-4">Arrange these monitors around my workspace.</div>
        <div className="bg-blue-900/30 p-2 rounded-lg mr-4 border border-blue-700/30 text-blue-100">
          Arrange Mode is ready. Drag a screen directly, hold Shift for depth, or press R while dragging to rotate.
        </div>
      </div>
    )}
  </div>
);

const NewTabRenderer = () => (
  <div className="h-full flex flex-col items-center justify-center text-center bg-[#121820] text-gray-400 px-8">
    <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-400/20 text-blue-300 flex items-center justify-center mb-4">
      <Icon name="globe" size={22} />
    </div>
    <div className="text-white text-sm font-semibold">New spatial browser</div>
    <div className="text-[10px] mt-2 max-w-[280px] leading-relaxed">
      Type a web address or search above. If a site blocks embedding, switch this screen to Full Browser.
    </div>
  </div>
);

const ChromeTabRenderer = ({ source }) => (
  <div className="h-full flex items-center justify-center bg-[#111821] p-8 text-center">
    <div>
      <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-400/20 text-blue-300 flex items-center justify-center">
        <Icon name="globe" size={22} />
      </div>
      <div className="mt-4 text-white text-sm font-semibold">Real Chrome tab source</div>
      <p className="mt-2 text-[10px] leading-relaxed text-gray-400 max-w-xs">
        Tab {source.sourceId || 'not connected'} is represented by the companion protocol. Live capture and input
        require an explicitly authorized extension connection.
      </p>
    </div>
  </div>
);

const StreamRenderer = ({ source }) => (
  <div className="h-full flex items-center justify-center bg-[#111821] p-8 text-center text-gray-400">
    <div>
      <div className="text-white text-sm font-semibold">{source.type === 'desktop-window' ? 'Desktop window' : 'Live stream'}</div>
      <div className="mt-2 text-[10px]">Waiting for source {source.sourceId || 'connection'}…</div>
    </div>
  </div>
);

const IframeRenderer = ({ id, url, title, reloadToken, onStatus, onEmbedIssue }) => {
  const iframeRef = useRef(null);
  const timeoutRef = useRef(null);

  /* Known before the request is made. Most of what anyone puts in a control
   * centre already refuses framing, and saying so instantly is better than
   * showing a white rectangle for several seconds first. */
  const knownPolicy = knownFramingPolicy(url);

  useEffect(() => {
    window.clearTimeout(timeoutRef.current);
    if (!url) {
      onStatus('idle');
      return undefined;
    }
    if (knownPolicy === FRAMING.BLOCKED) {
      onStatus('blocked');
      onEmbedIssue(true);
      return undefined;
    }
    onStatus('loading');
    /* A backstop for a site that never responds at all. Blocking itself is no
     * longer detected here — a refused frame fires `load` like any other, which
     * is why this timeout never used to fire and the panel stayed white. */
    timeoutRef.current = window.setTimeout(() => {
      onStatus('unresponsive');
      onEmbedIssue(true);
    }, 12000);
    return () => window.clearTimeout(timeoutRef.current);
  }, [url, reloadToken, onStatus, onEmbedIssue, knownPolicy]);

  useEffect(() => {
    const detectIframeFocus = () => {
      window.setTimeout(() => {
        if (document.activeElement === iframeRef.current) {
          useStore.getState().setSelectedScreen(id);
        }
      }, 0);
    };
    window.addEventListener('blur', detectIframeFocus);
    return () => window.removeEventListener('blur', detectIframeFocus);
  }, [id]);

  if (!url) return <NewTabRenderer />;
  /* Nothing is requested from a site we know will refuse. The panel shows the
   * refusal state instead, which ScreenBrowser renders over this. */
  if (knownPolicy === FRAMING.BLOCKED) return null;

  return (
    <iframe
      key={url + ':' + reloadToken}
      ref={iframeRef}
      data-testid="screen-iframe"
      data-screen-id={id}
      data-embed-state="unverified"
      src={url}
      title={title}
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
      onLoad={() => {
        window.clearTimeout(timeoutRef.current);
        /*
         * `load` is not proof of anything. A frame refused by X-Frame-Options
         * or frame-ancestors fires it too, having loaded the browser's own
         * blank error document — which is exactly how a refusal used to be
         * reported as a success and leave a white panel behind.
         *
         * So ask the frame where it is. Real cross-origin content refuses to
         * answer, and that refusal is the proof it worked.
         */
        const verdict = classifyLoadedFrame(
          () => iframeRef.current?.contentWindow?.location?.href
        );
        if (verdict === FRAMING.BLOCKED) {
          onStatus('blocked');
          onEmbedIssue(true);
          return;
        }
        onStatus('loaded');
      }}
      onError={() => {
        window.clearTimeout(timeoutRef.current);
        onStatus('blocked');
        onEmbedIssue(true);
      }}
    />
  );
};

const ScreenRenderer = ({ screen, reloadToken, onStatus, onEmbedIssue, chromiumState, onRetry }) => {
  const source = screen.source;
  if (source.type === 'chromium') {
    const state = chromiumState || {};
    const view = chromiumConnectionView(state);
    const showState = view.kind !== 'ready' && !(view.kind === 'loading' && state.textureReady);
    return showState ? (
      <div
        className="chromium-source-status"
        data-testid="chromium-source-status"
        data-connection-state={view.kind}
        style={{ pointerEvents: view.retryable ? 'auto' : 'none' }}
      >
        <span className="loading-dot" />
        <span>{view.message}</span>
        {view.retryable && (
          <button
            type="button"
            className="ml-1 px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            data-browser-action="retry-browser-state"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            RETRY
          </button>
        )}
      </div>
    ) : null;
  }
  if (source.type === 'iframe') {
    return (
      <IframeRenderer
        id={screen.id}
        url={source.url || screen.url}
        title={source.title || screen.title}
        reloadToken={reloadToken}
        onStatus={onStatus}
        onEmbedIssue={onEmbedIssue}
      />
    );
  }
  if (source.type === 'chrome-tab') return <ChromeTabRenderer source={source} />;
  if (source.type === 'desktop-window' || source.type === 'stream') return <StreamRenderer source={source} />;
  return <MockRenderer screen={screen} />;
};

const useChromiumMetadata = (screen) => {
  const sourceId = screen.source.sourceId;
  const metadata = useChromiumSourceState(sourceId);
  const runtime = getChromiumSourceRuntime(sourceId);
  return {
    url: screen.source.url || screen.url || '',
    title: screen.source.title || screen.title,
    favicon: screen.source.favicon || '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    ...metadata,
    state: metadata.status || metadata.state || (resolveBrowserProvider().available ? 'creating' : 'offline'),
    textureReady: Boolean(runtime && runtime.frameCount > 0),
    frameCount: runtime ? runtime.frameCount : 0,
    lastFrameId: runtime ? runtime.lastFrameId : 0
  };
};

const chromiumConnectionView = (chromiumState) => {
  const bridgeAvailable = resolveBrowserProvider().available;
  const stateName = String(chromiumState && (chromiumState.state || chromiumState.status) || '').toLowerCase();
  if (!bridgeAvailable || stateName === 'offline') {
    return {
      kind: 'offline',
      message: 'Local Chromium is offline. Launch the Electron app to use Full Browser.',
      retryable: true
    };
  }
  if (stateName === 'crashed') {
    return { kind: 'crashed', message: 'Full Browser crashed.', retryable: true };
  }
  if (stateName === 'error') {
    return { kind: 'error', message: 'Full Browser could not load this page.', retryable: true };
  }
  if (stateName === 'destroying' || stateName === 'destroyed') {
    return { kind: 'connecting', message: 'Reconnecting Full Browser…', retryable: false };
  }
  if (!chromiumState || !chromiumState.textureReady || stateName === 'creating' || stateName === 'connecting') {
    return { kind: 'connecting', message: 'Connecting Full Browser…', retryable: false };
  }
  if (chromiumState.loading || stateName === 'loading') {
    return { kind: 'loading', message: 'Loading in Full Browser…', retryable: false };
  }
  return { kind: 'ready', message: 'Full Browser connected', retryable: false };
};

const ScreenBrowser = ({ screen, selected }) => {
  const interactionMode = useStore((state) => state.interactionMode);
  const focusRequest = useStore((state) => state.urlFocusRequest);
  const updateScreenUrl = useStore((state) => state.updateScreenUrl);
  const switchScreenSource = useStore((state) => state.switchScreenSource);
  const retryBrowserSource = useStore((state) => state.retryBrowserSource);
  const setSelected = useStore((state) => state.setSelectedScreen);
  const showToast = useStore((state) => state.showToast);
  const inputRef = useRef(null);
  const [inputUrl, setInputUrl] = useState(screen.url || '');
  const [reloadToken, setReloadToken] = useState(0);
  const [browserStatus, setBrowserStatus] = useState(screen.url ? 'loading' : 'idle');
  const [embedHelp, setEmbedHelp] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [historyState, setHistoryState] = useState({
    entries: screen.url ? [screen.url] : [],
    index: screen.url ? 0 : -1
  });
  const isChromium = screen.source.type === 'chromium';
  const chromiumState = useChromiumMetadata(screen);
  const browserProvider = resolveBrowserProvider();
  const chromiumApi = browserProvider.available ? browserProvider : null;
  const browserSourceId = screen.source.sourceId;
  const interactive = interactionMode === 'browse' || screen.locked;
  const sourceUrl = isChromium
    ? chromiumState.url || screen.source.url || screen.url || ''
    : screen.source.url || screen.url || '';
  const chromiumView = chromiumConnectionView(chromiumState);
  const browserIsLoading = isChromium
    ? chromiumView.kind === 'connecting' || chromiumView.kind === 'loading'
    : browserStatus === 'loading';

  useEffect(() => {
    setInputUrl(sourceUrl);
    setEmbedHelp(false);
    setFaviconFailed(false);
    setHistoryState((current) => {
      if (current.index >= 0 && current.entries[current.index] === sourceUrl) return current;
      return { entries: sourceUrl ? [sourceUrl] : [], index: sourceUrl ? 0 : -1 };
    });
  }, [sourceUrl]);

  useEffect(() => {
    if (!isChromium) return;
    setBrowserStatus(chromiumState.loading ? 'loading' : chromiumState.state || 'ready');
  }, [isChromium, chromiumState.loading, chromiumState.state]);

  useEffect(() => {
    if (!focusRequest || focusRequest.id !== screen.id) return;
    const timer = window.setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest, screen.id]);

  const handleStatus = useCallback((status) => setBrowserStatus(status), []);
  const handleEmbedIssue = useCallback((value) => setEmbedHelp(Boolean(value)), []);

  const navigate = (rawUrl, pushHistory = true) => {
    const normalized = normalizeBrowserInput(rawUrl);
    if (!normalized.ok) {
      showToast(normalized.error);
      return false;
    }
    if (!normalized.url) {
      showToast('Enter a website or search term.');
      return false;
    }
    if (isChromium) {
      if (!chromiumApi) {
        showToast('Launch the Electron app to use the Chromium texture.');
        return false;
      }
      setEmbedHelp(false);
      setBrowserStatus('loading');
      setInputUrl(normalized.url);
      chromiumApi.navigate(browserSourceId, normalized.url).then((metadata) => {
        if (!metadata) return;
        if (metadata.url) {
          setInputUrl(metadata.url);
          updateScreenUrl(screen.id, metadata.url);
        }
      }).catch((error) => showToast(error.message || 'Chromium navigation failed.'));
      return true;
    }
    setInputUrl(normalized.url);
    setEmbedHelp(false);
    setBrowserStatus(normalized.url ? 'loading' : 'idle');
    if (pushHistory) {
      setHistoryState((current) => {
        const entries = current.entries.slice(0, current.index + 1);
        if (!entries.length || entries[entries.length - 1] !== normalized.url) entries.push(normalized.url);
        return { entries, index: entries.length - 1 };
      });
    }
    updateScreenUrl(screen.id, normalized.url);
    return true;
  };

  const goHistory = (direction) => {
    if (isChromium) {
      if (!chromiumApi) return;
      setBrowserStatus('loading');
      const method = direction < 0 ? 'back' : 'forward';
      chromiumApi[method](browserSourceId).catch((error) => {
        showToast(error.message || 'Chromium history navigation failed.');
      });
      return;
    }
    const nextIndex = historyState.index + direction;
    if (nextIndex < 0 || nextIndex >= historyState.entries.length) return;
    const nextUrl = historyState.entries[nextIndex];
    setHistoryState((current) => ({ ...current, index: nextIndex }));
    setInputUrl(nextUrl);
    setEmbedHelp(false);
    setBrowserStatus('loading');
    updateScreenUrl(screen.id, nextUrl);
  };

  const handleUrlKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    navigate(inputUrl, true);
    inputRef.current && inputRef.current.blur();
  };

  let faviconUrl = (isChromium ? chromiumState.favicon : screen.source.favicon) || '';
  if (!faviconUrl && sourceUrl) {
    try {
      faviconUrl = new URL('/favicon.ico', sourceUrl).href;
    } catch {
      faviconUrl = '';
    }
  }

  return (
    <div
      className={'mock-window' + (isChromium ? ' chromium-window' : '')}
      data-testid="spatial-screen"
      data-screen-id={screen.id}
      data-selected={selected ? 'true' : 'false'}
      data-locked={screen.locked ? 'true' : 'false'}
      data-source-type={screen.source.type}
      data-interactive={interactive ? 'true' : 'false'}
      data-manipulation-enabled={!interactive ? 'true' : 'false'}
      style={{ pointerEvents: isChromium ? 'none' : interactive ? 'auto' : 'none' }}
      onPointerDown={(event) => {
        event.stopPropagation();
        setSelected(screen.id);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="mock-header" data-testid="browser-bar" data-screen-id={screen.id} title={screen.title}>
        <div className="flex gap-1 shrink-0 mr-0.5" aria-hidden="true">
          <div className="w-2 h-2 rounded-full bg-red-500/75" />
          <div className="w-2 h-2 rounded-full bg-yellow-500/75" />
          <div className="w-2 h-2 rounded-full bg-green-500/75" />
        </div>

        <BrowserButton
          action="back"
          label="Back"
          disabled={isChromium ? !chromiumState.canGoBack : historyState.index <= 0}
          onClick={() => goHistory(-1)}
        >
          <Icon name="back" size={14} />
        </BrowserButton>
        <BrowserButton
          action="forward"
          label="Forward"
          disabled={isChromium
            ? !chromiumState.canGoForward
            : historyState.index < 0 || historyState.index >= historyState.entries.length - 1}
          onClick={() => goHistory(1)}
        >
          <Icon name="forward" size={14} />
        </BrowserButton>
        <BrowserButton
          action="reload"
          label="Reload"
          disabled={!sourceUrl}
          onClick={() => {
            setBrowserStatus('loading');
            if (isChromium && chromiumApi) {
              chromiumApi.reload(browserSourceId).catch((error) => {
                showToast(error.message || 'Chromium reload failed.');
              });
            } else {
              setReloadToken((value) => value + 1);
            }
          }}
        >
          <Icon name="reload" size={13} />
        </BrowserButton>

        <div className="w-4 h-4 shrink-0 flex items-center justify-center text-gray-400">
          {faviconUrl && !faviconFailed ? (
            <img
              src={faviconUrl}
              alt=""
              className="w-3.5 h-3.5 rounded-sm"
              onError={() => setFaviconFailed(true)}
            />
          ) : <Icon name="globe" size={13} />}
        </div>

        <input
          ref={inputRef}
          type="text"
          className="url-input"
          data-testid="url-input"
          data-screen-id={screen.id}
          aria-label={'Address for ' + screen.title}
          placeholder="Search or enter website"
          value={inputUrl}
          onChange={(event) => setInputUrl(event.target.value)}
          onKeyDown={handleUrlKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          spellCheck="false"
        />

        <SourceModeButton
          fullBrowser={isChromium}
          onClick={() => switchScreenSource(screen.id, isChromium ? 'iframe' : 'chromium')}
        />

        {browserIsLoading && (
          <span className="inline-flex items-center gap-1 shrink-0" title={isChromium ? chromiumView.message : 'Loading'}>
            <span className="loading-dot" data-testid="loading-indicator" />
            {isChromium && <span className="text-[8px] text-blue-200 font-semibold">LOADING</span>}
          </span>
        )}

        {isChromium && chromiumView.retryable && (
          <BrowserButton
            action="retry-browser"
            label="Retry Full Browser"
            onClick={() => retryBrowserSource(screen.id)}
          >
            <Icon name="reload" size={13} />
          </BrowserButton>
        )}

        {!isChromium && (
          <BrowserButton
            action="embed-help"
            label="Embedding help"
            disabled={!sourceUrl}
            onClick={() => setEmbedHelp(true)}
          >
            <Icon name="info" size={13} />
          </BrowserButton>
        )}
        {!isChromium && (
          <BrowserButton
            action="open-external"
            label="Open in real tab"
            disabled={!sourceUrl}
            onClick={() => openExternal(sourceUrl)}
          >
            <Icon name="external" size={13} />
          </BrowserButton>
        )}
      </div>

      <div className="mock-content">
        <ScreenRenderer
          screen={screen}
          reloadToken={reloadToken}
          onStatus={handleStatus}
          onEmbedIssue={handleEmbedIssue}
          chromiumState={chromiumState}
          onRetry={() => retryBrowserSource(screen.id)}
        />
        {!isChromium && embedHelp && sourceUrl && (
          <div className="embed-message" data-testid="embed-fallback">
            <div className="max-w-sm px-4">
              <div className="w-10 h-10 mx-auto rounded-xl bg-amber-500/10 border border-amber-400/20 flex items-center justify-center text-amber-300">
                <Icon name="info" size={18} />
              </div>
              <div className="text-white font-semibold text-sm mt-3" data-testid="embed-headline">
                This website prevents embedded viewing.
              </div>
              <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">
                {framingMessage(sourceUrl)} That is the site&rsquo;s own security policy,
                and it applies to every browser. Full Browser opens it in local
                Chromium, which is not a frame and is not subject to it.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
                <button
                  type="button"
                  className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold tracking-wide"
                  data-browser-action="open-full-browser"
                  onClick={() => switchScreenSource(screen.id, 'chromium')}
                >
                  OPEN IN FULL BROWSER
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[10px]"
                  onClick={() => openExternal(sourceUrl)}
                >
                  EXTERNAL TAB
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[10px]"
                  onClick={() => {
                    try {
                      navigator.clipboard?.writeText?.(sourceUrl);
                      useStore.getState().showToast('Address copied');
                    } catch {
                      /* Clipboard access is permission-gated and refusing it is
                       * not worth an error state over. */
                    }
                  }}
                >
                  COPY URL
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-[10px]"
                  onClick={() => setEmbedHelp(false)}
                >
                  DISMISS
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SpatialControlButton = ({
  action,
  label,
  active,
  disabled,
  danger,
  onClick,
  children
}) => (
  <button
    type="button"
    className={'spatial-control-button' + (danger ? ' danger' : '') + (disabled ? ' opacity-30 cursor-not-allowed' : '')}
    data-screen-action={action}
    data-active={active ? 'true' : 'false'}
    aria-label={label}
    title={label}
    disabled={disabled}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      if (!disabled) onClick();
    }}
  >
    {children}
  </button>
);

const RepeatControlButton = ({
  action,
  label,
  disabled,
  onStep,
  onFinish,
  children
}) => {
  const delayRef = useRef(null);
  const intervalRef = useRef(null);
  const activeRef = useRef(false);

  const stop = useCallback((event) => {
    if (event) event.stopPropagation();
    window.clearTimeout(delayRef.current);
    window.clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
    if (activeRef.current) {
      activeRef.current = false;
      onFinish();
    }
  }, [onFinish]);

  useEffect(() => () => {
    window.clearTimeout(delayRef.current);
    window.clearInterval(intervalRef.current);
  }, []);

  return (
    <button
      type="button"
      className={'spatial-control-button' + (disabled ? ' opacity-30 cursor-not-allowed' : '')}
      data-screen-action={action}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabled) return;
        activeRef.current = true;
        onStep();
        delayRef.current = window.setTimeout(() => {
          intervalRef.current = window.setInterval(onStep, 90);
        }, 360);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </button>
  );
};

const ScreenControls = ({ screen, objectRef, hovered, showResize, setShowResize }) => {
  const selectedId = useStore((state) => state.selectedScreen);
  const interactionMode = useStore((state) => state.interactionMode);
  const rotationSnap = useStore((state) => state.rotationSnap);
  const positionSnap = useStore((state) => state.positionSnap);
  const advancedGizmo = useStore((state) => state.advancedGizmo);
  const advancedTransformMode = useStore((state) => state.advancedTransformMode);
  const [moreOpen, setMoreOpen] = useState(false);
  const isSelected = selectedId === screen.id;
  const visible = isSelected || hovered;
  const editable = !screen.locked;

  useEffect(() => {
    if (!isSelected) setMoreOpen(false);
  }, [isSelected]);

  if (!visible) return null;

  /* The overlay bar and the in-scene bar drive one implementation, so a
   * control cannot behave differently depending on which surface it was
   * pressed on, and both follow the viewer rather than the desktop camera. */
  const actions = createScreenActions({ screen, objectRef, setShowResize });
  const commitObject = actions.commit;
  const rotateStep = actions.rotateStep;
  const faceCamera = actions.faceCamera;
  const nudgeDepth = actions.nudgeDepth;
  const resetPose = actions.resetPose;
  const duplicate = actions.duplicate;

  return (
    <Html
      transform
      center
      position={[0, screen.size[1] / 2 + 0.18, 0.09]}
      distanceFactor={1.1}
      style={{ pointerEvents: 'none', overflow: 'visible' }}
      zIndexRange={[200, 100]}
    >
      <div
        className="relative"
        style={{ pointerEvents: 'auto' }}
        onPointerDown={(event) => event.stopPropagation()}
        data-testid="screen-controls"
        data-screen-id={screen.id}
      >
        <div className="spatial-control-bar">
          <SpatialControlButton
            action="move"
            label="Move screen"
            active={interactionMode === 'arrange' && !showResize}
            disabled={!editable}
            onClick={() => {
              useStore.getState().setSelectedScreen(screen.id);
              useStore.getState().setInteractionMode('arrange');
              setShowResize(false);
            }}
          >
            <Icon name="move" />
          </SpatialControlButton>

          <RepeatControlButton
            action="rotate-left"
            label={'Rotate left ' + (rotationSnap || 15) + ' degrees'}
            disabled={!editable}
            onStep={() => rotateStep(1)}
            onFinish={commitObject}
          >
            <Icon name="rotate-left" />
          </RepeatControlButton>
          <RepeatControlButton
            action="rotate-right"
            label={'Rotate right ' + (rotationSnap || 15) + ' degrees'}
            disabled={!editable}
            onStep={() => rotateStep(-1)}
            onFinish={commitObject}
          >
            <Icon name="rotate-right" />
          </RepeatControlButton>

          <SpatialControlButton
            action="face-me"
            label="Face me"
            disabled={!editable}
            onClick={faceCamera}
          >
            <Icon name="face" />
          </SpatialControlButton>
          <SpatialControlButton
            action="scale"
            label="Resize screen"
            active={showResize}
            disabled={!editable}
            onClick={() => {
              useStore.getState().setSelectedScreen(screen.id);
              useStore.getState().setInteractionMode('arrange');
              setShowResize(!showResize);
            }}
          >
            <Icon name="scale" />
          </SpatialControlButton>

          <div className="spatial-divider" />

          <SpatialControlButton
            action="toggle-lock"
            label={screen.locked ? 'Unlock screen' : 'Lock screen'}
            active={screen.locked}
            onClick={() => {
              setShowResize(false);
              useStore.getState().toggleScreenLock(screen.id);
            }}
          >
            <Icon name={screen.locked ? 'lock' : 'unlock'} />
          </SpatialControlButton>
          <SpatialControlButton
            action="duplicate"
            label="Duplicate screen"
            onClick={duplicate}
          >
            <Icon name="copy" />
          </SpatialControlButton>
          <SpatialControlButton
            action="close"
            label="Close screen"
            danger
            onClick={() => useStore.getState().removeScreen(screen.id)}
          >
            <Icon name="close" />
          </SpatialControlButton>
          <SpatialControlButton
            action="more"
            label="More screen controls"
            active={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
          >
            <Icon name="more" />
          </SpatialControlButton>
        </div>

        {moreOpen && (
          <div className="spatial-more-menu">
            <button
              type="button"
              className="spatial-menu-button"
              data-screen-action="focus"
              onClick={() => {
                useStore.getState().focusCameraOnScreen(screen.id);
                setMoreOpen(false);
              }}
            >
              <span>Focus camera</span><Icon name="focus" size={13} />
            </button>
            <button
              type="button"
              className={'spatial-menu-button' + (!editable ? ' opacity-35 cursor-not-allowed' : '')}
              data-screen-action="reset"
              disabled={!editable}
              onClick={resetPose}
            >
              <span>Reset pose</span><Icon name="reset" size={13} />
            </button>
            <div className="grid grid-cols-2 gap-1 mt-1">
              <button
                type="button"
                className={'spatial-menu-button justify-center' + (!editable ? ' opacity-35' : '')}
                disabled={!editable}
                data-screen-action="depth-closer"
                onClick={() => nudgeDepth(-0.35)}
                title="Bring closer"
              >
                <Icon name="depth-in" size={13} /><span>Closer</span>
              </button>
              <button
                type="button"
                className={'spatial-menu-button justify-center' + (!editable ? ' opacity-35' : '')}
                disabled={!editable}
                data-screen-action="depth-farther"
                onClick={() => nudgeDepth(0.35)}
                title="Move farther"
              >
                <Icon name="depth-out" size={13} /><span>Farther</span>
              </button>
            </div>

            <div className="h-px bg-white/10 my-2" />
            <label className="flex items-center justify-between gap-3 px-2 py-1.5">
              <span className="text-gray-400">Angle snap</span>
              <select
                className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-white outline-none"
                data-testid="rotation-snap"
                data-angle={rotationSnap || 'off'}
                value={rotationSnap}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => useStore.getState().setRotationSnap(Number(event.target.value))}
              >
                <option value="5">5°</option>
                <option value="15">15°</option>
                <option value="30">30°</option>
                <option value="45">45°</option>
                <option value="0">Off</option>
              </select>
            </label>
            <button
              type="button"
              className="spatial-menu-button"
              onClick={() => useStore.getState().setPositionSnap(!positionSnap)}
            >
              <span>Position snapping</span>
              <span className={positionSnap ? 'text-blue-300' : 'text-gray-500'}>{positionSnap ? 'On' : 'Off'}</span>
            </button>
            <button
              type="button"
              className="spatial-menu-button"
              onClick={() => applyArcArrangement()}
              data-screen-action="snap-arc"
            >
              <span>Snap workspace to arc</span><Icon name="arc" size={13} />
            </button>

            <div className="h-px bg-white/10 my-2" />
            <button
              type="button"
              className="spatial-menu-button"
              onClick={() => {
                useStore.getState().setInteractionMode('arrange');
                useStore.getState().setAdvancedGizmo(!advancedGizmo);
              }}
            >
              <span>Developer gizmo</span>
              <span className={advancedGizmo ? 'text-blue-300' : 'text-gray-500'}>{advancedGizmo ? 'On' : 'Off'}</span>
            </button>
            {advancedGizmo && (
              <div className="grid grid-cols-3 gap-1 px-1 pt-1">
                {['translate', 'rotate', 'scale'].map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={'px-2 py-1.5 rounded-md capitalize ' + (advancedTransformMode === mode ? 'bg-blue-600 text-white' : 'bg-white/5 text-gray-400')}
                    onClick={() => useStore.getState().setAdvancedTransformMode(mode)}
                  >
                    {mode === 'translate' ? 'Move' : mode}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Html>
  );
};

const SnapGuide = () => {
  const guide = useStore((state) => state.snapGuide);
  if (!guide) return null;
  const position = guide.position;
  let guidePosition = position;
  let dimensions = [0.012, 0.012, 0.012];
  if (guide.axis === 'y') {
    guidePosition = [position[0], guide.value, position[2] - 0.08];
    dimensions = [7, 0.008, 0.008];
  } else if (guide.axis === 'x') {
    guidePosition = [guide.value, position[1], position[2] - 0.08];
    dimensions = [0.008, 5, 0.008];
  } else {
    guidePosition = [position[0], position[1], guide.value];
    dimensions = [0.9, 0.008, 0.008];
  }
  return (
    <group position={guidePosition}>
      <mesh>
        <boxGeometry args={dimensions} />
        <meshBasicMaterial color="#60a5fa" transparent opacity={0.32} depthWrite={false} />
      </mesh>
      <Html
        center
        position={[0, 0.12, 0]}
        distanceFactor={2}
        style={{ pointerEvents: 'none' }}
        pointerEvents="none"
        zIndexRange={[20, 0]}
      >
        <div
          className="px-2 py-1 rounded-md bg-blue-950/80 border border-blue-400/25 text-blue-200 text-[9px] uppercase tracking-[0.12em] whitespace-nowrap"
          data-testid="snap-guide"
          data-snap-kind={guide.kind}
        >
          {guide.kind.replace('-', ' ')}
        </div>
      </Html>
    </group>
  );
};

const SpatialScreen = ({ screen }) => {
  /* A boolean selector, so a screen re-renders only when its own membership
   * changes rather than on every plan update. */
  const asLayer = useStore((state) => state.layerScreenIds.includes(screen.id));
  const selectedId = useStore((state) => state.selectedScreen);
  const interactionMode = useStore((state) => state.interactionMode);
  const rotationModifier = useStore((state) => state.rotationModifier);
  const rotationSnap = useStore((state) => state.rotationSnap);
  const positionSnap = useStore((state) => state.positionSnap);
  const advancedGizmo = useStore((state) => state.advancedGizmo);
  const advancedTransformMode = useStore((state) => state.advancedTransformMode);
  const uiSurface = useStore((state) => state.uiSurface);
  const setSelected = useStore((state) => state.setSelectedScreen);
  const setManipulating = useStore((state) => state.setManipulatingScreen);
  const spatialChrome = uiSurface === 'spatial';

  /* Browser state for the in-scene chrome. Read unconditionally because hooks
   * cannot be conditional; it is inert for non-Chromium sources. */
  const spatialChromiumState = useChromiumMetadata(screen);
  const spatialConnectionView = chromiumConnectionView(spatialChromiumState);
  const { camera, gl } = useThree();
  const objectRef = useRef(null);
  const initializedRef = useRef(false);
  const transitionRef = useRef(null);
  const lastTransitionRef = useRef(null);
  const sessionRef = useRef(null);
  const finishRef = useRef(null);
  const guideTimerRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [showResize, setShowResize] = useState(false);
  const isSelected = selectedId === screen.id;
  const isChromium = screen.source.type === 'chromium';
  const [width, height] = screen.size;
  /*
   * Where the page goes, and where the handles go.
   *
   * Previously the page was `width - 0.01` across, leaving a 5 mm strip of
   * panel to grab — 0.14 degrees at two metres, smaller than the pointing error
   * that pressing a trigger introduces. The window was unhittable by
   * construction. Regions are now geometry with a test behind them.
   */
  const regions = useMemo(
    () => computeWindowRegions({ width, height, headerHeight: BROWSER_HEADER_WORLD_HEIGHT }),
    [width, height]
  );
  const browserSurfaceHeight = regions.content.height;

  const setBrowserSurfaceRef = useCallback((mesh) => {
    if (mesh) sceneRuntime.browserSurfaces.set(screen.id, mesh);
    else sceneRuntime.browserSurfaces.delete(screen.id);
  }, [screen.id]);

  useLayoutEffect(() => {
    const object = objectRef.current;
    if (!object) return;
    const targetPosition = new THREE.Vector3(...screen.position);
    const targetEuler = new THREE.Euler(
      screen.rotation[0],
      screen.rotation[1],
      screen.rotation[2],
      screen.rotation[3] || ROTATION_ORDER
    );
    const targetQuaternion = new THREE.Quaternion().setFromEuler(targetEuler);
    const targetScale = new THREE.Vector3(...screen.scale);

    if (!initializedRef.current) {
      object.position.copy(targetPosition);
      object.quaternion.copy(targetQuaternion);
      object.scale.copy(targetScale);
      object.rotation.order = targetEuler.order;
      initializedRef.current = true;
      lastTransitionRef.current = screen._transition || null;
      return;
    }

    if (screen._transition && lastTransitionRef.current !== screen._transition) {
      lastTransitionRef.current = screen._transition;
      transitionRef.current = {
        position: targetPosition,
        quaternion: targetQuaternion,
        scale: targetScale,
        rotationOrder: targetEuler.order
      };
      sessionRef.current = null;
      return;
    }

    if (!sessionRef.current && !transitionRef.current) {
      object.position.copy(targetPosition);
      object.quaternion.copy(targetQuaternion);
      object.scale.copy(targetScale);
      object.rotation.order = targetEuler.order;
    }
  }, [
    screen.position[0],
    screen.position[1],
    screen.position[2],
    screen.rotation[0],
    screen.rotation[1],
    screen.rotation[2],
    screen.rotation[3],
    screen.scale[0],
    screen.scale[1],
    screen.scale[2],
    screen._transition
  ]);

  useEffect(() => {
    const object = objectRef.current;
    if (!object) return undefined;
    sceneRuntime.screenObjects.set(screen.id, object);
    return () => {
      if (sceneRuntime.screenObjects.get(screen.id) === object) {
        sceneRuntime.screenObjects.delete(screen.id);
      }
      sceneRuntime.browserSurfaces.delete(screen.id);
      if (sessionRef.current) {
        sessionRef.current = null;
        useStore.getState().setManipulatingScreen(false);
        setCameraLock('manipulate:' + screen.id, false);
      }
    };
  }, [screen.id]);

  useFrame((_, delta) => {
    const object = objectRef.current;
    const transition = transitionRef.current;
    if (!object || !transition || sessionRef.current) return;
    const alpha = 1 - Math.exp(-delta * 8.5);
    object.position.lerp(transition.position, alpha);
    object.quaternion.slerp(transition.quaternion, alpha);
    object.scale.lerp(transition.scale, alpha);
    if (
      object.position.distanceToSquared(transition.position) < 0.00002 &&
      1 - Math.abs(object.quaternion.dot(transition.quaternion)) < 0.00002 &&
      object.scale.distanceToSquared(transition.scale) < 0.00002
    ) {
      object.position.copy(transition.position);
      object.quaternion.copy(transition.quaternion);
      object.scale.copy(transition.scale);
      object.rotation.order = transition.rotationOrder;
      transitionRef.current = null;
    }
  });

  const finishManipulation = useCallback((event) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (event) event.stopPropagation();
    try {
      if (session.captureTarget && session.captureTarget.hasPointerCapture && session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
    } catch {
      // Pointer capture can already be gone after a browser-level cancel.
    }
    const object = objectRef.current;
    if (object) {
      const transform = objectTransform(object);
      useStore.getState().commitScreenTransform(
        screen.id,
        transform.position,
        transform.rotation,
        transform.scale
      );
    }
    setManipulating(false);
    setCameraLock('manipulate:' + screen.id, false);
    window.clearTimeout(guideTimerRef.current);
    guideTimerRef.current = window.setTimeout(() => {
      if (!useStore.getState().isManipulatingScreen) useStore.getState().setSnapGuide(null);
    }, 650);
  }, [screen.id, setManipulating]);
  finishRef.current = finishManipulation;

  useEffect(() => {
    const finishOnBlur = () => finishRef.current && finishRef.current();
    const finishOnEscape = (event) => {
      if (event.key === 'Escape') finishOnBlur();
    };
    window.addEventListener('blur', finishOnBlur);
    window.addEventListener('keydown', finishOnEscape);
    return () => {
      window.removeEventListener('blur', finishOnBlur);
      window.removeEventListener('keydown', finishOnEscape);
      window.clearTimeout(guideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (screen.locked) setShowResize(false);
  }, [screen.locked]);

  const beginManipulation = (event, requestedKind, fromRegion = null) => {
    event.stopPropagation();
    setSelected(screen.id);

    /* Read the mode and modifiers from the store at event time rather than from
     * this render's closure. A pointerdown can arrive before React has
     * committed the render that followed the state change, and the stale values
     * silently produced the wrong gesture: holding R and dragging immediately
     * started a move instead of a rotation, and switching to Arrange and
     * dragging at once did nothing at all. */
    const liveState = useStore.getState();
    const liveScreen = liveState.screens.find((candidate) => candidate.id === screen.id) || screen;

    /* Recover from a session that was never finished.
     *
     * A pointer-up can be lost: the pointer leaves the window, capture is
     * revoked, or the release is delivered to another object. A pointer cannot
     * legitimately press twice without releasing, so a surviving session at
     * this point is always stale — including one recorded against this same
     * pointer id. Treating it as a reason to ignore the gesture left the
     * screen permanently unmanipulable with no recovery short of a reload.
     * Close it and continue. */
    if (sessionRef.current) finishRef.current?.();

    /*
     * A handle is a handle in every mode.
     *
     * Requiring Arrange to move a window is what made the whole system feel
     * broken: the mode is invisible, nothing about a panel suggests you are in
     * the wrong one, and entering XR forces Browse — so in a headset the
     * pointer could never move anything and only a controller grip worked.
     * Dragging the BODY of a panel still requires Arrange, because the body is
     * the page and dragging it in Browse would steal clicks. That is the whole
     * mode now: an accelerator that makes the page draggable too.
     */
    const rejection =
      event.button !== 0 ? 'non-primary-button'
      : (!fromRegion && liveState.interactionMode !== 'arrange') ? 'not-arrange-mode'
      : liveScreen.locked ? 'screen-locked'
      : sessionRef.current ? 'session-could-not-be-cleared'
      : null;
    if (rejection) {
      recordManipulationAttempt({
        screenId: screen.id,
        outcome: 'rejected',
        reason: rejection,
        button: event.button,
        pointerId: event.pointerId,
        mode: liveState.interactionMode
      });
      return;
    }

    transitionRef.current = null;
    const nativeEvent = event.nativeEvent || event;
    const kind = requestedKind || (liveState.rotationModifier ? 'rotate' : 'move');
    let session = null;
    if (kind === 'rotate') {
      session = ScreenInteraction.beginRotate({ object: objectRef.current, ray: event.ray });
    } else if (kind === 'scale') {
      session = ScreenInteraction.beginScale({ object: objectRef.current, ray: event.ray });
    } else {
      session = ScreenInteraction.beginGrab({
        object: objectRef.current,
        ray: event.ray,
        depthMode: Boolean(nativeEvent.shiftKey)
      });
    }
    /* Depth is a scalar push/pull axis rather than a pixel delta, so the
     * pointer's own motion has to be converted into one. A mouse offers
     * vertical travel; a controller will offer a thumbstick. */
    if (session && session.depthMode) {
      session.lastPointerY = Number(nativeEvent.clientY) || 0;
      session.pushPullScale = PUSH_PULL_PER_PIXEL;
    }
    if (!session) {
      recordManipulationAttempt({
        screenId: screen.id,
        outcome: 'rejected',
        reason: 'no-session-from-' + kind,
        hasObject: Boolean(objectRef.current),
        hasRay: Boolean(event.ray),
        pointerId: event.pointerId
      });
      return;
    }
    recordManipulationAttempt({
      screenId: screen.id,
      outcome: 'started',
      kind,
      region: fromRegion,
      pointerId: event.pointerId
    });
    session.pointerId = event.pointerId;
    session.captureTarget = event.target;
    sessionRef.current = session;
    useStore.getState().setSnapGuide(null);
    setCameraLock('manipulate:' + screen.id, true);
    setManipulating(true, session.depthMode ? 'depth' : kind);
    try {
      event.target.setPointerCapture(event.pointerId);
    } catch {
      // R3F still delivers moves while the pointer remains over the canvas.
    }
  };

  const updateManipulation = (event) => {
    const session = sessionRef.current;
    const object = objectRef.current;
    if (!session || !object) return;
    event.stopPropagation();
    const nativeEvent = event.nativeEvent || event;

    if (session.kind === 'move') {
      let pushPull = 0;
      if (session.depthMode) {
        const pointerY = Number(nativeEvent.clientY) || 0;
        pushPull = (pointerY - session.lastPointerY) * session.pushPullScale;
        session.lastPointerY = pointerY;
      }
      const rawPosition = ScreenInteraction.updateGrab(session, { ray: event.ray, pushPull });
      if (!rawPosition) return;
      if (session.depthMode) {
        object.position.copy(worldToLocal(object, rawPosition));
        useStore.getState().setSnapGuide(null);
      } else {
        const snapped = snapScreenPosition(screen.id, rawPosition);
        object.position.copy(worldToLocal(object, snapped.position));
        useStore.getState().setSnapGuide(snapped.guide);
      }
    } else if (session.kind === 'rotate') {
      object.rotation.y = ScreenInteraction.updateRotate(session, {
        ray: event.ray,
        snapDegrees: rotationSnap
      });
      useStore.getState().setSnapGuide(null);
    } else if (session.kind === 'scale') {
      const nextScale = ScreenInteraction.updateScale(session, { ray: event.ray });
      if (nextScale) object.scale.copy(nextScale);
      useStore.getState().setSnapGuide(null);
    }
  };

  const handleWheel = (event) => {
    const liveState = useStore.getState();
    const liveScreen = liveState.screens.find((candidate) => candidate.id === screen.id) || screen;
    if (liveState.interactionMode !== 'arrange' || liveScreen.locked) return;
    event.stopPropagation();
    const object = objectRef.current;
    if (!object) return;
    setSelected(screen.id);
    /* The wheel is simply one source of the push/pull axis; a thumbstick will
     * supply the same scalar with no other change to this path. */
    const viewer = viewpointPosition(new THREE.Vector3());
    const world = object.getWorldPosition(new THREE.Vector3());
    const direction = world.clone().sub(viewer);
    direction.y = 0;
    if (direction.lengthSq() < 0.0001) viewpointForwardHorizontal(direction);
    direction.normalize();
    const amount = clamp(event.deltaY, -120, 120) * 0.003;
    const candidate = world.clone().addScaledVector(direction, amount);
    clampWorldDistance(candidate, viewer, MIN_GRAB_DISTANCE, MAX_GRAB_DISTANCE);
    object.position.copy(worldToLocal(object, candidate));
    const transform = objectTransform(object);
    useStore.getState().commitScreenTransform(
      screen.id,
      transform.position,
      transform.rotation,
      transform.scale
    );
  };

  const commitAdvancedTransform = () => {
    const object = objectRef.current;
    if (!object) return;
    const transform = objectTransform(object);
    useStore.getState().commitScreenTransform(
      screen.id,
      transform.position,
      transform.rotation,
      transform.scale
    );
    setManipulating(false);
    setCameraLock('manipulate:' + screen.id, false);
  };

  const resizeCorners = [
    [-width / 2, -height / 2],
    [-width / 2, height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2]
  ];

  return (
    <>
      <group
        ref={objectRef}
        name={'spatial-screen-' + screen.id}
        onPointerDown={(event) => beginManipulation(event)}
        onPointerMove={updateManipulation}
        onPointerUp={finishManipulation}
        onPointerCancel={finishManipulation}
        onLostPointerCapture={finishManipulation}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (isChromium && (interactionMode === 'browse' || screen.locked)) return;
          useStore.getState().focusCameraOnScreen(screen.id);
        }}
        onWheel={handleWheel}
        onClick={(event) => {
          event.stopPropagation();
          setSelected(screen.id);
        }}
      >
        <RoundedBox args={[width, height, 0.055]} radius={0.025} smoothness={4}>
          <meshStandardMaterial
            color={isSelected ? '#171c24' : hovered ? '#151a21' : '#111419'}
            roughness={0.28}
            metalness={0.72}
          />
          <Edges
            threshold={20}
            scale={1.005}
            color={isSelected ? '#6da8ed' : hovered ? '#46586e' : '#272d36'}
          />
        </RoundedBox>

        {isChromium && (
          <ChromiumTextureSource
            /* Remounting is how a Full Browser screen is rebuilt from scratch.
             * The nonce is part of the key so that Retry tears the Chromium
             * source down and creates a fresh one, rather than trying to
             * revive a crashed webContents in place. */
            key={browserSourceKey(screen)}
            sourceId={screen.source.sourceId}
            initialUrl={screen.source.url || screen.url || 'https://example.com'}
            viewportWidth={screen.source.browserWidth || 1280}
            viewportHeight={screen.source.browserHeight || 800}
            deviceScaleFactor={resolveDeviceScaleFactor({
              logicalWidth: screen.source.browserWidth || 1280,
              logicalHeight: screen.source.browserHeight || 800
            })}
            frameRate={30}
            worldWidth={regions.content.width}
            worldHeight={regions.content.height}
            position={[regions.content.x, regions.content.y, 0.035]}
            interactionMode={interactionMode}
            locked={screen.locked}
            focused={isSelected && (interactionMode === 'browse' || screen.locked)}
            asLayer={asLayer}
            meshRef={setBrowserSurfaceRef}
            onSelect={() => setSelected(screen.id)}
            onHoverChange={setHovered}
            onInputCaptureChange={(suppressed) => {
              setCameraLock('browser-surface:' + screen.id, suppressed);
            }}
            onMetadata={(metadata) => useStore.getState().syncBrowserSource(screen.id, metadata)}
            onError={(error) => {
              const message = error && error.message ? error.message : 'Chromium source unavailable';
              if (resolveBrowserProvider().available) useStore.getState().showToast(message);
            }}
          />
        )}

        {!spatialChrome && <Html
          transform
          occlude={isChromium ? false : 'blending'}
          position={[0, 0, 0.031]}
          style={{
            width: width * 400 + 'px',
            height: height * 400 + 'px',
            pointerEvents: isChromium ? 'none' : interactionMode === 'arrange' && !screen.locked ? 'none' : 'auto'
          }}
          pointerEvents={isChromium ? 'none' : interactionMode === 'arrange' && !screen.locked ? 'none' : 'auto'}
          distanceFactor={1.1}
          zIndexRange={[50, 0]}
        >
          <ScreenBrowser screen={screen} selected={isSelected} />
        </Html>}

        {/*
          * The handles.
          *
          * Invisible, deliberately oversized, and strictly outside the page —
          * a collider that reached over the content would move the window when
          * someone clicked a link, which is the fault this replaces. They sit
          * in front of the content surface so nothing can steal from them, and
          * they extend past the panel edge into empty space, so the target is
          * about twice what the design shows.
          *
          * They are live in BOTH modes. Manipulation used to require Arrange,
          * and entering XR forces Browse, so in a headset there was no pointer
          * path to move a window at all.
          */}
        {regions.grabs.map((region) => (
          <mesh
            key={region.id}
            name={`grab-${region.id}`}
            position={[region.x, region.y, COLLIDER_Z]}
            /* Present even when locked. An invisible mesh is not raycast, so
               hiding these would make a locked window silently unresponsive
               instead of visibly refusing — and "nothing happened" is the
               failure mode this whole change is about. beginManipulation
               rejects with a reason the diagnostics can show. */
            userData={{ role: 'grab-region', region: region.id, screenId: screen.id }}
            onPointerDown={(event) => beginManipulation(event, REGION_GESTURE[region.id], region.id)}
            onPointerMove={updateManipulation}
            onPointerUp={finishManipulation}
          >
            <planeGeometry args={[region.width, region.height]} />
            {/* Transparent rather than `visible={false}`: an invisible mesh is
                not raycast by three, so it would be no target at all. */}
            <meshBasicMaterial
              transparent
              opacity={hovered && !screen.locked ? 0.06 : 0}
              color="#8ab8f2"
              depthWrite={false}
            />
          </mesh>
        ))}

        {screen.locked && (
          <Html
            transform
            center
            position={[width / 2 - 0.09, -height / 2 + 0.09, 0.08]}
            distanceFactor={1.2}
            style={{ pointerEvents: 'none' }}
            pointerEvents="none"
            zIndexRange={[70, 60]}
          >
            <div
              className="w-6 h-6 rounded-full bg-black/70 border border-white/10 text-gray-300 flex items-center justify-center shadow-lg"
              data-testid="lock-indicator"
              title="Locked"
            >
              <Icon name="lock" size={11} />
            </div>
          </Html>
        )}

        {isSelected && interactionMode === 'arrange' && !screen.locked && (
          <>
            <mesh
              name="rotation-handle"
              position={[0, height / 2 + 0.08, 0.075]}
              onPointerDown={(event) => beginManipulation(event, 'rotate')}
              userData={{ role: 'rotation-handle', screenId: screen.id }}
            >
              <circleGeometry args={[0.055, 24]} />
              <meshBasicMaterial color="#8ab8f2" transparent opacity={0.88} depthTest={false} />
            </mesh>
            <mesh position={[0, height / 2 + 0.025, 0.068]}>
              <boxGeometry args={[0.012, 0.095, 0.01]} />
              <meshBasicMaterial color="#6b95c9" transparent opacity={0.55} depthTest={false} />
            </mesh>
          </>
        )}

        {isSelected && interactionMode === 'arrange' && showResize && !screen.locked && resizeCorners.map((corner, index) => (
          <mesh
            key={index}
            name="resize-handle"
            position={[corner[0], corner[1], 0.08]}
            onPointerDown={(event) => beginManipulation(event, 'scale')}
            userData={{ role: 'resize-handle', screenId: screen.id }}
          >
            <boxGeometry args={[0.085, 0.085, 0.035]} />
            <meshBasicMaterial color="#82b2ed" transparent opacity={0.92} depthTest={false} />
          </mesh>
        ))}

        {spatialChrome ? (
          <SpatialScreenChrome
            screen={screen}
            objectRef={objectRef}
            hovered={hovered}
            isSelected={isSelected}
            showResize={showResize}
            setShowResize={setShowResize}
            width={width}
            height={height}
            isChromium={isChromium}
            chromiumState={spatialChromiumState}
            connectionView={spatialConnectionView}
          />
        ) : (
          <ScreenControls
            screen={screen}
            objectRef={objectRef}
            hovered={hovered}
            showResize={showResize}
            setShowResize={setShowResize}
          />
        )}
      </group>

      {isSelected && interactionMode === 'arrange' && advancedGizmo && !screen.locked && (
        <TransformControls
          object={objectRef}
          mode={advancedTransformMode}
          size={0.62}
          translationSnap={positionSnap ? 0.25 : null}
          rotationSnap={rotationSnap ? rotationSnap * DEG : null}
          onMouseDown={() => {
            setCameraLock('manipulate:' + screen.id, true);
            setManipulating(true, 'advanced');
          }}
          onMouseUp={commitAdvancedTransform}
        />
      )}
    </>
  );
};

const ConnectionLine = ({ connection }) => {
  const screens = useStore((state) => state.screens);
  const agents = useStore((state) => state.agents);

  /* Either end may be an agent. Both carry a `position`, so everything below
   * is identical once the node is found — without this the line would resolve
   * an agent id against the screen list, find nothing, and silently hide. */
  const nodeFor = (id, kind) => (kind === 'agent'
    ? agents.find((agent) => agent.id === id)
    : screens.find((screen) => screen.id === id));

  const source = nodeFor(connection.sourceId, connection.sourceKind);
  const target = nodeFor(connection.targetId, connection.targetKind);
  const groupRef = useRef(null);
  const lineRef = useRef(null);
  const particleRef = useRef(null);
  const agentRef = useRef(null);
  const positions = useMemo(() => new Float32Array(25 * 3), []);
  const curveRef = useRef(new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3()
  ));
  const startRef = useRef(new THREE.Vector3());
  const endRef = useRef(new THREE.Vector3());
  const midRef = useRef(new THREE.Vector3());
  const pointRef = useRef(new THREE.Vector3());

  useFrame((state) => {
    const group = groupRef.current;
    if (!group) return;
    const sourceObject = sceneRuntime.screenObjects.get(connection.sourceId);
    const targetObject = sceneRuntime.screenObjects.get(connection.targetId);
    if (!sourceObject && !source || !targetObject && !target) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const start = startRef.current;
    const end = endRef.current;
    if (sourceObject) start.copy(sourceObject.position);
    else start.fromArray(source.position);
    if (targetObject) end.copy(targetObject.position);
    else end.fromArray(target.position);
    const mid = midRef.current.copy(start).add(end).multiplyScalar(0.5);
    mid.y += 0.45;
    mid.z -= 0.32;

    const curve = curveRef.current;
    curve.v0.copy(start);
    curve.v1.copy(mid);
    curve.v2.copy(end);
    for (let index = 0; index < 25; index += 1) {
      curve.getPoint(index / 24, pointRef.current);
      const offset = index * 3;
      positions[offset] = pointRef.current.x;
      positions[offset + 1] = pointRef.current.y;
      positions[offset + 2] = pointRef.current.z;
    }
    if (lineRef.current) {
      lineRef.current.geometry.attributes.position.needsUpdate = true;
    }
    if (particleRef.current) {
      curve.getPoint((state.clock.elapsedTime * 0.25) % 1, particleRef.current.position);
    }
    if (agentRef.current) agentRef.current.position.copy(mid);
  });

  return (
    <group ref={groupRef}>
      <line ref={lineRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#3b82f6" transparent opacity={0.38} depthWrite={false} />
      </line>
      <mesh ref={particleRef}>
        <sphereGeometry args={[0.035, 10, 10]} />
        <meshBasicMaterial color="#75b4ff" />
      </mesh>

      {connection.agent && (
        <group ref={agentRef}>
          <mesh>
            <octahedronGeometry args={[0.075, 0]} />
            <meshStandardMaterial color="#8b5cf6" emissive="#321469" roughness={0.2} metalness={0.75} />
          </mesh>
          <Html
            position={[0, 0.14, 0]}
            center
            distanceFactor={2}
            style={{ pointerEvents: 'none' }}
            pointerEvents="none"
            zIndexRange={[20, 0]}
          >
            <div className="bg-[#20173a]/90 backdrop-blur-md px-2.5 py-1 rounded-md border border-purple-400/30 text-white text-[9px] font-medium whitespace-nowrap shadow-xl flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse" />
              {connection.agent}
            </div>
          </Html>
        </group>
      )}
    </group>
  );
};

const CameraSystem = () => {
  const { camera, gl } = useThree();
  const command = useStore((state) => state.cameraCommand);
  const controlsRef = useRef(null);
  const animationRef = useRef(null);
  const savedViewRef = useRef(null);

  const attachControls = useCallback((controls) => {
    controlsRef.current = controls;
    sceneRuntime.orbitControls = controls;
  }, []);

  useEffect(() => {
    sceneRuntime.camera = camera;
    sceneRuntime.renderer = gl;
    return () => {
      if (sceneRuntime.camera === camera) sceneRuntime.camera = null;
      if (sceneRuntime.renderer === gl) sceneRuntime.renderer = null;
      sceneRuntime.orbitControls = null;
      releaseAllCameraLocks();
    };
  }, [camera, gl]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!command || !controls) return;

    if (command.type === 'focus') {
      const object = sceneRuntime.screenObjects.get(command.screenId);
      const screen = useStore.getState().screens.find((candidate) => candidate.id === command.screenId);
      if (!object || !screen) return;
      if (!savedViewRef.current) {
        savedViewRef.current = {
          position: camera.position.clone(),
          target: controls.target.clone()
        };
      }
      const front = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion).normalize();
      const toCurrentCamera = camera.position.clone().sub(object.position);
      if (front.dot(toCurrentCamera) < 0) front.negate();
      const verticalFov = viewpointFov();
      const scaledWidth = screen.size[0] * object.scale.x;
      const scaledHeight = screen.size[1] * object.scale.y;
      const fitHeight = scaledHeight / (2 * Math.tan(verticalFov / 2));
      const fitWidth = scaledWidth / (2 * Math.tan(verticalFov / 2) * viewpointAspect());
      const distance = Math.max(fitHeight, fitWidth) * 1.42 + 0.25;
      animationRef.current = {
        position: object.position.clone().addScaledVector(front, distance),
        target: object.position.clone(),
        clearSaved: false
      };
    } else if (command.type === 'return') {
      const saved = savedViewRef.current;
      if (!saved) return;
      animationRef.current = {
        position: saved.position.clone(),
        target: saved.target.clone(),
        clearSaved: true
      };
    }
  }, [command, camera]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    /* Reassert ownership every frame. Interaction state — not render order —
     * decides whether the camera may move. */
    applyCameraControlState(controls, { presenting: isPresenting() });

    const animation = animationRef.current;
    if (!animation) return;
    const alpha = 1 - Math.exp(-delta * 6.5);
    camera.position.lerp(animation.position, alpha);
    controls.target.lerp(animation.target, alpha);
    controls.update();
    if (
      camera.position.distanceToSquared(animation.position) < 0.00003 &&
      controls.target.distanceToSquared(animation.target) < 0.00003
    ) {
      camera.position.copy(animation.position);
      controls.target.copy(animation.target);
      controls.update();
      if (animation.clearSaved) savedViewRef.current = null;
      animationRef.current = null;
    }
  });

  return (
    <OrbitControls
      ref={attachControls}
      makeDefault
      minPolarAngle={Math.PI / 6}
      maxPolarAngle={Math.PI / 1.5}
      minDistance={0.75}
      maxDistance={16}
      enableDamping
      dampingFactor={0.055}
      enablePan
      target={[0, 1.35, -1.5]}
    />
  );
};

/*
 * Applies the adaptive quality policy once every few frames.
 *
 * Evaluating on every frame would cost more than it saves, and a screen's
 * visibility does not change meaningfully at 60Hz. Four times a second is
 * responsive enough that turning toward a paused screen brings it back before
 * the eye settles on it.
 */
const BrowserQualityDirector = () => {
  const screens = useStore((state) => state.screens);
  const selectedScreen = useStore((state) => state.selectedScreen);
  const controllerRef = useRef(null);
  const elapsedRef = useRef(0);

  if (!controllerRef.current) {
    controllerRef.current = new BrowserQualityController({
      provider: resolveBrowserProvider(),
      onError: () => {
        // A quality request is a hint. A provider that cannot honour it, or a
        // source that vanished between evaluation and application, must never
        // surface as a user-facing error.
      }
    });
  }

  useEffect(() => () => controllerRef.current?.reset(), []);

  useFrame((_, delta) => {
    elapsedRef.current += delta;
    if (elapsedRef.current < 0.25) return;
    elapsedRef.current = 0;

    const controller = controllerRef.current;
    controller.setProvider(resolveBrowserProvider());
    controller.apply(evaluateQuality({
      screens,
      screenObjects: sceneRuntime.screenObjects,
      focusedScreenId: selectedScreen
    }));
  });

  return null;
};

const isTypingTarget = (target) => {
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
};

const useKeyboardShortcuts = () => {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'a' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        useStore.getState().toggleInteractionMode();
        return;
      }
      if (key === 'l' && (event.metaKey || event.ctrlKey)) {
        const selectedId = useStore.getState().selectedScreen;
        if (selectedId) {
          event.preventDefault();
          useStore.getState().requestUrlFocus(selectedId);
        }
        return;
      }
      if (
        key === 'r' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        useStore.getState().interactionMode === 'arrange'
      ) {
        useStore.getState().setRotationModifier(true);
      }
    };
    const handleKeyUp = (event) => {
      if (event.key.toLowerCase() === 'r') useStore.getState().setRotationModifier(false);
    };
    const handleBlur = () => useStore.getState().setRotationModifier(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);
};

const ArcSettings = ({ onClose }) => {
  const settings = useStore((state) => state.arcSettings);
  const setSettings = useStore((state) => state.setArcSettings);
  const rows = [
    { key: 'radius', label: 'Radius', min: 2.5, max: 10, step: 0.1, suffix: 'm' },
    { key: 'spacing', label: 'Spacing', min: 0.8, max: 4, step: 0.1, suffix: 'm' },
    { key: 'height', label: 'Height', min: -1, max: 5, step: 0.05, suffix: 'm' },
    { key: 'arcAngle', label: 'Arc angle', min: 20, max: 170, step: 5, suffix: '°' }
  ];
  return (
    <div className="absolute bottom-[54px] right-0 w-72 glass-panel rounded-2xl p-4 shadow-2xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs font-semibold text-white">Magnetic Arc</div>
          <div className="text-[9px] text-gray-500 mt-0.5">Unlocked screens face the current view</div>
        </div>
        <button
          type="button"
          className="w-7 h-7 rounded-lg hover:bg-white/10 text-gray-400 flex items-center justify-center"
          onClick={onClose}
          aria-label="Close arc settings"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="space-y-3">
        {rows.map((row) => (
          <label key={row.key} className="block">
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-gray-400">{row.label}</span>
              <span className="text-gray-200 font-mono">{Number(settings[row.key]).toFixed(row.step < 0.1 ? 2 : 1)}{row.suffix}</span>
            </div>
            <input
              type="range"
              className="w-full h-1"
              min={row.min}
              max={row.max}
              step={row.step}
              value={settings[row.key]}
              onChange={(event) => setSettings({ [row.key]: Number(event.target.value) })}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="w-full mt-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold tracking-[0.08em]"
        onClick={() => {
          applyArcArrangement();
          onClose();
        }}
      >
        APPLY ARC
      </button>
    </div>
  );
};

/* First-start help. Shown until the person closes it; remembered on this
 * computer only. Plain words: the people who buy this are not developers. */
const WELCOME_DISMISSED_KEY = 'scc:welcome-dismissed';
const readWelcomeDismissed = () => {
  try { return localStorage.getItem(WELCOME_DISMISSED_KEY) === '1'; } catch { return false; }
};
const WelcomeCard = () => {
  const [open, setOpen] = useState(() => !readWelcomeDismissed());
  if (!open) return null;
  const close = () => {
    try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); } catch { /* still closes */ }
    setOpen(false);
  };
  return (
    <div
      className="absolute left-5 bottom-24 pointer-events-auto glass-panel rounded-2xl px-5 py-4 text-xs text-gray-200 w-[340px] max-w-[calc(100vw-40px)] space-y-2"
      data-testid="welcome-card"
      role="dialog"
      aria-label="Welcome"
    >
      <div className="text-sm font-semibold text-white">Welcome to Spatial Command Center</div>
      <div>Every screen here is a real web page you can click, type and scroll in, placed in 3D around you. The two screens are just examples.</div>
      <div><span className="text-blue-300 font-semibold">Add a screen:</span> press <b>+ SCREEN</b> at the bottom, then type a website address in the bar above the new screen and press Return.</div>
      <div><span className="text-blue-300 font-semibold">Move screens:</span> press <b>ARRANGE</b> at the top (or the A key), then drag a screen. Hold Shift to push it nearer or farther.</div>
      <div><span className="text-blue-300 font-semibold">Look around:</span> drag on the empty background.</div>
      <div><span className="text-blue-300 font-semibold">Keep your layout:</span> it saves by itself; the disk button saves right now. The names at the bottom are ready-made layouts.</div>
      <div className="pt-1 flex justify-end">
        <button
          type="button"
          data-testid="welcome-close"
          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold"
          onClick={close}
        >
          Got it
        </button>
      </div>
    </div>
  );
};

const Overlay = () => {
  const screens = useStore((state) => state.screens);
  const selectedId = useStore((state) => state.selectedScreen);
  const interactionMode = useStore((state) => state.interactionMode);
  const isManipulating = useStore((state) => state.isManipulatingScreen);
  const manipulationKind = useStore((state) => state.manipulationKind);
  const currentPreset = useStore((state) => state.currentPreset);
  const positionSnap = useStore((state) => state.positionSnap);
  const cameraFocused = useStore((state) => state.cameraFocused);
  const uiSurface = useStore((state) => state.uiSurface);
  const toast = useStore((state) => state.toast);
  const [arcSettingsOpen, setArcSettingsOpen] = useState(false);
  const selectedScreen = screens.find((screen) => screen.id === selectedId);
  const presetNames = ['Welcome', 'Developer', 'CommandArc', 'Focus', 'WideArc', 'TripleMonitor', 'Stack', 'Surround'];
  const browserBridgeReady = resolveBrowserProvider().available;

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => useStore.getState().clearToast(toast.id), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div className="absolute inset-0 pointer-events-none z-10 p-5" style={{ zIndex: 1000 }}>
      <div className="absolute top-5 left-5 pointer-events-auto">
        <div className="glass-panel rounded-2xl px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-blue-500/15 flex items-center justify-center border border-blue-400/35 text-blue-300 text-base shadow-[0_0_14px_rgba(59,130,246,0.16)]">
            ⌘
          </div>
          <div>
            <h1 className="font-semibold text-sm tracking-wide text-white">Spatial Command Center</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <div className={'w-1.5 h-1.5 rounded-full ' + (browserBridgeReady ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400')} />
              <span className="text-[9px] text-gray-400 font-mono tracking-wider">
                LOCAL CHROMIUM {browserBridgeReady ? 'READY' : 'OFFLINE'} · {screens.length} {screens.length === 1 ? 'SCREEN' : 'SCREENS'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute top-5 left-1/2 -translate-x-1/2 pointer-events-auto text-center">
        <div className="mode-switch" role="group" aria-label="Interaction mode">
          <button
            type="button"
            className="mode-option"
            data-active={interactionMode === 'browse' ? 'true' : 'false'}
            onClick={() => useStore.getState().setInteractionMode('browse')}
          >
            BROWSE
          </button>
          <button
            type="button"
            className="mode-option"
            data-testid="mode-toggle"
            data-active={interactionMode === 'arrange' ? 'true' : 'false'}
            aria-pressed={interactionMode === 'arrange'}
            onClick={() => useStore.getState().setInteractionMode('arrange')}
          >
            ARRANGE <span className="ml-1 opacity-60 font-mono">A</span>
          </button>
        </div>
        <div className="mt-2 flex justify-center">
          <div className="chrome-switch" role="group" aria-label="Screen chrome surface">
            <button
              type="button"
              className="chrome-option"
              data-testid="ui-surface-dom"
              data-active={uiSurface === 'dom' ? 'true' : 'false'}
              title="Overlay chrome: crisp HTML controls, desktop only"
              onClick={() => useStore.getState().setUiSurface('dom')}
            >
              OVERLAY
            </button>
            <button
              type="button"
              className="chrome-option"
              data-testid="ui-surface-spatial"
              data-active={uiSurface === 'spatial' ? 'true' : 'false'}
              title="Spatial chrome: in-scene controls that also work in a headset"
              onClick={() => useStore.getState().setUiSurface('spatial')}
            >
              SPATIAL
            </button>
          </div>
        </div>
        {interactionMode === 'arrange' && (
          <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-950/70 border border-blue-400/20 text-[9px] tracking-[0.11em] text-blue-200 backdrop-blur-md">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            DRAG UNLOCKED SCREENS · LOCKED SCREENS STAY BROWSABLE
          </div>
        )}
      </div>

      <div className="absolute top-5 right-5 pointer-events-auto">
        <div className="glass-panel px-4 py-3 rounded-2xl text-[10px] text-gray-400 font-mono min-w-[220px]">
          <div className="flex items-center justify-between text-white font-sans font-semibold text-xs mb-2">
            <span>{interactionMode === 'browse' ? 'Browse Mode' : 'Arrange Mode'}</span>
            <span className={'w-2 h-2 rounded-full ' + (interactionMode === 'browse' ? 'bg-emerald-400' : 'bg-blue-400')} />
          </div>
          {interactionMode === 'browse' ? (
            <div>Websites receive clicks, typing, and scroll</div>
          ) : (
            <div className="space-y-1">
              <div><span className="text-blue-300">Drag</span> move · <span className="text-blue-300">Shift + drag</span> depth</div>
              <div><span className="text-blue-300">R + drag</span> rotate · <span className="text-blue-300">Wheel</span> depth</div>
              <div className="pt-1 text-gray-500">Snapping {positionSnap ? 'on' : 'off'}</div>
            </div>
          )}
          {isManipulating && (
            <div className="mt-2 pt-2 border-t border-white/10 text-blue-300 uppercase tracking-wider">
              {manipulationKind} active
            </div>
          )}
        </div>
      </div>

      {selectedScreen && (
        <div className="absolute top-32 right-5 pointer-events-auto glass-panel rounded-2xl px-4 py-3 text-xs text-gray-300 w-60">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[9px] uppercase tracking-[0.18em] text-gray-500">Selected Screen</div>
            {selectedScreen.locked && (
              <span className="inline-flex items-center gap-1 text-[9px] text-gray-400">
                <Icon name="lock" size={10} /> LOCKED
              </span>
            )}
          </div>
          <div className="mt-1.5 text-sm font-semibold text-white truncate">{selectedScreen.title}</div>
          <div className="mt-1 text-[9px] text-gray-500 truncate">{selectedScreen.url || 'New tab'}</div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button
              type="button"
              data-testid="focus-selected"
              className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-[10px] text-gray-200 flex items-center justify-center gap-1.5"
              onClick={() => useStore.getState().focusCameraOnScreen(selectedScreen.id)}
            >
              <Icon name="focus" size={12} /> Focus
            </button>
            {cameraFocused ? (
              <button
                type="button"
                data-testid="return-workspace"
                className="px-2 py-2 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 text-[10px] text-blue-200"
                onClick={() => useStore.getState().returnCameraToWorkspace()}
              >
                Return view
              </button>
            ) : (
              <button
                type="button"
                className="px-2 py-2 rounded-lg bg-white/5 text-[10px] text-gray-500"
                disabled
              >
                Wheel = depth
              </button>
            )}
          </div>
        </div>
      )}

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 pointer-events-auto max-w-[calc(100vw-32px)]">
        <div className="relative glass-panel rounded-2xl p-1.5 flex gap-1 items-center overflow-visible">
          {arcSettingsOpen && <ArcSettings onClose={() => setArcSettingsOpen(false)} />}
          <button
            type="button"
            data-testid="add-screen"
            className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold tracking-wide flex items-center gap-1.5 shrink-0 active:scale-95 transition"
            onClick={() => createScreenInFront()}
          >
            <Icon name="plus" size={13} /> SCREEN
          </button>
          <button
            type="button"
            data-testid="save-workspace"
            className="w-9 h-8 rounded-xl text-gray-400 hover:text-white hover:bg-white/10 flex items-center justify-center shrink-0"
            onClick={() => useStore.getState().saveCurrent()}
            aria-label="Save workspace"
            title="Save workspace"
          >
            <Icon name="save" size={14} />
          </button>
          <div className="h-5 w-px bg-white/10 mx-1 shrink-0" />
          <div className="flex gap-0.5 overflow-x-auto">
            {presetNames.map((presetName) => (
              <button
                key={presetName}
                type="button"
                data-testid="preset-button"
                data-preset={presetName}
                onClick={() => useStore.getState().applyPreset(presetName)}
                className={'px-3 py-2 text-[10px] font-medium rounded-xl transition-all active:scale-95 whitespace-nowrap ' + (
                  currentPreset === presetName
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                )}
              >
                {presetName.replace(/([a-z])([A-Z])/g, '$1 $2')}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-white/10 mx-1 shrink-0" />
          <button
            type="button"
            data-screen-action="snap-arc"
            className="px-3 py-2 rounded-xl text-[10px] text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            onClick={applyArcArrangement}
          >
            <Icon name="arc" size={13} /> ARC SNAP
          </button>
          <button
            type="button"
            className="w-7 h-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 flex items-center justify-center shrink-0"
            onClick={() => setArcSettingsOpen((value) => !value)}
            aria-label="Arc settings"
            title="Arc settings"
          >
            <Icon name="more" size={13} />
          </button>
        </div>
      </div>

      <XrEntryControls />

      <WelcomeCard />

      {toast && (
        <div
          key={toast.id}
          className="toast absolute bottom-20 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-[#181c22]/95 border border-white/10 shadow-xl text-[10px] text-gray-200 tracking-wide"
          data-testid="toast"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
};

const App = () => {
  const screens = useStore((state) => state.screens);
  const connections = useStore((state) => state.connections);
  const interactionMode = useStore((state) => state.interactionMode);
  const isManipulating = useStore((state) => state.isManipulatingScreen);
  const selectedId = useStore((state) => state.selectedScreen);
  const setSelected = useStore((state) => state.setSelectedScreen);
  const browserLayersEnabled = useStore((state) => state.browserLayersEnabled);
  /* Non-empty only while a session is presenting with layers, because
   * LayerDirector clears it on exit — so this is exactly "layers are live". */
  const layersLive = useStore((state) => state.layerScreenIds.length > 0);
  useKeyboardShortcuts();

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('qa')) return undefined;
    const hook = Object.freeze({
      snapshot: () => {
        const state = useStore.getState();
        return JSON.parse(JSON.stringify({
          screens: state.screens.map((screen) => {
            const object = sceneRuntime.screenObjects.get(screen.id);
            return {
              ...serializeScreen(screen),
              liveTransform: object ? objectTransform(object) : null
            };
          }),
          connections: state.connections,
          interactionMode: state.interactionMode,
          selectedScreen: state.selectedScreen,
          isManipulatingScreen: state.isManipulatingScreen,
          manipulationKind: state.manipulationKind,
          rotationModifier: state.rotationModifier,
          currentPreset: state.currentPreset,
          rotationSnap: state.rotationSnap,
          positionSnap: state.positionSnap
        }));
      },
      cameraSnapshot: () => sceneRuntime.camera ? {
        position: sceneRuntime.camera.position.toArray(),
        quaternion: sceneRuntime.camera.quaternion.toArray()
      } : null,
      orbitEnabled: () => sceneRuntime.orbitControls ? sceneRuntime.orbitControls.enabled : null,
      chromiumSnapshot: (screenId) => {
        const screen = useStore.getState().screens.find((candidate) => candidate.id === screenId);
        if (!screen || screen.source.type !== 'chromium') return null;
        const runtime = getChromiumSourceRuntime(screen.source.sourceId);
        const mesh = sceneRuntime.browserSurfaces.get(screenId);
        return {
          screenId,
          sourceId: screen.source.sourceId,
          state: runtime ? runtime.status || runtime.state : 'OFFLINE',
          url: runtime && runtime.url || screen.url,
          title: runtime && runtime.title || screen.title,
          width: screen.source.browserWidth || 1280,
          height: screen.source.browserHeight || 800,
          frameCount: runtime ? runtime.frameCount : 0,
          lastFrameId: runtime ? runtime.lastFrameId : 0,
          textureWidth: runtime ? runtime.textureWidth : 0,
          textureHeight: runtime ? runtime.textureHeight : 0,
          textureReady: Boolean(runtime && runtime.frameCount > 0 && mesh && mesh.material && mesh.material.name === 'ChromiumOffscreenTextureMaterial'),
          material: mesh && mesh.material ? mesh.material.name : null
        };
      },
      lastManipulationAttempt: () => manipulationDiagnostics.last,
      qualityTiers: () => {
        const state = useStore.getState();
        const decisions = evaluateQuality({
          screens: state.screens,
          screenObjects: sceneRuntime.screenObjects,
          focusedScreenId: state.selectedScreen
        });
        // A Map does not survive structured cloning to a QA client.
        return Object.fromEntries(decisions);
      },
      uiSurface: () => useStore.getState().uiSurface,
      selectScreen: (id) => useStore.getState().setSelectedScreen(id),
      setUiSurface: (surface) => useStore.getState().setUiSurface(surface),

      /* Locate an in-scene spatial control and project its centre to client
       * coordinates, so QA can click real geometry rather than DOM nodes.
       * This is how the XR-critical chrome gets covered by the same gate. */
      spatialControls: (screenId) => {
        const root = sceneRuntime.screenObjects.get(screenId);
        if (!root) return null;
        const found = [];
        root.traverse((object) => {
          if (object.userData && object.userData.role === 'spatial-button') {
            found.push({
              icon: object.userData.icon,
              label: object.userData.label,
              disabled: Boolean(object.userData.disabled)
            });
          }
        });
        return found;
      },

      projectSpatialControl: (screenId, icon) => {
        const root = sceneRuntime.screenObjects.get(screenId);
        const camera = sceneRuntime.camera;
        const renderer = sceneRuntime.renderer;
        if (!root || !camera || !renderer) return null;
        let target = null;
        root.traverse((object) => {
          if (!target && object.userData && object.userData.role === 'spatial-button' && object.userData.icon === icon) {
            target = object;
          }
        });
        if (!target) return null;
        target.updateWorldMatrix(true, false);
        camera.updateMatrixWorld();
        const point = new THREE.Vector3();
        target.getWorldPosition(point);
        const projected = point.clone().project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return {
          icon,
          clientX: rect.left + (projected.x + 1) * rect.width / 2,
          clientY: rect.top + (1 - projected.y) * rect.height / 2,
          visible: projected.z >= -1 && projected.z <= 1,
          disabled: Boolean(target.userData.disabled)
        };
      },

      /* Setting the mode directly, rather than through the keyboard shortcut,
       * so a test is not also testing the shortcut. */
      setInteractionMode: (mode) => {
        useStore.getState().setInteractionMode(mode);
        return useStore.getState().interactionMode;
      },

      /*
       * Aim at one of a window's grab handles.
       *
       * The browser-surface projection cannot reach these: the handles are, by
       * design, strictly outside the page. A test that can only aim at the page
       * cannot prove the thing that matters — that a window can be moved
       * WITHOUT touching the page.
       */
      projectGrabRegion: (screenId, regionId) => {
        const object = sceneRuntime.screenObjects.get(screenId);
        const camera = sceneRuntime.camera;
        const renderer = sceneRuntime.renderer;
        if (!object || !camera || !renderer) return null;
        let target = null;
        object.traverse((child) => {
          if (!target && child.userData?.role === 'grab-region' && child.userData.region === regionId) target = child;
        });
        if (!target) return null;
        target.updateWorldMatrix(true, false);
        camera.updateMatrixWorld();
        const point = target.getWorldPosition(new THREE.Vector3());
        const projected = point.clone().project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return {
          clientX: rect.left + (projected.x + 1) * rect.width / 2,
          clientY: rect.top + (1 - projected.y) * rect.height / 2,
          region: regionId,
          visible: projected.z >= -1 && projected.z <= 1
        };
      },

      projectBrowserUv: (screenId, rawU, rawV) => {
        const screen = useStore.getState().screens.find((candidate) => candidate.id === screenId);
        const mesh = sceneRuntime.browserSurfaces.get(screenId);
        const camera = sceneRuntime.camera;
        const renderer = sceneRuntime.renderer;
        if (!screen || !mesh || !camera || !renderer || screen.source.type !== 'chromium') return null;
        const u = clamp(Number(rawU), 0, 1);
        const v = clamp(Number(rawV), 0, 1);
        const width = mesh.geometry.parameters.width;
        const height = mesh.geometry.parameters.height;
        mesh.updateWorldMatrix(true, false);
        camera.updateMatrixWorld();
        const point = new THREE.Vector3((u - 0.5) * width, (v - 0.5) * height, 0);
        mesh.localToWorld(point);
        const projected = point.clone().project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        const browserWidth = screen.source.browserWidth || 1280;
        const browserHeight = screen.source.browserHeight || 800;
        return {
          clientX: rect.left + (projected.x + 1) * rect.width / 2,
          clientY: rect.top + (1 - projected.y) * rect.height / 2,
          browserX: clamp(Math.round(u * browserWidth), 0, browserWidth - 1),
          browserY: clamp(Math.round((1 - v) * browserHeight), 0, browserHeight - 1),
          sourceId: screen.source.sourceId,
          visible: projected.z >= -1 && projected.z <= 1
        };
      }
    });
    window.__SCC_TEST__ = hook;
    return () => {
      if (window.__SCC_TEST__ === hook) delete window.__SCC_TEST__;
    };
  }, []);

  /* Apply ?layout once, on mount. Later renders must not re-apply it, or a
   * screen the user added would vanish on the next state change. */
  useEffect(() => {
    if (!requestedLayout) return;
    const wanted = requestedLayout.toLowerCase().replace(/[^a-z]/g, '');
    /* Read from the presets themselves rather than a copy of their names. The
     * copy had already drifted: a preset added to workspace-presets.js but not
     * to a list here is unreachable by ?layout=, and it fails by quietly
     * loading the last saved workspace instead -- which looks like the preset
     * is broken rather than missing from a lookup table. */
    const match = Object.keys(PRESETS)
      .find((preset) => preset.toLowerCase().replace(/[^a-z]/g, '') === wanted);
    if (match) useStore.getState().applyPreset(match);
  }, []);

  return (
    <div
      className="relative w-full h-full"
      data-testid="spatial-app"
      data-mode={interactionMode}
      data-manipulating={isManipulating ? 'true' : 'false'}
      data-selected-screen-id={selectedId || ''}
    >
      {/* Owns the microphone, renders nothing. Mounted outside the Canvas so
        * voice works identically on the desktop and inside a session. */}
      <VoiceCommands />
      {/* Discovers host agent adapters. Renders nothing. */}
      <AgentBootstrap />
      <Overlay />
      <BindingsLauncher />
      <Canvas
        data-testid="spatial-canvas"
        camera={{ position: [0, 1.8, 4.5], fov: 55 }}
        dpr={[1, 1.5]}
        /*
         * The probe needs a transparent base layer.
         *
         * @pmndrs/xr composites with the base layer pushed last, so the WebGL
         * scene draws on top of every quad layer. With alpha:false and an opaque
         * background it paints a wall over them and a compositor layer can never
         * be seen. Everywhere else the opaque context is kept, since it is
         * cheaper and the app does not use layers yet.
         */
        /* Decided once, at mount: a context's alpha cannot change afterwards,
         * and a composition layer is visible only where the base layer is
         * transparent. */
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          alpha: needsTransparentBaseLayer({ layersEnabled: browserLayersEnabled, probe: probeEnabled })
        }}
        onPointerMissed={() => setSelected(null)}
      >
        <XR store={xrStore}>
        {/* An opaque clear colour lives in the base layer, which composites on
          * top of every quad layer — so it must go while layers are live. Only
          * then: on the desktop nothing is layered, and dropping the background
          * there would just make the canvas transparent for no benefit. The
          * alpha context above is fixed at mount; the background is not, so it
          * can be surrendered exactly when it costs something. */}
        {probeEnabled || layersLive ? null : <color attach="background" args={['#0f1115']} />}
        <LayerDirector />
        <ambientLight intensity={0.48} />
        <directionalLight position={[5, 8, 2]} intensity={0.85} />
        {/* Same reason as the background: a room drawn into the base layer
          * hides the layers beneath it. This is the separation §13A needs for
          * passthrough, reached from the other direction. */}
        {layerOn('env') && environmentAllowed({ presenting: layersLive, layersActive: layersLive }) ? (
          <Suspense fallback={null}>
            <StudioEnvironment />
          </Suspense>
        ) : null}

        {/*
          * Everything the user arranges hangs from one node.
          *
          * WORLD and FOLLOW are one transform on this parent — identity in
          * WORLD, easing after the viewer in FOLLOW. No window knows which mode
          * it is in and no window transform is rewritten when the mode changes,
          * so switching cannot reload a page or lose state. It is also one
          * matrix write per frame instead of N.
          *
          * System controls are deliberately NOT in here: they hang from their
          * own follow root, or WORLD mode would leave them behind when the user
          * turned round.
          */}
        <WorkspaceRoot>
          {probeEnabled || !layerOn('screens') ? null : screens.map((screen) => (
            <SpatialScreen key={screen.id} screen={screen} />
          ))}

          {probeEnabled || !layerOn('screens') ? null : connections.map((connection) => (
            <ConnectionLine key={connection.id} connection={connection} />
          ))}

          {probeEnabled || !layerOn('screens') ? null : <AgentNodes />}

          {probeEnabled || !layerOn('screens') ? null : <ConnectorDrawing />}

          {probeEnabled || !layerOn('screens') ? null : <ConnectorConfigPanel />}
        </WorkspaceRoot>

        {layerOn('screens') ? <SnapGuide /> : null}
        {/*
          * ContactShadows renders the scene into an offscreen render target.
          * Without `frames` it does so every frame, and restoring the target to
          * null inside an XR session binds the canvas framebuffer rather than
          * the session's, which blanks the headset. ?no-shadows isolates it.
          */}
        {layerOn('shadow') ? (
          <DesktopOnly>
            <ContactShadows
              position={[0, -0.62, 0]}
              opacity={0.48}
              scale={18}
              blur={2.5}
              far={8}
              resolution={256}
              color="#000000"
            />
          </DesktopOnly>
        ) : null}
        {layerOn('quality') ? <BrowserQualityDirector /> : null}
        <CameraSystem />
        <XrSystem />
        <XrSystemUiMount />
        <XrControllerBindings />
        <SpatialKeyboard />
        <XrControllerInput />
        <XrNavigation standoff={standoffMetres} />
        {probeEnabled ? <LegibilityProbe /> : null}
        {xrProbeBuild || diagEnabled ? <DiagnosticsHud visible={diagEnabled} mask={maskLabel} /> : null}
        </XR>
      </Canvas>
    </div>
  );
};

/*
 * Renders its children only outside an immersive session.
 *
 * ContactShadows draws the scene into its own render target every frame. On a
 * desktop that is invisible; inside an XR session it leaves the wrong
 * framebuffer bound and the headset receives nothing, which is the fault this
 * gates. The shadows are also a virtual-floor effect, and section 13A of the
 * architecture brief is explicit that nothing critical should depend on a
 * virtual floor, so dropping them in a headset is correct behaviour rather than
 * merely a workaround.
 *
 * Desktop rendering is untouched.
 */
/*
 * The system controls exist only inside a session. On a desktop the DOM overlay
 * is the better surface and is already there; duplicating it in the scene would
 * give two controls for one piece of state.
 */
const XrSystemUiMount = () => {
  const session = useXR((state) => state.session);
  /* ?xr-ui=1 draws the session controls on a desktop, where they are otherwise
   * never rendered. Without it the first time this code ever executes is inside
   * a headset, which is the worst possible place to discover a mount error —
   * there is no console, and the failure looks like an empty room. */
  return <XrSystemUi presenting={Boolean(session) || forceXrUi} />;
};

const DesktopOnly = ({ children }) => {
  const session = useXR((state) => state.session);
  return session ? null : children;
};

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Spatial Command Center failed to render.', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0f1115] p-8 text-center">
        <div className="glass-panel rounded-2xl p-6 max-w-lg">
          <div className="text-white font-semibold">The spatial workspace could not start.</div>
          <div className="text-gray-400 text-sm mt-2">{this.state.error.message}</div>
          <button
            type="button"
            className="mt-4 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm"
            onClick={() => window.location.reload()}
          >
            Reload workspace
          </button>
        </div>
      </div>
    );
  }
}

const root = createRoot(document.getElementById('root'));
root.render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
