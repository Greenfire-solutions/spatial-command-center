'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron/main');
const { shell } = require('electron');
const { BrowserSourceManager } = require('./browser-source-manager.cjs');
const { IpcBitmapFrameTransport } = require('./frame-transport.cjs');
const { registerBrowserSourceIpc } = require('./ipc.cjs');
const { ContentExtractor } = require('./extraction/content-extractor.cjs');
const { ClaudeAgentAdapter } = require('./agents/claude-adapter.cjs');
const { PERSISTENT_PARTITION } = require('./constants.cjs');
const { resolveApiKey } = require('./api-key.cjs');

/* Automated checks run against a throwaway profile so they can never read or
 * overwrite the saved layout, cookies or sign-ins of the person's real copy.
 * Must be set before the app is ready. Unset in normal use. */
if (process.env.SCC_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.SCC_USER_DATA_DIR));

/* A check that runs with no window should not put an icon in the Dock either. */
if (process.env.SCC_HIDDEN_WINDOW === '1' && process.platform === 'darwin') app.dock?.hide();

let mainWindow = null;
let sourceManager = null;
let frameTransport = null;
let disposeIpc = null;

const DIST_ENTRY_PATH = path.join(__dirname, '..', 'dist', 'index.html');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const resolveRendererTarget = () => {
  const configuredUrl = String(process.env.SCC_RENDERER_URL || '').trim();
  if (!configuredUrl) {
    return {
      kind: 'build',
      entryPath: DIST_ENTRY_PATH,
      trustedUrl: pathToFileURL(DIST_ENTRY_PATH)
    };
  }

  let developmentUrl;
  try {
    developmentUrl = new URL(configuredUrl);
  } catch {
    throw new Error('SCC_RENDERER_URL must be a valid loopback HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(developmentUrl.protocol) ||
    !LOOPBACK_HOSTS.has(developmentUrl.hostname) ||
    developmentUrl.username ||
    developmentUrl.password
  ) {
    throw new Error(
      'SCC_RENDERER_URL must use HTTP(S) on 127.0.0.1, localhost, or ::1 without credentials.'
    );
  }
  developmentUrl.hash = '';
  return {
    kind: 'development',
    entryUrl: developmentUrl,
    trustedUrl: new URL(developmentUrl.href)
  };
};

const isTrustedNavigation = (rendererTarget, navigationUrl) => {
  let destination;
  try {
    destination = new URL(navigationUrl);
  } catch {
    return false;
  }
  const trusted = rendererTarget.trustedUrl;
  if (rendererTarget.kind === 'development') {
    return destination.origin === trusted.origin && destination.pathname === trusted.pathname;
  }
  return destination.protocol === 'file:' && destination.pathname === trusted.pathname;
};

const configurePersistentBrowserSession = () => {
  const browserSession = session.fromPartition(PERSISTENT_PARTITION);
  // The POC keeps sign-in cookies/storage persistent while declining powerful
  // site permissions until a user-facing permission UI is implemented.
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
};

const secureSpatialWindow = (rendererTarget) => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    // SCC_HIDDEN_WINDOW=1 is for automated start-up checks only: the app runs,
    // but its window never appears on the screen of the Mac running the check.
    show: process.env.SCC_HIDDEN_WINDOW !== '1',
    backgroundColor: '#0f1115',
    title: 'Spatial Command Center',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true
    }
  });

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedNavigation(rendererTarget, navigationUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
};

const createApplicationWindow = async () => {
  const rendererTarget = resolveRendererTarget();
  configurePersistentBrowserSession();
  mainWindow = secureSpatialWindow(rendererTarget);
  frameTransport = new IpcBitmapFrameTransport({
    getTargetWebContents: () => mainWindow?.webContents || null
  });
  sourceManager = new BrowserSourceManager({ BrowserWindow, frameTransport });
  disposeIpc = registerBrowserSourceIpc({
    ipcMain,
    manager: sourceManager,
    frameTransport,
    getTrustedWebContents: () => mainWindow?.webContents || null,
    shell,
    contentExtractor: new ContentExtractor({ manager: sourceManager }),
    /* Constructed whether or not a key is present. Without one it reports
     * itself unavailable and the agent node shows as offline, which is a
     * clearer failure than the adapter not existing. */
    agentAdapters: [new ClaudeAgentAdapter({ apiKey: resolveApiKey() })],
    runtimeInfo: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      partition: PERSISTENT_PARTITION,
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      defaultFrameRate: 30
    }
  });

  mainWindow.on('closed', () => {
    disposeIpc?.();
    disposeIpc = null;
    sourceManager?.close();
    sourceManager = null;
    frameTransport = null;
    mainWindow = null;
  });

  const query = process.env.SCC_ELECTRON_QA === '1' ? { qa: '1' } : {};
  /* Extra renderer flags for automated runs, so a test can exercise a code path
   * that is normally only reachable inside an immersive session. */
  for (const pair of (process.env.SCC_RENDERER_QUERY || '').split('&')) {
    const [name, value] = pair.split('=');
    if (name) query[name] = value ?? '1';
  }
  if (rendererTarget.kind === 'development') {
    const developmentUrl = new URL(rendererTarget.entryUrl.href);
    for (const [name, value] of Object.entries(query)) developmentUrl.searchParams.set(name, value);
    await mainWindow.loadURL(developmentUrl.href);
  } else {
    if (!existsSync(rendererTarget.entryPath)) {
      throw new Error(
        `The app has not been built yet (${rendererTarget.entryPath} is missing). Double-click "Start Spatial Command Center", which builds it for you, or run "npm run build" first.`
      );
    }
    await mainWindow.loadFile(rendererTarget.entryPath, { query });
  }

  // Deterministic integration hook. Normal production startup leaves source
  // ownership to the React ChromiumSource mounted on screen s5.
  if (process.env.SCC_BROWSER_SOURCE_AUTOSTART === '1') {
    sourceManager.createSource({
      id: 'browser-s5',
      url: process.env.SCC_BROWSER_SOURCE_URL || 'https://example.com/',
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      frameRate: 30
    });
  }

  // Automated QA drives real pointer and keyboard input into this window over
  // the DevTools protocol. Both macOS and Chromium discard or heavily throttle
  // synthetic input, timers, and requestAnimationFrame for a window that is not
  // frontmost, which makes input-driven assertions fail for reasons unrelated
  // to the application. QA runs therefore take and hold the foreground. This is
  // gated behind SCC_ELECTRON_QA and never affects a normal launch.
  if (process.env.SCC_ELECTRON_QA === '1') {
    if (process.platform === 'darwin' && typeof app.focus === 'function') {
      app.focus({ steal: true });
    }
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.webContents.focus();
  }

  if (process.env.SCC_OPEN_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
};

app.whenReady().then(() => {
  if (process.env.SCC_HIDDEN_WINDOW === '1' && app.dock) app.dock.hide();
  createApplicationWindow().catch((error) => {
    console.error('Could not start Spatial Command Center:', error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createApplicationWindow().catch(console.error);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => sourceManager?.close());
