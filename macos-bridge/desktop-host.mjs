#!/usr/bin/env node
/*
 * macOS desktops as spatial screens.
 *
 * The third implementation of the same wire protocol as
 * electron/host/remote-host.cjs and chrome-bridge/relay.mjs, which is the whole
 * reason this is small: the workspace needs no new provider, no new frame
 * format, and no client change. Pointing ?host= at this is the integration.
 *
 * Multiple desktops
 * -----------------
 * A screen asks for a display by URL — `macos://display/2` — and that ordinal
 * is an avfoundation "Capture screen N", looked up fresh because the ffmpeg
 * device index shifts when a camera is plugged in. Each display gets its own
 * capture process, started when the first screen asks for it and stopped when
 * the last one goes away, so an unused desktop costs nothing.
 *
 * Spaces were the obvious route and do not work: macOS composites only the
 * active Space, so an inactive one captures black. Virtual displays are always
 * composited. macos-bridge/displays.mjs creates them.
 *
 * Still display-only on purpose. Input is a separate and much harder half —
 * CGEvent injection, Accessibility permission, coordinate mapping — and the
 * question this answers first is whether the pixels are worth reading. They
 * are: a quad layer at text-optimized reads every row down to 10px where a
 * textured mesh cannot.
 *
 * Why ffmpeg rather than ScreenCaptureKit: it answered the question today. Now
 * that the answer is yes, a Swift helper on ScreenCaptureKit is the real
 * implementation — better frame pacing, per-window capture, no subprocess, and
 * one process instead of one per display.
 *
 *   node macos-bridge/desktop-host.mjs --width 1600 --fps 12 --quality 4
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { captureDeviceMap, displayOrdinal } from './displays.mjs';

const CHANNEL = 'spatial-command-center.browser-control';
const VERSION = 1;

const parseArgs = (argv) => {
  const args = { port: 8789, host: '127.0.0.1', width: 1600, fps: 12, quality: 4 };
  const flags = { '--port': 'port', '--width': 'width', '--fps': 'fps', '--quality': 'quality' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags[argv[index]];
    if (!key) continue;
    args[key] = Number(argv[index + 1]) || args[key];
    index += 1;
  }
  return args;
};

const options = parseArgs(process.argv.slice(2));
const token = process.env.SPATIAL_DESKTOP_TOKEN || crypto.randomBytes(16).toString('hex');

/* [uint32 LE header length][header JSON][JPEG] — identical to the other two
 * hosts, so the client decodes all three without knowing which produced it. */
const encodeFrame = (header, jpeg) => {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(headerJson.byteLength, 0);
  return Buffer.concat([prefix, headerJson, jpeg]);
};

const respond = (request, result) => JSON.stringify({
  channel: CHANNEL, version: VERSION, kind: 'response',
  requestId: request.requestId, ok: true, result
});

const respondError = (request, code, message) => JSON.stringify({
  channel: CHANNEL, version: VERSION, kind: 'response',
  requestId: request.requestId, ok: false, error: { code, message }
});

const state = {
  client: null,
  /* ordinal -> { ffmpeg, sourceIds, frameId, width, height } */
  displays: new Map(),
  /* sourceId -> ordinal, so destroySource can find its display without a scan. */
  sourceDisplay: new Map(),
  deviceMap: new Map(),
  capture: { child: null, running: [], timer: null }
};

/*
 * Request arguments travel under `payload`, not at the top level.
 *
 * createRequest() builds { channel, version, kind, requestId, action, sourceId,
 * payload }, so `message.sourceId` is top-level but `message.url` does not
 * exist — it is `message.payload.url`. Reading the flat shape returned
 * undefined for every screen, displayOrdinal fell back to 0, and all five
 * desktops mirrored display 0 while the client sat in CONNECTING forever.
 *
 * Both shapes are accepted so a host speaking the flatter dialect still works,
 * and so this cannot silently regress to the fallback again.
 */
const requestUrl = (message) => message?.payload?.url ?? message?.url;

const displayState = (ordinal) => {
  if (!state.displays.has(ordinal)) {
    state.displays.set(ordinal, {
      ffmpeg: null, sourceIds: new Set(), frameId: 0,
      width: options.width, height: 0
    });
  }
  return state.displays.get(ordinal);
};

const snapshot = (sourceId) => {
  const ordinal = state.sourceDisplay.get(sourceId) ?? 0;
  const display = displayState(ordinal);
  return {
    id: sourceId,
    url: `macos://display/${ordinal}`,
    title: ordinal === 0 ? 'Mac desktop' : `Desktop ${ordinal}`,
    favicon: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: display.width,
    height: display.height || Math.round(display.width * 10 / 16),
    deviceScaleFactor: 1,
    frameRate: options.fps,
    focused: false,
    state: 'ready',
    crashed: false
  };
};

const send = (payload, binary = false) => {
  const socket = state.client;
  if (!socket || socket.readyState !== 1) return;
  socket.send(payload, { binary });
};

/*
 * ffmpeg writes one JPEG after another with no framing, so the stream has to be
 * split on the markers themselves: FFD8 starts an image, FFD9 ends it. Scanning
 * for FFD9 alone would cut early on the same bytes inside entropy-coded data,
 * so a frame is only emitted when a start has been seen first and the pair is
 * balanced.
 */
const createJpegSplitter = (onFrame) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let start = buffer.indexOf('ffd8', 0, 'hex');
    while (start !== -1) {
      const end = buffer.indexOf('ffd9', start + 2, 'hex');
      if (end === -1) break;
      onFrame(buffer.subarray(start, end + 2));
      buffer = buffer.subarray(end + 2);
      start = buffer.indexOf('ffd8', 0, 'hex');
    }
    /* Guard against a stream that never produces a valid pair. */
    if (buffer.length > 32 * 1024 * 1024) buffer = Buffer.alloc(0);
  };
};

/*
 * One capture helper for every display.
 *
 * The previous design ran an ffmpeg per display and could not work:
 * bin/scc-capture-test measured each display capturing alone in about 600ms,
 * and *two* concurrently wedging indefinitely. ffmpeg's avfoundation screen
 * input is exclusive, and the second capture takes the first one down rather
 * than failing, so adding a screen silently broke the screen already working.
 *
 * macos-bridge/sck-capture.swift replaces it with ScreenCaptureKit: one
 * process, one capture engine, an independent SCStream per display. Measured at
 * five displays delivering simultaneously, which is the whole point.
 *
 * The helper is started with the exact set of displays currently in use and
 * restarted when that set changes. Restarts are debounced because a workspace
 * loads its screens in a burst, and starting five helpers in five milliseconds
 * only to kill four of them is a good way to reintroduce a race.
 */
const HELPER = new URL('./.bin/sck-capture', import.meta.url).pathname;
const RESTART_DEBOUNCE_MS = 250;

const wantedDisplays = () =>
  [...state.displays.entries()]
    .filter(([, display]) => display.sourceIds.size > 0)
    .map(([ordinal]) => ordinal)
    .sort((a, b) => a - b);

const stopCapture = () => {
  if (!state.capture.child) return;
  state.capture.child.kill('SIGKILL');
  state.capture.child = null;
  state.capture.running = [];
  for (const display of state.displays.values()) display.height = 0;
};

/*
 * Frames arrive as: "SCCF" | uint32 ordinal | uint32 length | jpeg.
 *
 * The magic is checked on every frame and the reader resynchronises by sliding
 * one byte at a time when it does not match, so a partial write can never
 * silently reinterpret JPEG bytes as a header.
 */
const createFrameReader = (onFrame) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 12) return;
      if (buffer.toString('ascii', 0, 4) !== 'SCCF') { buffer = buffer.subarray(1); continue; }
      const ordinal = buffer.readUInt32LE(4);
      const length = buffer.readUInt32LE(8);
      if (buffer.length < 12 + length) return;
      onFrame(ordinal, buffer.subarray(12, 12 + length));
      buffer = buffer.subarray(12 + length);
    }
  };
};

const spawnHelper = (ordinals) => {
  stopCapture();
  if (!ordinals.length) return;

  const child = spawn(HELPER, [
    '--displays', ordinals.join(','),
    '--width', String(options.width),
    '--fps', String(options.fps),
    '--quality', String(options.quality)
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  state.capture.child = child;
  state.capture.running = ordinals;

  const read = createFrameReader((ordinal, jpeg) => {
    const display = state.displays.get(ordinal);
    if (!display || !display.sourceIds.size) return;
    display.frameId += 1;

    /* The first frame of each display goes to disk. A headset holds the only
     * client slot, so this is the only way to inspect what it is being sent
     * without taking the session away from the person wearing it. */
    if (display.frameId === 1) {
      try { writeFileSync(`/tmp/scc-desktop-${ordinal}.jpg`, jpeg); } catch { /* never break the stream */ }
    }
    /* Dimensions come from the SOF0 marker rather than being assumed, so the
     * client is never told a size the pixels do not have. */
    if (!display.height) {
      const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
      if (sof !== -1 && jpeg.length > sof + 9) {
        display.height = jpeg.readUInt16BE(sof + 5);
        display.width = jpeg.readUInt16BE(sof + 7);
      }
    }
    for (const sourceId of display.sourceIds) {
      send(encodeFrame({
        sourceId,
        frameId: display.frameId,
        width: display.width,
        height: display.height,
        logicalWidth: display.width,
        logicalHeight: display.height,
        deviceScaleFactor: 1,
        capturedAt: Date.now()
      }, jpeg), true);
    }
  });

  child.stdout.on('data', read);
  child.stderr.on('data', (data) => {
    const text = String(data).trim();
    if (text) console.log(text.split('\n').map((line) => `  ${line}`).join('\n'));
  });
  child.on('exit', (code) => {
    if (state.capture.child !== child) return;
    state.capture.child = null;
    state.capture.running = [];
    if (code) console.error(`[desktop] capture helper exited (${code}). Screen Recording permission may be missing.`);
  });
};

/*
 * Bring the helper in line with the displays currently in use, if it is not
 * already. Comparing the sorted sets means a screen that comes and goes without
 * changing the set does not restart the capture and blank every other display.
 */
const syncCapture = () => {
  clearTimeout(state.capture.timer);
  state.capture.timer = setTimeout(() => {
    const wanted = wantedDisplays();
    if (wanted.join(',') === state.capture.running.join(',')) return;
    if (!wanted.length) { stopCapture(); return; }
    console.log(`[desktop] capturing display(s) ${wanted.join(', ')}`);
    spawnHelper(wanted);
  }, RESTART_DEBOUNCE_MS);
};

const handle = async (message) => {
  switch (message.action) {
    case 'createSource': {
      const ordinal = displayOrdinal(requestUrl(message));
      state.sourceDisplay.set(message.sourceId, ordinal);
      displayState(ordinal).sourceIds.add(message.sourceId);
      syncCapture();
      return respond(message, snapshot(message.sourceId));
    }
    case 'destroySource': {
      const ordinal = state.sourceDisplay.get(message.sourceId);
      if (ordinal !== undefined) {
        const display = displayState(ordinal);
        display.sourceIds.delete(message.sourceId);
        state.sourceDisplay.delete(message.sourceId);
        /* Stop the camera only when the last screen showing it goes away. */
        syncCapture();
      }
      return respond(message, { id: message.sourceId, destroyed: true });
    }
    case 'getSource':
      return respond(message, snapshot(message.sourceId));
    case 'listSources':
      return respond(message, [...state.sourceDisplay.keys()].map(snapshot));
    /*
     * `navigate` is the one that carries meaning here: pointing a screen at a
     * different macos://display/N moves it to another desktop without tearing
     * the screen down, which is how a workspace swaps what a panel shows.
     */
    case 'navigate': {
      const from = state.sourceDisplay.get(message.sourceId);
      const to = displayOrdinal(requestUrl(message));
      if (from !== to) {
        if (from !== undefined) {
          const previous = displayState(from);
          previous.sourceIds.delete(message.sourceId);
        }
        state.sourceDisplay.set(message.sourceId, to);
        displayState(to).sourceIds.add(message.sourceId);
        syncCapture();
      }
      return respond(message, snapshot(message.sourceId));
    }
    /* Accepted and ignored. A desktop has no history, and input is the separate
     * half this prototype deliberately does not attempt. */
    case 'back': case 'forward': case 'reload': case 'stop':
    case 'resize': case 'focus': case 'blur': case 'setQuality':
      return respond(message, snapshot(message.sourceId));
    case 'sendPointerEvent': case 'sendWheelEvent':
    case 'sendKeyboardEvent': case 'insertText':
      return respondError(message, 'READ_ONLY', 'This desktop surface is display-only for now.');
    default:
      return respondError(message, 'UNSUPPORTED', `${message.action} is not supported.`);
  }
};

const server = new WebSocketServer({ port: options.port, host: options.host });

server.on('connection', (socket, request) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.searchParams.get('token') !== token) {
    socket.close(1008, 'bad token');
    return;
  }
  /*
   * The newest client wins.
   *
   * Refusing the second connection was meant to stop two workspaces fighting
   * over one capture, and in practice the only thing it ever refused was the
   * page that had just replaced a dead one. A headset reload leaves the old
   * socket briefly unclosed, so the new page was rejected and rendered nothing
   * — a coin flip on every reload, reported as "nothing is rendering", with a
   * cause visible only in this log.
   *
   * There is one person in one headset, so the later connection is by
   * definition the live one. The previous socket is closed explicitly rather
   * than left to time out, so its capture is released now.
   */
  if (state.client && state.client !== socket) {
    console.log('[desktop] replacing an existing client with the newer connection');
    try { state.client.close(4410, 'replaced by a newer client'); } catch { /* already gone */ }
    state.client = null;
    state.sourceDisplay.clear();
    state.displays.clear();
    stopCapture();
  }
  state.client = socket;
  console.log('[desktop] workspace connected');

  socket.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.kind !== 'request') return;
    console.log(`[desktop] <- ${message.action} source=${message.sourceId} url=${JSON.stringify(requestUrl(message))}`);
    try {
      send(await handle(message));
    } catch (error) {
      /* An exception here used to reject the async listener and vanish as an
       * unhandled rejection: the client kept waiting on a response that would
       * never come, and reported the source as CONNECTING forever. Failing
       * loudly and answering the request is what turns that into a diagnosis. */
      console.error(`[desktop] !! ${message.action} threw: ${error?.stack || error}`);
      send(respondError(message, 'HOST_ERROR', String(error?.message || error)));
    }
  });

  const drop = () => {
    if (state.client !== socket) return;
    state.client = null;
    stopCapture();
    state.displays.clear();
    state.sourceDisplay.clear();
    console.log('[desktop] workspace disconnected');
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.on('listening', async () => {
  state.deviceMap = await captureDeviceMap();
  const ordinals = [...state.deviceMap.keys()].sort((a, b) => a - b);
  console.log('');
  console.log('  macOS desktop host');
  console.log(`  ${ordinals.length} capturable display(s): ${ordinals.map((n) => `macos://display/${n}`).join(', ')}`);
  console.log(`  ${options.width}px wide, ${options.fps}fps, q${options.quality}, one capture per display in use`);
  console.log('');
  console.log(`  ?host=ws://${options.host}:${options.port}/&token=${token}`);
  console.log('');
  console.log('  Display only. Needs Screen Recording permission for this terminal.');
  console.log('');
});

/*
 * Take the capture helper down with us, on every signal that ends this process.
 *
 * Only SIGINT was handled, and the host is normally stopped with SIGTERM — so a
 * restart orphaned the helper, which kept its SCStreams open. The replacement
 * host then started a second helper against displays the first still held, and
 * ScreenCaptureKit failed every stream with "application connection being
 * interrupted". The visible result was five sources connected and painting
 * nothing, which is indistinguishable from a capture that never started.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopCapture();
    process.exit(0);
  });
}
process.on('exit', stopCapture);
