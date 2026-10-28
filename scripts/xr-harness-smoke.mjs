#!/usr/bin/env node

/*
 * Drives the XR test harness in a headless browser.
 *
 * This is the instrument that closes the development loop. Everything it asserts
 * used to require a headset on a head, and the answer came back as an impression
 * rather than a measurement.
 *
 * It launches Chrome with a remote debugging port, opens the headset document with
 * ?xr-harness=1, waits for the emulated device, then poses controllers and presses
 * buttons over CDP. The assertions it makes are the failure modes recorded in
 * docs/XR_FOUNDATION_ARCHITECTURE.md, starting with the one that is live today:
 * a controller disappearing mid-grab must not leave the window held.
 *
 * Usage:
 *   npm run dev:frontend                 # in another shell
 *   node scripts/xr-harness-smoke.mjs
 *
 * Options:
 *   --url http://127.0.0.1:4173/xr.html  the document to drive
 *   --chrome <path>                      Chrome binary
 *   --keep                               leave the browser open on exit
 *   --verbose                            print every CDP evaluation
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { WebSocket } from 'ws';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_URL = 'http://127.0.0.1:4173/xr.html';
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Failure extends Error {}

const parseArgs = (argv) => {
  const options = { url: DEFAULT_URL, chrome: DEFAULT_CHROME, keep: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    const next = () => inline ?? argv[++i];
    if (name === '--url') options.url = next();
    else if (name === '--chrome') options.chrome = next();
    else if (name === '--keep') options.keep = true;
    else if (name === '--verbose' || name === '-v') options.verbose = true;
    else throw new Failure(`Unknown option: ${argv[i]}`);
  }
  return options;
};

/* A CDP connection reduced to the one thing this script needs: evaluate an
 * expression in the page and get the value back. */
class Page {
  constructor(webSocketUrl, verbose) {
    this.url = webSocketUrl;
    this.verbose = verbose;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.on('open', resolve);
      this.socket.on('error', (error) => reject(new Failure(`CDP socket failed: ${error.message}`)));
      this.socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Failure(message.error.message));
        else entry.resolve(message.result);
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Failure(`CDP timed out: ${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /* Every evaluation awaits its promise and returns a plain value, so a caller
   * never has to think about remote object handles. */
  async evaluate(expression, { userGesture = false } = {}) {
    if (this.verbose) console.log(`  eval: ${expression.replace(/\s+/g, ' ').slice(0, 110)}`);
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      // requestSession() demands a transient user activation, exactly as it does
      // for a real Enter VR button. CDP can supply one, so the test drives the
      // same guarded path a person does rather than a relaxed one.
      userGesture
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text;
      throw new Failure(`page threw: ${text}`);
    }
    return result.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

/* Recent Chrome requires PUT on /json/new and answers 405 to a GET, which reads
 * like an endpoint change rather than a protocol one. The method is passed
 * explicitly so that surprise is visible here instead of in a caller. */
const fetchJson = async (url, method = 'GET') => {
  const response = await fetch(url, { method });
  if (!response.ok) throw new Failure(`${url} returned ${response.status}`);
  return response.json();
};

const waitForChrome = async (endpoint) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await fetchJson(`${endpoint}/json/version`); } catch { await sleep(250); }
  }
  throw new Failure(`Chrome never answered on ${endpoint}`);
};

/* Assertions are collected rather than thrown, so one failure does not hide the
 * state of everything after it — which is the whole reason this exists. */
const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return passed;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const endpoint = `http://127.0.0.1:${PORT}`;

  try {
    await fetch(options.url);
  } catch {
    throw new Failure(`No dev server at ${options.url}. Run \`npm run dev:frontend\` first.`);
  }

  const profile = await mkdtemp(path.join(tmpdir(), 'scc-xr-harness-'));
  const chrome = spawn(options.chrome, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-sandbox',
    // Prefer the real GPU. Forcing SwiftShader yields 1-2 fps for this scene, and at
    // that rate anything polled per frame becomes a coin flip — the difference
    // between a test and a rumour. ANGLE over Metal keeps headless deterministic.
    // --enable-unsafe-swiftshader stays as the fallback for machines without one.
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
    'about:blank'
  ], { stdio: options.verbose ? 'inherit' : 'ignore' });

  let page;
  try {
    await waitForChrome(endpoint);
    const target = await fetchJson(
      // ?diag= is the project's own positional layer mask (hud env shadow screens
      // quality). Software rendering cannot afford the environment probe or contact
      // shadows, and neither is under test here.
      `${endpoint}/json/new?${encodeURIComponent(`${options.url}?xr-harness=1&qa&diag=10010`)}`,
      'PUT'
    );
    page = new Page(target.webSocketDebuggerUrl, options.verbose);
    await page.connect();
    await page.send('Runtime.enable');

    console.log(`\nDriving ${options.url}?xr-harness=1\n`);

    // ---- the harness itself installs -------------------------------------
    const installed = await (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const ready = await page.evaluate(`
          if (!window.__SCC_XR__) return null;
          await window.__SCC_XR__.ready;
          return { available: window.__SCC_XR__.available(), error: window.__SCC_XR__.error() };
        `).catch(() => null);
        if (ready) return ready;
        await sleep(500);
      }
      return null;
    })();

    if (!check('harness installs', Boolean(installed?.available), installed?.error || (installed ? '' : 'window.__SCC_XR__ never appeared'))) {
      return;
    }

    const before = await page.evaluate('return await window.__SCC_XR__.snapshot();');
    // Chrome has its own navigator.xr, so merely finding one proves nothing. What
    // matters is whether the emulated device is the thing answering.
    const supported = await page.evaluate(`
      if (!navigator.xr) return null;
      try { return await navigator.xr.isSessionSupported('immersive-vr'); }
      catch (error) { return String(error && error.message || error); }
    `);
    check('emulated device answers isSessionSupported', supported === true, `returned ${JSON.stringify(supported)}`);
    check('both controllers present',
      before.controllers.left.status === 'VALID' && before.controllers.right.status === 'VALID',
      `left=${before.controllers.left.status} right=${before.controllers.right.status}`);
    check('workspace has screens', before.screens.length > 0, `${before.screens.length} screens`);

    // ---- wait for the scene to actually mount ----------------------------
    // The store is a module singleton and is populated before anything renders, so
    // "there are screens" does not mean "the canvas exists". A live Object3D in the
    // scene registry does, and @react-three/xr cannot connect a session until then.
    const mounted = await (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const snap = await page.evaluate('return await window.__SCC_XR__.snapshot();').catch(() => null);
        if (snap?.screens?.some((screen) => screen.liveTransform)) return snap;
        await sleep(500);
      }
      return null;
    })();
    check('R3F scene mounts and registers screen objects',
      Boolean(mounted),
      mounted ? `${mounted.screens.filter((s) => s.liveTransform).length} live objects` : 'no Object3D ever registered');

    // ---- a session can be entered ----------------------------------------
    const entered = await page.evaluate(`
      try { return await window.__SCC_XR__.enter('immersive-vr'); }
      catch (error) { return { failed: String(error && error.message || error) }; }
    `, { userGesture: true });
    const sessionOk = check('immersive-vr session starts',
      Boolean(entered?.xr?.sessionActive),
      entered?.failed || (entered?.xr ? `visibility=${entered.xr.visibilityState}` : ''));

    // ---- is the session actually ticking? --------------------------------
    if (sessionOk) {
      const frames = await page.evaluate('return await window.__SCC_XR__.countFrames(1000);');
      const fps = frames?.frames || 0;
      check('XR frame loop runs', fps > 0, `${fps} fps`);
      if (fps < 15) {
        console.log(`    only ${fps} fps — the GPU path probably fell back to software.`);
        console.log('    Checks below poll rather than sleep, but expect flakiness.');
      }
    }

    // ---- THE GRAB-LEAK TEST ----------------------------------------------
    // Specified behaviour, docs/XR_FOUNDATION_ARCHITECTURE.md §11.3: when a device
    // holding a window disappears, the window commits at its last valid transform
    // and nothing stays held.
    //
    // Order matters. Every observation is taken at the moment it is about, because
    // a diagnostic captured after the disconnect describes the wrong world.
    if (sessionOk) {
      // Aim at a real screen. A squeeze that hits nothing proves nothing.
      const live = (mounted || before).screens.filter((screen) => screen.liveTransform && !screen.locked);
      const target = live[0] || (mounted || before).screens.find((screen) => screen.liveTransform);

      if (!target) {
        check('a grabbable screen exists', false, 'no screen registered an Object3D');
      } else {
        const aim = target.liveTransform.position;
        console.log(`    aiming at "${target.name || target.id}" at ${JSON.stringify(aim.map((v) => Number(v.toFixed(2))))}`);

        // The rendered controller object is created when the XR component mounts,
        // which at a couple of frames per second is well after the session resolves.
        // Aiming before it exists silently does nothing.
        const controllerReady = await (async () => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const probe = await page.evaluate(`return await window.__SCC_XR__.probeRay('right');`).catch(() => null);
            if (probe && !probe.error) return probe;
            await sleep(250);
          }
          return null;
        })();
        check('rendered controller object exists', Boolean(controllerReady),
          controllerReady ? `${controllerReady.candidates} raycast candidates` : 'never appeared');

        const aimed = await page.evaluate(`
          const xr = window.__SCC_XR__;
          xr.setController('right', { position: [0.15, 1.35, -0.1] });
          try { return { ok: await xr.aimAtWorld('right', ${JSON.stringify(aim)}) }; }
          catch (error) { return { ok: false, threw: String(error && error.stack || error) }; }
        `);
        // Reported, not asserted. Aim converges over frames, and under software
        // rendering there may not be many; whether it converged tightly matters far
        // less than whether the ray landed on the panel, which the next check gates.
        console.log(`    aim converged: ${aimed?.ok === true}${aimed?.threw ? ` (${aimed.threw})` : ''}`);
        await sleep(250);
        await page.evaluate(`window.__SCC_XR__.press('right', 'squeeze', 1); return true;`);

        // Poll rather than sleep. Under software rendering the frame loop runs at a
        // couple of hertz, and a fixed wait against a per-frame poll is a coin flip.
        let holding = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          holding = await page.evaluate('return await window.__SCC_XR__.snapshot();');
          if (holding.interaction.isManipulatingScreen) break;
          await sleep(250);
        }

        const grabbed = check('squeeze on an aimed ray starts a grab',
          holding.interaction.isManipulatingScreen === true,
          `isManipulatingScreen=${holding.interaction.isManipulatingScreen}, kind=${holding.interaction.manipulationKind}, selected=${holding.interaction.selectedScreen}`);

        // Captured while the squeeze is still held and the controller still present.
        if (!grabbed) {
          const ray = await page.evaluate(`return await window.__SCC_XR__.probeRay('right');`);
          const iwer = await page.evaluate(`
            const snap = await window.__SCC_XR__.snapshot();
            return snap.controllers.right;
          `);
          console.log('\n    --- IWER controller (what we wrote) ---');
          console.log('    ' + JSON.stringify(iwer));
          console.log('    --- rendered ray (what the app sees) ---');
          console.log('    ' + JSON.stringify(ray));
          const debug = await page.evaluate('return await window.__SCC_XR__.inputDebug();');
          console.log('\n    --- input path, squeeze held, controller still connected ---');
          console.log('    ' + JSON.stringify(debug, null, 2).split('\n').join('\n    '));
          console.log('');
        }

        /* Measure the window that was actually grabbed, not the one we aimed at.
         * Aim converges to within a few degrees, which is enough to land on a
         * neighbour — and measuring an untouched window makes every assertion below
         * pass while proving nothing. */
        const grabbedId = holding.interaction.selectedScreen || target.id;
        if (grabbedId !== target.id) console.log(`    (aimed at ${target.id}, grabbed ${grabbedId})`);

        // Drag it somewhere new before losing the controller. Without this the commit
        // has nothing to prove: the stored position already equals the held one, and
        // an unwind that writes nothing at all still passes.
        const startPosition = holding.screens.find((s) => s.id === grabbedId)?.liveTransform?.position || null;
        await page.evaluate(`
          const xr = window.__SCC_XR__;
          xr.setController('right', { position: [0.55, 1.55, -0.1] });
          return await xr.aimAtWorld('right', ${JSON.stringify([aim[0] + 0.9, aim[1] + 0.35, aim[2]])});
        `);
        for (let attempt = 0; attempt < 12; attempt += 1) await page.evaluate('return await window.__SCC_XR__.nextFrame();');

        holding = await page.evaluate('return await window.__SCC_XR__.snapshot();');
        const heldPosition = holding.screens.find((screen) => screen.id === grabbedId)?.liveTransform?.position || null;
        const moved = startPosition && heldPosition
          ? Math.hypot(heldPosition[0] - startPosition[0], heldPosition[1] - startPosition[1], heldPosition[2] - startPosition[2])
          : 0;
        check('the held window actually moves with the controller', moved > 0.1, `moved ${moved.toFixed(3)} m`);

        // ---- now remove the controller mid-gesture -------------------------
        await page.evaluate(`window.__SCC_XR__.disconnect('right'); return true;`);
        let after = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await sleep(250);
          after = await page.evaluate('return await window.__SCC_XR__.snapshot();');
          if (!after.interaction.isManipulatingScreen) break;
        }

        check('controller removal is observed',
          after.controllers.right.status === 'DISCONNECTED',
          after.controllers.right.status);

        if (grabbed) {
          check('no window is left held after the controller vanishes',
            after.interaction.isManipulatingScreen === false,
            `isManipulatingScreen=${after.interaction.isManipulatingScreen}, kind=${after.interaction.manipulationKind}`);

          const settled = after.screens.find((screen) => screen.id === grabbedId);
          const stored = settled?.storeTransform?.position || null;
          const drift = heldPosition && stored
            ? Math.hypot(stored[0] - heldPosition[0], stored[1] - heldPosition[1], stored[2] - heldPosition[2])
            : null;
          check('the window is committed where it was held, not moved',
            drift !== null && drift < 0.25,
            drift === null ? 'could not compare transforms' : `drift ${drift.toFixed(3)} m`);
        } else {
          console.log('    the grab never started, so the leak itself was NOT exercised.');
          console.log('    Everything above this line still holds; this one check is unproven.');
        }

        const stillFinite = after.screens.every((screen) => screen.finite);
        check('every persisted transform is finite', stillFinite);
      }
    }

  } finally {
    if (page) page.close();
    if (!options.keep) {
      chrome.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`\nBrowser left running on ${endpoint} (profile ${profile})`);
    }
  }

  const failed = results.filter((entry) => !entry.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`\n${error instanceof Failure ? error.message : error}`);
  process.exitCode = 1;
});
