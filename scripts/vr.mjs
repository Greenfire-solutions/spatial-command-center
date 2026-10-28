#!/usr/bin/env node

/*
 * Put the workspace on a headset with one command.
 *
 * The two halves have always had to be started separately and then introduced
 * to each other by hand, through a query string carrying the host address and a
 * generated token. Every part of that is a place to go wrong, and in a headset
 * the failures all look the same: a workspace full of windows reporting that
 * local Chromium is offline, which is a message about Electron shown on a
 * device that cannot run Electron, describing a transport that was working.
 *
 * So this script owns both halves. It mints the token, tells the host to use
 * it, tells the server where the host is, and the server injects that into
 * every page it serves. The wearer opens the origin and it works — no query
 * string, no token to retype, and a bookmark that is still correct tomorrow.
 *
 * Usage:
 *   npm run vr                  build, serve, host, print the URL
 *   npm run vr -- --no-build    skip the build
 *   npm run vr -- --https       also serve TLS on the LAN address
 *   npm run vr -- --port 4173
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const parseArgs = (argv) => {
  const options = { build: true, https: false, port: 4173, hostPort: 8787 };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const next = () => inline ?? argv[++index];
    if (name === '--no-build') options.build = false;
    else if (name === '--https') options.https = true;
    else if (name === '--port') options.port = Number(next());
    else if (name === '--host-port') options.hostPort = Number(next());
    else throw new Error(`Unknown option: ${argv[index]}`);
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

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const lan = lanAddress();
  if (!lan) throw new Error('No LAN address found, so a headset has nothing to reach.');

  /* One token, minted here and handed to both halves, so it never has to be
   * copied from one terminal to another or typed into a headset. */
  const token = process.env.SPATIAL_HOST_TOKEN || crypto.randomBytes(12).toString('hex');
  const scheme = options.https ? 'wss' : 'ws';
  const hostUrl = `${scheme}://${lan}:${options.hostPort}`;

  const children = [];
  let shuttingDown = false;

  const stopAll = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    process.exitCode = code ?? 0;
  };

  const start = (label, args, extraEnv) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit'
    });
    child.once('error', (error) => {
      console.error(`Could not start ${label}: ${error.message}`);
      stopAll(1);
    });
    /* The two halves are one feature. If either dies the other is useless, and
     * leaving it running would leave a browser reachable on the network with
     * nothing driving it. */
    child.once('exit', (code) => {
      if (!shuttingDown) {
        console.error(`\n  ${label} exited (${code}). Stopping the other half.\n`);
        stopAll(code ?? 1);
      }
    });
    children.push(child);
    return child;
  };

  start('browser host', [
    path.join(projectRoot, 'scripts', 'run-electron.mjs'),
    'electron/host/remote-host.cjs',
    '--',
    ...(options.https ? ['--https'] : []),
    '--host', lan,
    '--port', String(options.hostPort)
  ], { SPATIAL_HOST_TOKEN: token });

  start('page server', [
    path.join(projectRoot, 'scripts', 'serve-xr.mjs'),
    ...(options.build ? [] : ['--no-build']),
    ...(options.https ? ['--https'] : []),
    '--port', String(options.port)
  ], { SPATIAL_HOST_URL: hostUrl, SPATIAL_HOST_TOKEN: token });

  const pageScheme = options.https ? 'https' : 'http';
  const pagePort = options.https ? options.port + 1 : options.port;
  console.log(`\n  Open this in the headset browser:\n\n      ${pageScheme}://${lan}:${pagePort}/\n`);
  console.log('  No query string, no token: the server tells the page where the');
  console.log('  host is, so a bookmark keeps working.\n');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stopAll(0));
  }
};

try {
  main();
} catch (error) {
  console.error(`\nCould not start: ${error.message}\n`);
  process.exitCode = 1;
}
