#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const STARTUP_TIMEOUT_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const loadOptionalEnvironment = async () => {
  const environmentPath = path.join(projectRoot, '.env');
  let contents;
  try {
    contents = await readFile(environmentPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const [index, sourceLine] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new Error(`.env line ${index + 1} must use KEY=VALUE syntax.`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`.env line ${index + 1} has an invalid variable name.`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
};

const resolveDevelopmentAddress = () => {
  const host = String(process.env.SCC_DEV_HOST || DEFAULT_HOST).trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'SCC_DEV_HOST must be a loopback host (127.0.0.1, localhost, or ::1) because the renderer receives the trusted Electron preload.'
    );
  }
  const port = Number(process.env.SCC_DEV_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SCC_DEV_PORT must be an integer between 1 and 65535.');
  }
  const urlHost = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host;
  return {
    host: host.replace(/^\[|\]$/g, ''),
    port,
    rendererUrl: `http://${urlHost}:${port}/`
  };
};

const childResult = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
};

const stopChild = async (child, signal = 'SIGTERM') => {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([childResult(child), sleep(SHUTDOWN_TIMEOUT_MS)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

const waitForRenderer = async (rendererUrl, viteProcess, spawnError) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (spawnError.current) throw spawnError.current;
    if (viteProcess.exitCode !== null || viteProcess.signalCode !== null) {
      throw new Error('Vite exited before the renderer became ready.');
    }
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`Vite responded with HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(
    `Timed out waiting for Vite at ${rendererUrl}${lastError ? `: ${lastError.message}` : '.'}`
  );
};

const main = async () => {
  await loadOptionalEnvironment();
  const { host, port, rendererUrl } = resolveDevelopmentAddress();
  const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  try {
    await readFile(viteCli);
  } catch {
    throw new Error('Vite is not installed. Run npm install before npm run dev.');
  }

  let electronBinary;
  try {
    electronBinary = require('electron');
  } catch {
    throw new Error('Electron is not installed. Run npm install before npm run dev.');
  }

  const viteEnvironment = { ...process.env };
  const viteSpawnError = { current: null };
  const viteProcess = spawn(
    process.execPath,
    [viteCli, '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: projectRoot,
      env: viteEnvironment,
      stdio: 'inherit'
    }
  );
  viteProcess.once('error', (error) => {
    viteSpawnError.current = error;
  });

  let electronProcess = null;
  let requestedSignal = null;
  const forwardSignal = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    if (electronProcess) electronProcess.kill(signal);
    viteProcess.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  try {
    await waitForRenderer(rendererUrl, viteProcess, viteSpawnError);
    const electronEnvironment = {
      ...process.env,
      SCC_RENDERER_URL: rendererUrl
    };
    delete electronEnvironment.ELECTRON_RUN_AS_NODE;

    electronProcess = spawn(electronBinary, [projectRoot], {
      cwd: projectRoot,
      env: electronEnvironment,
      stdio: 'inherit'
    });
    const firstExit = await Promise.race([
      childResult(viteProcess).then((result) => ({ owner: 'vite', ...result })),
      childResult(electronProcess).then((result) => ({ owner: 'electron', ...result })),
      new Promise((_, reject) => electronProcess.once('error', reject))
    ]);

    if (firstExit.owner === 'vite' && !requestedSignal) {
      throw new Error(
        `Vite stopped while Electron was running${firstExit.code === null ? '' : ` (exit ${firstExit.code})`}.`
      );
    }
    if (!requestedSignal && firstExit.owner === 'electron') {
      process.exitCode = firstExit.code === null ? 1 : firstExit.code;
    }
  } finally {
    await Promise.all([
      stopChild(electronProcess, requestedSignal || 'SIGTERM'),
      stopChild(viteProcess, requestedSignal || 'SIGTERM')
    ]);
    if (requestedSignal) process.exitCode = requestedSignal === 'SIGINT' ? 130 : 143;
  }
};

main().catch((error) => {
  if (process.exitCode === 130 || process.exitCode === 143) return;
  console.error(`Development startup failed: ${error.message}`);
  process.exitCode = 1;
});
