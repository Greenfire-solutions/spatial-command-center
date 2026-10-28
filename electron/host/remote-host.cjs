'use strict';

/*
 * The desktop companion half of the remote provider.
 *
 * An Electron process that owns real offscreen Chromium sources and serves
 * them to a headset over a single WebSocket: JPEG frames down, validated
 * control messages up. It is the host that docs/FRAME_TRANSPORT.md and
 * RemoteChromiumProvider were written against, reached over a socket rather
 * than a WebRTC DataChannel.
 *
 * It is deliberately a separate entry point from electron/main.cjs. The
 * desktop app and the headset each get their own BrowserSourceManager, so
 * running one does not disturb the other, and the host can run with no visible
 * window at all.
 *
 * Security posture — this is the point where the strong local posture would be
 * easiest to lose, because the browser is now reachable over a socket:
 *
 *   - Binds to 127.0.0.1 by default. The intended route is `adb reverse`,
 *     which makes the headset reach the machine as localhost and therefore
 *     exposes nothing to the network. --host is opt-in and prints a warning.
 *   - Requires a shared token, generated per run and printed once. A
 *     connection without it is closed before any message is read.
 *   - Accepts one client at a time. A second connection is refused rather than
 *     silently sharing control of the same browsers.
 *   - Every inbound message goes through protocol validateRequest() — an
 *     allowlist of actions, id patterns, version and size — and then through
 *     BrowserSourceManager, which validates URLs and input exactly as it does
 *     for the local IPC path. Nothing here trusts the peer.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { WebSocketServer } = require('ws');

const { BrowserSourceManager } = require('../browser-source-manager.cjs');
const { JpegFrameTransport } = require('./jpeg-frame-transport.cjs');
const { ContentExtractor } = require('../extraction/content-extractor.cjs');

/* The protocol is authored as an ES module for the renderer. Read it through a
 * dynamic import so there is exactly one definition of the wire format rather
 * than a CommonJS copy that can drift out of step. */
const loadProtocol = () => import(
  require('node:url').pathToFileURL(
    path.resolve(__dirname, '../../src/providers/remote/protocol.js')
  ).href
);

/*
 * The certificate serve-xr.mjs already generates for the LAN address.
 *
 * Shared deliberately rather than minted separately: a headset that has
 * accepted one self-signed certificate should not be asked to accept a second
 * for the same machine.
 */
const certificateFor = (host) => {
  const directory = path.resolve(__dirname, '../../.cache/xr-certs');
  const key = path.join(directory, `${host}.key`);
  const cert = path.join(directory, `${host}.crt`);
  if (!fs.existsSync(key) || !fs.existsSync(cert)) return null;
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
};

const parseArgs = (argv) => {
  /*
   * 15 fps was chosen when the question was whether frames arrive at all. It
   * answers that, and it is visibly wrong for scrolling: a page dragged under
   * the pointer moves in steps rather than sliding, which reads as the whole
   * workspace being slow. 30 is the smallest number that stops looking broken,
   * and the attention scheduler already lowers it again for windows that are
   * not being looked at, so the cost is paid only where it is noticed.
   * Tune with --max-fps and --quality if the network or the machine objects.
   */
  const args = { port: 8787, host: '127.0.0.1', quality: 72, maxFps: 30, tls: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];
    if (arg === '--port') { args.port = Number(next()) || args.port; index += 1; }
    else if (arg === '--host') { args.host = next() || '0.0.0.0'; index += 1; }
    else if (arg === '--quality') { args.quality = Number(next()) || args.quality; index += 1; }
    else if (arg === '--max-fps') { args.maxFps = Number(next()) || args.maxFps; index += 1; }
    else if (arg === '--https' || arg === '--tls') { args.tls = true; }
  }
  return args;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const protocol = await loadProtocol();
  const token = process.env.SPATIAL_HOST_TOKEN || crypto.randomBytes(16).toString('hex');

  let client = null;

  const sendRaw = (data) => {
    if (!client || client.readyState !== client.OPEN) return;
    client.send(data);
  };

  const transport = new JpegFrameTransport({
    send: sendRaw,
    quality: options.quality,
    maxFps: options.maxFps
  });

  const manager = new BrowserSourceManager({ BrowserWindow, frameTransport: transport });
  const extractor = new ContentExtractor({ manager });

  const notify = (type, sourceId, data) => {
    if (!client || client.readyState !== client.OPEN) return;
    client.send(protocol.encode(protocol.createNotification(type, sourceId, data)));
  };

  manager.on('metadata', (metadata) => notify('metadata', metadata?.id ?? null, metadata));
  manager.on('event', (payload) => notify('event', payload?.sourceId ?? null, payload));

  /*
   * Action dispatch.
   *
   * Mirrors electron/ipc.cjs one-for-one on purpose. The manager performs the
   * real validation in both paths, so the remote surface cannot accept
   * anything the local one would reject.
   */
  const dispatch = async (request) => {
    const { action, sourceId, payload } = request;
    switch (action) {
      case 'createSource':  return manager.createSource(payload);
      case 'destroySource': return manager.destroySource(sourceId);
      case 'getSource':     return manager.getSource(sourceId);
      case 'listSources':   return manager.listSources();
      case 'navigate':      return manager.navigate(sourceId, payload.url);
      case 'back':          return manager.back(sourceId);
      case 'forward':       return manager.forward(sourceId);
      case 'reload':        return manager.reload(sourceId);
      case 'stop':          return manager.stop(sourceId);
      case 'resize':        return manager.resize(sourceId, payload.width, payload.height, payload.deviceScaleFactor);
      case 'setQuality': {
        const result = manager.setQuality(sourceId, payload);
        /* Route the attention tier into the encoder as well as into Chromium.
         * browser-quality.js already decided this number; spending encode time
         * on a screen nobody is looking at would ignore it. */
        transport.setSourceFrameRate(sourceId, payload.frameRate);
        return result;
      }
      case 'focus':             return manager.focus(sourceId);
      case 'blur':              return manager.blur(sourceId);
      case 'sendPointerEvent':  return manager.sendPointerEvent(sourceId, payload);
      case 'sendWheelEvent':    return manager.sendWheelEvent(sourceId, payload);
      case 'sendKeyboardEvent': return manager.sendKeyboardEvent(sourceId, payload);
      case 'insertText':        return manager.insertText(sourceId, payload.text);
      /* Enforced host-side, exactly as the local IPC path does. A headset is
       * further from the browser than a renderer is, not closer. */
      case 'extract':           return extractor.extract(sourceId, {
        capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : []
      });
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  };

  /* Reject before the upgrade completes, so an unauthenticated peer never
   * reaches the message loop. */
  const verifyClient = ({ req }, done) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('token') !== token) return done(false, 401, 'Unauthorized');
    return done(true);
  };

  /*
   * WebXR is only exposed in a secure context, so a headset reached over the
   * LAN loads the page over https — and an https page may not open a ws://
   * socket. Without TLS here the workspace would render and every browser
   * surface would silently fail to connect, which is exactly the failure that
   * looks like the app being broken rather than the transport being blocked.
   *
   * Not needed on the adb path, where the headset reaches the machine as
   * localhost over plain http.
   */
  let server;
  if (options.tls) {
    const credentials = certificateFor(options.host);
    if (!credentials) {
      console.error(
        `\n  No certificate for ${options.host}.\n`
        + '  Run `npm run xr:serve:https` once to generate one, then retry.\n'
      );
      app.exit(1);
      return;
    }
    /*
     * A plain GET to this port is not a mistake to ignore: it is how a headset
     * is told to trust the self-signed certificate, because a WebSocket
     * certificate prompt has no interface. Without a request handler the
     * upgrade-only server leaves such a request hanging, so the one step that
     * decides whether browser surfaces will work at all looks like a failure.
     * Answer it, so accepting the certificate visibly succeeds.
     */
    const httpsServer = https.createServer(credentials, (request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(
        '<!doctype html><meta charset="utf-8">'
        + '<title>Certificate accepted</title>'
        + '<body style="background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui;padding:2rem">'
        + '<h1 style="font-size:1.25rem">Certificate accepted</h1>'
        + '<p>This port carries the browser stream, not a page. '
        + 'Now open the workspace and enter VR.</p></body>'
      );
    });
    httpsServer.listen(options.port, options.host);
    server = new WebSocketServer({ server: httpsServer, verifyClient });
    /* WebSocketServer only emits 'listening' when it owns the server. */
    httpsServer.on('listening', () => server.emit('listening'));
  } else {
    server = new WebSocketServer({ host: options.host, port: options.port, verifyClient });
  }

  server.on('connection', (socket) => {
    if (client && client.readyState === client.OPEN) {
      socket.close(4409, 'A client is already connected.');
      return;
    }
    client = socket;
    console.log('[host] headset connected');

    socket.on('message', async (raw, isBinary) => {
      if (isBinary) return; // Frames only travel outward.
      const message = protocol.decode(raw);
      const check = protocol.validateRequest(message);
      if (!check.ok) {
        socket.send(protocol.encode(protocol.createErrorResponse(message, check.code, check.message)));
        return;
      }
      try {
        const result = await dispatch(check.request);
        socket.send(protocol.encode(protocol.createResponse(check.request, result ?? null)));
      } catch (error) {
        socket.send(protocol.encode(
          protocol.createErrorResponse(check.request, error.code || 'REMOTE_BROWSER_ERROR', error.message)
        ));
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      console.log('[host] headset disconnected');
    });
    socket.on('error', (error) => console.warn(`[host] socket error: ${error.message}`));
  });

  server.on('listening', () => {
    const scheme = options.tls ? 'wss' : 'ws';
    const where = options.host === '127.0.0.1'
      ? `${scheme}://localhost:${options.port}`
      : `${scheme}://${options.host}:${options.port}`;
    console.log('');
    console.log('  Spatial Command Center: remote browser host');
    console.log(`  ${where}/?token=${token}`);
    console.log(`  jpeg quality ${options.quality}, up to ${options.maxFps} fps per source`);
    if (options.host !== '127.0.0.1') {
      console.log('');
      console.log('  ! Bound beyond loopback. Anyone who reaches this port and token');
      console.log('    controls a real browser. Prefer `adb reverse` over --host.');
    }
    console.log('');
  });

  const shutdown = () => {
    transport.close();
    manager.close();
    server.close();
    app.quit();
  };
  app.on('before-quit', () => { transport.close(); manager.close(); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

/* Offscreen sources are hidden BrowserWindows. Destroying the last one must
 * not take the host down with it. */
app.on('window-all-closed', () => {});

app.whenReady().then(main).catch((error) => {
  console.error(`Could not start the remote host: ${error.stack || error.message}`);
  app.exit(1);
});
