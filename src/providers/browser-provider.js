/*
 * BrowserSourceProvider — the transport-independent contract between the
 * spatial workspace and whatever is actually running a browser page.
 *
 * The React/Three scene must never need to know whether a browser source is:
 *   - a local Electron offscreen webContents,
 *   - a Chromium instance on another machine reached over WebRTC,
 *   - or a future server-hosted browser session.
 *
 * Everything above this interface deals in source ids, normalized input, and
 * frame descriptors. Everything below it deals in transports.
 *
 * Lifecycle
 *   createSource(options) -> Promise<SourceSnapshot>
 *   destroySource(sourceId) -> Promise<{ id, destroyed }>
 *   getSource(sourceId) -> Promise<SourceSnapshot>
 *   listSources() -> Promise<SourceSnapshot[]>
 *
 * Navigation
 *   navigate(sourceId, url), back, forward, reload, stop
 *
 * Presentation
 *   resize(sourceId, width, height, deviceScaleFactor)
 *   setQuality(sourceId, { frameRate, painting })   optional, a hint
 *
 * Input
 *   focus(sourceId), blur(sourceId)
 *   sendPointerEvent(sourceId, event)   normalized, viewport-relative pixels
 *   sendWheelEvent(sourceId, event)
 *   sendKeyboardEvent(sourceId, event)
 *   insertText(sourceId, text)
 *
 * Content
 *   extract(sourceId, { capabilities })  structured page content, limited to
 *   the categories the caller was granted. Enforced by the host, never here.
 *
 * Streams (each returns an unsubscribe function)
 *   onFrame(sourceId, listener)     listener receives a frame descriptor
 *   onMetadata(sourceId, listener)  title, url, loading, history availability
 *   onEvent(sourceId, listener)     crashes, load errors, popups
 *
 * A SourceSnapshot is:
 *   { id, url, title, favicon, loading, canGoBack, canGoForward,
 *     width, height, deviceScaleFactor, frameRate, focused, state, crashed }
 *
 * `state` is one of: creating | loading | ready | error | crashed | offline.
 */

const notImplemented = (method) => () => {
  throw new Error(`BrowserSourceProvider.${method}() is not implemented by this provider.`);
};

export class BrowserSourceProvider {
  /* A stable identifier for diagnostics and QA, e.g. 'electron-chromium'. */
  get id() { return 'abstract'; }

  /* Whether this provider can currently serve sources. A provider may exist
   * but be unavailable, which is a normal state rather than an error: the
   * browser-only development build has no Electron bridge. */
  get available() { return false; }

  /* Describes how frames arrive, so the renderer can select a texture surface
   * without probing individual frames. */
  get frameFormat() { return null; }

  createSource = notImplemented('createSource');
  destroySource = notImplemented('destroySource');
  getSource = notImplemented('getSource');
  listSources = notImplemented('listSources');
  navigate = notImplemented('navigate');
  back = notImplemented('back');
  forward = notImplemented('forward');
  reload = notImplemented('reload');
  stop = notImplemented('stop');
  resize = notImplemented('resize');
  /* Optional: adjust paint rate / pause painting for a source. A provider that
   * cannot vary quality may leave this unimplemented; callers treat it as a
   * hint rather than a requirement. */
  setQuality = () => Promise.resolve(null);
  focus = notImplemented('focus');
  blur = notImplemented('blur');
  sendPointerEvent = notImplemented('sendPointerEvent');
  sendWheelEvent = notImplemented('sendWheelEvent');
  sendKeyboardEvent = notImplemented('sendKeyboardEvent');
  insertText = notImplemented('insertText');
  /* Optional: a provider that cannot read page content leaves this, and a
   * connector reports that extraction is unavailable rather than failing. */
  extract = () => Promise.resolve({
    ok: false,
    code: 'EXTRACTION_UNSUPPORTED',
    message: 'This browser provider cannot read page content.'
  });
  onFrame = notImplemented('onFrame');
  onMetadata = notImplemented('onMetadata');
  onEvent = notImplemented('onEvent');
}

const noop = () => {};
const unavailable = (method) => () => Promise.reject(
  new Error(`No browser provider is connected, so ${method} is unavailable.`)
);

/*
 * The provider used when nothing can serve browser sources — for example the
 * browser-only dev build, where window.spatialBrowser does not exist.
 *
 * It reports `available: false` so the UI can show an honest offline state,
 * and its subscriptions are inert rather than throwing, so a screen can mount
 * and display that state without special-casing its absence everywhere.
 */
export class UnavailableBrowserProvider extends BrowserSourceProvider {
  constructor(reason = 'No local browser runtime is present.') {
    super();
    this.reason = reason;
  }

  get id() { return 'unavailable'; }
  get available() { return false; }
  get frameFormat() { return null; }

  createSource = unavailable('creating a browser source');
  destroySource = () => Promise.resolve({ id: null, destroyed: false });
  getSource = unavailable('reading a browser source');
  listSources = () => Promise.resolve([]);
  navigate = unavailable('navigation');
  back = unavailable('navigation');
  forward = unavailable('navigation');
  reload = unavailable('navigation');
  stop = unavailable('navigation');
  resize = () => Promise.resolve(null);
  setQuality = () => Promise.resolve(null);
  focus = () => Promise.resolve(null);
  blur = () => Promise.resolve(null);
  sendPointerEvent = () => Promise.resolve({ accepted: false });
  sendWheelEvent = () => Promise.resolve({ accepted: false });
  sendKeyboardEvent = () => Promise.resolve({ accepted: false });
  insertText = () => Promise.resolve({ accepted: false });
  extract = () => Promise.resolve({
    ok: false,
    code: 'EXTRACTION_UNAVAILABLE',
    message: 'No browser provider is connected, so the page cannot be read.'
  });
  onFrame = () => noop;
  onMetadata = () => noop;
  onEvent = () => noop;
}
