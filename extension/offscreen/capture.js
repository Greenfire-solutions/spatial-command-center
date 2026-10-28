/*
 * Capture and transport, in the one context that can hold both.
 *
 * A Manifest V3 service worker cannot keep a MediaStream and is evicted when
 * idle, so a worker-owned capture dies quietly a few seconds after it starts.
 * An offscreen document persists, which makes it the right place for the
 * stream, the encoder, and the socket to the relay.
 *
 * Tab APIs are not reachable from here, so anything requiring chrome.tabs or
 * chrome.debugger is asked of the service worker over runtime messaging. The
 * split is: this file moves pixels, the worker moves control.
 */

const FRAME_QUALITY = 0.72;
const DEFAULT_FPS = 12;

const sources = new Map();
let socket = null;
let frameSequence = 0;

/* [uint32 LE header length][header JSON][JPEG] — the same framing the Electron
 * host writes, so the workspace decodes both without knowing which produced it. */
const encodeFrame = (header, jpegBytes) => {
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const message = new Uint8Array(4 + headerJson.byteLength + jpegBytes.byteLength);
  new DataView(message.buffer).setUint32(0, headerJson.byteLength, true);
  message.set(headerJson, 4);
  message.set(jpegBytes, 4 + headerJson.byteLength);
  return message.buffer;
};

const send = (payload) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(typeof payload === 'string' ? payload : payload);
};

const ask = (type, detail) => chrome.runtime.sendMessage({ scope: 'scc-bridge', type, detail });

const stopSource = (sourceId) => {
  const entry = sources.get(sourceId);
  if (!entry) return;
  clearInterval(entry.timer);
  entry.stream.getTracks().forEach((track) => track.stop());
  entry.video.srcObject = null;
  sources.delete(sourceId);
};

/*
 * Start capturing a tab.
 *
 * The stream id is minted by the service worker, because getMediaStreamId must
 * be called from an extension context that can see the tab. Here we only
 * consume it.
 */
const startSource = async ({ sourceId, streamId, width, height, frameRate }) => {
  stopSource(sourceId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: frameRate || DEFAULT_FPS
      }
    }
  });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });

  const grab = async () => {
    const entry = sources.get(sourceId);
    if (!entry || video.readyState < 2) return;
    /* Encoding is the expensive step, so a frame is skipped rather than queued
     * when the previous one is still being encoded. A backlog would show up as
     * latency that never recovers. */
    if (entry.encoding) return;
    entry.encoding = true;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_QUALITY });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      frameSequence += 1;
      send(encodeFrame({
        sourceId,
        frameId: frameSequence,
        width: canvas.width,
        height: canvas.height,
        logicalWidth: canvas.width,
        logicalHeight: canvas.height,
        deviceScaleFactor: 1,
        capturedAt: Date.now()
      }, bytes));
    } catch {
      /* A dropped frame is superseded by the next one. */
    } finally {
      entry.encoding = false;
    }
  };

  const timer = setInterval(grab, Math.round(1000 / (frameRate || DEFAULT_FPS)));
  sources.set(sourceId, { stream, video, canvas, context, timer, encoding: false });
};

const connect = (url) => {
  socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => ask('relay-state', { connected: true }));
  socket.addEventListener('close', () => {
    ask('relay-state', { connected: false });
    for (const sourceId of [...sources.keys()]) stopSource(sourceId);
    /* The relay is a developer process and will be restarted often. */
    setTimeout(() => connect(url), 2000);
  });
  socket.addEventListener('error', () => socket.close());

  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    /* Control is the worker's job. It answers, and we forward the answer. */
    const reply = await ask('protocol', message);
    if (reply && reply.forward) send(JSON.stringify(reply.forward));
    if (reply && reply.startCapture) await startSource(reply.startCapture).catch(() => {});
    if (reply && reply.stopCapture) stopSource(reply.stopCapture);
  });
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.scope !== 'scc-offscreen') return undefined;
  if (message.type === 'connect') {
    connect(message.detail.url);
    sendResponse({ ok: true });
  }
  if (message.type === 'push') {
    send(JSON.stringify(message.detail));
    sendResponse({ ok: true });
  }
  return true;
});
