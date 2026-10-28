/*
 * A synthetic `window.spatialBrowser` bridge for WebXR Phase 0.
 *
 * The Quest cannot run Electron, so the headset build has no preload and no
 * offscreen Chromium. Rather than fork the application for that case, this
 * module implements the same bridge contract the preload exposes and installs
 * it on the same global before the app boots.
 *
 * `resolveBrowserProvider()` then detects a bridge exactly as it does under
 * Electron and constructs `ElectronChromiumProvider` over it, so the entire
 * real application runs unmodified: the same provider, the same frame
 * descriptors, the same un-swizzle shader, the same input plumbing. Phase 0
 * therefore measures the real render path rather than a stand in for it.
 *
 * What this is not: it serves static pages and swallows navigation. It exists
 * to answer layout and legibility questions in the headset. Real pages arrive
 * when the remote provider is built.
 */

import { canvasToBgraBuffer, drawSyntheticPage, PAGE_KINDS } from './synthetic-page.js';

const DEFAULT_VIEWPORT = Object.freeze({
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  frameRate: 30
});

/* Deterministic assignment so a given screen always shows the same content
 * across reloads. A layout judgement is worthless if the panels shuffle. */
const kindForSourceId = (sourceId) => {
  const text = String(sourceId || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return PAGE_KINDS[hash % PAGE_KINDS.length];
};

const titleForKind = (kind) => ({
  legibility: 'Legibility reference',
  article: 'Spatial interfaces and the cost of a pixel',
  code: 'browser-source-manager.cjs',
  dashboard: 'Session throughput'
}[kind] || 'Untitled');

const urlForKind = (kind) => ({
  legibility: 'https://probe.local/legibility',
  article: 'https://probe.local/notes/angular-resolution',
  code: 'https://probe.local/src/browser-source-manager',
  dashboard: 'https://probe.local/metrics'
}[kind] || 'https://probe.local/');

const listenersFor = (map, sourceId) => {
  if (!map.has(sourceId)) map.set(sourceId, new Set());
  return map.get(sourceId);
};

const broadcast = (map, sourceId, payload) => {
  for (const listener of [...listenersFor(map, sourceId)]) {
    try {
      listener(payload);
    } catch (error) {
      console.error('[xr-probe] listener threw', error);
    }
  }
  for (const listener of [...listenersFor(map, null)]) {
    try {
      listener(payload);
    } catch (error) {
      console.error('[xr-probe] wildcard listener threw', error);
    }
  }
};

/*
 * The preload accepts either (listener) or (sourceId, listener). Matching that
 * overload here matters: `subscribeToSource` in the texture layer relies on it,
 * and a stricter signature would fail only at runtime inside the headset.
 */
const makeSubscribe = (map) => (sourceOrListener, possibleListener) => {
  const hasSourceId = typeof sourceOrListener !== 'function';
  const sourceId = hasSourceId ? (sourceOrListener || null) : null;
  const listener = hasSourceId ? possibleListener : sourceOrListener;
  if (typeof listener !== 'function') return () => {};
  const bucket = listenersFor(map, sourceId);
  bucket.add(listener);
  return () => bucket.delete(listener);
};

class SyntheticBrowserBridge {
  constructor() {
    this.available = true;
    this.transport = 'synthetic-canvas-bitmap';
    this.sources = new Map();
    this.frameListeners = new Map();
    this.metadataListeners = new Map();
    this.eventListeners = new Map();
    this.sequence = 0;

    this.onFrame = makeSubscribe(this.frameListeners);
    this.onMetadata = makeSubscribe(this.metadataListeners);
    this.onEvent = makeSubscribe(this.eventListeners);
  }

  snapshot(source) {
    return {
      id: source.id,
      url: source.url,
      title: source.title,
      favicon: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      width: source.width,
      height: source.height,
      deviceScaleFactor: source.deviceScaleFactor,
      frameRate: source.frameRate,
      focused: source.focused,
      state: 'ready',
      crashed: false
    };
  }

  /* Re-render only when geometry actually changed. Repainting a 1280x800 page
   * and repacking four megabytes on every frame request would dominate the
   * headset's frame budget and corrupt the very measurement being taken. */
  render(source) {
    source.canvas = drawSyntheticPage({
      width: source.width,
      height: source.height,
      kind: source.kind,
      title: source.title,
      url: source.url,
      canvas: source.canvas
    });
    source.pixels = canvasToBgraBuffer(source.canvas, source.pixels);
    source.dirty = false;
    return source;
  }

  publish(source) {
    if (source.dirty || !source.pixels) this.render(source);
    this.sequence += 1;
    broadcast(this.frameListeners, source.id, {
      sourceId: source.id,
      frameId: this.sequence,
      width: source.width,
      height: source.height,
      logicalWidth: Math.round(source.width / source.deviceScaleFactor),
      logicalHeight: Math.round(source.height / source.deviceScaleFactor),
      deviceScaleFactor: source.deviceScaleFactor,
      stride: source.width * 4,
      premultipliedAlpha: true,
      colorSpace: 'srgb',
      pixelFormat: 'BGRA',
      capturedAt: Date.now(),
      buffer: source.pixels
    });
  }

  publishMetadata(source) {
    broadcast(this.metadataListeners, source.id, this.snapshot(source));
  }

  runtimeInfo() {
    return Promise.resolve({
      transport: this.transport,
      synthetic: true,
      sources: this.sources.size,
      note: 'WebXR Phase 0 probe. Static canvas pages, no Chromium.'
    });
  }

  createSource(options = {}) {
    const id = options.id || `synthetic-${this.sources.size + 1}`;
    const kind = options.kind || kindForSourceId(id);
    const existing = this.sources.get(id);
    const source = existing || {
      id,
      kind,
      canvas: null,
      pixels: null,
      focused: false,
      dirty: true
    };
    source.width = Math.max(1, Math.round(options.width || DEFAULT_VIEWPORT.width));
    source.height = Math.max(1, Math.round(options.height || DEFAULT_VIEWPORT.height));
    source.deviceScaleFactor = options.deviceScaleFactor || DEFAULT_VIEWPORT.deviceScaleFactor;
    source.frameRate = options.frameRate || DEFAULT_VIEWPORT.frameRate;
    source.title = titleForKind(source.kind);
    source.url = options.url || urlForKind(source.kind);
    source.dirty = true;
    this.sources.set(id, source);

    /* Deliver asynchronously so a subscriber that attaches immediately after
     * createSource() still receives the first frame, matching how the real
     * bridge behaves across the IPC boundary. */
    Promise.resolve().then(() => {
      if (!this.sources.has(id)) return;
      this.publishMetadata(source);
      this.publish(source);
    });

    return Promise.resolve(this.snapshot(source));
  }

  destroySource(sourceId) {
    const existed = this.sources.delete(sourceId);
    return Promise.resolve({ id: sourceId, destroyed: existed });
  }

  getSource(sourceId) {
    const source = this.sources.get(sourceId);
    return Promise.resolve(source ? this.snapshot(source) : null);
  }

  listSources() {
    return Promise.resolve([...this.sources.values()].map((source) => this.snapshot(source)));
  }

  resize(sourceId, width, height, deviceScaleFactor = 1) {
    const source = this.sources.get(sourceId);
    if (!source) return Promise.resolve(null);
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (
      source.width === nextWidth
      && source.height === nextHeight
      && source.deviceScaleFactor === deviceScaleFactor
    ) {
      return Promise.resolve(this.snapshot(source));
    }
    source.width = nextWidth;
    source.height = nextHeight;
    source.deviceScaleFactor = deviceScaleFactor;
    source.dirty = true;
    this.publish(source);
    return Promise.resolve(this.snapshot(source));
  }

  requestFrame(sourceId = null) {
    const targets = sourceId ? [this.sources.get(sourceId)] : [...this.sources.values()];
    targets.filter(Boolean).forEach((source) => this.publish(source));
  }

  focus(sourceId) {
    const source = this.sources.get(sourceId);
    if (source) source.focused = true;
    return Promise.resolve(source ? this.snapshot(source) : null);
  }

  blur(sourceId) {
    const source = this.sources.get(sourceId);
    if (source) source.focused = false;
    return Promise.resolve(source ? this.snapshot(source) : null);
  }

  /*
   * Navigation and input are accepted and discarded.
   *
   * Accepting them keeps every caller on its normal path, so a Phase 0 session
   * exercises the real pointer, wheel and keyboard routing all the way to the
   * provider boundary. Only the far side of that boundary is absent.
   */
  navigate(sourceId) { return this.getSource(sourceId); }
  back(sourceId) { return this.getSource(sourceId); }
  forward(sourceId) { return this.getSource(sourceId); }
  reload(sourceId) { return this.getSource(sourceId); }
  stop(sourceId) { return this.getSource(sourceId); }
  sendPointerEvent() { return Promise.resolve(true); }
  sendWheelEvent() { return Promise.resolve(true); }
  sendKeyboardEvent() { return Promise.resolve(true); }
  insertText() { return Promise.resolve(true); }
  openExternal(url) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    return Promise.resolve(true);
  }
}

/**
 * Install the synthetic bridge on `window.spatialBrowser`.
 *
 * Refuses to replace a real Electron preload bridge, so importing this module
 * inside the desktop application can never downgrade it to static pages.
 *
 * @returns {SyntheticBrowserBridge|null} the installed bridge, or null when a
 *   real bridge was already present.
 */
export const installSyntheticBridge = () => {
  if (typeof window === 'undefined') return null;
  if (window.spatialBrowser && window.spatialBrowser.transport !== 'synthetic-canvas-bitmap') {
    console.warn('[xr-probe] a real spatialBrowser bridge is present; leaving it in place.');
    return null;
  }
  const bridge = new SyntheticBrowserBridge();
  Object.defineProperty(window, 'spatialBrowser', {
    value: bridge,
    writable: false,
    configurable: true
  });
  return bridge;
};

export { SyntheticBrowserBridge };
