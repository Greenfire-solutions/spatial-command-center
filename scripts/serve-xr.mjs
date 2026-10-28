#!/usr/bin/env node

/*
 * Serve the built workspace to a headset.
 *
 * WebXR is only exposed in a secure context, so a Quest will not show
 * navigator.xr at all when a page is served over plain http from a LAN
 * address. There are two ways to satisfy that, and this script supports both:
 *
 *   adb reverse   The headset reaches the machine as http://localhost:PORT.
 *                 localhost is a secure context, so no certificate is
 *                 involved and nothing has to be trusted on the device. This
 *                 is the preferred path and the default when adb is present.
 *
 *   https         A self-signed certificate over the LAN address. WebXR works,
 *                 but the certificate has to be accepted once on the headset,
 *                 and Quest Browser makes that mildly tedious.
 *
 * Usage:
 *   npm run xr:serve                serve, using adb reverse when available
 *   npm run xr:serve -- --https     also serve https on the LAN address
 *   npm run xr:serve -- --no-build  skip the build step
 *   npm run xr:serve -- --port 4173
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');
const certDirectory = path.join(projectRoot, '.cache', 'xr-certs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm'
};

const parseArgs = (argv) => {
  const options = { build: true, https: false, port: 4173, adb: true };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const next = () => inline ?? argv[++index];
    if (name === '--no-build') options.build = false;
    else if (name === '--https') options.https = true;
    else if (name === '--no-adb') options.adb = false;
    else if (name === '--port') options.port = Number(next());
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }
  return options;
};

const lanAddress = () => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
};

const findAdb = () => {
  const candidates = [
    'adb',
    path.join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb'),
    path.join(process.env.HOME || '', 'Android/Sdk/platform-tools/adb'),
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb'
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
};

const adbDevices = (adb) => {
  const result = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((device) => device.state === 'device');
};

/*
 * A self-signed certificate for the LAN address, valid for a year.
 *
 * It carries the IP in subjectAltName because browsers ignore the common name,
 * and without a matching SAN the headset will refuse the page outright rather
 * than offering to continue.
 */
const ensureCertificate = (host) => {
  mkdirSync(certDirectory, { recursive: true });
  const keyPath = path.join(certDirectory, `${host}.key`);
  const certPath = path.join(certDirectory, `${host}.crt`);

  if (existsSync(keyPath) && existsSync(certPath)) {
    const age = Date.now() - statSync(certPath).mtimeMs;
    if (age < 300 * 24 * 60 * 60 * 1000) {
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    }
  }

  const configPath = path.join(certDirectory, `${host}.cnf`);
  writeFileSync(configPath, [
    '[req]',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    'prompt = no',
    '[req_distinguished_name]',
    'CN = Spatial Command Center',
    '[v3_req]',
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = IP:${host}, DNS:localhost, IP:127.0.0.1`
  ].join('\n'));

  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '365', '-config', configPath
  ], { stdio: 'ignore' });

  if (result.error || result.status !== 0) {
    throw new Error(
      'Could not generate a certificate with openssl. Use the adb path instead, ' +
      'or install openssl and retry.'
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
};

/*
 * Headset telemetry sink.
 *
 * src/xr/diagnostics.js has always posted here, but nothing ever listened, so
 * every fact a headset reported was dropped — which is why the first real
 * session could only be described as "most of it did not work". A Quest has no
 * console you can read while wearing it, so this endpoint is the only channel
 * that turns a session into evidence. Appended as JSON lines, one per batch.
 */
const diagLogPath = path.join(projectRoot, '.cache', 'xr-diag.log');

/*
 * The browser host this build should talk to, injected into every page.
 *
 * Supplied by `npm run vr`, which starts the host and this server together and
 * therefore knows both halves. Absent when the server is run on its own, in
 * which case pages fall back to their own query string exactly as before —
 * nothing here removes a way of configuring the app, it only adds one that
 * cannot be typed wrong.
 */
const remoteConfig = process.env.SPATIAL_HOST_URL
  ? { url: process.env.SPATIAL_HOST_URL, token: process.env.SPATIAL_HOST_TOKEN || '' }
  : null;

const collectDiagnostics = (request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    // A telemetry sink must not become a memory hole.
    if (body.length > 1_000_000) request.destroy();
  });
  request.on('end', () => {
    try {
      mkdirSync(path.dirname(diagLogPath), { recursive: true });
      const batch = JSON.parse(body);
      for (const entry of batch.entries || []) {
        appendFileSync(diagLogPath, `${JSON.stringify({
          sessionId: batch.sessionId,
          frames: batch.frames,
          ...entry
        })}\n`);
      }
      for (const entry of batch.entries || []) {
        const detail = entry.text || entry.message || (entry.name ? `${entry.name}=${entry.value}` : '');
        console.log(`  [headset] ${entry.kind}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
      }
    } catch {
      /* Malformed telemetry is not worth failing a request over. */
    }
    response.writeHead(204).end();
  });
};

const serveStatic = (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://placeholder');
  let relativePath = decodeURIComponent(requestUrl.pathname);

  if (relativePath === '/__diag') {
    if (request.method === 'POST') return collectDiagnostics(request, response);
    response.writeHead(405).end('POST only');
    return;
  }

  if (relativePath.endsWith('/')) relativePath += 'index.html';

  const resolved = path.normalize(path.join(distDirectory, relativePath));
  // Never serve outside dist, whatever the request contains.
  if (!resolved.startsWith(distDirectory)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  const filePath = existsSync(resolved) && statSync(resolved).isFile()
    ? resolved
    : path.join(distDirectory, 'index.html');

  if (!existsSync(filePath)) {
    response.writeHead(404).end('Not found');
    return;
  }

  const headers = {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Required for SharedArrayBuffer-backed features and harmless otherwise.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless'
  };

  /*
   * Tell every page where its browser host is, before any of its code runs.
   *
   * This used to be the wearer's job, carried in a query string that had to
   * survive being typed on a virtual keyboard, bookmarked, and restored by the
   * browser after a crash. It did not survive: a tab reopened without
   * `?host=` resolves to UnavailableBrowserProvider, and every window in the
   * workspace then reports that local Chromium is offline — a message about
   * Electron, shown on a headset that could never run Electron, describing a
   * transport that was in fact running correctly the whole time.
   *
   * Configuration belongs to whoever knows the answer, and that is this server:
   * it is started by the same command as the host and is handed the address and
   * token directly. Injecting them ahead of the module graph keeps
   * resolveBrowserProvider synchronous, and works for every entry point and
   * every URL rather than one blessed link.
   */
  if (path.extname(filePath) === '.html' && remoteConfig) {
    const html = readFileSync(filePath, 'utf8').replace(
      '</head>',
      `<script>window.__SCC_REMOTE__=${JSON.stringify(remoteConfig)}</script></head>`
    );
    headers['Content-Length'] = Buffer.byteLength(html);
    response.writeHead(200, headers);
    response.end(html);
    return;
  }

  response.writeHead(200, headers);
  createReadStream(filePath).pipe(response);
};

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => resolve());
});

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('/*', ''));
    return;
  }

  if (options.build) {
    console.log('Building the workspace…');
    const build = spawnSync(process.execPath, [path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    if (build.status !== 0) throw new Error('The build failed; not serving a stale bundle.');
  }
  if (!existsSync(path.join(distDirectory, 'index.html'))) {
    throw new Error('dist/index.html is missing. Run without --no-build.');
  }

  const httpServer = createHttpServer(serveStatic);
  await listen(httpServer, options.port, '0.0.0.0');

  const host = lanAddress();
  let httpsPort = null;
  if (options.https) {
    if (!host) throw new Error('No LAN address found, so https has nothing to certify.');
    const credentials = ensureCertificate(host);
    const httpsServer = createHttpsServer(credentials, serveStatic);
    httpsPort = options.port + 1;
    await listen(httpsServer, httpsPort, '0.0.0.0');
  }

  console.log('\n  Spatial Command Center — headset serving\n');

  const adb = options.adb ? findAdb() : null;
  const devices = adb ? adbDevices(adb) : [];

  if (adb && devices.length) {
    for (const device of devices) {
      const reverse = spawnSync(adb, ['-s', device.serial, 'reverse', `tcp:${options.port}`, `tcp:${options.port}`], { encoding: 'utf8' });
      const ok = !reverse.error && reverse.status === 0;
      console.log(`  ${ok ? '✓' : '✗'} adb reverse for ${device.serial}${ok ? '' : ` — ${(reverse.stderr || '').trim()}`}`);
    }
    console.log(`\n  Open this in the headset browser:\n\n      http://localhost:${options.port}/\n`);
    console.log('  localhost is a secure context, so WebXR is available and no');
    console.log('  certificate has to be trusted on the device.\n');
  } else {
    if (!adb) console.log('  adb was not found, so no reverse tunnel was set up.');
    else console.log('  adb found, but no device is connected in device mode.');
    console.log('  Install platform-tools and enable developer mode on the headset');
    console.log('  for the simplest path.\n');

    if (httpsPort) {
      console.log(`  Open this in the headset browser:\n\n      https://${host}:${httpsPort}/\n`);
      console.log('  The certificate is self-signed, so Quest Browser will warn once.');
      console.log('  Accept it, or WebXR will not be offered.\n');
    } else {
      console.log(`  Plain http is available at http://${host}:${options.port}/ but`);
      console.log('  WebXR will NOT be exposed there: it requires a secure context.');
      console.log('  Re-run with --https, or connect the headset over adb.\n');
    }
  }

  console.log(`  Serving ${distDirectory}`);
  console.log('  Press Ctrl+C to stop.\n');
};

main().catch((error) => {
  console.error(`\nCould not start headset serving: ${error.message}\n`);
  process.exitCode = 1;
});
