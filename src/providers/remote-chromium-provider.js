import { BrowserSourceProvider } from './browser-provider.js';
import { FRAME_FORMATS } from './frame-formats.js';
import {
  createRequest,
  decode,
  encode,
  validateInbound
} from './remote/protocol.js';

/*
 * A browser provider backed by Chromium on another machine.
 *
 * This is the provider a headset uses. Electron cannot run on a Quest, so the
 * browser lives on a desktop companion and reaches the headset over WebRTC. It
 * satisfies exactly the same BrowserSourceProvider contract as
 * ElectronChromiumProvider, which is what makes the spatial scene, the
 * interaction system, and the store indifferent to where the browser is.
 *
 * Transport split:
 *
 *   video down    One media track per browser source, hardware encoded and
 *                 hardware decoded. Raw frames are never sent: a single
 *                 1280x800 surface is 4MB per frame, ~123 MB/s at 30fps.
 *                 Frames surface as VIDEO_ELEMENT descriptors, so the scene
 *                 binds a VideoTexture instead of uploading pixels.
 *
 *   control up    Small validated JSON over a DataChannel. Input arrives here
 *                 already in normalized browser coordinates, because the
 *                 ray/UV mapping is shared with the local path — so the
 *                 interaction model does not change when the browser moves
 *                 off-machine.
 *
 * The peer connection and signaling channel are injected rather than
 * constructed here, so the whole provider is testable without a network and so
 * a different signaling transport can be substituted.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const CONTROL_CHANNEL_LABEL = 'browser-control';

const notConnected = (what) => new Error(
  `RemoteChromiumProvider is not connected, so ${what} is unavailable.`
);

export class RemoteChromiumProvider extends BrowserSourceProvider {
  /*
   * @param signaling  an object with connect(), send(message), onMessage(cb),
   *                   close(); responsible for exchanging SDP and ICE.
   * @param createPeerConnection  factory returning an RTCPeerConnection.
   * @param requestTimeoutMs  how long a control request may go unanswered.
   */
  constructor({
    signaling,
    createPeerConnection,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onError
  } = {}) {
    super();
    this.signaling = signaling || null;
    this.createPeerConnection = createPeerConnection ||
      (typeof RTCPeerConnection === 'function' ? (config) => new RTCPeerConnection(config) : null);
    this.requestTimeoutMs = requestTimeoutMs;
    this.onError = onError || null;

    this.peerConnection = null;
    this.controlChannel = null;
    this.pendingRequests = new Map();

    /* sourceId -> { element, track, stream } */
    this.mediaBySource = new Map();
    this.frameListeners = new Set();
    this.metadataListeners = new Set();
    this.eventListeners = new Set();
    this.connected = false;
  }

  get id() { return 'remote-chromium'; }

  get available() {
    return Boolean(this.connected && this.controlChannel && this.controlChannel.readyState === 'open');
  }

  /* Frames are decoded video, not pixels. */
  get frameFormat() { return FRAME_FORMATS.VIDEO_ELEMENT; }

  // ---------------------------------------------------------------- lifecycle

  async connect(configuration = {}) {
    if (!this.signaling) throw new Error('RemoteChromiumProvider requires a signaling channel.');
    if (!this.createPeerConnection) throw new Error('No RTCPeerConnection implementation is available.');
    if (this.peerConnection) return this;

    const peer = this.createPeerConnection({
      iceServers: configuration.iceServers || [],
      bundlePolicy: 'max-bundle'
    });
    this.peerConnection = peer;

    // One control channel, created by the client so the host can simply accept.
    const channel = peer.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true });
    this.attachControlChannel(channel);

    peer.ontrack = (event) => this.handleTrack(event);
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.connected = false;
        this.rejectAllPending(new Error(`The remote browser host connection is ${state}.`));
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) this.signaling.send({ kind: 'ice', candidate: event.candidate });
    };

    this.signaling.onMessage((message) => this.handleSignalingMessage(message).catch((error) => this.report(error)));
    await this.signaling.connect();

    const offer = await peer.createOffer({ offerToReceiveVideo: true });
    await peer.setLocalDescription(offer);
    this.signaling.send({ kind: 'offer', sdp: peer.localDescription });

    return this;
  }

  async handleSignalingMessage(message) {
    if (!message || !this.peerConnection) return;
    if (message.kind === 'answer' && message.sdp) {
      await this.peerConnection.setRemoteDescription(message.sdp);
      this.connected = true;
      return;
    }
    if (message.kind === 'ice' && message.candidate) {
      await this.peerConnection.addIceCandidate(message.candidate).catch(() => {
        // A candidate that arrives before the remote description, or for a
        // transport already established, is normal and not worth surfacing.
      });
    }
  }

  attachControlChannel(channel) {
    this.controlChannel = channel;
    channel.onmessage = (event) => this.handleControlMessage(event.data);
    channel.onclose = () => {
      this.connected = false;
      this.rejectAllPending(new Error('The remote browser control channel closed.'));
    };
  }

  async disconnect() {
    this.rejectAllPending(new Error('The remote browser connection was closed.'));
    for (const media of this.mediaBySource.values()) this.releaseMedia(media);
    this.mediaBySource.clear();
    this.controlChannel?.close?.();
    this.peerConnection?.close?.();
    this.signaling?.close?.();
    this.controlChannel = null;
    this.peerConnection = null;
    this.connected = false;
  }

  // ------------------------------------------------------------------ control

  request(action, sourceId, payload) {
    if (!this.available) return Promise.reject(notConnected(action));
    const message = createRequest(action, sourceId, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error(`The remote browser host did not answer ${action} in time.`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(message.requestId, { resolve, reject, timer, action });
      try {
        this.controlChannel.send(encode(message));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(message.requestId);
        reject(error);
      }
    });
  }

  handleControlMessage(raw) {
    const decoded = decode(raw);
    const validation = validateInbound(decoded);
    if (!validation.ok) return;
    const message = validation.message;

    if (message.kind === 'response') {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error?.message || 'The remote browser rejected the request.');
        error.code = message.error?.code;
        pending.reject(error);
      }
      return;
    }

    if (message.type === 'metadata') {
      this.dispatch(this.metadataListeners, message.sourceId, message.data);
      return;
    }
    if (message.type === 'event') {
      this.dispatch(this.eventListeners, message.sourceId, { ...message.data, sourceId: message.sourceId });
    }
  }

  rejectAllPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  report(error) {
    if (this.onError) this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  // -------------------------------------------------------------------- media

  /*
   * Bind an inbound track to a source.
   *
   * The host names each track's stream after the source it carries, which is
   * how one peer connection can serve many browser surfaces without a second
   * negotiation per screen.
   */
  handleTrack(event) {
    const stream = event.streams && event.streams[0];
    const sourceId = stream?.id;
    if (!sourceId) return;

    const element = this.createVideoElement(stream);
    const media = { element, track: event.track, stream };
    const previous = this.mediaBySource.get(sourceId);
    if (previous) this.releaseMedia(previous);
    this.mediaBySource.set(sourceId, media);

    const publish = () => {
      this.dispatch(this.frameListeners, sourceId, {
        sourceId,
        format: FRAME_FORMATS.VIDEO_ELEMENT,
        width: element.videoWidth || 0,
        height: element.videoHeight || 0,
        logicalWidth: element.videoWidth || 0,
        logicalHeight: element.videoHeight || 0,
        deviceScaleFactor: 1,
        frame: element,
        capturedAt: Date.now()
      });
    };

    /* A VideoTexture only needs the element once; it samples the live frame on
     * every render, so this publishes per track rather than per frame.
     *
     * Publish immediately so the surface binds even before metadata arrives —
     * a track whose loadedmetadata never fires would otherwise leave the
     * screen permanently blank — then publish again with the real dimensions. */
    publish();
    element.addEventListener('loadedmetadata', publish, { once: true });

    event.track.addEventListener('ended', () => {
      const current = this.mediaBySource.get(sourceId);
      if (current === media) {
        this.releaseMedia(media);
        this.mediaBySource.delete(sourceId);
      }
    });
  }

  createVideoElement(stream) {
    if (typeof document === 'undefined') {
      // Test environments have no DOM; a plain object is enough for the
      // descriptor plumbing to be exercised.
      return { videoWidth: 0, videoHeight: 0, addEventListener() {}, removeEventListener() {}, srcObject: stream };
    }
    const element = document.createElement('video');
    element.srcObject = stream;
    element.autoplay = true;
    element.muted = true;
    element.playsInline = true;
    element.play?.().catch(() => {
      // Autoplay can be refused until a gesture; the texture binds either way
      // and starts updating as soon as playback begins.
    });
    return element;
  }

  releaseMedia(media) {
    try {
      media.track?.stop?.();
      if (media.element) media.element.srcObject = null;
    } catch {
      // Releasing a track that is already gone is not an error.
    }
  }

  dispatch(listeners, sourceId, payload) {
    for (const listener of [...listeners]) {
      if (!listener.sourceId || listener.sourceId === sourceId) listener.callback(payload);
    }
  }

  subscribe(set, sourceId, callback) {
    const entry = { sourceId: sourceId || null, callback };
    set.add(entry);
    return () => set.delete(entry);
  }

  // ----------------------------------------------------------------- contract

  createSource = (options) => this.request('createSource', options?.id ?? null, options || {});
  destroySource = (sourceId) => this.request('destroySource', sourceId);
  getSource = (sourceId) => this.request('getSource', sourceId);
  listSources = () => this.request('listSources', null);

  navigate = (sourceId, url) => this.request('navigate', sourceId, { url });
  back = (sourceId) => this.request('back', sourceId);
  forward = (sourceId) => this.request('forward', sourceId);
  reload = (sourceId) => this.request('reload', sourceId);
  stop = (sourceId) => this.request('stop', sourceId);

  resize = (sourceId, width, height, deviceScaleFactor) => (
    this.request('resize', sourceId, { width, height, deviceScaleFactor })
  );

  /* Maps onto encoder bitrate and track enable/disable on the host rather than
   * onto Chromium's paint rate, which is why the contract calls it a hint. */
  setQuality = (sourceId, options) => this.request('setQuality', sourceId, options || {});

  focus = (sourceId) => this.request('focus', sourceId);
  blur = (sourceId) => this.request('blur', sourceId);

  sendPointerEvent = (sourceId, input) => this.request('sendPointerEvent', sourceId, input || {});
  sendWheelEvent = (sourceId, input) => this.request('sendWheelEvent', sourceId, input || {});
  sendKeyboardEvent = (sourceId, input) => this.request('sendKeyboardEvent', sourceId, input || {});
  insertText = (sourceId, text) => this.request('insertText', sourceId, { text });

  onFrame = (sourceId, callback) => this.subscribe(this.frameListeners, sourceId, callback);
  onMetadata = (sourceId, callback) => this.subscribe(this.metadataListeners, sourceId, callback);
  onEvent = (sourceId, callback) => this.subscribe(this.eventListeners, sourceId, callback);
}

/*
 * The security bar a remote host must clear. Recorded here because the local
 * provider's posture is strong and moving the browser off-machine must not
 * quietly weaken it.
 */
export const REMOTE_PROVIDER_REQUIREMENTS = Object.freeze([
  'Authenticated signaling: no unauthenticated peer may create or drive a browser source.',
  'Per-session credentials, not a shared long-lived secret.',
  'Encrypted media and data channels, and a signaling path that matches.',
  'Every request validated on the host exactly as electron/validation.cjs validates it locally.',
  'URLs re-validated host-side; the client is never the only check.',
  'Control messages bounded in size so the channel cannot be used as a data pipe.',
  'No unauthenticated pixel bridge, CDP port, or proxy exposed on the network.',
  'A user-visible indication on the host that a browser surface is being streamed.'
]);

export { PROTOCOL_CHANNEL, PROTOCOL_VERSION } from './remote/protocol.js';
