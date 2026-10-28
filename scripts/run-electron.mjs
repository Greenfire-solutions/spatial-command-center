#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const [entryArgument, ...electronArguments] = process.argv.slice(2);

if (!entryArgument) {
  console.error('Usage: node scripts/run-electron.mjs <entry.cjs> [...arguments]');
  process.exitCode = 1;
} else {
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron');
  const environment = { ...process.env };
  // Codex and some Node tooling set this globally. Electron treats its mere
  // presence as a request to run as Node, which makes runtime tests silently
  // skip the actual browser process and fail to resolve Electron APIs.
  delete environment.ELECTRON_RUN_AS_NODE;

  const entryPath = path.resolve(projectRoot, entryArgument);
  const child = spawn(electronBinary, [entryPath, ...electronArguments], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit'
  });

  let forwardedSignal = null;
  const forward = (signal) => {
    if (forwardedSignal || child.exitCode !== null || child.signalCode !== null) return;
    forwardedSignal = signal;
    child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  child.once('error', (error) => {
    console.error(`Could not start Electron: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (code !== null) process.exitCode = code;
    else if (forwardedSignal) process.exitCode = forwardedSignal === 'SIGINT' ? 130 : 143;
    else {
      console.error(`Electron exited with signal ${signal || 'unknown'}.`);
      process.exitCode = 1;
    }
  });
}
