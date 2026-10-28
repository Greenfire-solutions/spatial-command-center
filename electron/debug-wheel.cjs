'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron/main');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'browser-source-test.html'), 'utf8');
const server = require('node:http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixture);
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    x: -4096,
    y: -4096,
    show: true,
    webPreferences: {
      offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  win.webContents.on('did-finish-load', async () => {
    console.log('loaded');
    console.log('before', await win.webContents.executeJavaScript('window.scrollY'));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 640, y: 400, modifiers: [] });
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 640, y: 400, deltaY: 420, wheelTicksY: 4, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: [] });
    setTimeout(async () => {
      const val = await win.webContents.executeJavaScript('({scrollY: window.scrollY, body: document.body.scrollHeight})');
      console.log('after', val);
      server.close(() => app.exit(0));
    }, 1500);
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  setTimeout(() => {
    console.error('timeout');
    server.close(() => app.exit(1));
  }, 10000);
});
