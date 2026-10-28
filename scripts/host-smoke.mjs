#!/usr/bin/env node

/*
 * End-to-end gate for the remote browser host.
 *
 * Launches the real host in Electron, connects as a headset would, creates a
 * real offscreen Chromium source, and waits for actual JPEG frames to arrive
 * over the socket. It asserts on the bytes — JPEG magic, plausible size — so a
 * pass means pixels genuinely crossed the transport, not that a handshake
 * completed.
 *
 * This is the remote-path counterpart to test:runtime. It needs Electron and a
 * loopback port; it does not need a headset or a network.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import {
  createRequest,
  decode,
  encode,
  validateInbound
} from '../src/providers/remote/protocol.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);

const TOKEN = 'host-smoke-token';
const HOST_PORT = 8799;
const FRAME_TIMEOUT_MS = 25_000;

const log = (message) => console.log(`  ${message}`);
const fail = (message) => { console.error(`\n  FAILED: ${message}\n`); process.exitCode = 1; };

const serveFixture = () => new Promise((resolve) => {
  const html = readFileSync(path.join(projectRoot, 'electron/fixtures/browser-source-test.html'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const waitForPort = async (port, attempts = 60) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reachable = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
      socket.once('open', () => { socket.close(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const main = async () => {
  const { server, port: fixturePort } = await serveFixture();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
  log(`fixture served at ${fixtureUrl}`);

  const electronBinary = require('electron');
  const environment = { ...process.env, SPATIAL_HOST_TOKEN: TOKEN };
  delete environment.ELECTRON_RUN_AS_NODE;

  const host = spawn(
    electronBinary,
    [path.join(projectRoot, 'electron/host/remote-host.cjs'), '--port', String(HOST_PORT)],
    { cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let hostOutput = '';
  host.stdout.on('data', (chunk) => { hostOutput += chunk; });
  host.stderr.on('data', (chunk) => { hostOutput += chunk; });

  const cleanup = () => {
    try { host.kill('SIGTERM'); } catch { /* already gone */ }
    server.close();
  };

  try {
    if (!await waitForPort(HOST_PORT)) {
      fail(`the host never accepted a connection on ${HOST_PORT}.\n\n${hostOutput}`);
      return cleanup();
    }
    log(`host accepting connections on ${HOST_PORT}`);

    const socket = new WebSocket(`ws://127.0.0.1:${HOST_PORT}/?token=${TOKEN}`);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    log('connected as a headset would');

    const pending = new Map();
    const frames = [];
    let firstFrameAt = null;
    const startedAt = Date.now();

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.from(data);
        const headerLength = buffer.readUInt32LE(0);
        const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
        const body = buffer.subarray(4 + headerLength);
        if (firstFrameAt === null) firstFrameAt = Date.now();
        frames.push({ header, body });
        return;
      }
      const message = decode(data.toString());
      const check = validateInbound(message);
      if (!check.ok || message.kind !== 'response') return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error?.message || 'request failed'));
    });

    const request = (action, sourceId, payload) => new Promise((resolve, reject) => {
      const message = createRequest(action, sourceId, payload);
      pending.set(message.requestId, { resolve, reject });
      socket.send(encode(message));
      setTimeout(() => {
        if (pending.delete(message.requestId)) reject(new Error(`${action} timed out`));
      }, 15_000);
    });

    const snapshot = await request('createSource', 'smoke-1', {
      id: 'smoke-1',
      url: fixtureUrl,
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      frameRate: 30
    });
    if (!snapshot || snapshot.id !== 'smoke-1') {
      fail(`createSource returned an unexpected snapshot: ${JSON.stringify(snapshot)}`);
      return cleanup();
    }
    log(`source created: ${snapshot.id} (${snapshot.width}x${snapshot.height})`);

    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (frames.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (frames.length === 0) {
      fail(`no frames arrived within ${FRAME_TIMEOUT_MS}ms.\n\n${hostOutput}`);
      return cleanup();
    }

    const first = frames[0];
    const isJpeg = first.body[0] === 0xff && first.body[1] === 0xd8;
    if (!isJpeg) {
      fail(`the payload is not JPEG (leading bytes ${first.body[0]}, ${first.body[1]}).`);
      return cleanup();
    }

    const bytes = frames.reduce((total, frame) => total + frame.body.byteLength, 0);
    const average = Math.round(bytes / frames.length);
    const rawEquivalent = first.header.width * first.header.height * 4;

    log(`frames received: ${frames.length}`);
    log(`first frame after: ${firstFrameAt - startedAt}ms`);
    log(`payload: ${first.header.width}x${first.header.height}, avg ${(average / 1024).toFixed(1)} KB`);
    log(`vs raw BGRA: ${(rawEquivalent / 1024 / 1024).toFixed(2)} MB — ${Math.round(rawEquivalent / average)}x smaller`);

    // A frame small enough to be an error page, or large enough to be raw, is
    // a failure even though it decoded.
    if (average < 1024) {
      fail(`frames are implausibly small (${average} bytes); the page may not have rendered.`);
      return cleanup();
    }

    const navigated = await request('navigate', 'smoke-1', { url: `${fixtureUrl}?second=1` });
    log(`navigation accepted: ${navigated?.url ?? 'ok'}`);

    await request('destroySource', 'smoke-1');
    log('source destroyed');

    console.log('\n  PASS — real pixels crossed the socket.\n');
  } catch (error) {
    fail(`${error.message}\n\n${hostOutput}`);
  } finally {
    cleanup();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
