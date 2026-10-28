#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const fixturePath = path.join(projectRoot, 'electron', 'fixtures', 'browser-poc.html');
const DEFAULT_TIMEOUT = 45000;
// One CDP request must never be able to consume a whole step budget: a request
// lost across a navigation has to fail fast so the caller can retry.
const COMMAND_TIMEOUT_MS = 8000;
const REQUIRED_QA_METHODS = ['snapshot', 'projectBrowserUv', 'chromiumSnapshot', 'projectGrabRegion'];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const quote = (value) => JSON.stringify(value);

class PocFailure extends Error {}

const parseArgs = (argv) => {
  const options = {
    electron: process.env.SCC_ELECTRON_BINARY || '',
    timeout: Number(process.env.SCC_ELECTRON_POC_TIMEOUT) || DEFAULT_TIMEOUT,
    keepProfile: false,
    verbose: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split('=', 2);
    const nextValue = () => inlineValue ?? argv[++index];
    if (name === '--electron') options.electron = nextValue();
    else if (name === '--timeout') options.timeout = Number(nextValue());
    else if (name === '--keep-profile') options.keepProfile = true;
    else if (name === '--verbose' || name === '-v') options.verbose = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new PocFailure(`Unknown option: ${argument}`);
  }

  if (!Number.isFinite(options.timeout) || options.timeout < 5000) {
    throw new PocFailure('--timeout must be at least 5000 milliseconds.');
  }
  return options;
};

const usage = () => {
  console.log(`Spatial Command Center Electron Chromium-texture smoke test

Usage:
  node scripts/electron-poc-smoke.mjs [--electron PATH] [--timeout 45000] [--keep-profile] [--verbose]

The runner starts a deterministic local page, launches this project through Electron
with a temporary profile and DevTools port, then drives the visible R3F canvas. It
never calls browser-source input methods directly.

Required QA hook when Electron is launched with SCC_ELECTRON_QA=1:
  window.__SCC_TEST__.snapshot()
  window.__SCC_TEST__.chromiumSnapshot(screenId)
  window.__SCC_TEST__.projectBrowserUv(screenId, u, v)

Run npm install before this script if node_modules/.bin/electron is missing.`);
};

const isExecutable = async (candidate) => {
  if (!candidate) return false;
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveElectronBinary = async (explicitPath) => {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (await isExecutable(resolved)) return resolved;
    throw new PocFailure(`Electron is not executable at ${resolved}`);
  }

  const candidates = process.platform === 'win32'
    ? [path.join(projectRoot, 'node_modules', '.bin', 'electron.cmd')]
    : [
        path.join(projectRoot, 'node_modules', '.bin', 'electron'),
        path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')
      ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new PocFailure('Electron is not installed. Run npm install, then retry this smoke test.');
};

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address());
  });
});

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

const reservePort = async () => {
  const server = createServer();
  const address = await listen(server);
  await closeServer(server);
  return address.port;
};

const startFixtureServer = async () => {
  const fixture = await readFile(fixturePath);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/' || requestUrl.pathname === '/browser-poc.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': fixture.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(fixture);
      return;
    }
    if (requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  const address = await listen(server);
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/browser-poc.html`
  };
};

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new PocFailure(`DevTools endpoint returned ${response.status} for ${url}`);
  return response.json();
};

const waitForDevTools = async (endpoint, timeout, electronLogs) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`${endpoint}/json/version`);
      if (version.webSocketDebuggerUrl) return version;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const tail = electronLogs.slice(-20).join('\n');
  throw new PocFailure(
    `Timed out waiting for Electron DevTools at ${endpoint}: ${lastError?.message || 'not available'}` +
    (tail ? `\nElectron output:\n${tail}` : '')
  );
};

const waitForTarget = async (endpoint, predicate, label, timeout) => {
  const deadline = Date.now() + timeout;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await fetchJson(`${endpoint}/json/list`).catch(() => []);
    const target = latest.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl && predicate(candidate));
    if (target) return target;
    await sleep(100);
  }
  throw new PocFailure(
    `Timed out waiting for ${label}. Targets: ${latest.map((target) => `${target.title} <${target.url}>`).join(', ') || 'none'}`
  );
};

const RETRYABLE_CDP_MESSAGE = /execution context was destroyed|cannot find context with specified id|context with specified id not found|inspected target navigated or closed|target closed|session with given id not found|no execution context|command timed out|closed the DevTools connection|is not connected/i;

const isRetryableCdpError = (error) => Boolean(error) && (
  error.retryable === true || RETRYABLE_CDP_MESSAGE.test(String(error.message || ''))
);

const retryable = (message) => {
  const error = new PocFailure(message);
  error.retryable = true;
  return error;
};

/*
 * A CDP client that survives cross-document navigation.
 *
 * Two properties matter for this suite. First, a single command has its own
 * short timeout that is independent of the overall step deadline, so one
 * request lost across a navigation cannot consume the entire budget. Second,
 * the connection tracks the page's default execution context and re-resolves
 * its target, because reload and address-bar navigation destroy the context
 * (and can replace the target) that earlier evaluations were bound to.
 */
class CdpConnection {
  constructor(resolveTarget, { label, connectTimeout, commandTimeout }) {
    this.resolveTarget = resolveTarget;
    this.label = label;
    this.connectTimeout = connectTimeout;
    this.commandTimeout = commandTimeout;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
    this.contextId = null;
    this.connecting = null;
    this.closed = false;
    this.domains = [];
    this.trackExecutionContexts();
  }

  get connected() {
    return Boolean(this.socket) && this.socket.readyState === WebSocket.OPEN;
  }

  async connect(domains = ['Runtime', 'Page']) {
    this.domains = domains;
    await this.ensureConnected();
  }

  ensureConnected() {
    if (this.closed) return Promise.reject(new PocFailure(`${this.label} client is closed`));
    if (this.connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.openSocket().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async openSocket() {
    const target = await this.resolveTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    this.socket = socket;
    this.contextId = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PocFailure(`Timed out connecting to ${this.label}`)),
        this.connectTimeout
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new PocFailure(`WebSocket connection failed for ${this.label}`));
      }, { once: true });
    });

    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => {
      // Rejecting as retryable lets waitForEvaluation reconnect instead of
      // failing the whole step when a navigation replaces the target.
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(retryable(`${this.label} closed the DevTools connection`));
      }
      this.pending.clear();
      this.contextId = null;
    });

    for (const domain of this.domains) await this.rawSend(`${domain}.enable`);
  }

  trackExecutionContexts() {
    this.on('Runtime.executionContextCreated', ({ context }) => {
      if (context && context.auxData && context.auxData.isDefault) this.contextId = context.id;
    });
    this.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      if (this.contextId === executionContextId) this.contextId = null;
    });
    this.on('Runtime.executionContextsCleared', () => {
      this.contextId = null;
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString());
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new PocFailure(`${pending.method}: ${message.error.message}`);
        error.retryable = RETRYABLE_CDP_MESSAGE.test(String(message.error.message || ''));
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  rawSend(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(retryable(`${this.label} is not connected`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(retryable(`${this.label} command timed out: ${method}`));
      }, this.commandTimeout);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async send(method, params = {}) {
    await this.ensureConnected();
    return this.rawSend(method, params);
  }

  close() {
    this.closed = true;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

/*
 * Electron's own sandboxed-renderer bootstrap intermittently logs a failure
 * from node:electron/js2c/sandbox_bundle before it retries successfully. It
 * originates entirely inside Electron's internal bundle, never in application
 * code, and the run demonstrably proceeds. These are surfaced as warnings so
 * they stay visible, but they do not fail the suite; every other renderer
 * error and exception still does.
 */
const ELECTRON_INTERNAL_NOISE = [
  /node:electron\/js2c\/sandbox_bundle/,
  /sandboxed_renderer\.bundle\.js script failed to run/,
  /Cannot destructure property 'preloadScripts' of 'binding\.startupData'/
];

const isElectronInternalNoise = (message) => ELECTRON_INTERNAL_NOISE.some(
  (pattern) => pattern.test(String(message))
);

const exceptionText = (details) => {
  const headline = details.exception?.description || details.exception?.value || details.text || 'Runtime exception';
  const frame = details.stackTrace?.callFrames?.[0];
  return frame ? `${headline} (${frame.url || 'page'}:${frame.lineNumber + 1}:${frame.columnNumber + 1})` : String(headline);
};

const remoteValue = (argument) => {
  if (Object.prototype.hasOwnProperty.call(argument, 'value')) return String(argument.value);
  return argument.unserializableValue || argument.description || argument.type || '<value>';
};

/*
 * Evaluate with a bounded retry over transient CDP faults. Navigation churn
 * (destroyed contexts, replaced targets, a request lost mid-swap) is test
 * infrastructure noise, not an application assertion, so it is retried rather
 * than reported as a failure. Genuine page exceptions still fail immediately.
 */
const evaluate = async (connection, expression, { retryBudget = 5000 } = {}) => {
  const deadline = Date.now() + retryBudget;
  let lastError;
  for (;;) {
    try {
      const result = await connection.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) throw new PocFailure(exceptionText(result.exceptionDetails));
      return result.result?.value;
    } catch (error) {
      if (/context/i.test(String(error.message || ""))) connection.contextId = null;
      if (!isRetryableCdpError(error) || Date.now() >= deadline) throw error;
      lastError = error;
      await sleep(75);
    }
  }
};

const waitForEvaluation = async (connection, expression, label, timeout, options = {}) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(connection, expression, { retryBudget: 250 });
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const suffix = lastError ? ` (${lastError.message})` : `; last value: ${JSON.stringify(lastValue)}`;

  // A timeout is the moment the surrounding state matters most. Capturing it
  // here turns "it did not happen" into something actionable.
  let diagnosis = '';
  if (options.diagnose) {
    try {
      const detail = await evaluate(connection, options.diagnose, { retryBudget: 500 });
      diagnosis = `\n  state at timeout: ${JSON.stringify(detail)}`;
    } catch (error) {
      diagnosis = `\n  state at timeout unavailable: ${error.message}`;
    }
  }
  throw new PocFailure(`Timed out waiting for ${label}${suffix}${diagnosis}`);
};

const dispatchMouse = (connection, type, point, detail = {}) => connection.send('Input.dispatchMouseEvent', {
  type,
  x: point.clientX,
  y: point.clientY,
  button: detail.button || 'none',
  buttons: detail.buttons ?? 0,
  clickCount: detail.clickCount || 0,
  deltaX: detail.deltaX || 0,
  deltaY: detail.deltaY || 0,
  modifiers: detail.modifiers || 0,
  pointerType: 'mouse'
});

const mouseMove = (connection, point, detail = {}) => dispatchMouse(connection, 'mouseMoved', point, detail);

/*
 * Synthetic clicks are dispatched with human-scale timing on purpose. A press
 * and release in the same millisecond, or two clicks with no gap between them,
 * can be coalesced before they reach the offscreen page, dropping events that
 * the assertions below count exactly.
 */
const CLICK_HOLD_MS = 24;
const DOUBLE_CLICK_GAP_MS = 60;

const mouseClick = async (connection, point, { button = 'left', clickCount = 1 } = {}) => {
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  await mouseMove(connection, point);
  await dispatchMouse(connection, 'mousePressed', point, { button, buttons, clickCount });
  await sleep(CLICK_HOLD_MS);
  await dispatchMouse(connection, 'mouseReleased', point, { button, buttons: 0, clickCount });
};

/*
 * Drag a screen and require that the intended gesture actually begins.
 *
 * A synthetic pointer-down occasionally produces no raycast intersection in a
 * headed window, and the application never sees the press at all. That is an
 * input-delivery miss, not a behavioural failure, and the application's own
 * diagnostics distinguish the two: if it recorded no attempt for this screen,
 * the event never arrived and the press is worth re-sending. If it recorded a
 * rejection, that is a real defect and it is reported rather than retried.
 */
const dragScreenGesture = async (connection, { screenId, kind, project, delta, timeout, attempts = 3 }) => {
  let lastState = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const from = await evaluate(connection, project);
    if (!from || from.visible === false) {
      throw new PocFailure(`Could not project a drag origin for ${screenId}`);
    }
    const to = { clientX: from.clientX + delta.x, clientY: from.clientY + delta.y };

    await mouseMove(connection, from);
    await dispatchMouse(connection, 'mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });

    const began = await evaluate(connection, `(() => {
      const state = window.__SCC_TEST__.snapshot();
      return state.isManipulatingScreen && state.manipulationKind === ${quote(kind)};
    })()`, { retryBudget: 1200 }).catch(() => false);

    if (!began) {
      lastState = await evaluate(connection, `(() => ({
        attempt: window.__SCC_TEST__.lastManipulationAttempt(),
        mode: window.__SCC_TEST__.snapshot().interactionMode
      }))()`).catch(() => null);
      await dispatchMouse(connection, 'mouseReleased', from, { button: 'left', buttons: 0, clickCount: 1 });

      if (lastState && lastState.attempt && lastState.attempt.outcome === 'rejected') {
        throw new PocFailure(
          `The application rejected the ${kind} gesture: ${JSON.stringify(lastState.attempt)}`
        );
      }
      await sleep(150);
      continue;
    }

    for (let step = 1; step <= 10; step += 1) {
      const progress = step / 10;
      await mouseMove(connection, {
        clientX: from.clientX + delta.x * progress,
        clientY: from.clientY + delta.y * progress
      }, { button: 'left', buttons: 1 });
      await sleep(16);
    }
    await dispatchMouse(connection, 'mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
    return { from, to, attempt };
  }

  throw new PocFailure(
    `The ${kind} gesture was never delivered to ${screenId} after ${attempts} attempts. ` +
    `Last application state: ${JSON.stringify(lastState)}`
  );
};

/*
 * Activate an in-scene control and require the workspace state to change.
 *
 * As with drags, a synthetic press occasionally produces no intersection, and
 * a control whose texture has just swapped can miss a press delivered in the
 * same frame. The assertion — that a ray hit on real geometry changes real
 * state — is unchanged; only undelivered input is re-sent.
 */
/*
 * Click a point on a browser surface and require the page to observe it.
 *
 * A synthetic press occasionally produces no raycast intersection, in which
 * case the application never sees it and the page never will either. Firing
 * once and then polling forever turns a dropped input into a timeout with no
 * explanation. Re-sending an input the page demonstrably never received does
 * not weaken the assertion — the page-side condition is unchanged and still
 * has to become true.
 */
const clickBrowserSurfaceUntil = async (appConnection, pageConnection, {
  project,
  condition,
  label,
  timeout,
  attempts = 3
}) => {
  let lastObserved = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const point = await evaluate(appConnection, project);
    if (!point || point.visible === false) {
      throw new PocFailure(`Could not project a click target for ${label}`);
    }
    await mouseClick(appConnection, point);

    const deadline = Date.now() + Math.min(timeout, 4000);
    while (Date.now() < deadline) {
      lastObserved = await evaluate(pageConnection, condition, { retryBudget: 250 }).catch(() => false);
      if (lastObserved) return lastObserved;
      await sleep(100);
    }
    await sleep(150);
  }
  throw new PocFailure(
    `${label} was never observed by the page after ${attempts} clicks. Last value: ${JSON.stringify(lastObserved)}`
  );
};

const activateSpatialControl = async (connection, { screenId, icon, expect, timeout, attempts = 3 }) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const point = await waitForEvaluation(
      connection,
      `(() => {
        window.__SCC_TEST__.selectScreen(${quote(screenId)});
        return window.__SCC_TEST__.projectSpatialControl(${quote(screenId)}, ${quote(icon)});
      })()`,
      `the spatial '${icon}' control to be projectable`,
      timeout
    );
    if (!point.visible) throw new PocFailure(`The spatial '${icon}' control is not visible to the camera`);

    await mouseClick(connection, point);

    const satisfied = await evaluate(connection, expect, { retryBudget: 1500 }).catch(() => false);
    if (satisfied) return { point, attempt };
    await sleep(200);
  }
  throw new PocFailure(
    `Activating the spatial '${icon}' control did not change workspace state after ${attempts} attempts.`
  );
};

const mouseDoubleClick = async (connection, point) => {
  await mouseClick(connection, point, { clickCount: 1 });
  await sleep(DOUBLE_CLICK_GAP_MS);
  await mouseClick(connection, point, { clickCount: 2 });
};

const keyEvent = (connection, type, key, code, keyCode, detail = {}) => connection.send('Input.dispatchKeyEvent', {
  type,
  key,
  code,
  windowsVirtualKeyCode: keyCode,
  nativeVirtualKeyCode: keyCode,
  modifiers: detail.modifiers || 0,
  ...(detail.text ? { text: detail.text, unmodifiedText: detail.text } : {}),
  // Chromium resolves shortcuts such as select-all through its editing command
  // pipeline rather than from the key event alone. On macOS in particular a
  // bare Cmd+A dispatch does not select anything, so the command is explicit.
  ...(detail.commands ? { commands: detail.commands } : {})
});

const pressKey = async (connection, key, code, keyCode, detail = {}) => {
  await keyEvent(connection, 'keyDown', key, code, keyCode, detail);
  await keyEvent(connection, 'keyUp', key, code, keyCode, detail);
};

const typeText = async (connection, value) => {
  for (const character of value) {
    const upper = character.toUpperCase();
    const isLetter = /^[a-z]$/i.test(character);
    const isDigit = /^\d$/.test(character);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${character}` : '';
    const keyCode = isLetter ? upper.charCodeAt(0) : isDigit ? character.charCodeAt(0) : character.charCodeAt(0);
    await pressKey(connection, character, code, keyCode, { text: character });
  }
};

const rectCenter = async (connection, selector) => {
  const rect = await evaluate(connection, `(() => {
    const element = document.querySelector(${quote(selector)});
    if (!element || element.disabled) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      : null;
  })()`);
  if (!rect) throw new PocFailure(`Could not locate a visible UI target: ${selector}`);
  return rect;
};

const vectorDistance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));
const angleDistance = (left, right) => Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const electronBinary = await resolveElectronBinary(options.electron);
  const fixture = await startFixtureServer();
  const cdpPort = await reservePort();
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'scc-electron-poc-'));
  const electronLogs = [];
  const runtimeErrors = [];
  const passes = [];
  let electronProcess = null;
  let appCdp = null;
  let fixtureCdp = null;

  const pass = (label) => {
    passes.push(label);
    console.log(`PASS  ${label}`);
  };
  const ensure = (condition, message, detail) => {
    if (!condition) throw new PocFailure(detail ? `${message}: ${detail}` : message);
  };

  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    Object.assign(environment, {
      SCC_ELECTRON_QA: '1',
      SCC_BROWSER_SOURCE_AUTOSTART: '1',
      SCC_BROWSER_SOURCE_URL: fixture.url,
      ELECTRON_ENABLE_LOGGING: '1'
    });
    const launchArguments = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The spatial renderer coalesces pointer moves through
      // requestAnimationFrame. Chromium throttles rAF and timers for windows it
      // considers occluded or backgrounded, which on a busy desktop silently
      // starves input delivery and makes these assertions flaky for reasons
      // unrelated to the application. Automated runs opt out of that
      // throttling; nothing about the application's behaviour is relaxed.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      projectRoot
    ];
    console.log(`LAUNCH ${electronBinary}`);
    console.log(`FIXTURE ${fixture.url}`);
    electronProcess = spawn(electronBinary, launchArguments, {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    electronProcess.on('error', (error) => electronLogs.push(`spawn error: ${error.message}`));
    for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
      let remainder = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (remainder + chunk).split(/\r?\n/);
        remainder = lines.pop() || '';
        for (const line of lines) {
          if (!line) continue;
          electronLogs.push(line);
          if (options.verbose) console.log(`ELECTRON ${line}`);
        }
      });
    }

    await waitForDevTools(endpoint, options.timeout, electronLogs);
    const isAppTarget = (target) => (
      /Spatial Command Center/i.test(target.title) || /\/index\.html(?:[?#]|$)/.test(target.url)
    );
    const isFixtureTarget = (target) => {
      try {
        const targetUrl = new URL(target.url);
        return targetUrl.origin === fixture.origin && targetUrl.pathname === '/browser-poc.html';
      } catch {
        return false;
      }
    };

    // Resolved lazily on every (re)connect: reload and address-bar navigation
    // can replace the offscreen fixture's DevTools target.
    appCdp = new CdpConnection(
      () => waitForTarget(endpoint, isAppTarget, 'the visible Spatial Command Center renderer', options.timeout),
      { label: 'visible app', connectTimeout: options.timeout, commandTimeout: COMMAND_TIMEOUT_MS }
    );
    fixtureCdp = new CdpConnection(
      () => waitForTarget(endpoint, isFixtureTarget, 'the offscreen Chromium fixture renderer', options.timeout),
      { label: 'offscreen fixture', connectTimeout: options.timeout, commandTimeout: COMMAND_TIMEOUT_MS }
    );

    const registerErrors = (connection, label) => {
      connection.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        runtimeErrors.push(`${label} exception: ${exceptionText(exceptionDetails)}`);
      });
      connection.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'error' || type === 'assert') {
          runtimeErrors.push(`${label} console.${type}: ${args.map(remoteValue).join(' ')}`);
        }
      });
    };
    registerErrors(appCdp, 'app');
    registerErrors(fixtureCdp, 'fixture');
    await Promise.all([appCdp.connect(), fixtureCdp.connect()]);

    // The spatial renderer batches pointer moves through requestAnimationFrame.
    // An occluded window throttles rAF, so input-driven steps need the window
    // genuinely foregrounded rather than merely open.
    await appCdp.send('Page.bringToFront').catch(() => {});


    await waitForEvaluation(
      fixtureCdp,
      `document.body?.dataset?.fixtureReady === 'true' && typeof window.__POC_FIXTURE__?.snapshot === 'function'`,
      'the deterministic fixture',
      options.timeout
    );
    const viewport = await evaluate(fixtureCdp, 'window.__POC_FIXTURE__.viewport()');
    ensure(viewport.width === 1280 && viewport.height === 800, 'Chromium viewport is not the required 1280 × 800', JSON.stringify(viewport));
    pass('one offscreen Chromium webContents loaded the 1280 × 800 local fixture');

    const hookStatus = await waitForEvaluation(
      appCdp,
      `(() => {
        const hook = window.__SCC_TEST__;
        if (!hook) return false;
        const missing = ${quote(REQUIRED_QA_METHODS)}.filter((name) => typeof hook[name] !== 'function');
        return missing.length ? { missing } : { ready: true };
      })()`,
      'the Electron POC QA hook',
      options.timeout
    );
    if (!hookStatus.ready) {
      throw new PocFailure(
        `The POC QA hook is incomplete (missing ${hookStatus.missing.join(', ')}). ` +
        'See this script\'s --help output for the minimal non-production hook contract.'
      );
    }

    const appSnapshot = await waitForEvaluation(
      appCdp,
      `(() => {
        const snapshot = window.__SCC_TEST__.snapshot();
        /* The harness pre-creates exactly one source, 'browser-s5', at the
           fixture URL, so that is the screen to assert against. Selecting the
           first chromium-typed screen instead used to be equivalent, back when
           a Chromium source was opt-in and s5 was the only preset screen that
           asked for one. Every preset screen carries a real browser now, so
           that selector silently started matching s1 and comparing the
           fixture URL against github.com. */
        const screen = snapshot.screens.find((candidate) => candidate.source?.sourceId === 'browser-s5');
        return screen ? { snapshot, screen } : false;
      })()`,
      'a Chromium-backed spatial monitor',
      options.timeout
    );
    const screenId = appSnapshot.screen.id;
    const sourceId = appSnapshot.screen.source.sourceId;
    ensure(sourceId, 'The Chromium screen has no browser source ID');

    const sourceState = await waitForEvaluation(
      appCdp,
      `(async () => {
        const sources = await window.spatialBrowser?.listSources?.();
        const source = sources?.find((candidate) => candidate.id === ${quote(sourceId)});
        return source && source.state === 'ready' ? source : false;
      })()`,
      'ready browser-source metadata',
      options.timeout
    );
    ensure(sourceState.url.startsWith(fixture.url), 'Browser source URL does not match the fixture', sourceState.url);

    const textureState = await waitForEvaluation(
      appCdp,
      `(() => {
        const state = window.__SCC_TEST__.chromiumSnapshot(${quote(screenId)});
        return state?.textureReady && state.frameCount > 0 && state.width === 1280 && state.height === 800 ? state : false;
      })()`,
      'a live 1280 × 800 Chromium frame on the Three.js texture',
      options.timeout
    );
    ensure(textureState.sourceId === sourceId, 'Texture/source identity mismatch');
    const screenshot = await appCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    ensure((screenshot.data || '').length > 10000, 'Visible Electron renderer screenshot was unexpectedly empty');
    pass('native browser frames reached a live Three.js texture on the visible spatial monitor');

    const projectFixtureTarget = async (targetName) => {
      const target = await evaluate(fixtureCdp, `window.__POC_FIXTURE__.rect(${quote(targetName)})`);
      ensure(target, `Fixture target is missing: ${targetName}`);
      const u = target.centerX / viewport.width;
      const v = 1 - (target.centerY / viewport.height);
      const projected = await evaluate(
        appCdp,
        `window.__SCC_TEST__.projectBrowserUv(${quote(screenId)}, ${u}, ${v})`
      );
      ensure(projected && projected.visible !== false, `Spatial projection failed for ${targetName}`);
      ensure(Number.isFinite(projected.clientX) && Number.isFinite(projected.clientY), `Projection has invalid client coordinates for ${targetName}`);
      ensure(Math.abs(projected.browserX - target.centerX) <= 2, `Browser X mapping is wrong for ${targetName}`, JSON.stringify(projected));
      ensure(Math.abs(projected.browserY - target.centerY) <= 2, `Browser Y mapping is wrong for ${targetName}`, JSON.stringify(projected));
      return projected;
    };

    await appCdp.send('Page.bringToFront').catch(() => {});
    const pointerPoint = await projectFixtureTarget('pointer-pad');
    await mouseMove(appCdp, pointerPoint);
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__.snapshot().pointerMoves > 0`,
      'pointer move delivered through raycast UV mapping',
      options.timeout
    );
    await mouseClick(appCdp, pointerPoint, { button: 'right' });
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__.snapshot().rightClicks === 1`,
      'right click delivered through raycast UV mapping',
      options.timeout
    );
    await mouseDoubleClick(appCdp, pointerPoint);
    await waitForEvaluation(
      fixtureCdp,
      `(() => {
        const snapshot = window.__POC_FIXTURE__.snapshot();
        const satisfied = snapshot.doubleClicks >= 1 && snapshot.pointerDowns >= 3 && snapshot.pointerUps >= 3;
        return satisfied ? snapshot : 'observed ' + JSON.stringify({
          doubleClicks: snapshot.doubleClicks,
          pointerDowns: snapshot.pointerDowns,
          pointerUps: snapshot.pointerUps,
          rightClicks: snapshot.rightClicks
        });
      })()`,
      'down/up/double-click delivery',
      options.timeout
    );
    pass('canvas raycast maps move, left/right down/up, context click, and double-click to Chromium pixels');

    const inputPoint = await projectFixtureTarget('input');
    await mouseClick(appCdp, inputPoint);
    // Typing before the remote field actually holds focus loses characters and
    // fails for a reason unrelated to the routing being tested. Wait for the
    // page itself to confirm focus landed where the click aimed.
    await waitForEvaluation(
      fixtureCdp,
      `document.activeElement && document.activeElement.dataset.pocTarget === 'input'`,
      'the fixture text field to take focus from the spatial click',
      options.timeout
    );
    const typedValue = 'spatial-codex-42';
    await typeText(appCdp, typedValue);
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__.snapshot().input === ${quote(typedValue)} && window.__POC_FIXTURE__.snapshot().keyDowns >= ${typedValue.length} && window.__POC_FIXTURE__.snapshot().keyUps >= ${typedValue.length}`,
      'keyboard and text input in offscreen Chromium',
      options.timeout
    );
    pass('focused spatial browser receives keyDown, keyUp, and text input');

    const buttonTarget = await evaluate(fixtureCdp, `window.__POC_FIXTURE__.rect('button')`);
    ensure(buttonTarget, 'Fixture target is missing: button');
    await clickBrowserSurfaceUntil(appCdp, fixtureCdp, {
      project: `window.__SCC_TEST__.projectBrowserUv(${quote(screenId)}, ${buttonTarget.centerX / 1280}, ${1 - buttonTarget.centerY / 800})`,
      condition: `window.__POC_FIXTURE__.snapshot().buttonClicks >= 1`,
      label: 'a click on the fixture button',
      timeout: options.timeout
    });
    const linkPoint = await projectFixtureTarget('link');
    await mouseClick(appCdp, linkPoint);
    await waitForEvaluation(
      fixtureCdp,
      `location.search.includes('view=linked') && window.__POC_FIXTURE__.snapshot().view === 'linked'`,
      'normal link navigation',
      options.timeout
    );
    pass('clicking a link on the tilted browser texture performs real Chromium navigation');

    const browserActionPoint = (action) => rectCenter(
      appCdp,
      `[data-testid="spatial-screen"][data-screen-id="${screenId}"] [data-browser-action="${action}"]`
    );
    await mouseClick(appCdp, await browserActionPoint('back'));
    await waitForEvaluation(
      fixtureCdp,
      `!location.search.includes('view=linked') && window.__POC_FIXTURE__.snapshot().view === 'base'`,
      'spatial Back button',
      options.timeout
    );
    await mouseClick(appCdp, await browserActionPoint('forward'));
    await waitForEvaluation(
      fixtureCdp,
      `location.search.includes('view=linked') && window.__POC_FIXTURE__.snapshot().view === 'linked'`,
      'spatial Forward button',
      options.timeout
    );
    await mouseClick(appCdp, await browserActionPoint('back'));
    await waitForEvaluation(fixtureCdp, `window.__POC_FIXTURE__.snapshot().view === 'base'`, 'return to base fixture', options.timeout);
    const beforeReload = await evaluate(fixtureCdp, 'window.__POC_FIXTURE__.snapshot().loadCount');
    await mouseClick(appCdp, await browserActionPoint('reload'));
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__?.snapshot().loadCount > ${Number(beforeReload)}`,
      'spatial Reload button',
      options.timeout
    );
    pass('Back, Forward, and Reload control the real Chromium navigation history');

    const addressUrl = `${fixture.url}?address=bar`;
    const addressPoint = await rectCenter(
      appCdp,
      `[data-testid="url-input"][data-screen-id="${screenId}"]`
    );
    await mouseClick(appCdp, addressPoint);
    const selectModifier = process.platform === 'darwin' ? 4 : 2;
    const selectKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    const selectCode = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
    const selectKeyCode = process.platform === 'darwin' ? 91 : 17;
    await keyEvent(appCdp, 'keyDown', selectKey, selectCode, selectKeyCode, { modifiers: selectModifier });
    await keyEvent(appCdp, 'keyDown', 'a', 'KeyA', 65, { modifiers: selectModifier, commands: ['selectAll'] });
    await keyEvent(appCdp, 'keyUp', 'a', 'KeyA', 65, { modifiers: selectModifier });
    await keyEvent(appCdp, 'keyUp', selectKey, selectCode, selectKeyCode);
    await appCdp.send('Input.insertText', { text: addressUrl });

    // Guard the interaction itself: if select-all silently fails, the address
    // is spliced into the old value and the navigation assertion below would
    // fail for a reason that has nothing to do with the application.
    const addressFieldValue = await waitForEvaluation(
      appCdp,
      `(() => {
        const input = Array.from(document.querySelectorAll('[data-testid="url-input"]'))
          .find((element) => element.dataset.screenId === ${quote(screenId)});
        return input && input.value === ${quote(addressUrl)} ? input.value : false;
      })()`,
      'the address bar to contain exactly the typed URL',
      options.timeout
    );
    ensure(addressFieldValue === addressUrl, 'Address bar did not receive the typed URL', addressFieldValue);
    await pressKey(appCdp, 'Enter', 'Enter', 13);
    await waitForEvaluation(
      fixtureCdp,
      `location.href === ${quote(addressUrl)} && window.__POC_FIXTURE__?.snapshot().view === 'base'`,
      'address-bar Chromium navigation',
      options.timeout
    );
    pass('the existing address bar navigates the Chromium browser source');

    const freshPointerPoint = await projectFixtureTarget('pointer-pad');
    await mouseClick(appCdp, freshPointerPoint);
    await dispatchMouse(appCdp, 'mouseWheel', freshPointerPoint, { deltaX: 28, deltaY: 620 });
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__.snapshot().scrollEvents > 0 && window.__POC_FIXTURE__.snapshot().scrollY > 100`,
      'wheel scrolling in offscreen Chromium',
      options.timeout
    );
    pass('wheel X/Y is routed from the spatial surface to the Chromium page');

    const keyDownsBeforeShortcutGuard = await evaluate(
      fixtureCdp,
      'window.__POC_FIXTURE__.snapshot().keyDowns'
    );
    await pressKey(appCdp, 'a', 'KeyA', 65, { text: 'a' });
    await waitForEvaluation(
      fixtureCdp,
      `window.__POC_FIXTURE__.snapshot().keyDowns > ${Number(keyDownsBeforeShortcutGuard)}`,
      'typing routed to Chromium instead of a host shortcut',
      options.timeout
    );
    const modeAfterBrowserKey = await evaluate(appCdp, 'window.__SCC_TEST__.snapshot().interactionMode');
    ensure(modeAfterBrowserKey === 'browse', 'Typing A in Chromium unexpectedly toggled the host interaction mode');
    pass('global host shortcuts do not hijack typing in a focused Chromium page');

    await mouseClick(appCdp, await rectCenter(appCdp, '[data-testid="mode-toggle"]'));
    await waitForEvaluation(
      appCdp,
      `window.__SCC_TEST__.snapshot().interactionMode === 'arrange'`,
      'Arrange Mode from its visible control',
      options.timeout
    );
    const beforeMove = await evaluate(
      appCdp,
      `window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).liveTransform`
    );
    await dragScreenGesture(appCdp, {
      screenId,
      kind: 'move',
      project: `window.__SCC_TEST__.projectBrowserUv(${quote(screenId)}, 0.5, 0.5)`,
      // Drag away from the right-hand overlay panels. Those panels legitimately
      // capture pointer input, and a screen parked underneath one cannot receive
      // a subsequent press — a real hazard of HTML chrome, and one more reason
      // the spatial surface exists.
      delta: { x: -90, y: 24 },
      timeout: options.timeout
    });
    const movedTransform = await waitForEvaluation(
      appCdp,
      `(() => {
        const transform = window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).liveTransform;
        return Math.hypot(...transform.position.map((value, index) => value - ${quote(beforeMove.position)}[index])) > 0.02 ? transform : false;
      })()`,
      'direct screen movement in Arrange Mode',
      options.timeout
    );

    await keyEvent(appCdp, 'keyDown', 'r', 'KeyR', 82, { text: 'r' });
    // The R modifier is what turns the next drag into a rotation. Confirm the
    // application registered it before dragging, so a lost keystroke reports
    // itself here instead of as a mysterious "rotation did not happen".
    await waitForEvaluation(
      appCdp,
      `window.__SCC_TEST__.snapshot().rotationModifier === true`,
      'the rotate modifier to be registered',
      options.timeout
    );
    await dragScreenGesture(appCdp, {
      screenId,
      kind: 'rotate',
      project: `window.__SCC_TEST__.projectBrowserUv(${quote(screenId)}, 0.5, 0.5)`,
      delta: { x: 110, y: 0 },
      timeout: options.timeout
    });
    await keyEvent(appCdp, 'keyUp', 'r', 'KeyR', 82);
    const rotatedTransform = await waitForEvaluation(
      appCdp,
      `(() => {
        const transform = window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).liveTransform;
        return Math.abs(Math.atan2(
          Math.sin(transform.rotation[1] - ${Number(movedTransform.rotation[1])}),
          Math.cos(transform.rotation[1] - ${Number(movedTransform.rotation[1])})
        )) > 0.02 ? transform : false;
      })()`,
      'direct screen rotation in Arrange Mode',
      options.timeout
    );
    ensure(vectorDistance(beforeMove.position, movedTransform.position) > 0.02, 'Screen position did not change');
    ensure(angleDistance(movedTransform.rotation[1], rotatedTransform.rotation[1]) > 0.02, 'Screen yaw did not change');

    /*
     * The complaint this whole change exists to answer: a window was almost
     * impossible to grab. The page covered it to within 5 mm, and manipulation
     * additionally required Arrange mode — which entering XR switches off.
     *
     * So: switch to Browse, where the page is live and where the old build
     * could not move a window at all, and drag it by its bezel. The page must
     * not move under the pointer, and the window must.
     */
    /* The store refuses a mode change while a manipulation is in flight, so the
     * previous gesture has to have fully settled before the toggle will take. */
    await waitForEvaluation(
      appCdp,
      `window.__SCC_TEST__.snapshot().isManipulatingScreen === false`,
      'the previous gesture to settle',
      options.timeout
    );
    await waitForEvaluation(
      appCdp,
      `(() => {
        if (window.__SCC_TEST__.snapshot().interactionMode === 'browse') return true;
        window.__SCC_TEST__.setInteractionMode('browse');
        return window.__SCC_TEST__.snapshot().interactionMode === 'browse';
      })()`,
      'Browse mode for the bezel-grab check',
      options.timeout
    );

    const beforeBezelDrag = await evaluate(appCdp, `(() => {
      const screen = window.__SCC_TEST__.snapshot().screens.find((s) => s.id === ${quote(screenId)});
      return screen.liveTransform.position;
    })()`);

    await dragScreenGesture(appCdp, {
      screenId,
      kind: 'move',
      project: `window.__SCC_TEST__.projectGrabRegion(${quote(screenId)}, 'bezel-left')`,
      delta: { x: 90, y: -40 },
      timeout: options.timeout
    });

    const afterBezelDrag = await evaluate(appCdp, `(() => {
      const screen = window.__SCC_TEST__.snapshot().screens.find((s) => s.id === ${quote(screenId)});
      return screen.liveTransform.position;
    })()`);

    const bezelMoved = ['0', '1', '2'].some(
      (axis) => Math.abs(afterBezelDrag[axis] - beforeBezelDrag[axis]) > 0.02
    );
    ensure(bezelMoved, 'Dragging the bezel in Browse mode did not move the window',
      `${JSON.stringify(beforeBezelDrag)} -> ${JSON.stringify(afterBezelDrag)}`);
    pass('a window is grabbable by its frame in Browse mode, without touching the page');

    /* And the counterpart: the page is still live in the same mode. If the
     * handles were stealing content clicks we would have traded one fault for
     * another. */
    const pageBeforeClick = await evaluate(fixtureCdp, 'window.__POC_FIXTURE__.snapshot()');
    const centre = await evaluate(
      appCdp,
      `window.__SCC_TEST__.projectBrowserUv(${quote(screenId)}, 0.5, 0.5)`
    );
    await mouseMove(appCdp, centre);
    await dispatchMouse(appCdp, 'mousePressed', centre, { button: 'left', buttons: 1, clickCount: 1 });
    await dispatchMouse(appCdp, 'mouseReleased', centre, { button: 'left', buttons: 0, clickCount: 1 });
    const pageAfterClick = await waitForEvaluation(
      fixtureCdp,
      `(() => {
        const snap = window.__POC_FIXTURE__.snapshot();
        return snap.pointerDowns > ${pageBeforeClick.pointerDowns} ? snap : false;
      })()`,
      'the page still receiving clicks with grab handles present',
      options.timeout
    ).catch(() => null);
    ensure(pageAfterClick, 'The grab handles stole a click from the page',
      `pointerDowns stayed at ${pageBeforeClick.pointerDowns}`);
    pass('the page is still fully clickable with the grab handles in place');

    const fixtureStateBeforeBrowse = await evaluate(fixtureCdp, 'window.__POC_FIXTURE__.snapshot()');
    ensure(fixtureStateBeforeBrowse.scrollY > 100, 'Browser page state was lost during arrangement');
    await pressKey(appCdp, 'a', 'KeyA', 65, { text: 'a' });
    await waitForEvaluation(
      appCdp,
      `window.__SCC_TEST__.snapshot().interactionMode === 'browse'`,
      'Browse Mode after transform isolation test',
      options.timeout
    );
    const textureAfterTransform = await evaluate(appCdp, `window.__SCC_TEST__.chromiumSnapshot(${quote(screenId)})`);
    ensure(textureAfterTransform.textureReady && textureAfterTransform.frameCount >= textureState.frameCount, 'Browser texture stopped while the monitor moved');
    pass('moving and rotating the monitor does not recreate or lose its live Chromium page');

    /*
     * Adaptive quality. The workspace should be spending its frame budget on
     * the screen the user is working on, not on every surface equally.
     */
    await evaluate(appCdp, `window.__SCC_TEST__.selectScreen(${quote(screenId)})`);
    const tiers = await waitForEvaluation(
      appCdp,
      `(() => {
        const decisions = window.__SCC_TEST__.qualityTiers();
        return Object.keys(decisions).length ? decisions : false;
      })()`,
      'the adaptive quality policy to classify the browser surfaces',
      options.timeout
    );
    const focusedTier = tiers[sourceId];
    ensure(focusedTier, 'The Chromium source was not classified by the quality policy');
    ensure(
      focusedTier.tier === 'focused',
      'The selected browser surface should run at the focused tier',
      JSON.stringify(focusedTier)
    );
    pass('adaptive quality classifies browser surfaces by attention');

    /*
     * Spatial chrome.
     *
     * Everything above this point was driven through HTML overlays, which do
     * not exist inside an immersive WebXR session. This phase switches the
     * workspace to in-scene chrome and drives the same essential controls as
     * real geometry, through the same raycast path a controller will use. If
     * this passes, the XR-critical interface is not dependent on the DOM.
     */
    await evaluate(appCdp, `window.__SCC_TEST__.setUiSurface('spatial')`);
    await waitForEvaluation(
      appCdp,
      `window.__SCC_TEST__.uiSurface() === 'spatial'`,
      'the spatial chrome surface to activate',
      options.timeout
    );

    // The DOM chrome must actually be gone, not merely covered.
    const domChromeGone = await waitForEvaluation(
      appCdp,
      `document.querySelectorAll('[data-testid="url-input"]').length === 0 ? 'gone' : false`,
      'the HTML browser chrome to be removed in spatial mode',
      options.timeout
    );
    ensure(domChromeGone === 'gone', 'HTML chrome still present while spatial chrome is active');

    const spatialButtons = await waitForEvaluation(
      appCdp,
      `(() => {
        const found = window.__SCC_TEST__.spatialControls(${quote(screenId)});
        return found && found.length ? found : false;
      })()`,
      'in-scene spatial controls to exist as scene objects',
      options.timeout
    );
    const icons = spatialButtons.map((button) => button.icon);
    for (const required of ['move', 'rotate-left', 'rotate-right', 'face', 'scale', 'copy', 'close', 'back', 'forward', 'reload']) {
      ensure(icons.includes(required), `Spatial chrome is missing the ${required} control`, icons.join(','));
    }
    pass('essential screen and browser controls exist as real scene geometry, not HTML');

    // Drive a spatial control by raycast and confirm it changes real state.
    const lockedBefore = await evaluate(
      appCdp,
      `window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).locked`
    );
    // Derive the icon from what is actually rendered rather than assuming it,
    // and keep the screen selected so its control bar stays mounted.
    const lockIcon = icons.includes('lock') ? 'lock' : 'unlock';
    await activateSpatialControl(appCdp, {
      screenId,
      icon: lockIcon,
      expect: `window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).locked === ${!lockedBefore}`,
      timeout: options.timeout
    });

    // Restore, and prove the toggle works in both directions.
    await activateSpatialControl(appCdp, {
      screenId,
      icon: lockIcon === 'lock' ? 'unlock' : 'lock',
      expect: `window.__SCC_TEST__.snapshot().screens.find((screen) => screen.id === ${quote(screenId)}).locked === ${lockedBefore}`,
      timeout: options.timeout
    });
    pass('a ray hit on in-scene chrome drives real workspace state');

    // The Chromium texture must be unaffected by the chrome surface swap.
    const textureAfterSpatial = await evaluate(appCdp, `window.__SCC_TEST__.chromiumSnapshot(${quote(screenId)})`);
    ensure(
      textureAfterSpatial.textureReady && textureAfterSpatial.frameCount >= textureState.frameCount,
      'The browser texture stopped when the chrome surface changed'
    );
    pass('switching chrome surfaces does not disturb the live browser texture');

    await evaluate(appCdp, `window.__SCC_TEST__.setUiSurface('dom')`);

    const uniqueErrors = [...new Set(runtimeErrors)];
    const noise = uniqueErrors.filter(isElectronInternalNoise);
    const applicationErrors = uniqueErrors.filter((message) => !isElectronInternalNoise(message));
    for (const message of noise) console.log(`WARN  ignored Electron-internal noise: ${message.split('\n')[0]}`);
    if (applicationErrors.length) {
      throw new PocFailure(
        `Captured ${applicationErrors.length} renderer error(s):\n  - ${applicationErrors.join('\n  - ')}`
      );
    }
    pass('no application renderer exceptions or console errors were captured');
    console.log(`\nELECTRON POC OK  ${passes.length} validations passed`);
  } finally {
    appCdp?.close();
    fixtureCdp?.close();
    if (electronProcess && electronProcess.exitCode === null && electronProcess.signalCode === null) {
      electronProcess.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => electronProcess.once('exit', () => resolve(true))),
        sleep(3000).then(() => false)
      ]);
      if (!exited) electronProcess.kill('SIGKILL');
    }
    await closeServer(fixture.server);
    if (options.keepProfile) console.log(`PROFILE ${profileDirectory}`);
    else {
      // Electron can still be flushing profile files as the process exits, so
      // removal races the last writes. Cleanup must never fail a run whose
      // assertions all passed.
      await rm(profileDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
        .catch((error) => console.log(`WARN  could not remove the temporary profile: ${error.message}`));
    }
  }
};

main().catch((error) => {
  console.error(`\nELECTRON POC FAILED\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
