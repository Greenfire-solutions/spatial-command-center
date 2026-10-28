/*
 * The headset entry point.
 *
 * This entry exists so the Quest build never receives Electron's trusted
 * preload. `scripts/dev.mjs` refuses any non-loopback host precisely because
 * the desktop renderer is trusted; the headset is reached over the network, so
 * it must be a different document with a different bridge.
 *
 * Order matters here. The synthetic bridge is installed on `window` before
 * `app.jsx` is imported, because `app.jsx` mounts itself at import time and
 * `resolveBrowserProvider()` memoizes whichever bridge it finds first.
 */

import { installDiagnostics } from './diagnostics.js';
import { installSyntheticBridge } from './synthetic-bridge.js';
import { installXrTestHarness } from './test-harness.js';

/* Installed first, so an error thrown while the bridge or the app is still
 * loading is captured rather than lost. */
/* Marks this document as the headset probe build, so the scene reports
 * telemetry from every session rather than only when a flag is present. */
window.__SCC_XR_PROBE__ = true;

installDiagnostics();

const bridge = installSyntheticBridge();
if (bridge) {
  console.info('[xr-probe] synthetic browser bridge installed. Pages are static.');
}

/* Installed here for the same reason the bridge is: navigator.xr must exist
 * before `app.jsx` mounts, because `xr-store.js` is created at module scope and
 * the entry controls decide what to offer from what they find. Inert unless
 * ?xr-harness=1, and inert on a real headset regardless. */
installXrTestHarness();

import('../app.jsx').catch((error) => {
  console.error('[xr-probe] failed to start the workspace', error);
  const root = document.getElementById('root');
  if (root) {
    root.textContent = `Failed to start the workspace: ${error && error.message}`;
  }
});
