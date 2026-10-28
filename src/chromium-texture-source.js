import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';

import { resolveBrowserProvider } from './providers/index.js';
import { isBitmapFormat } from './providers/frame-formats.js';
import { createSurfaceForKind, surfaceKindForFormat } from './video-texture-surface.js';
import { XRLayer } from '@react-three/xr';
import { recordEvent, recordFact } from './xr/diagnostics.js';
import { isSystemKeyboardSink } from './xr/system-keyboard.js';
import {
  DEFAULT_CHROMIUM_VIEWPORT,
  domWheelDeltaToElectron,
  domButtonToElectronButton,
  electronKeyCode,
  isChromiumInputEnabled,
  isEditableDomTarget,
  keyboardModifiers,
  pointerModifiers,
  printableTextForKeyboardEvent,
  tightlyPackFrameRows,
  uvToChromiumInputPoint,
  validateRawFrame
} from './chromium-texture-utils.js';

/*
 * This module renders a browser source into the 3D scene and routes spatial
 * input back to it. It talks only to a BrowserSourceProvider (see
 * providers/browser-provider.js) and deliberately knows nothing about how that
 * provider reaches an actual browser.
 *
 * Today the only implementation is ElectronChromiumProvider, backed by the
 * trusted preload bridge. A remote WebRTC provider will satisfy the same
 * contract, and nothing in this file, the scene, or the store should need to
 * change to accommodate it.
 *
 * Frames arrive as descriptors carrying an explicit format rather than as
 * naked byte arrays, so a future video-backed surface can be selected here
 * without disturbing the interaction or transform systems.
 */

const h = React.createElement;

const VERTEX_SHADER = `
  varying vec2 vBrowserUv;

  void main() {
    vBrowserUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* NativeImage.toBitmap() is BGRA and premultiplied. Swizzle/unpremultiply on
 * the GPU instead of walking roughly four megabytes of JavaScript per frame. */
const FRAGMENT_SHADER = `
  uniform sampler2D browserTexture;
  uniform bool sourceIsBgra;
  uniform bool sourceIsPremultiplied;
  varying vec2 vBrowserUv;

  void main() {
    vec4 browserPixel = texture2D(browserTexture, vBrowserUv);
    if (sourceIsBgra) {
      browserPixel = vec4(browserPixel.b, browserPixel.g, browserPixel.r, browserPixel.a);
    }
    if (sourceIsPremultiplied && browserPixel.a > 0.00001) {
      browserPixel.rgb /= browserPixel.a;
    }
    gl_FragColor = browserPixel;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const noop = () => {};

/* Metadata is low-frequency React state; frame buffers are intentionally not.
 * The mutable metrics object lets QA sample frame progress without making the
 * component tree render at Chromium's paint rate. */
const chromiumSourceRuntime = new Map();

/* A single inert runtime shared by every screen that has no browser source.
 * Mock and iframe screens still read this state so their chrome can render
 * uniformly, and without this they would each mint a permanent runtime entry
 * keyed by an empty id that nothing ever releases. */
let inertRuntime = null;

const createInertRuntime = () => ({
  sourceId: '',
  metadata: {
    id: '', sourceId: '', url: '', title: '', loading: false,
    canGoBack: false, canGoForward: false, status: 'OFFLINE',
    frameCount: 0, textureWidth: 0, textureHeight: 0, lastFrameId: 0, lastFrameAt: 0,
    metrics: { frameCount: 0, textureWidth: 0, textureHeight: 0, lastFrameId: 0, lastFrameAt: 0 }
  },
  metrics: { frameCount: 0, textureWidth: 0, textureHeight: 0, lastFrameId: 0, lastFrameAt: 0 },
  listeners: new Set(),
  hasPresentedFrame: false
});

const runtimeFor = (sourceId) => {
  if (!sourceId) {
    if (!inertRuntime) inertRuntime = createInertRuntime();
    return inertRuntime;
  }
  let runtime = chromiumSourceRuntime.get(sourceId);
  if (!runtime) {
    const metrics = {
      frameCount: 0,
      textureWidth: 0,
      textureHeight: 0,
      lastFrameId: 0,
      lastFrameAt: 0
    };
    runtime = {
      sourceId,
      metadata: {
        id: sourceId,
        sourceId,
        url: '',
        title: 'Chromium',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        status: 'CONNECTING',
        frameCount: 0,
        textureWidth: 0,
        textureHeight: 0,
        lastFrameId: 0,
        lastFrameAt: 0,
        metrics
      },
      metrics,
      listeners: new Set(),
      hasPresentedFrame: false
    };
    chromiumSourceRuntime.set(sourceId, runtime);
  }
  return runtime;
};

const notifyRuntime = (runtime) => {
  for (const listener of runtime.listeners) listener();
};

const releaseRuntimeWhenUnused = (sourceId) => {
  if (!sourceId) return;
  queueMicrotask(() => {
    const runtime = chromiumSourceRuntime.get(sourceId);
    if (runtime && runtime.listeners.size === 0) chromiumSourceRuntime.delete(sourceId);
  });
};

const resetRuntimeFrames = (sourceId) => {
  const runtime = runtimeFor(sourceId);
  runtime.metrics.frameCount = 0;
  runtime.metrics.textureWidth = 0;
  runtime.metrics.textureHeight = 0;
  runtime.metrics.lastFrameId = 0;
  runtime.metrics.lastFrameAt = 0;
  runtime.metadata.frameCount = 0;
  runtime.metadata.textureWidth = 0;
  runtime.metadata.textureHeight = 0;
  runtime.metadata.lastFrameId = 0;
  runtime.metadata.lastFrameAt = 0;
  runtime.hasPresentedFrame = false;
};

const updateRuntimeMetadata = (sourceId, rawMetadata, fallbackStatus) => {
  if (!sourceId) return null;
  const runtime = runtimeFor(sourceId);
  const payload = rawMetadata && (rawMetadata.source || rawMetadata.session || rawMetadata.metadata || rawMetadata);
  const metadata = payload && typeof payload === 'object' ? payload : {};
  runtime.metadata = {
    ...runtime.metadata,
    ...metadata,
    id: metadata.id || sourceId,
    sourceId,
    status: metadata.status || metadata.state || fallbackStatus || runtime.metadata.status,
    metrics: runtime.metrics
  };
  notifyRuntime(runtime);
  return runtime.metadata;
};

const recordRuntimeFrame = (sourceId, result) => {
  const runtime = runtimeFor(sourceId);
  runtime.metrics.frameCount += 1;
  runtime.metrics.textureWidth = result.width;
  runtime.metrics.textureHeight = result.height;
  runtime.metrics.lastFrameId = result.frameId;
  runtime.metrics.lastFrameAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  runtime.metadata.frameCount = runtime.metrics.frameCount;
  runtime.metadata.textureWidth = runtime.metrics.textureWidth;
  runtime.metadata.textureHeight = runtime.metrics.textureHeight;
  runtime.metadata.lastFrameId = runtime.metrics.lastFrameId;
  runtime.metadata.lastFrameAt = runtime.metrics.lastFrameAt;
  /* The first live frame is a meaningful state transition. Later frames only
   * mutate metrics and never publish React updates. */
  if (!runtime.hasPresentedFrame) {
    runtime.hasPresentedFrame = true;
    runtime.metadata = {
      ...runtime.metadata,
      status: runtime.metadata.loading ? 'LOADING' : 'READY',
      metrics: runtime.metrics
    };
    notifyRuntime(runtime);
  }
};

export const getChromiumSourceRuntime = (sourceId) => {
  const runtime = chromiumSourceRuntime.get(sourceId);
  if (!runtime) return null;
  return {
    ...runtime.metadata,
    frameCount: runtime.metrics.frameCount,
    textureWidth: runtime.metrics.textureWidth,
    textureHeight: runtime.metrics.textureHeight,
    lastFrameId: runtime.metrics.lastFrameId,
    lastFrameAt: runtime.metrics.lastFrameAt
  };
};

export const useChromiumSourceState = (sourceId) => {
  const runtime = runtimeFor(sourceId);
  const subscribe = useCallback((listener) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }, [runtime]);
  const getSnapshot = useCallback(() => runtime.metadata, [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const currentProvider = (explicitProvider) => resolveBrowserProvider(explicitProvider);

/* A provider always exists; an unavailable one reports itself honestly rather
 * than being null, so mount paths do not need to special-case its absence. */
const providerAvailable = (provider) => Boolean(provider && provider.available);

const reportBridgeError = (onError, error) => {
  const normalized = error instanceof Error ? error : new Error(String(error || 'Browser bridge call failed.'));
  (typeof onError === 'function' ? onError : console.error)(normalized);
};

const invokeBridge = (provider, method, args, onError) => {
  if (!provider || typeof provider[method] !== 'function') {
    reportBridgeError(onError, new Error('The browser provider does not support ' + method + '().'));
    return null;
  }
  try {
    const result = provider[method](...args);
    if (result && typeof result.catch === 'function') result.catch((error) => reportBridgeError(onError, error));
    return result;
  } catch (error) {
    reportBridgeError(onError, error);
    return null;
  }
};

const subscribeToSource = (provider, method, sourceId, listener, onError) => {
  if (!provider || typeof provider[method] !== 'function') return noop;
  try {
    const unsubscribe = provider[method](sourceId, listener);
    if (typeof unsubscribe === 'function') return unsubscribe;
    const offMethod = method === 'onFrame' ? 'offFrame' : method === 'onMetadata' ? 'offMetadata' : '';
    return () => {
      if (offMethod && typeof provider[offMethod] === 'function') provider[offMethod](sourceId, listener);
    };
  } catch (error) {
    reportBridgeError(onError, error);
    return noop;
  }
};

const useLatest = (value) => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};

export class ChromiumDataTextureSurface {
  /* Uploaded pixels, not a decoded object — there is nothing a WebXR layer can
   * take as a src. Stated rather than left undefined: the local Electron path
   * is also the one path that never needs a layer, because Electron exposes no
   * navigator.xr and so never enters a session. */
  get layerSource() { return null; }

  constructor() {
    const placeholder = new Uint8Array([
      14, 18, 25, 255,
      18, 25, 35, 255,
      18, 25, 35, 255,
      14, 18, 25, 255
    ]);
    this.texture = this.createTexture(placeholder, 2, 2);

    this.material = new THREE.ShaderMaterial({
      name: 'ChromiumOffscreenTextureMaterial',
      uniforms: {
        browserTexture: { value: this.texture },
        sourceIsBgra: { value: false },
        sourceIsPremultiplied: { value: false }
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      side: THREE.FrontSide,
      toneMapped: false
    });
    this.width = DEFAULT_CHROMIUM_VIEWPORT.width;
    this.height = DEFAULT_CHROMIUM_VIEWPORT.height;
    this.frameId = 0;
    this.repackBuffer = null;
    this.disposed = false;
  }

  createTexture(pixels, width, height) {
    const texture = new THREE.DataTexture(
      pixels,
      width,
      height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    /* Native bitmap row zero is the top row. Plane UV.y=1 is the visual top,
     * so flipY keeps display orientation and input mapping in agreement. */
    texture.flipY = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }

  update(frame) {
    if (this.disposed) return { ok: false, error: 'Texture surface is disposed.' };
    const validated = validateRawFrame(frame);
    if (!validated.ok) return validated;
    const pixels = tightlyPackFrameRows(validated, this.repackBuffer);
    this.repackBuffer = validated.stride === validated.width * 4 ? null : pixels;
    this.width = validated.width;
    this.height = validated.height;
    this.frameId = Number(frame.frameId) || this.frameId + 1;

    /* WebGL immutable texture storage cannot be resized with texSubImage2D.
     * Recreate only when the browser viewport changes; ordinary frames keep
     * the zero-copy typed-array update path and never trigger a React render. */
    if (
      this.texture.image.width !== validated.width ||
      this.texture.image.height !== validated.height
    ) {
      const previousTexture = this.texture;
      this.texture = this.createTexture(pixels, validated.width, validated.height);
      this.material.uniforms.browserTexture.value = this.texture;
      previousTexture.dispose();
    } else {
      this.texture.image.data = pixels;
      this.texture.needsUpdate = true;
    }
    this.material.uniforms.sourceIsBgra.value = validated.pixelFormat === 'bgra';
    this.material.uniforms.sourceIsPremultiplied.value = validated.premultipliedAlpha;
    return {
      ok: true,
      width: validated.width,
      height: validated.height,
      frameId: this.frameId,
      pixelFormat: validated.pixelFormat
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
    this.material.dispose();
    this.repackBuffer = null;
  }
}

export const createChromiumSourceController = (sourceId, explicitProvider, onError) => {
  const provider = currentProvider(explicitProvider);
  const call = (method, ...args) => invokeBridge(provider, method, [sourceId, ...args], onError);
  return Object.freeze({
    sourceId,
    available: providerAvailable(provider),
    get: () => call('getSource'),
    navigate: (url) => call('navigate', url),
    back: () => call('back'),
    forward: () => call('forward'),
    reload: () => call('reload'),
    stop: () => call('stop'),
    resize: (width, height, deviceScaleFactor = 1) => call('resize', width, height, deviceScaleFactor),
    focus: () => call('focus'),
    blur: () => call('blur'),
    pointer: (event) => call('sendPointerEvent', event),
    wheel: (event) => call('sendWheelEvent', event),
    keyboard: (event) => call('sendKeyboardEvent', event),
    insertText: (text) => call('insertText', text),
    destroy: () => call('destroySource')
  });
};

export const useChromiumSourceController = (sourceId, options = {}) => {
  const provider = currentProvider(options.provider || options.api);
  const onErrorRef = useLatest(options.onError);
  return useMemo(
    () => createChromiumSourceController(sourceId, provider, (error) => onErrorRef.current && onErrorRef.current(error)),
    [sourceId, provider]
  );
};

/* This hook owns Chromium lifecycle only. Its dependency list deliberately
 * contains no world-space position/rotation/scale, so moving a monitor can
 * never recreate or navigate its webContents. */
export const useChromiumSourceLifecycle = ({
  sourceId,
  provider: explicitProvider,
  initialUrl = 'https://example.com',
  width = DEFAULT_CHROMIUM_VIEWPORT.width,
  height = DEFAULT_CHROMIUM_VIEWPORT.height,
  deviceScaleFactor = DEFAULT_CHROMIUM_VIEWPORT.deviceScaleFactor,
  frameRate = DEFAULT_CHROMIUM_VIEWPORT.frameRate,
  createOnMount = true,
  destroyOnUnmount = true,
  onBeforeDestroy,
  onMetadata,
  onError
}) => {
  const provider = currentProvider(explicitProvider);
  const onMetadataRef = useLatest(onMetadata);
  const onBeforeDestroyRef = useLatest(onBeforeDestroy);
  const onErrorRef = useLatest(onError);
  const initialOptionsRef = useRef(null);
  if (!initialOptionsRef.current || initialOptionsRef.current.sourceId !== sourceId) {
    initialOptionsRef.current = {
      sourceId,
      url: initialUrl,
      width,
      height,
      deviceScaleFactor,
      frameRate
    };
  }

  useEffect(() => {
    if (!sourceId || !providerAvailable(provider)) {
      if (sourceId && createOnMount) {
        updateRuntimeMetadata(sourceId, null, 'OFFLINE');
        /* Browser-served development mode is an expected offline fallback,
         * not a renderer error. Consumers may opt into a visible notice. */
        if (onErrorRef.current) {
          onErrorRef.current(new Error('Electron browser bridge is unavailable.'));
        }
      }
      return undefined;
    }
    let active = true;
    if (createOnMount) resetRuntimeFrames(sourceId);
    updateRuntimeMetadata(sourceId, {
      url: initialOptionsRef.current.url,
      loading: Boolean(initialOptionsRef.current.url)
    }, createOnMount ? 'CREATING' : 'CONNECTING');
    const unsubscribeMetadata = subscribeToSource(
      provider,
      'onMetadata',
      sourceId,
      (metadata) => {
        if (!active) return;
        const normalized = updateRuntimeMetadata(sourceId, metadata);
        if (onMetadataRef.current) onMetadataRef.current(normalized || metadata);
      },
      onErrorRef.current
    );
    if (createOnMount) {
      const options = initialOptionsRef.current;
      const result = invokeBridge(provider, 'createSource', [{
        id: sourceId,
        url: options.url,
        width: options.width,
        height: options.height,
        deviceScaleFactor: options.deviceScaleFactor,
        frameRate: options.frameRate
      }], onErrorRef.current);
      if (result && typeof result.then === 'function') {
        result.then((metadata) => {
          if (!active || !metadata) return;
          const normalized = updateRuntimeMetadata(sourceId, metadata);
          if (onMetadataRef.current) onMetadataRef.current(normalized || metadata);
        }).catch(noop);
      }
    }
    return () => {
      active = false;
      unsubscribeMetadata();
      if (destroyOnUnmount) {
        if (onBeforeDestroyRef.current) onBeforeDestroyRef.current();
        updateRuntimeMetadata(sourceId, null, 'DESTROYING');
        invokeBridge(provider, 'destroySource', [sourceId], onErrorRef.current);
      }
      releaseRuntimeWhenUnused(sourceId);
    };
  }, [provider, sourceId, createOnMount, destroyOnUnmount]);

  useEffect(() => {
    if (!providerAvailable(provider) || !sourceId || !createOnMount) return;
    invokeBridge(provider, 'resize', [sourceId, width, height, deviceScaleFactor], onErrorRef.current);
  }, [provider, sourceId, createOnMount, width, height, deviceScaleFactor]);
};

export const useChromiumFrameSurface = ({ sourceId, provider: explicitProvider, onFrame, onError }) => {
  const provider = currentProvider(explicitProvider);

  /* Pick the surface from what the provider says it delivers, not from an
   * assumption about where the browser is running. A local Electron source
   * uploads bitmaps; a remote one hands over a decoded video element that the
   * GPU samples directly. The scene, the interaction system, and the store
   * are identical either way. */
  const surfaceKind = surfaceKindForFormat(provider?.frameFormat);
  const surface = useMemo(
    () => createSurfaceForKind(surfaceKind, { BitmapSurface: ChromiumDataTextureSurface }),
    [sourceId, surfaceKind]
  );
  const onFrameRef = useLatest(onFrame);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    if (!providerAvailable(provider) || !sourceId) return undefined;
    return subscribeToSource(provider, 'onFrame', sourceId, (frame) => {
      if (!frame || frame.sourceId && frame.sourceId !== sourceId) return;
      const result = surface.update(frame);
      if (!result.ok) {
        reportBridgeError(onErrorRef.current, new Error(result.error));
        return;
      }
      recordRuntimeFrame(sourceId, result);
      if (onFrameRef.current) onFrameRef.current(result, frame);
    }, onErrorRef.current);
  }, [provider, sourceId, surface]);

  useEffect(() => () => surface.dispose(), [surface]);
  return surface;
};

const hostOwnsKeyboardShortcut = (event) => (
  (event.metaKey || event.ctrlKey) && !event.altKey && String(event.key || '').toLowerCase() === 'l'
);

class ChromiumKeyboardRouter {
  constructor() {
    this.endpoint = null;
    this.pressed = new Map();
    this.installed = false;
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);
    this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.handleDocumentFocusIn = this.handleDocumentFocusIn.bind(this);
  }

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    window.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('keyup', this.handleKeyUp, true);
    window.addEventListener('blur', this.handleWindowBlur, true);
    document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    document.addEventListener('focusin', this.handleDocumentFocusIn, true);
  }

  focus(endpoint) {
    this.install();
    if (this.endpoint && this.endpoint.sourceId !== endpoint.sourceId) this.blur(this.endpoint.sourceId);
    const alreadyFocused = this.endpoint && this.endpoint.sourceId === endpoint.sourceId;
    this.endpoint = endpoint;
    const canvas = endpoint.domElement;
    if (canvas && typeof canvas.focus === 'function') {
      if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
      try {
        canvas.focus({ preventScroll: true });
      } catch {
        canvas.focus();
      }
    }
    if (alreadyFocused) return;
    invokeBridge(endpoint.provider, 'focus', [endpoint.sourceId], endpoint.onErrorRef.current);
  }

  blur(sourceId, notifyBridge = true) {
    if (!this.endpoint || sourceId && this.endpoint.sourceId !== sourceId) return;
    const endpoint = this.endpoint;
    this.releasePressedKeys(endpoint);
    this.endpoint = null;
    if (notifyBridge) invokeBridge(endpoint.provider, 'blur', [endpoint.sourceId], endpoint.onErrorRef.current);
  }

  releasePressedKeys(endpoint = this.endpoint) {
    if (!endpoint) return;
    for (const pressed of this.pressed.values()) {
      invokeBridge(endpoint.provider, 'sendKeyboardEvent', [endpoint.sourceId, {
        type: 'keyUp',
        keyCode: pressed.keyCode,
        modifiers: pressed.modifiers
      }], endpoint.onErrorRef.current);
    }
    this.pressed.clear();
  }

  activeEndpoint(event) {
    const endpoint = this.endpoint;
    if (!endpoint || !endpoint.enabledRef.current) return null;
    if (isEditableDomTarget(event.target)) return null;
    return endpoint;
  }

  consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  handleKeyDown(event) {
    const endpoint = this.activeEndpoint(event);
    if (!endpoint || hostOwnsKeyboardShortcut(event)) return;
    this.consume(event);
    const keyCode = electronKeyCode(event);
    const modifiers = keyboardModifiers(event);
    if (event.repeat) modifiers.push('isautorepeat');
    const identity = event.code || event.key || keyCode;
    this.pressed.set(identity, { keyCode, modifiers });
    invokeBridge(endpoint.provider, 'sendKeyboardEvent', [endpoint.sourceId, {
      type: 'keyDown',
      keyCode,
      code: event.code || '',
      modifiers,
      isAutoRepeat: Boolean(event.repeat)
    }], endpoint.onErrorRef.current);
    const text = printableTextForKeyboardEvent(event);
    if (text) {
      invokeBridge(endpoint.provider, 'sendKeyboardEvent', [endpoint.sourceId, {
        type: 'char',
        keyCode: text,
        text,
        modifiers
      }], endpoint.onErrorRef.current);
    }
  }

  handleKeyUp(event) {
    const endpoint = this.activeEndpoint(event);
    if (!endpoint || hostOwnsKeyboardShortcut(event)) return;
    const keyCode = electronKeyCode(event);
    const identity = event.code || event.key || keyCode;
    if (!this.pressed.has(identity)) return;
    this.consume(event);
    invokeBridge(endpoint.provider, 'sendKeyboardEvent', [endpoint.sourceId, {
      type: 'keyUp',
      keyCode,
      code: event.code || '',
      modifiers: keyboardModifiers(event)
    }], endpoint.onErrorRef.current);
    this.pressed.delete(identity);
  }

  handleWindowBlur() {
    this.blur(null, true);
  }

  handleDocumentPointerDown(event) {
    const endpoint = this.endpoint;
    if (!endpoint || event.target === endpoint.domElement) return;
    this.blur(endpoint.sourceId, true);
  }

  handleDocumentFocusIn(event) {
    const endpoint = this.endpoint;
    if (!endpoint || event.target === endpoint.domElement) return;
    /* The headset's system keyboard types into a hidden DOM field, so focus
     * necessarily leaves the canvas to raise it. That is the wearer beginning
     * to type at this surface, not leaving it — and blurring here would revoke
     * the focus the host requires before it accepts a single keystroke. */
    if (isSystemKeyboardSink(event.target)) return;
    // Keyboard-driven focus changes (notably Cmd/Ctrl+L) have no pointerdown.
    // Release remote modifiers and logical focus before the host field types.
    this.blur(endpoint.sourceId, true);
  }
}

const chromiumKeyboardRouter = new ChromiumKeyboardRouter();

const nativePointerEvent = (event) => event && (event.nativeEvent || event.sourceEvent || event);

const stopBrowserPointerEvent = (event, preventDefault = false) => {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  const nativeEvent = nativePointerEvent(event);
  if (preventDefault && nativeEvent && typeof nativeEvent.preventDefault === 'function') {
    nativeEvent.preventDefault();
  }
};

const pointFromR3fEvent = (event, viewport, fallback) => {
  if (event && event.uv) return uvToChromiumInputPoint(event.uv, viewport.width, viewport.height);
  return fallback || { x: 0, y: 0 };
};

export const ChromiumTextureSource = ({
  sourceId,
  provider: explicitProvider,
  initialUrl = 'https://example.com',
  viewportWidth = DEFAULT_CHROMIUM_VIEWPORT.width,
  viewportHeight = DEFAULT_CHROMIUM_VIEWPORT.height,
  deviceScaleFactor = DEFAULT_CHROMIUM_VIEWPORT.deviceScaleFactor,
  frameRate = DEFAULT_CHROMIUM_VIEWPORT.frameRate,
  worldWidth = 2.2,
  worldHeight = 1.35,
  position = [0, 0, 0.032],
  interactionMode = 'browse',
  locked = false,
  enabled = true,
  focused,
  manageLifecycle = true,
  destroyOnUnmount = true,
  renderOrder = 2,
  /* Render as a WebXR composition layer rather than a textured mesh.
   *
   * Measured on a Quest 3: a mesh cannot resolve small type, while the same
   * content as a quad layer at text-optimized quality reads down to 10px. The
   * caller decides — see xr/layer-policy.js — because the decision depends on
   * the session, the attention tier, and a runtime budget this component
   * cannot see. Ignored when the surface has no layer source. */
  asLayer = false,
  meshRef,
  orbitControls,
  userData,
  onSelect,
  onFocus,
  onBlur,
  onHoverChange,
  onInputCaptureChange,
  onMetadata,
  onFrame,
  onError
}) => {
  const provider = currentProvider(explicitProvider);
  const inputEnabled = isChromiumInputEnabled({ enabled, interactionMode, locked });
  const enabledRef = useLatest(inputEnabled);
  const onErrorRef = useLatest(onError);
  const onFrameRef = useLatest(onFrame);
  const onSelectRef = useLatest(onSelect);
  const onFocusRef = useLatest(onFocus);
  const onBlurRef = useLatest(onBlur);
  const onHoverChangeRef = useLatest(onHoverChange);
  const onInputCaptureChangeRef = useLatest(onInputCaptureChange);
  const orbitControlsRef = useLatest(orbitControls);
  const viewportRef = useRef({ width: viewportWidth, height: viewportHeight });
  const latestPointRef = useRef({ x: 0, y: 0 });
  const pendingMoveRef = useRef(null);
  const moveFrameRef = useRef(null);
  const activePointersRef = useRef(new Map());
  const pointerSeenRef = useRef(false);
  const clickRef = useRef({ button: '', time: 0, x: -100, y: -100, count: 0 });
  const hoveredRef = useRef(false);
  const { gl } = useThree();

  const surface = useChromiumFrameSurface({
    sourceId,
    provider,
    onError,
    onFrame: (result, rawFrame) => {
      if (onFrameRef.current) onFrameRef.current(result, rawFrame);
    }
  });

  /* Input events use Chromium's logical viewport, not the physical bitmap
   * dimensions. They differ on HiDPI displays when deviceScaleFactor > 1. */
  viewportRef.current.width = viewportWidth;
  viewportRef.current.height = viewportHeight;

  const send = useCallback((method, payload) => {
    if (!providerAvailable(provider)) return;
    invokeBridge(provider, method, [sourceId, payload], onErrorRef.current);
  }, [provider, sourceId]);

  const setCameraInputSuppressed = useCallback((suppressed, reason) => {
    const controls = orbitControlsRef.current;
    if (controls && typeof controls === 'object' && 'enabled' in controls) {
      controls.enabled = !suppressed;
    }
    if (onInputCaptureChangeRef.current) {
      onInputCaptureChangeRef.current(Boolean(suppressed), reason, sourceId);
    }
  }, [sourceId]);

  const focusBrowser = useCallback(() => {
    if (!providerAvailable(provider) || !enabledRef.current) return;
    chromiumKeyboardRouter.focus({
      sourceId,
      provider,
      enabledRef,
      onErrorRef,
      domElement: gl.domElement
    });
    if (onFocusRef.current) onFocusRef.current(sourceId);
  }, [provider, sourceId, gl]);

  const flushMove = useCallback(() => {
    if (moveFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(moveFrameRef.current);
    }
    moveFrameRef.current = null;
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending && enabledRef.current) send('sendPointerEvent', pending);
  }, [send]);

  const queueMove = useCallback((payload) => {
    pendingMoveRef.current = payload;
    if (moveFrameRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      flushMove();
      return;
    }
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending && enabledRef.current) send('sendPointerEvent', pending);
    });
  }, [flushMove, send]);

  const releasePointers = useCallback(() => {
    for (const pointer of activePointersRef.current.values()) {
      send('sendPointerEvent', {
        type: 'mouseUp',
        x: latestPointRef.current.x,
        y: latestPointRef.current.y,
        button: pointer.button,
        clickCount: pointer.clickCount,
        modifiers: []
      });
    }
    activePointersRef.current.clear();
  }, [send]);

  useChromiumSourceLifecycle({
    sourceId,
    provider,
    initialUrl,
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor,
    frameRate,
    createOnMount: manageLifecycle,
    destroyOnUnmount: manageLifecycle && destroyOnUnmount,
    onBeforeDestroy: () => {
      flushMove();
      releasePointers();
      chromiumKeyboardRouter.blur(sourceId, true);
      setCameraInputSuppressed(false, 'unmount');
    },
    onMetadata,
    onError
  });

  useEffect(() => {
    if (inputEnabled) return undefined;
    flushMove();
    releasePointers();
    hoveredRef.current = false;
    if (onHoverChangeRef.current) onHoverChangeRef.current(false);
    chromiumKeyboardRouter.blur(sourceId, true);
    setCameraInputSuppressed(false, 'mode-change');
    if (onBlurRef.current) onBlurRef.current(sourceId);
    return undefined;
  }, [inputEnabled, sourceId, flushMove, releasePointers, setCameraInputSuppressed]);

  useEffect(() => {
    if (focused === true && inputEnabled) focusBrowser();
    if (focused === false) chromiumKeyboardRouter.blur(sourceId, true);
  }, [focused, inputEnabled, focusBrowser, sourceId]);

  useEffect(() => () => {
    flushMove();
    releasePointers();
    chromiumKeyboardRouter.blur(sourceId, true);
    setCameraInputSuppressed(false, 'unmount');
  }, [flushMove, releasePointers, sourceId, setCameraInputSuppressed]);

  const handlePointerMove = useCallback((event) => {
    if (!enabledRef.current) return;
    stopBrowserPointerEvent(event);
    if (!hoveredRef.current) {
      hoveredRef.current = true;
      setCameraInputSuppressed(true, 'pointer-move');
      if (onHoverChangeRef.current) onHoverChangeRef.current(true);
    }
    const nativeEvent = nativePointerEvent(event);
    const point = pointFromR3fEvent(event, viewportRef.current, latestPointRef.current);
    latestPointRef.current = point;
    queueMove({
      type: 'mouseMove',
      ...point,
      button: domButtonToElectronButton(nativeEvent && nativeEvent.button),
      buttons: Number(nativeEvent && nativeEvent.buttons) || 0,
      movementX: Number(nativeEvent && nativeEvent.movementX) || 0,
      movementY: Number(nativeEvent && nativeEvent.movementY) || 0,
      modifiers: pointerModifiers(nativeEvent)
    });
  }, [queueMove, setCameraInputSuppressed]);

  const handlePointerDown = useCallback((event) => {
    /* Reported once per source. "The pointer does not interact" has several
     * very different causes — no ray reaching the mesh at all, a ray that hits
     * but is gated off, or input that is delivered and rejected downstream —
     * and from inside a headset they are indistinguishable. This says which. */
    if (!pointerSeenRef.current) {
      pointerSeenRef.current = true;
      recordEvent('surface:first-pointer-down', {
        sourceId,
        enabled: enabledRef.current,
        hasUv: Boolean(event && event.uv),
        pointerType: event && event.pointerType
      });
    }
    if (!enabledRef.current) return;
    stopBrowserPointerEvent(event, true);
    flushMove();
    const nativeEvent = nativePointerEvent(event);
    const point = pointFromR3fEvent(event, viewportRef.current, latestPointRef.current);
    latestPointRef.current = point;
    const button = domButtonToElectronButton(nativeEvent && nativeEvent.button);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const previous = clickRef.current;
    const closeEnough = Math.hypot(point.x - previous.x, point.y - previous.y) <= 6;
    const repeated = previous.button === button && closeEnough && now - previous.time <= 500;
    const nativeDetail = Math.max(0, Number(nativeEvent && nativeEvent.detail) || 0);
    const clickCount = Math.min(3, Math.max(nativeDetail, repeated ? previous.count + 1 : 1));
    clickRef.current = { button, time: now, x: point.x, y: point.y, count: clickCount };
    activePointersRef.current.set(event.pointerId, { button, clickCount });
    try {
      if (event.target && typeof event.target.setPointerCapture === 'function') {
        event.target.setPointerCapture(event.pointerId);
      }
    } catch {
      // R3F continues delivering intersections when native capture is absent.
    }
    setCameraInputSuppressed(true, 'pointer-down');
    focusBrowser();
    if (onSelectRef.current) onSelectRef.current(sourceId);
    send('sendPointerEvent', {
      type: 'mouseDown',
      ...point,
      button,
      buttons: Number(nativeEvent && nativeEvent.buttons) || 0,
      clickCount,
      modifiers: pointerModifiers(nativeEvent)
    });
  }, [flushMove, focusBrowser, send, setCameraInputSuppressed, sourceId]);

  const handlePointerUp = useCallback((event) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (!pointer) return;
    stopBrowserPointerEvent(event, true);
    flushMove();
    const nativeEvent = nativePointerEvent(event);
    const point = pointFromR3fEvent(event, viewportRef.current, latestPointRef.current);
    latestPointRef.current = point;
    send('sendPointerEvent', {
      type: 'mouseUp',
      ...point,
      button: pointer.button,
      buttons: Number(nativeEvent && nativeEvent.buttons) || 0,
      clickCount: pointer.clickCount,
      modifiers: pointerModifiers(nativeEvent)
    });
    activePointersRef.current.delete(event.pointerId);
    try {
      if (event.target && typeof event.target.releasePointerCapture === 'function') {
        event.target.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The DOM can release capture before R3F reports pointerup.
    }
    if (!hoveredRef.current) setCameraInputSuppressed(false, 'pointer-up');
  }, [flushMove, send, setCameraInputSuppressed]);

  const handlePointerCancel = useCallback((event) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (!pointer) return;
    stopBrowserPointerEvent(event, true);
    send('sendPointerEvent', {
      type: 'mouseUp',
      ...latestPointRef.current,
      button: pointer.button,
      clickCount: pointer.clickCount,
      modifiers: []
    });
    activePointersRef.current.delete(event.pointerId);
    if (!hoveredRef.current) setCameraInputSuppressed(false, 'pointer-cancel');
  }, [send, setCameraInputSuppressed]);

  const handleWheel = useCallback((event) => {
    if (!enabledRef.current) return;
    // R3F installs wheel handling through a passive DOM listener. Camera input
    // is already disabled while this surface is hovered, so preventing the
    // native default is both unnecessary and produces a browser warning.
    stopBrowserPointerEvent(event);
    if (!hoveredRef.current) {
      hoveredRef.current = true;
      setCameraInputSuppressed(true, 'wheel');
      if (onHoverChangeRef.current) onHoverChangeRef.current(true);
    }
    focusBrowser();
    if (onSelectRef.current) onSelectRef.current(sourceId);
    const nativeEvent = nativePointerEvent(event);
    const point = pointFromR3fEvent(event, viewportRef.current, latestPointRef.current);
    latestPointRef.current = point;
    const deltaX = domWheelDeltaToElectron(event.deltaX ?? (nativeEvent && nativeEvent.deltaX));
    const deltaY = domWheelDeltaToElectron(event.deltaY ?? (nativeEvent && nativeEvent.deltaY));
    send('sendWheelEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX,
      deltaY,
      wheelTicksX: Math.round(deltaX / 120),
      wheelTicksY: Math.round(deltaY / 120),
      hasPreciseScrollingDeltas: true,
      canScroll: true,
      modifiers: keyboardModifiers(nativeEvent)
    });
  }, [focusBrowser, send, setCameraInputSuppressed, sourceId]);

  const handlePointerOut = useCallback((event) => {
    if (!enabledRef.current) return;
    hoveredRef.current = false;
    if (onHoverChangeRef.current) onHoverChangeRef.current(false);
    if (activePointersRef.current.size) return;
    stopBrowserPointerEvent(event);
    flushMove();
    send('sendPointerEvent', {
      type: 'mouseLeave',
      ...latestPointRef.current,
      modifiers: []
    });
    setCameraInputSuppressed(false, 'pointer-out');
  }, [flushMove, send, setCameraInputSuppressed]);

  const setResolvedMeshRef = useCallback((mesh) => {
    if (typeof meshRef === 'function') meshRef(mesh);
    else if (meshRef && typeof meshRef === 'object') meshRef.current = mesh;
  }, [meshRef]);

  /* A layer is only possible when the surface can hand over a decoded object.
   * A DataTexture cannot, which is why the local path silently stays a mesh
   * rather than producing a transparent hole. */
  const layerSource = surface.layerSource || null;
  const renderAsLayer = Boolean(asLayer && layerSource);

  const element = renderAsLayer ? XRLayer : 'mesh';

  return h(
    element,
    {
      ref: setResolvedMeshRef,
      name: 'chromium-texture-' + sourceId,
      position,
      renderOrder,
      ...(renderAsLayer ? {
        src: layerSource,
        shape: 'quad',
        /* The reason this exists. The runtime samples the source once at its
         * own resolution instead of through the eye buffer. */
        quality: 'text-optimized',
        pixelWidth: viewportWidth,
        pixelHeight: viewportHeight
      } : {}),
      userData: {
        role: 'chromium-texture',
        sourceId,
        ...(userData || {})
      },
      onPointerMove: handlePointerMove,
      onPointerDown: handlePointerDown,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handlePointerCancel,
      onPointerOver: (event) => {
        if (!enabledRef.current) return;
        stopBrowserPointerEvent(event);
        hoveredRef.current = true;
        setCameraInputSuppressed(true, 'pointer-over');
        if (onHoverChangeRef.current) onHoverChangeRef.current(true);
      },
      onPointerOut: handlePointerOut,
      onDoubleClick: (event) => {
        if (enabledRef.current) stopBrowserPointerEvent(event, true);
      },
      onContextMenu: (event) => {
        if (enabledRef.current) stopBrowserPointerEvent(event, true);
      },
      onWheel: handleWheel
    },
    h('planeGeometry', { args: [worldWidth, worldHeight] }),
    /* A layer is composited from its src by the runtime, so attaching the
     * surface material would paint the same pixels into the base layer on top
     * of it — the exact mistake that made the probe black. */
    renderAsLayer ? null : h('primitive', { object: surface.material, attach: 'material' })
  );
};

export {
  DEFAULT_CHROMIUM_VIEWPORT,
  isChromiumInputEnabled,
  uvToBrowserPixels,
  uvToChromiumInputPoint
} from './chromium-texture-utils.js';
