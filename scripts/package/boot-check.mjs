#!/usr/bin/env node
/*
 * Starts the ready app from an unzipped folder with no window on screen, and
 * proves it works: the 3D workspace loads, the welcome card is there, and the
 * two example screens really open their web pages. Then it quits the app.
 *
 *   scripts/node.sh scripts/package/boot-check.mjs "<unzipped folder>" [port]
 *
 * It uses a throwaway settings folder, so a real saved layout is never read or
 * changed, and it stops only the app it started (by process id).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const folder = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || process.env.SCC_PORT || 10251);
const timeoutMs = Number(process.env.SCC_BOOT_TIMEOUT || 90000);
const profile = mkdtempSync(path.join(os.tmpdir(), 'scc-boot-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const env = { ...process.env, SCC_LAUNCH_QUIET: '1', SCC_PORT: String(port), SCC_USER_DATA_DIR: profile };
/* This check itself may run on the app's engine in Node mode; the app must not. */
delete env.ELECTRON_RUN_AS_NODE;
const started = Date.now();
const child = spawn('/bin/bash', [path.join(folder, 'Start Spatial Command Center.command')], {
  cwd: folder,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const targets = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.ok ? await response.json() : [];
  } catch { return []; }
};

const waitFor = async (predicate, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  return null;
};

const evaluate = (wsUrl, expression) => new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl);
  const timer = setTimeout(() => { socket.close(); reject(new Error('evaluate timed out')); }, 15000);
  socket.onopen = () => socket.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true }
  }));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    socket.close();
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
    else resolve(message.result?.result?.value);
  };
  socket.onerror = () => { clearTimeout(timer); reject(new Error('debugger connection failed')); };
});

let exitCode = 1;
try {
  const main = await waitFor(async () => (await targets())
    .find((target) => target.type === 'page' && /\/dist\/index\.html/.test(target.url)), timeoutMs);
  check('the app starts and loads its 3D workspace', main, main ? `${((Date.now() - started) / 1000).toFixed(1)} s` : output.slice(-400));
  if (main) {
    const page = await waitFor(async () => {
      const state = await evaluate(main.webSocketDebuggerUrl, `(() => ({
        canvas: Boolean(document.querySelector('canvas')),
        welcome: document.querySelector('[data-testid="welcome-card"]')?.innerText || '',
        app: Boolean(document.querySelector('[data-testid="spatial-app"]'))
      }))()`).catch(() => null);
      return state?.canvas && state?.app ? state : null;
    }, 30000);
    check('the 3D canvas is drawn', page?.canvas);
    check('the welcome card explains the first steps', /Add a screen/.test(page?.welcome || ''));

    for (const [label, host] of [['Wikipedia', 'wikipedia.org'], ['Map', 'openstreetmap.org']]) {
      const source = await waitFor(async () => (await targets())
        .find((target) => target.type === 'page' && target.url.includes(host)), 45000);
      let title = '';
      if (source) {
        title = await waitFor(async () => {
          const value = await evaluate(source.webSocketDebuggerUrl,
            'document.readyState === "complete" ? document.title : ""').catch(() => '');
          return value || null;
        }, 30000) || '';
      }
      check(`the ${label} example screen opens its real web page`, source && title, title || 'needs internet');
    }

    /* The first thing the welcome card tells a person to do: + SCREEN. */
    const before = (await targets()).filter((target) => target.type === 'page').length;
    const clicked = await evaluate(main.webSocketDebuggerUrl, `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => /^\\s*SCREEN\\s*$/.test(b.innerText));
      if (!button) return false;
      button.click();
      return true;
    })()`).catch(() => false);
    const added = clicked && await waitFor(async () =>
      (await targets()).filter((target) => target.type === 'page').length > before, 30000);
    check('+ SCREEN adds a new live screen', added, clicked ? '' : 'no + SCREEN button found');
  }
  exitCode = results.every((result) => result.ok) ? 0 : 1;
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  await sleep(1500);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  rmSync(profile, { recursive: true, force: true });
}
console.log(exitCode === 0 ? `\nboot-check: all ${results.length} passed` : '\nboot-check: FAILED');
process.exit(exitCode);
