import { UnavailableBrowserProvider } from './browser-provider.js';
import { ElectronChromiumProvider } from './electron-chromium-provider.js';
import { WebSocketBrowserProvider } from './remote/websocket-browser-provider.js';

export { BrowserSourceProvider, UnavailableBrowserProvider } from './browser-provider.js';
export { ElectronChromiumProvider } from './electron-chromium-provider.js';
export { WebSocketBrowserProvider } from './remote/websocket-browser-provider.js';
export { FRAME_FORMATS, describeBitmapFrame, isBitmapFormat } from './frame-formats.js';

let cachedProvider = null;
let cachedBridge = null;
let cachedRemoteKey = null;

/*
 * Remote host configuration, read from the page URL.
 *
 * The headset opens the build with the host address and token in the query
 * string, which is why this is configuration rather than feature detection:
 * the Quest browser has no Electron bridge, so detection alone could only ever
 * conclude "offline".
 *
 *   ?host=ws://localhost:8787&token=<token>
 *
 * With `adb reverse` the host really is localhost from the headset's point of
 * view, so nothing is exposed to the network.
 */
const remoteConfigFromLocation = () => {
  if (typeof window === 'undefined' || !window.location) return null;
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
  const url = params.get('host');
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) return null;
  return { url, token: params.get('token') || '' };
};

/*
 * The host the serving page was told about.
 *
 * `npm run vr` starts the host and the static server together, so the server
 * knows the address and token and injects them ahead of the module graph. That
 * makes the workspace work from any URL it is reached by — a bookmark, a
 * restored tab, the bare origin — instead of only from one link carrying a
 * query string that a wearer had to keep intact.
 *
 * It is a fallback rather than the primary source: an explicit `?host=` still
 * wins, so a session can always be pointed somewhere else without restarting
 * the server.
 */
const remoteConfigFromPage = () => {
  if (typeof window === 'undefined') return null;
  const injected = window.__SCC_REMOTE__;
  if (!injected || typeof injected.url !== 'string') return null;
  if (!/^wss?:\/\//i.test(injected.url)) return null;
  return { url: injected.url, token: typeof injected.token === 'string' ? injected.token : '' };
};

/*
 * Resolve the provider that should serve browser sources right now.
 *
 * Today there is exactly one real implementation, selected by the presence of
 * the Electron preload bridge. A remote provider will be selected here too —
 * by configuration rather than by feature detection — and nothing above this
 * function will need to change.
 *
 * An explicit provider always wins, which is how tests inject a fake.
 */
/*
 * Where this page's browser host is, and how it was decided.
 *
 * Exported so the precedence can be tested without opening a socket:
 * constructing a provider connects, which is the wrong thing to do in a unit
 * test and the right thing to do everywhere else.
 */
export const resolveRemoteConfig = () => remoteConfigFromLocation() || remoteConfigFromPage();

export const resolveBrowserProvider = (explicitProvider) => {
  if (explicitProvider) return explicitProvider;

  /* Configuration wins over detection. A desktop build launched with a host
   * in the query string talks to that host, which is how the remote path is
   * exercised without a headset in hand. */
  const remote = remoteConfigFromLocation() || remoteConfigFromPage();
  if (remote) {
    const key = `${remote.url}|${remote.token}`;
    if (cachedRemoteKey !== key || cachedProvider?.id !== 'websocket-chromium') {
      cachedProvider?.close?.();
      cachedRemoteKey = key;
      cachedBridge = null;
      cachedProvider = new WebSocketBrowserProvider(remote);
      /* Wired here rather than inside the provider, so the transport stays
       * ignorant of the workspace it happens to be serving. */
      /* Fires on every connect, including the first, so a screen that mounted
       * before the socket opened still gets its source created. */
      cachedProvider.onReconnect = () => {
        import('../store/workspace-store.js')
          .then(({ useStore }) => useStore.getState().recreateBrowserSources())
          .catch(() => {});
      };
    }
    return cachedProvider;
  }

  const bridge = typeof window !== 'undefined' ? window.spatialBrowser : null;
  if (!bridge) {
    if (!cachedProvider || cachedProvider.id !== 'unavailable') {
      cachedProvider = new UnavailableBrowserProvider(
        'Local Chromium is offline. Launch the Electron app to use Full Browser.'
      );
      cachedBridge = null;
    }
    return cachedProvider;
  }

  // Reuse the adapter while the underlying bridge is the same object, so that
  // provider identity is stable across renders and can be used in dependency
  // arrays without causing effects to re-run every frame.
  if (cachedBridge !== bridge) {
    cachedBridge = bridge;
    cachedProvider = new ElectronChromiumProvider(bridge);
  }
  return cachedProvider;
};

/* Test seam: forget any memoized provider. */
export const resetBrowserProviderCache = () => {
  cachedProvider = null;
  cachedBridge = null;
  cachedRemoteKey = null;
};
