'use strict';

const { app, BrowserWindow } = require('electron/main');
const { BrowserSourceManager } = require('../browser-source-manager.cjs');

const TARGETS = [
  'https://example.com/',
  'https://www.wikipedia.org/',
  'https://www.apple.com/',
  'https://www.google.com/',
  'https://mail.google.com/'
];
const SOURCE_ID = 'browser-site-smoke';
const NAVIGATION_TIMEOUT = Number(process.env.SCC_SITE_SMOKE_TIMEOUT) || 30000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (predicate, label, timeout = NAVIGATION_TIMEOUT) => {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await predicate();
    if (latest) return latest;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${latest ? ` (${JSON.stringify(latest)})` : ''}.`);
};

class CountingFrameTransport {
  constructor() {
    this.counts = new Map();
    this.latest = new Map();
  }

  publish(frame) {
    this.counts.set(frame.sourceId, (this.counts.get(frame.sourceId) || 0) + 1);
    this.latest.set(frame.sourceId, {
      width: frame.width,
      height: frame.height,
      capturedAt: Date.now()
    });
  }

  count(sourceId) { return this.counts.get(sourceId) || 0; }
  releaseSource(sourceId) { this.counts.delete(sourceId); this.latest.delete(sourceId); }
  close() { this.counts.clear(); this.latest.clear(); }
}

const run = async () => {
  const frameTransport = new CountingFrameTransport();
  const loadErrors = new Map();
  const manager = new BrowserSourceManager({
    BrowserWindow,
    frameTransport,
    // Never read or mutate the user's persistent signed-in browser profile.
    partition: `scc-site-smoke-${process.pid}`
  });
  manager.on('event', (event) => {
    if (event.type === 'load-error') loadErrors.set(event.sourceId, event);
  });

  const results = [];
  try {
    manager.createSource({
      id: SOURCE_ID,
      url: TARGETS[0],
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      frameRate: 12
    });

    for (let index = 0; index < TARGETS.length; index += 1) {
      const requestedUrl = TARGETS[index];
      const startingFrameCount = frameTransport.count(SOURCE_ID);
      loadErrors.delete(SOURCE_ID);
      if (index > 0) manager.navigate(SOURCE_ID, requestedUrl);

      const snapshot = await waitFor(() => {
        const current = manager.getSource(SOURCE_ID);
        const hasFreshFrame = frameTransport.count(SOURCE_ID) > startingFrameCount;
        if ((!current.loading && current.state === 'ready' && hasFreshFrame) || current.state === 'error') {
          return current;
        }
        return null;
      }, requestedUrl);

      const error = loadErrors.get(SOURCE_ID);
      results.push({
        requestedUrl,
        finalUrl: snapshot.url,
        title: snapshot.title,
        state: snapshot.state,
        frameCount: frameTransport.count(SOURCE_ID) - startingFrameCount,
        frame: frameTransport.latest.get(SOURCE_ID) || null,
        error: error ? error.error || error.errorCode || 'load-error' : null,
        ok: snapshot.state === 'ready' && frameTransport.count(SOURCE_ID) > startingFrameCount
      });
    }
  } finally {
    manager.close();
  }

  console.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
};

app.whenReady().then(run).then(() => app.exit(process.exitCode || 0)).catch((error) => {
  console.error(error.stack || error);
  app.exit(1);
});

setTimeout(() => {
  console.error('Representative-site smoke test exceeded its overall timeout.');
  app.exit(1);
}, NAVIGATION_TIMEOUT * TARGETS.length + 15000).unref();
