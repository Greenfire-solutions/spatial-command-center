#!/usr/bin/env node

import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

const STORAGE_KEY = 'spatial-command-center-layout-v1';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
const PRESET_SCREEN_COUNTS = {
  Welcome: 2,
  Developer: 5,
  CommandArc: 5,
  Focus: 2,
  WideArc: 5,
  TripleMonitor: 3,
  Stack: 4,
  Surround: 7
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const quote = (value) => JSON.stringify(value);

class SmokeFailure extends Error {}

const parseArgs = (argv) => {
  const options = {
    endpoint: process.env.SCC_CDP_ENDPOINT || DEFAULT_ENDPOINT,
    appUrl: process.env.SCC_APP_URL || '',
    timeout: Number(process.env.SCC_SMOKE_TIMEOUT) || 30000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split('=', 2);
    const nextValue = () => inlineValue ?? argv[++index];
    if (name === '--endpoint') options.endpoint = nextValue();
    else if (name === '--url') options.appUrl = nextValue();
    else if (name === '--timeout') options.timeout = Number(nextValue());
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new SmokeFailure(`Unknown option: ${argument}`);
  }

  if (!/^https?:\/\//i.test(options.endpoint)) options.endpoint = `http://${options.endpoint}`;
  options.endpoint = options.endpoint.replace(/\/$/, '');
  if (!Number.isFinite(options.timeout) || options.timeout < 1000) {
    throw new SmokeFailure('--timeout must be at least 1000 milliseconds');
  }
  return options;
};

const usage = () => {
  console.log(`Spatial Command Center CDP smoke test

Usage:
  node scripts/smoke.mjs [--endpoint http://127.0.0.1:9222] [--url http://127.0.0.1:4173/] [--timeout 30000]

Chrome must already be running with remote debugging enabled, for example:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/scc-smoke-profile \\
    http://127.0.0.1:4173/?qa=1

The runner adds ?qa=1, restores the workspace localStorage value, and exits non-zero
for assertion failures, main-frame Runtime exceptions, or console.error calls.`);
};

const fetchJson = async (url, init) => {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new SmokeFailure(
      `Could not reach Chrome at ${url}: ${error.message}. Start Chrome with --remote-debugging-port=9222.`
    );
  }
  if (!response.ok) throw new SmokeFailure(`Chrome endpoint returned ${response.status} for ${url}`);
  return response.json();
};

const withQaFlag = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SmokeFailure(`The app URL is invalid: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SmokeFailure('Serve the app over HTTP; file: pages cannot reliably load the external Babel module.');
  }
  url.searchParams.set('qa', '1');
  return url.href;
};

const selectTarget = async (options) => {
  const targets = await fetchJson(`${options.endpoint}/json/list`);
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  const wanted = options.appUrl ? new URL(withQaFlag(options.appUrl)) : null;

  let target = wanted
    ? pages.find((page) => {
        try {
          const pageUrl = new URL(page.url);
          return pageUrl.origin === wanted.origin && pageUrl.pathname === wanted.pathname;
        } catch {
          return false;
        }
      })
    : pages.find((page) => /[?&]qa(?:=|&|$)/.test(page.url));

  if (!target) target = pages.find((page) => /Spatial Command Center/i.test(page.title));
  if (!target && pages.length === 1) target = pages[0];

  if (!target && wanted) {
    target = await fetchJson(
      `${options.endpoint}/json/new?${encodeURIComponent(wanted.href)}`,
      { method: 'PUT' }
    );
    target.createdBySmoke = true;
  }

  if (!target) {
    throw new SmokeFailure(
      'No unambiguous app page target was found. Open the app with ?qa=1 or pass --url.'
    );
  }
  if (!wanted && (!target.url || target.url === 'about:blank')) {
    throw new SmokeFailure('The selected Chrome target is blank. Pass --url with the local app URL.');
  }
  return target;
};

class CdpConnection {
  constructor(webSocketUrl, timeout) {
    this.webSocketUrl = webSocketUrl;
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmokeFailure(`Timed out connecting to ${this.webSocketUrl}`)),
        this.timeout
      );
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new SmokeFailure(`WebSocket connection failed: ${this.webSocketUrl}`));
      }, { once: true });
    });

    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new SmokeFailure('Chrome closed the DevTools connection'));
      }
      this.pending.clear();
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
      if (message.error) pending.reject(new SmokeFailure(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SmokeFailure(`CDP command timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

const remoteValue = (argument) => {
  if (Object.prototype.hasOwnProperty.call(argument, 'value')) {
    try {
      return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value);
    } catch {
      return String(argument.value);
    }
  }
  return argument.unserializableValue || argument.description || argument.type || '<value>';
};

const exceptionText = (details) => {
  const headline = details.exception?.description || details.exception?.value || details.text || 'Runtime exception';
  const frame = details.stackTrace?.callFrames?.[0];
  return frame ? `${headline} (${frame.url || 'page'}:${frame.lineNumber + 1}:${frame.columnNumber + 1})` : String(headline);
};

const canonicalSnapshot = (snapshot) => ({
  screens: snapshot.screens.map(({ liveTransform, ...screen }) => screen),
  connections: snapshot.connections,
  currentPreset: snapshot.currentPreset,
  rotationSnap: snapshot.rotationSnap,
  positionSnap: snapshot.positionSnap
});

const angleDistance = (left, right) => Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
const vectorDistance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const target = await selectTarget(options);
  const cdp = new CdpConnection(target.webSocketDebuggerUrl, options.timeout);
  const passes = [];
  const runtimeErrors = [];
  const executionFrames = new Map();
  let mainFrameId = null;
  let captureErrors = true;
  let originalStorage;
  let storageCaptured = false;

  const pass = (label) => {
    passes.push(label);
    console.log(`PASS  ${label}`);
  };
  const ensure = (condition, message, detail) => {
    if (!condition) throw new SmokeFailure(detail ? `${message}: ${detail}` : message);
  };

  await cdp.connect();
  console.log(`TARGET ${target.title || '(untitled)'} — ${target.url}`);

  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) mainFrameId = frame.id;
  });
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    executionFrames.set(context.id, context.auxData?.frameId || null);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    executionFrames.delete(executionContextId);
  });
  cdp.on('Runtime.executionContextsCleared', () => executionFrames.clear());

  const belongsToMainFrame = (contextId) => {
    const frameId = executionFrames.get(contextId);
    return !frameId || !mainFrameId || frameId === mainFrameId;
  };
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    if (captureErrors && belongsToMainFrame(exceptionDetails.executionContextId)) {
      runtimeErrors.push(`exception: ${exceptionText(exceptionDetails)}`);
    }
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args, executionContextId }) => {
    if (captureErrors && (type === 'error' || type === 'assert') && belongsToMainFrame(executionContextId)) {
      runtimeErrors.push(`console.${type}: ${args.map(remoteValue).join(' ')}`);
    }
  });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw new SmokeFailure(exceptionText(result.exceptionDetails));
    return result.result?.value;
  };

  const waitForEvaluation = async (expression, label, timeout = options.timeout) => {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    throw new SmokeFailure(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
  };

  const snapshot = () => evaluate('window.__SCC_TEST__.snapshot()');
  const waitForState = async (predicate, label, timeout = options.timeout) => {
    const deadline = Date.now() + timeout;
    let latest;
    while (Date.now() < deadline) {
      try {
        latest = await snapshot();
        if (predicate(latest)) return latest;
      } catch {
        // The execution context is expected to disappear briefly during reload.
      }
      await sleep(100);
    }
    throw new SmokeFailure(`Timed out waiting for ${label}. Last snapshot: ${JSON.stringify(latest)}`);
  };

  const click = async (selector, label = selector) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${quote(selector)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    ensure(clicked, `Could not click ${label}`);
  };

  const clickPreset = (name) => click(
    `[data-testid="preset-button"][data-preset="${name}"]`,
    `${name} preset`
  );

  const clickScreenAction = async (screenId, action) => {
    const clicked = await evaluate(`(() => {
      const controls = [...document.querySelectorAll('[data-testid="screen-controls"]')]
        .find((element) => element.dataset.screenId === ${quote(screenId)});
      const button = controls && controls.querySelector('[data-screen-action=${quote(action)}]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    ensure(clicked, `Could not click ${action} for screen ${screenId}`);
  };

  const selectScreen = async (screenId) => {
    const selected = await evaluate(`(() => {
      const screen = [...document.querySelectorAll('[data-testid="spatial-screen"]')]
        .find((element) => element.dataset.screenId === ${quote(screenId)});
      if (!screen) return false;
      screen.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', button: 0
      }));
      return true;
    })()`);
    ensure(selected, `Could not select screen ${screenId}`);
    await waitForState((state) => state.selectedScreen === screenId, `selection of ${screenId}`);
  };

  const focusUrlInput = async (screenId) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll('[data-testid="url-input"]')]
        .find((element) => element.dataset.screenId === ${quote(screenId)});
      if (!input) return false;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return document.activeElement === input;
    })()`);
    ensure(focused, `Could not focus URL input for ${screenId}`);
  };

  const setUrlInput = async (screenId, value) => {
    const changed = await evaluate(`(() => {
      const input = [...document.querySelectorAll('[data-testid="url-input"]')]
        .find((element) => element.dataset.screenId === ${quote(screenId)});
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${quote(value)});
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return input.value;
    })()`);
    ensure(changed === value, `Could not set URL input for ${screenId}`);
  };

  const pressKey = async ({ key, code, keyCode, text = '' }) => {
    const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await cdp.send('Input.dispatchKeyEvent', {
      ...common,
      type: 'keyDown',
      ...(text ? { text, unmodifiedText: text } : {})
    });
    await cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  };

  const pressA = () => pressKey({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
  const pressEnter = () => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

  try {
    await cdp.send('Page.enable');
    const frameTree = await cdp.send('Page.getFrameTree');
    mainFrameId = frameTree.frameTree?.frame?.id || null;
    await cdp.send('Runtime.enable');

    const requestedUrl = withQaFlag(options.appUrl || target.url);
    const navigationMarker = `before-smoke-${Date.now()}-${Math.random()}`;
    await evaluate(`window.__SCC_SMOKE_PAGE_TOKEN__ = ${quote(navigationMarker)}`).catch(() => {});
    const navigation = await cdp.send('Page.navigate', { url: requestedUrl });
    ensure(!navigation.errorText, 'Chrome could not navigate to the app', navigation.errorText);

    await waitForEvaluation(`(() => {
      const params = new URLSearchParams(location.search);
      return params.has('qa') && window.__SCC_SMOKE_PAGE_TOKEN__ !== ${quote(navigationMarker)} &&
        typeof window.__SCC_TEST__?.snapshot === 'function';
    })()`, 'window.__SCC_TEST__');

    originalStorage = await evaluate(`localStorage.getItem(${quote(STORAGE_KEY)})`);
    storageCaptured = true;

    let state = await waitForState(
      (candidate) => Array.isArray(candidate.screens) && candidate.screens.every((screen) => screen.liveTransform),
      'mounted screen objects'
    );
    const mounted = await evaluate(`({
      app: Boolean(document.querySelector('[data-testid="spatial-app"]')),
      canvas: Boolean(document.querySelector('[data-testid="spatial-canvas"] canvas, canvas[data-testid="spatial-canvas"]')),
      mode: document.querySelector('[data-testid="spatial-app"]')?.dataset.mode,
      screens: document.querySelectorAll('[data-testid="spatial-screen"]').length,
      camera: window.__SCC_TEST__.cameraSnapshot(),
      orbit: window.__SCC_TEST__.orbitEnabled()
    })`);
    ensure(mounted.app && mounted.canvas, 'The app root or WebGL canvas did not mount');
    ensure(mounted.mode === state.interactionMode, 'DOM mode does not match the store');
    ensure(mounted.screens === state.screens.length, 'Mounted screen count does not match the store');
    ensure(mounted.camera && mounted.orbit !== null, 'Camera or OrbitControls did not register');
    ensure(state.interactionMode === 'browse' && state.isManipulatingScreen === false, 'Initial interaction state is invalid');
    pass('initial app, WebGL scene, QA hook, camera, and screens mounted');

    await clickPreset('Developer');
    state = await waitForState(
      (candidate) => candidate.currentPreset === 'Developer' && candidate.screens.length === 5,
      'Developer preset'
    );

    await evaluate(`document.querySelector('[data-testid="mode-toggle"]')?.focus()`);
    await pressA();
    state = await waitForState((candidate) => candidate.interactionMode === 'arrange', 'A shortcut to Arrange');
    ensure(await evaluate(`document.querySelector('[data-testid="spatial-app"]')?.dataset.mode`) === 'arrange', 'Arrange mode is missing from the DOM');
    await pressA();
    state = await waitForState((candidate) => candidate.interactionMode === 'browse', 'A shortcut back to Browse');
    pass('A toggles Browse/Arrange from a non-typing target');

    const guardScreenId = state.screens[0].id;
    await focusUrlInput(guardScreenId);
    const guardValue = await evaluate('document.activeElement.value');
    await pressA();
    await waitForEvaluation(
      `document.activeElement?.dataset?.testid === 'url-input' && document.activeElement.value === ${quote(`${guardValue}a`)}`,
      'typed A in the URL input'
    );
    state = await snapshot();
    ensure(state.interactionMode === 'browse', 'A toggled modes while the URL field was active');
    pass('typing A in the URL field does not toggle interaction mode');

    const beforeAddIds = new Set(state.screens.map((screen) => screen.id));
    const beforeAddCount = state.screens.length;
    await click('[data-testid="add-screen"]', 'add screen');
    state = await waitForState(
      (candidate) => candidate.screens.length === beforeAddCount + 1 && !beforeAddIds.has(candidate.selectedScreen),
      'new screen creation'
    );
    const addedId = state.selectedScreen;
    await waitForEvaluation(
      `[...document.querySelectorAll('[data-testid="url-input"]')].some((input) =>
        input.dataset.screenId === ${quote(addedId)} && document.activeElement === input)`,
      'new screen URL autofocus'
    );
    const added = state.screens.find((screen) => screen.id === addedId);
    ensure(added && !added.locked && added.source.type === 'iframe', 'New screen defaults are invalid');
    pass('add-screen creates, selects, and autofocuses a new iframe screen');

    await setUrlInput(addedId, 'example.com');
    await pressEnter();
    state = await waitForState(
      (candidate) => candidate.screens.find((screen) => screen.id === addedId)?.url === 'https://example.com/',
      'URL normalization'
    );
    const normalizedScreen = state.screens.find((screen) => screen.id === addedId);
    ensure(normalizedScreen.source.url === 'https://example.com/', 'Normalized URL did not reach ScreenSource');
    pass('URL entry normalizes example.com and updates screen/source state');

    await waitForEvaluation(
      `[...document.querySelectorAll('[data-testid="screen-controls"]')].some((controls) =>
        controls.dataset.screenId === ${quote(addedId)})`,
      'selected screen controls'
    );
    await clickScreenAction(addedId, 'toggle-lock');
    state = await waitForState(
      (candidate) => candidate.screens.find((screen) => screen.id === addedId)?.locked === true,
      'screen lock'
    );
    await waitForEvaluation(`[
      ...document.querySelectorAll('[data-testid="spatial-screen"]')
    ].find((screen) => screen.dataset.screenId === ${quote(addedId)})?.dataset.locked === 'true'`, 'locked DOM affordance');
    pass('lock action updates store and screen affordance');

    const original = state.screens.find((screen) => screen.id === addedId);
    const beforeDuplicateCount = state.screens.length;
    await clickScreenAction(addedId, 'duplicate');
    state = await waitForState(
      (candidate) => candidate.screens.length === beforeDuplicateCount + 1 && candidate.selectedScreen !== addedId,
      'screen duplication'
    );
    const duplicate = state.screens.find((screen) => screen.id === state.selectedScreen);
    ensure(duplicate && duplicate.id !== original.id, 'Duplicate ID is not unique');
    ensure(duplicate.url === original.url && duplicate.source.type === original.source.type, 'Duplicate did not copy its source');
    ensure(isDeepStrictEqual(duplicate.size, original.size), 'Duplicate did not copy screen size');
    ensure(vectorDistance(duplicate.position, original.position) > 0.1, 'Duplicate was not spatially offset');
    ensure(duplicate.locked === false, 'Duplicate should start unlocked');
    pass('duplicate copies screen/source geometry with a unique, offset, unlocked screen');

    for (const [presetName, expectedCount] of Object.entries(PRESET_SCREEN_COUNTS)) {
      await clickPreset(presetName);
      state = await waitForState(
        (candidate) => candidate.currentPreset === presetName && candidate.screens.length === expectedCount,
        `${presetName} preset state`
      );
      const ids = new Set(state.screens.map((screen) => screen.id));
      ensure(
        state.connections.every((connection) => ids.has(connection.sourceId) && ids.has(connection.targetId)),
        `${presetName} contains a dangling connection`
      );
      ensure(state.screens.every((screen) => screen.position.concat(screen.scale).every(Number.isFinite)), `${presetName} contains an invalid transform`);
    }
    pass('all seven presets produce valid screens and connection references');

    await clickPreset('TripleMonitor');
    const beforeArc = await waitForState(
      (candidate) => candidate.currentPreset === 'TripleMonitor' && candidate.screens.length === 3,
      'Triple Monitor before arc'
    );
    const camera = await evaluate('window.__SCC_TEST__.cameraSnapshot()');
    ensure(camera, 'Camera was unavailable for arc validation');
    await click('button[data-screen-action="snap-arc"]', 'global arc snap');
    state = await waitForState((candidate) => candidate.currentPreset === 'Custom', 'arc arrangement');
    ensure(
      state.screens.some((screen, index) => vectorDistance(screen.position, beforeArc.screens[index].position) > 0.01),
      'Arc arrangement did not change any screen position'
    );
    const arcHeights = state.screens.map((screen) => screen.position[1]);
    ensure(Math.max(...arcHeights) - Math.min(...arcHeights) < 1e-6, 'Arc screens are not aligned to one height');
    for (const screen of state.screens) {
      const expectedYaw = Math.atan2(
        camera.position[0] - screen.position[0],
        camera.position[2] - screen.position[2]
      );
      ensure(Math.abs(screen.rotation[0]) < 1e-6 && Math.abs(screen.rotation[2]) < 1e-6, `Arc tilted ${screen.id}`);
      ensure(angleDistance(screen.rotation[1], expectedYaw) < 1e-6, `Arc screen ${screen.id} does not face the camera`);
    }
    pass('arc snap aligns unlocked screens and keeps each upright/facing the camera');

    const persistedScreenId = state.screens[0].id;
    await selectScreen(persistedScreenId);
    await waitForEvaluation(
      `[...document.querySelectorAll('[data-testid="screen-controls"]')].some((controls) =>
        controls.dataset.screenId === ${quote(persistedScreenId)})`,
      'controls before persistence lock'
    );
    await clickScreenAction(persistedScreenId, 'toggle-lock');
    state = await waitForState(
      (candidate) => candidate.screens.find((screen) => screen.id === persistedScreenId)?.locked === true,
      'persistent lock state'
    );
    await setUrlInput(persistedScreenId, 'example.com');
    await pressEnter();
    state = await waitForState(
      (candidate) => candidate.screens.find((screen) => screen.id === persistedScreenId)?.url === 'https://example.com/',
      'persistent URL state'
    );
    await click('[data-testid="save-workspace"]', 'save workspace');
    const beforeReload = canonicalSnapshot(await snapshot());
    const stored = await evaluate(`JSON.parse(localStorage.getItem(${quote(STORAGE_KEY)}))`);
    ensure(stored && stored.version === 2, 'Saved workspace version is missing');
    ensure(stored.screens.some((screen) => screen.id === persistedScreenId && screen.locked && screen.url === 'https://example.com/'), 'Saved workspace omitted URL or lock state');

    const reloadMarker = `before-reload-${Date.now()}-${Math.random()}`;
    await evaluate(`window.__SCC_SMOKE_PAGE_TOKEN__ = ${quote(reloadMarker)}`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForEvaluation(`window.__SCC_SMOKE_PAGE_TOKEN__ !== ${quote(reloadMarker)} &&
      typeof window.__SCC_TEST__?.snapshot === 'function'`, 'QA hook after reload');
    state = await waitForState(
      (candidate) => candidate.screens.length === beforeReload.screens.length && candidate.screens.every((screen) => screen.liveTransform),
      'rehydrated workspace'
    );
    const afterReload = canonicalSnapshot(state);
    ensure(isDeepStrictEqual(afterReload, beforeReload), 'Reloaded workspace snapshot differs from the saved snapshot');
    ensure(state.interactionMode === 'browse' && state.selectedScreen === null, 'Transient mode/selection leaked through persistence');
    pass('save/reload preserves screen transforms, URL, lock, source, connections, and workspace settings');

    const uniqueErrors = [...new Set(runtimeErrors)];
    if (uniqueErrors.length) {
      throw new SmokeFailure(`Captured ${uniqueErrors.length} main-frame runtime error(s):\n  - ${uniqueErrors.join('\n  - ')}`);
    }
    pass('no main-frame Runtime exceptions or console errors were captured');
    console.log(`\nSMOKE OK  ${passes.length} validations passed`);
  } finally {
    captureErrors = false;
    if (storageCaptured) {
      try {
        if (originalStorage === null) await evaluate(`localStorage.removeItem(${quote(STORAGE_KEY)})`);
        else await evaluate(`localStorage.setItem(${quote(STORAGE_KEY)}, ${quote(originalStorage)})`);
        if (!target.createdBySmoke) await cdp.send('Page.reload', { ignoreCache: true });
        console.log('CLEAN restored the original workspace storage');
      } catch (error) {
        console.error(`CLEANUP ${error.message}`);
      }
    }
    cdp.close();
    if (target.createdBySmoke) {
      await fetch(`${options.endpoint}/json/close/${target.id}`).catch(() => {});
    }
  }
};

main().catch((error) => {
  console.error(`\nSMOKE FAILED  ${error.message}`);
  process.exitCode = 1;
});
