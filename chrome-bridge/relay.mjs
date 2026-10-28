#!/usr/bin/env node
/*
 * The relay between Chrome and the workspace.
 *
 * A Chrome extension cannot listen on a socket, so it cannot be a host the way
 * electron/host/remote-host.cjs is. It can only dial out. This process is the
 * meeting point: the extension connects as the host, the workspace connects as
 * the client, and messages are forwarded verbatim in both directions.
 *
 * Verbatim matters. The extension speaks the same wire protocol as the Electron
 * host — JSON control messages, and frames as
 * [uint32 LE header length][header JSON][JPEG] — so the workspace needs no new
 * provider and no code change at all. Pointing ?host= at this relay instead of
 * the Electron host is the entire integration.
 *
 *   extension  --ws(role=host)-->  relay  <--ws(role=client)--  workspace
 *
 * Loopback only. The tabs on the other side of this are signed into real
 * accounts; nothing about that should be reachable from a network.
 */

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const parseArgs = (argv) => {
  const args = { port: 8788, host: '127.0.0.1' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') { args.port = Number(argv[index + 1]) || args.port; index += 1; }
    if (argv[index] === '--host') { args.host = argv[index + 1] || args.host; index += 1; }
  }
  return args;
};

const options = parseArgs(process.argv.slice(2));
const token = process.env.SPATIAL_BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');

const peers = { host: null, client: null };

const describe = () => `host ${peers.host ? 'connected' : 'waiting'}, client ${peers.client ? 'connected' : 'waiting'}`;

const server = new WebSocketServer({ port: options.port, host: options.host });

server.on('connection', (socket, request) => {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    socket.close(1008, 'bad request');
    return;
  }

  /* Two roles, one of each. A second host would mean two Chromes racing to
   * answer the same request, so the newcomer replaces the old rather than
   * joining it. */
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'client';

  /*
   * The two roles are protected differently, because they are reachable
   * differently.
   *
   * The host is the extension: it can only dial 127.0.0.1, so anything able to
   * reach it is already running on this machine and a token adds nothing but a
   * configuration step for the user. The client is the workspace, which is
   * reached through a tunnel, so it must present the token.
   */
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  const needsToken = role === 'client' || !loopback;
  if (needsToken && url.searchParams.get('token') !== token) {
    socket.close(1008, 'bad token');
    return;
  }
  if (peers[role]) {
    try { peers[role].close(1000, 'replaced'); } catch { /* already gone */ }
  }
  peers[role] = socket;
  socket.binaryType = 'arraybuffer';
  console.log(`[relay] ${role} connected — ${describe()}`);

  socket.on('message', (data, isBinary) => {
    const other = role === 'host' ? peers.client : peers.host;
    if (!other || other.readyState !== 1) return;
    other.send(data, { binary: isBinary });
  });

  const drop = () => {
    if (peers[role] === socket) peers[role] = null;
    console.log(`[relay] ${role} disconnected — ${describe()}`);
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.on('listening', () => {
  console.log('');
  console.log('  Chrome tab bridge relay');
  console.log('');
  console.log(`  extension:  ws://${options.host}:${options.port}/?role=host   (no token needed on loopback)`);
  console.log(`  workspace:  ws://${options.host}:${options.port}/?role=client&token=${token}`);
  console.log('');
  console.log(`  ?host=ws://${options.host}:${options.port}/&token=${token}`);
  console.log('');
});

server.on('error', (error) => {
  console.error(`[relay] ${error.message}`);
  process.exit(1);
});
