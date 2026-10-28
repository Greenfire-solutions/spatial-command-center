import { BrowserSourceProvider } from '../browser-provider.js';
import { FRAME_FORMATS } from '../frame-formats.js';
import {
  createRequest,
  createResponse,
  decode,
  encode,
  validateInbound
} from './protocol.js';

/*
 * The headset half of the remote provider, over a WebSocket.
 *
 * RemoteChromiumProvider targets WebRTC: a media track per source and control
 * over a DataChannel. That remains the right destination — hardware decode
 * costs the client almost nothing. This provider takes the shorter road to the
 * same place: the host encodes each paint as JPEG and pushes it down the same
 * socket the control messages travel on.
 *
 * The wire format and the security model are shared with the WebRTC path
 * (./protocol.js), so moving to media tracks later replaces the transport and
 * the surface, not the contract or the host's validation.
 *
 * Frames arrive as one binary message per paint:
 *   [ uint32 LE header length ][ header JSON ][ JPEG bytes ]
 * and are decoded with createImageBitmap(), which runs off the main thread.
 */

const DEFAULT_REQUEST_TIMEOUT = 10_000;

const decodeFrameMessage = (buffer) => {
  if (!buffer || buffer.byteLength < 5) return null;
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  if (!Number.isFinite(headerLength) || headerLength <= 0) return null;
  if (buffer.byteLength < 4 + headerLength) return null;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
  } catch {
    return null;
  }
  return { header, body: new Uint8Array(buffer, 4 + headerLength) };
};

export class WebSocketBrowserProvider extends BrowserSourceProvider {
  constructor({ url, token, socket, requestTimeout = DEFAULT_REQUEST_TIMEOUT } = {}) {
    super();
    this.url = url;
    this.token = token;
    this.requestTimeout = requestTimeout;
    this.pending = new Map();
    this.frameListeners = new Map();
    this.metadataListeners = new Map();
    this.eventListeners = new Map();
    this.connected = false;
    this.closed = false;
    this.lastError = null;

    /* The socket is injectable so the provider is testable against a fake host
     * without a network, the way the WebRTC client already is. */
    this.socket = socket ?? null;
    if (!this.socket && url) this.connect();
  }

  get id() { return 'websocket-chromium'; }
  get available() { return this.connected && !this.closed; }
  get frameFormat() { return FRAME_FORMATS.IMAGE_BITMAP; }

  connect() {
    if (this.socket || this.closed) return;
    /* Constructing the socket throws on a malformed address. Synchronously that
     * reaches the caller; from a reconnect timer it would be an unhandled
     * exception, so it is caught and recorded either way. */
    try {
      const target = new URL(this.url);
      if (this.token) target.searchParams.set('token', this.token);
      const socket = new WebSocket(target.toString());
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.bind();
    } catch (error) {
      this.socket = null;
      this.lastError = `The browser host address is not usable: ${error?.message}`;
    }
  }

  bind() {
    const socket = this.socket;
    if (!socket) return;
    socket.addEventListener('open', () => {

      this.connected = true;
      /*
       * Announce every successful connect, not only reconnects.
       *
       * A screen mounts before the socket opens, and the lifecycle skips
       * createSource entirely when the provider is not yet available — with
       * nothing scheduled to try again. So the very first connection needs this
       * as much as a recovery does: without it a workspace opened from a cold
       * start shows a screen that has never painted and never will, while the
       * socket sits there healthy.
       *
       * Creating a source that already exists is harmless; never creating one
       * is not.
       */
      if (typeof this.onReconnect === 'function') {
        try { this.onReconnect(); } catch { /* never break the socket */ }
      }
      this.lastError = null;
      /* A successful connection resets the backoff, so a long session that
       * drops once does not inherit the longest delay forever. */
      this.retryDelay = 500;
    });
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => {
      this.lastError = 'The connection to the browser host failed.';
    });
    socket.addEventListener('close', (event) => {
      this.connected = false;
      /* Fail everything outstanding rather than leaving callers pending
       * forever — a promise that never settles is a worse failure than a
       * rejection, because nothing upstream can show it. */
      const reason = event?.code === 4409
        ? 'Another client is already connected to the browser host.'
        : 'The browser host connection closed.';
      this.lastError = reason;
      this.failAllPending(reason);
      this.socket = null;

      /*
       * Reconnect, with backoff.
       *
       * Without this a single dropped socket disables every browser source for
       * the life of the page, and the only recovery is a reload. The host is a
       * developer process that gets restarted, a tunnel can drop, and a headset
       * suspends on standby: all three are routine, and none should mean the
       * workspace silently stops working until somebody notices.
       *
       * A refusal is not retried. The host accepts one client, so retrying
       * would mean two workspaces fighting over the same browsers forever, and
       * a refusal needs a person to close the other one rather than time.
       */
      if (this.closed || event?.code === 4409) return;
      this.retryDelay = Math.min((this.retryDelay || 500) * 2, 15000);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, this.retryDelay);
    });
  }

  failAllPending(reason) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  receive(data) {
    if (data instanceof ArrayBuffer) {
      this.receiveFrame(data);
      return;
    }
    const message = decode(data);
    const check = validateInbound(message);
    if (!check.ok) return;

    if (message.kind === 'response') {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'The remote operation failed.'));
      return;
    }

    if (message.type === 'metadata') this.emit(this.metadataListeners, message.sourceId, message.data);
    else if (message.type === 'event') this.emit(this.eventListeners, message.sourceId, message.data);
  }

  async receiveFrame(buffer) {
    const parsed = decodeFrameMessage(buffer);
    if (!parsed) return;
    const { header, body } = parsed;
    if (!this.frameListeners.has(header.sourceId)) return;

    let bitmap;
    try {
      /*
       * Orientation is decided here, and it can only be decided here.
       *
       * `Texture.flipY` is ignored for an ImageBitmap: WebGL2's
       * UNPACK_FLIP_Y_WEBGL has no effect on an ImageBitmap upload, so the
       * usual three.js lever silently does nothing and the flag on the surface
       * reads like a setting when it is a comment. The only place the choice
       * takes effect is decode.
       *
       * Which way is correct is fixed by an invariant the rest of the app
       * already depends on: `uvToBrowserPixels` maps plane UV.y=1 — the visual
       * top — to browser row 0, and the Electron path satisfies that with
       * `flipY = true` on its DataTexture. A JPEG decodes top-row-first, which
       * without this option lands row 0 at UV.y=0, the bottom. That is not
       * merely an upside-down picture: input is mapped through the same UVs, so
       * every click lands mirrored about the horizontal centre line, and the
       * page becomes unusable in a way that looks like a hit-testing bug rather
       * than an orientation one.
       */
      bitmap = await createImageBitmap(
        new Blob([body], { type: 'image/jpeg' }),
        { imageOrientation: 'flipY' }
      );
    } catch {
      return; // A corrupt frame is dropped; the next paint supersedes it.
    }

    /* A frame that arrived while the screen was being torn down has nowhere to
     * go, and an ImageBitmap holds memory until it is closed. */
    if (!this.frameListeners.has(header.sourceId)) {
      bitmap.close?.();
      return;
    }

    this.emit(this.frameListeners, header.sourceId, {
      sourceId: header.sourceId,
      frameId: header.frameId,
      format: FRAME_FORMATS.IMAGE_BITMAP,
      width: header.width,
      height: header.height,
      logicalWidth: header.logicalWidth ?? header.width,
      logicalHeight: header.logicalHeight ?? header.height,
      deviceScaleFactor: header.deviceScaleFactor ?? 1,
      colorSpace: header.colorSpace || 'srgb',
      capturedAt: header.capturedAt ?? 0,
      frame: bitmap
    });
  }

  emit(registry, sourceId, payload) {
    const listeners = registry.get(sourceId);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(payload); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  subscribe(registry, sourceId, listener) {
    if (typeof listener !== 'function' || !sourceId) return () => {};
    if (!registry.has(sourceId)) registry.set(sourceId, new Set());
    registry.get(sourceId).add(listener);
    return () => {
      const listeners = registry.get(sourceId);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) registry.delete(sourceId);
    };
  }

  request(action, sourceId, payload) {
    if (this.closed) return Promise.reject(new Error('The browser host provider is closed.'));
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(this.lastError || 'The browser host is not connected.'));
    }
    const message = createRequest(action, sourceId, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error(`The host did not answer ${action} in time.`));
      }, this.requestTimeout);
      this.pending.set(message.requestId, { resolve, reject, timer });
      try {
        socket.send(encode(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(error);
      }
    });
  }

  /* --- BrowserSourceProvider --- */

  createSource = (options = {}) => this.request('createSource', options.id ?? null, options);
  destroySource = (sourceId) => this.request('destroySource', sourceId);
  getSource = (sourceId) => this.request('getSource', sourceId);
  listSources = () => this.request('listSources', null);
  navigate = (sourceId, url) => this.request('navigate', sourceId, { url });
  back = (sourceId) => this.request('back', sourceId);
  forward = (sourceId) => this.request('forward', sourceId);
  reload = (sourceId) => this.request('reload', sourceId);
  stop = (sourceId) => this.request('stop', sourceId);
  resize = (sourceId, width, height, deviceScaleFactor) =>
    this.request('resize', sourceId, { width, height, deviceScaleFactor });
  setQuality = (sourceId, options = {}) => this.request('setQuality', sourceId, options);
  focus = (sourceId) => this.request('focus', sourceId);
  blur = (sourceId) => this.request('blur', sourceId);
  sendPointerEvent = (sourceId, input) => this.request('sendPointerEvent', sourceId, input);
  sendWheelEvent = (sourceId, input) => this.request('sendWheelEvent', sourceId, input);
  sendKeyboardEvent = (sourceId, input) => this.request('sendKeyboardEvent', sourceId, input);
  insertText = (sourceId, text) => this.request('insertText', sourceId, { text });
  extract = (sourceId, options = {}) => this.request('extract', sourceId, {
    capabilities: options.capabilities || []
  });

  onFrame = (sourceId, listener) => this.subscribe(this.frameListeners, sourceId, listener);
  onMetadata = (sourceId, listener) => this.subscribe(this.metadataListeners, sourceId, listener);
  onEvent = (sourceId, listener) => this.subscribe(this.eventListeners, sourceId, listener);

  close() {
    if (this.closed) return;
    this.closed = true;
    /* Stop the reconnect first, or a pending retry resurrects a provider that
     * was deliberately torn down. */
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failAllPending('The browser host provider was closed.');
    this.frameListeners.clear();
    this.metadataListeners.clear();
    this.eventListeners.clear();
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
    this.connected = false;
  }
}

export { decodeFrameMessage };
export default WebSocketBrowserProvider;
