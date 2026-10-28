import { BrowserSourceProvider } from './browser-provider.js';
import { FRAME_FORMATS, describeBitmapFrame } from './frame-formats.js';

/*
 * The first BrowserSourceProvider implementation: local Electron Chromium.
 *
 * It is a thin adapter over the preload's window.spatialBrowser bridge. Its
 * only real work is translating the bridge's raw IPC frame payload into a
 * frame descriptor, so nothing above this file has to know that frames arrive
 * as premultiplied BGRA bytes over structured clone.
 *
 * The bridge is passed in rather than read from the global, so this provider
 * is testable without Electron and so a second bridge (a remote one) can be
 * adapted the same way.
 */
export class ElectronChromiumProvider extends BrowserSourceProvider {
  constructor(bridge) {
    super();
    if (!bridge) throw new TypeError('ElectronChromiumProvider requires the spatialBrowser bridge.');
    this.bridge = bridge;
  }

  get id() { return 'electron-chromium'; }

  get available() { return Boolean(this.bridge && this.bridge.available !== false); }

  /* Electron's OSR paint path yields premultiplied BGRA on every desktop
   * target we support. The GPU shader un-swizzles and un-premultiplies. */
  get frameFormat() { return FRAME_FORMATS.BGRA8_BITMAP; }

  runtimeInfo = () => this.bridge.runtimeInfo();

  createSource = (options) => this.bridge.createSource(options);
  destroySource = (sourceId) => this.bridge.destroySource(sourceId);
  getSource = (sourceId) => this.bridge.getSource(sourceId);
  listSources = () => this.bridge.listSources();

  navigate = (sourceId, url) => this.bridge.navigate(sourceId, url);
  back = (sourceId) => this.bridge.back(sourceId);
  forward = (sourceId) => this.bridge.forward(sourceId);
  reload = (sourceId) => this.bridge.reload(sourceId);
  stop = (sourceId) => this.bridge.stop(sourceId);

  resize = (sourceId, width, height, deviceScaleFactor) => (
    this.bridge.resize(sourceId, width, height, deviceScaleFactor)
  );

  setQuality = (sourceId, options) => this.bridge.setQuality(sourceId, options);

  focus = (sourceId) => this.bridge.focus(sourceId);
  blur = (sourceId) => this.bridge.blur(sourceId);

  sendPointerEvent = (sourceId, event) => this.bridge.sendPointerEvent(sourceId, event);
  sendWheelEvent = (sourceId, event) => this.bridge.sendWheelEvent(sourceId, event);
  sendKeyboardEvent = (sourceId, event) => this.bridge.sendKeyboardEvent(sourceId, event);
  insertText = (sourceId, text) => this.bridge.insertText(sourceId, text);

  /* The capability list travels to the main process, which enforces it. The
   * renderer is not trusted to filter its own permissions. */
  extract = (sourceId, options = {}) => (
    typeof this.bridge.extract === 'function'
      ? this.bridge.extract(sourceId, { capabilities: options.capabilities || [] })
      : Promise.resolve({
          ok: false,
          code: 'EXTRACTION_UNSUPPORTED',
          message: 'This desktop build does not support reading page content.'
        })
  );

  /* Open an address in the user's real browser. Electron denies renderer
   * window creation, so this must go through the main process. */
  openExternal = (url) => this.bridge.openExternal(url);

  requestFrame = (sourceId = null) => {
    if (typeof this.bridge.requestFrame === 'function') this.bridge.requestFrame(sourceId);
  };

  onFrame = (sourceId, listener) => this.bridge.onFrame(sourceId, (rawFrame) => {
    if (!rawFrame) return;
    listener(describeBitmapFrame(rawFrame, this.frameFormat));
  });

  onMetadata = (sourceId, listener) => this.bridge.onMetadata(sourceId, listener);
  onEvent = (sourceId, listener) => this.bridge.onEvent(sourceId, listener);
}
