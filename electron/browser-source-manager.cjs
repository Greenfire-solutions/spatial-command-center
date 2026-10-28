'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  PERSISTENT_PARTITION
} = require('./constants.cjs');
const { BrowserSourceError } = require('./errors.cjs');
const {
  normalizeCreateOptions,
  normalizeFrameRate,
  normalizeDeviceScaleFactor,
  normalizeKeyboardEvent,
  normalizeNavigationUrl,
  normalizePointerEvent,
  normalizeText,
  normalizeViewport,
  normalizeWheelEvent,
  requireSourceId
} = require('./validation.cjs');

const cleanRect = (rect, fallbackWidth, fallbackHeight) => ({
  x: Number.isFinite(rect?.x) ? rect.x : 0,
  y: Number.isFinite(rect?.y) ? rect.y : 0,
  width: Number.isFinite(rect?.width) ? rect.width : fallbackWidth,
  height: Number.isFinite(rect?.height) ? rect.height : fallbackHeight
});

class BrowserSourceManager extends EventEmitter {
  constructor({
    BrowserWindow,
    frameTransport,
    partition = PERSISTENT_PARTITION,
    logger = console,
    now = () => new Date()
  } = {}) {
    super();
    if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow constructor is required.');
    if (!frameTransport || typeof frameTransport.publish !== 'function') {
      throw new TypeError('A BrowserFrameTransport is required.');
    }
    this.BrowserWindow = BrowserWindow;
    this.frameTransport = frameTransport;
    this.partition = partition;
    this.logger = logger;
    this.now = now;
    this.sources = new Map();
    this.focusedSourceId = null;
    this.pointerState = new Map();
    this.closed = false;
  }

  createSource(input = {}) {
    if (this.closed) throw new BrowserSourceError('MANAGER_CLOSED', 'Browser source manager is closed.');
    const options = normalizeCreateOptions(input);
    const id = options.id || `browser-${crypto.randomUUID()}`;
    const existing = this.sources.get(id);
    if (existing) return this.snapshot(existing);

    const browserWindow = new this.BrowserWindow({
      width: options.width,
      height: options.height,
      x: -4096,
      y: -4096,
      // Offscreen sources are texture producers only. Electron paints a
      // BrowserWindow created with show:false by default
      // (paintWhenInitiallyHidden defaults to true), so exposing this native
      // window is unnecessary and covers the spatial workspace on macOS.
      show: false,
      useContentSize: true,
      frame: false,
      transparent: false,
      backgroundColor: '#ffffff',
      skipTaskbar: true,
      webPreferences: {
        partition: this.partition,
        offscreen: {
          useSharedTexture: false,
          deviceScaleFactor: options.deviceScaleFactor
        },
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        plugins: false,
        spellcheck: true,
        backgroundThrottling: false
      }
    });

    const record = {
      id,
      window: browserWindow,
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor,
      frameRate: options.frameRate,
      url: options.url,
      title: 'Loading…',
      favicon: '',
      loading: true,
      crashed: false,
      state: 'loading',
      createdAt: this.now().toISOString(),
      painting: true,
      destroying: false
    };
    this.sources.set(id, record);
    this.bindSource(record);

    browserWindow.webContents.setFrameRate(options.frameRate);
    browserWindow.webContents.setAudioMuted(false);
    browserWindow.webContents.loadURL(options.url).catch((error) => {
      if (!this.sources.has(id)) return;
      record.loading = false;
      record.state = 'error';
      this.emitSourceEvent('load-error', record, { error: error.message, url: options.url });
      this.emitMetadata(record);
    });

    this.emitSourceEvent('source-created', record);
    this.emitMetadata(record);
    return this.snapshot(record);
  }

  bindSource(record) {
    const { id, window: browserWindow } = record;
    const contents = browserWindow.webContents;

    contents.setWindowOpenHandler((details) => {
      let routedUrl = '';
      try {
        routedUrl = normalizeNavigationUrl(details.url);
      } catch {
        // Unsupported popup schemes remain blocked.
      }
      this.emitSourceEvent(routedUrl ? 'popup-routed' : 'popup-blocked', record, {
        url: details.url,
        disposition: details.disposition
      });
      // A detached popup cannot be represented by this screen's texture/input
      // surface. Route safe HTTP(S) popups into the same browser history so
      // target=_blank links and common sign-in flows remain usable.
      if (routedUrl) queueMicrotask(() => {
        if (this.sources.get(id) === record) this.navigate(id, routedUrl);
      });
      return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('paint', (_event, dirtyRect, image) => {
      if (!this.sources.has(id) || image.isEmpty()) return;
      const imageSize = image.getSize(1);
      this.frameTransport.publish({
        sourceId: id,
        image,
        width: imageSize.width || record.width,
        height: imageSize.height || record.height,
        logicalWidth: record.width,
        logicalHeight: record.height,
        deviceScaleFactor: record.deviceScaleFactor,
        dirtyRect: cleanRect(dirtyRect, record.width, record.height)
      });
    });

    contents.on('did-start-loading', () => {
      record.loading = true;
      record.state = 'loading';
      this.syncMetadata(record);
    });
    contents.on('did-stop-loading', () => {
      record.loading = false;
      record.state = 'ready';
      this.syncMetadata(record);
    });
    contents.on('did-navigate', () => this.syncMetadata(record));
    contents.on('did-navigate-in-page', () => this.syncMetadata(record));
    contents.on('page-title-updated', (_event, title) => {
      record.title = String(title || '');
      this.emitMetadata(record);
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      record.favicon = Array.isArray(favicons) && favicons.length ? String(favicons[0]) : '';
      this.emitMetadata(record);
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // ERR_ABORTED during a newer navigation.
      record.loading = false;
      record.state = 'error';
      this.emitSourceEvent('load-error', record, {
        errorCode,
        error: errorDescription,
        url: validatedURL
      });
      this.emitMetadata(record);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (record.destroying || details.reason === 'clean-exit') return;
      record.crashed = true;
      record.loading = false;
      record.state = 'crashed';
      this.emitMetadata(record);
      this.emitSourceEvent('source-crashed', record, {
        reason: details.reason,
        exitCode: details.exitCode
      });
      this.removeRecord(record, true, 'crashed');
    });
    contents.on('unresponsive', () => this.emitSourceEvent('source-unresponsive', record));
    contents.on('responsive', () => this.emitSourceEvent('source-responsive', record));
    browserWindow.on('closed', () => {
      if (this.sources.get(id) === record) this.removeRecord(record, false, 'window-closed');
    });
  }

  snapshot(record) {
    const contents = record.window && !record.window.isDestroyed() ? record.window.webContents : null;
    const history = contents && !contents.isDestroyed() ? contents.navigationHistory : null;
    return {
      id: record.id,
      url: record.url,
      title: record.title,
      favicon: record.favicon,
      loading: Boolean(record.loading),
      canGoBack: Boolean(history?.canGoBack()),
      canGoForward: Boolean(history?.canGoForward()),
      width: record.width,
      height: record.height,
      deviceScaleFactor: record.deviceScaleFactor,
      frameRate: record.frameRate,
      painting: record.painting !== false,
      focused: this.focusedSourceId === record.id,
      state: record.state,
      crashed: Boolean(record.crashed),
      createdAt: record.createdAt
    };
  }

  syncMetadata(record) {
    if (!this.sources.has(record.id) || record.window.isDestroyed()) return;
    const contents = record.window.webContents;
    record.url = contents.getURL() || record.url;
    record.title = contents.getTitle() || record.title;
    record.loading = contents.isLoading();
    if (!record.crashed) record.state = record.loading ? 'loading' : 'ready';
    this.emitMetadata(record);
  }

  emitMetadata(record) {
    if (this.sources.get(record.id) !== record) return;
    this.emit('metadata', this.snapshot(record));
  }

  emitSourceEvent(type, record, detail = {}) {
    this.emit('event', {
      type,
      sourceId: record.id,
      ...detail,
      timestamp: Date.now()
    });
  }

  getRecord(sourceId) {
    const id = requireSourceId(sourceId);
    const record = this.sources.get(id);
    if (!record || record.window.isDestroyed()) {
      throw new BrowserSourceError('SOURCE_NOT_FOUND', `No browser source exists with id "${id}".`);
    }
    return record;
  }

  getSource(sourceId) {
    return this.snapshot(this.getRecord(sourceId));
  }

  listSources() {
    return Array.from(this.sources.values(), (record) => this.snapshot(record));
  }

  destroySource(sourceId) {
    const id = requireSourceId(sourceId);
    const record = this.sources.get(id);
    if (!record || record.window.isDestroyed()) return { id, destroyed: false };
    this.removeRecord(record, true, 'destroyed');
    return { id: record.id, destroyed: true };
  }

  removeRecord(record, destroyWindow, reason) {
    if (this.sources.get(record.id) !== record) return;
    record.destroying = true;
    this.sources.delete(record.id);
    if (this.focusedSourceId === record.id) this.focusedSourceId = null;
    this.frameTransport.releaseSource(record.id);
    if (destroyWindow && record.window && !record.window.isDestroyed()) record.window.destroy();
    this.emit('event', {
      type: 'source-destroyed',
      sourceId: record.id,
      reason,
      timestamp: Date.now()
    });
  }

  navigate(sourceId, inputUrl) {
    const record = this.getRecord(sourceId);
    const url = normalizeNavigationUrl(inputUrl);
    record.url = url;
    record.loading = true;
    record.state = 'loading';
    record.window.webContents.loadURL(url).catch((error) => {
      if (!this.sources.has(record.id)) return;
      record.loading = false;
      record.state = 'error';
      this.emitSourceEvent('load-error', record, { url, error: error.message });
      this.emitMetadata(record);
    });
    this.emitMetadata(record);
    return this.snapshot(record);
  }

  back(sourceId) {
    const record = this.getRecord(sourceId);
    const history = record.window.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
    return this.snapshot(record);
  }

  forward(sourceId) {
    const record = this.getRecord(sourceId);
    const history = record.window.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
    return this.snapshot(record);
  }

  reload(sourceId) {
    const record = this.getRecord(sourceId);
    record.window.webContents.reload();
    return this.snapshot(record);
  }

  stop(sourceId) {
    const record = this.getRecord(sourceId);
    record.window.webContents.stop();
    return this.snapshot(record);
  }

  resize(sourceId, width, height, requestedScaleFactor) {
    const record = this.getRecord(sourceId);
    const size = normalizeViewport(width, height);
    if (requestedScaleFactor !== undefined) {
      const scaleFactor = normalizeDeviceScaleFactor(requestedScaleFactor);
      if (scaleFactor !== record.deviceScaleFactor) {
        throw new BrowserSourceError(
          'SCALE_FACTOR_IMMUTABLE',
          'deviceScaleFactor is fixed for the lifetime of this browser source.'
        );
      }
    }
    record.width = size.width;
    record.height = size.height;
    record.window.setContentSize(size.width, size.height, false);
    this.emitMetadata(record);
    return this.snapshot(record);
  }

  /*
   * Adjust how hard a source works.
   *
   * Chromium offers two useful levers for an offscreen view: the paint frame
   * rate, and whether it paints at all. A workspace can hold many browser
   * surfaces, and painting every one of them at full rate wastes CPU on
   * screens the user is not looking at — and, once frames cross a network,
   * bandwidth as well. The renderer decides the policy; this applies it.
   *
   * Pausing is deliberately not destruction: the page keeps running, keeps its
   * scroll position and session, and resumes instantly.
   */
  setQuality(sourceId, options = {}) {
    const record = this.getRecord(sourceId);
    const contents = record.window.webContents;

    if (options.frameRate !== undefined) {
      const frameRate = normalizeFrameRate(options.frameRate);
      if (frameRate !== record.frameRate) {
        record.frameRate = frameRate;
        contents.setFrameRate(frameRate);
      }
    }

    if (options.painting !== undefined) {
      const painting = Boolean(options.painting);
      if (painting !== contents.isPainting()) {
        if (painting) {
          contents.startPainting();
          // Resuming does not itself produce a frame: Chromium only paints
          // when something invalidates. Without this, a screen brought back
          // into view would keep showing the texture it had when it paused,
          // until the page happened to change on its own.
          contents.invalidate();
        } else {
          contents.stopPainting();
        }
      }
      record.painting = painting;
    }

    return this.snapshot(record);
  }

  focus(sourceId) {
    const record = this.getRecord(sourceId);
    if (this.focusedSourceId === record.id) return this.snapshot(record);
    if (this.focusedSourceId && this.focusedSourceId !== record.id) {
      const previous = this.sources.get(this.focusedSourceId);
      if (previous && !previous.window.isDestroyed()) {
        previous.window.blurWebView();
        this.emitMetadata(previous);
      }
    }
    this.focusedSourceId = record.id;
    // Focus only Chromium's offscreen RenderWidget. focusOnWebView() is the
    // BrowserWindow API Electron itself uses for offscreen focus(), and does
    // not move native/operating-system focus away from the spatial window.
    record.window.focusOnWebView();
    this.emitMetadata(record);
    return this.snapshot(record);
  }

  blur(sourceId) {
    const record = this.getRecord(sourceId);
    if (this.focusedSourceId !== record.id) return this.snapshot(record);
    record.window.blurWebView();
    this.focusedSourceId = null;
    this.emitMetadata(record);
    return this.snapshot(record);
  }

  sendPointerEvent(sourceId, input) {
    const record = this.getRecord(sourceId);
    const event = normalizePointerEvent(input, record);
    if (event.type === 'mouseDown') this.focus(record.id);
    this.pointerState.set(sourceId, { x: event.x, y: event.y, type: event.type });
    record.window.webContents.sendInputEvent(event);
    return { accepted: true };
  }

  sendWheelEvent(sourceId, input) {
    const record = this.getRecord(sourceId);
    if (this.focusedSourceId !== record.id) this.focus(record.id);
    const event = normalizeWheelEvent(input, record);
    record.window.webContents.sendInputEvent({ type: 'mouseMove', x: event.x, y: event.y, modifiers: [] });
    this.pointerState.set(sourceId, { x: event.x, y: event.y, type: 'mouseMove' });
    record.window.webContents.sendInputEvent(event);
    return { accepted: true };
  }

  sendKeyboardEvent(sourceId, input) {
    const record = this.getRecord(sourceId);
    if (this.focusedSourceId !== record.id) {
      throw new BrowserSourceError('SOURCE_NOT_FOCUSED', 'Keyboard input is accepted only by the focused browser source.');
    }
    record.window.webContents.sendInputEvent(normalizeKeyboardEvent(input));
    return { accepted: true };
  }

  async insertText(sourceId, input) {
    const record = this.getRecord(sourceId);
    if (this.focusedSourceId !== record.id) {
      throw new BrowserSourceError('SOURCE_NOT_FOCUSED', 'Text input is accepted only by the focused browser source.');
    }
    await record.window.webContents.insertText(normalizeText(input));
    return { accepted: true };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.sources.values()]) this.removeRecord(record, true, 'manager-closed');
    this.frameTransport.close();
    this.removeAllListeners();
  }
}

module.exports = { BrowserSourceManager };
