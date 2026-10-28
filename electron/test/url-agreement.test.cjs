'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeNavigationUrl } = require('../validation.cjs');

/*
 * The renderer normalizes what a user types; the main process re-validates it
 * before Chromium loads it. Those are two separate implementations because one
 * is CommonJS and the other is an ES module bundled by Vite, and they had
 * silently drifted: the renderer sent private and link-local addresses to
 * http://, the main process to https://, and bare host:port forms were
 * accepted by one and rejected by the other.
 *
 * This test is the reason that cannot happen again.
 */
const CORPUS = [
  'example.com',
  'www.example.com/path?query=1#hash',
  'https://example.com/',
  'http://example.com/',
  'localhost',
  'localhost:3000',
  'localhost:3000/app',
  '127.0.0.1',
  '127.0.0.1:8080',
  '0.0.0.0:8080',
  '10.0.0.5',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.1.1',
  '169.254.1.1',
  'printer.local',
  'dev.localhost',
  'myhost:8080',
  '[::1]:9000',
  'a.b.c.d.e.f/g',
  'hello world',
  'what is a spatial browser',
  'https://example.com/a?b=c&d=e'
];

const REJECTED_BY_BOTH = [
  'javascript:alert(1)',
  'file:///etc/passwd',
  'chrome://settings',
  'data:text/html,<h1>x</h1>',
  'https://user:secret@example.com/'
];

test('the renderer and main-process URL normalizers agree', async () => {
  const rendererModule = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'src', 'url-normalization.js')).href
  );
  const { normalizeBrowserInput } = rendererModule;

  const disagreements = [];
  for (const input of CORPUS) {
    let renderer;
    let main;
    try {
      const result = normalizeBrowserInput(input);
      renderer = result.ok ? result.url : `REJECTED`;
    } catch {
      renderer = 'THREW';
    }
    try {
      main = normalizeNavigationUrl(input);
    } catch (error) {
      main = `REJECTED:${error.code}`;
    }
    if (renderer !== main) disagreements.push({ input, renderer, main });
  }

  assert.deepEqual(
    disagreements,
    [],
    `The two normalizers disagree:\n${disagreements.map((row) => `  ${row.input}\n    renderer: ${row.renderer}\n    main:     ${row.main}`).join('\n')}`
  );
});

test('both normalizers refuse the same unsafe inputs', async () => {
  const { normalizeBrowserInput } = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'src', 'url-normalization.js')).href
  );

  for (const hostile of REJECTED_BY_BOTH) {
    const rendererResult = normalizeBrowserInput(hostile);
    assert.equal(rendererResult.ok, false, `renderer must refuse ${hostile}`);
    assert.throws(() => normalizeNavigationUrl(hostile), `main must refuse ${hostile}`);
  }
});

test('private and link-local addresses resolve over http on both sides', () => {
  for (const host of ['10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '127.0.0.1', 'printer.local']) {
    assert.match(
      normalizeNavigationUrl(host),
      /^http:\/\//,
      `${host} is a local address and must not be forced to https`
    );
  }
  assert.match(normalizeNavigationUrl('example.com'), /^https:\/\//, 'public hosts still default to https');
});
