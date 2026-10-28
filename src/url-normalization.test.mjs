import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBrowserInput } from './url-normalization.js';

test('normalizes bare domains to HTTPS and preserves complete HTTP(S) URLs', () => {
  assert.deepEqual(normalizeBrowserInput('example.com'), {
    ok: true,
    url: 'https://example.com/',
    kind: 'url'
  });
  assert.equal(normalizeBrowserInput('https://apple.com/store?q=mac#buy').url, 'https://apple.com/store?q=mac#buy');
  assert.equal(normalizeBrowserInput('http://example.com/test').url, 'http://example.com/test');
  assert.equal(normalizeBrowserInput('example.com:8443/test').url, 'https://example.com:8443/test');
});

test('uses HTTP for localhost and private development hosts', () => {
  assert.equal(normalizeBrowserInput('localhost:4173/test').url, 'http://localhost:4173/test');
  assert.equal(normalizeBrowserInput('devbox:3000').url, 'http://devbox:3000/');
  assert.equal(normalizeBrowserInput('127.0.0.1:9000').url, 'http://127.0.0.1:9000/');
  assert.equal(normalizeBrowserInput('192.168.1.25:8080/app').url, 'http://192.168.1.25:8080/app');
  assert.equal(normalizeBrowserInput('[::1]:5173').url, 'http://[::1]:5173/');
});

test('turns search-like input into a Google search', () => {
  const result = normalizeBrowserInput('spatial browser input routing');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'search');
  assert.equal(result.url, 'https://www.google.com/search?q=spatial%20browser%20input%20routing');
});

test('supports an empty new tab but rejects unsafe schemes and credentials', () => {
  assert.deepEqual(normalizeBrowserInput('  '), { ok: true, url: '', kind: 'empty' });
  assert.equal(normalizeBrowserInput('javascript:alert(1)').ok, false);
  assert.equal(normalizeBrowserInput('file:///tmp/example.html').ok, false);
  assert.deepEqual(normalizeBrowserInput('https://user:secret@example.com'), {
    ok: false,
    url: '',
    kind: 'invalid',
    error: 'Addresses with embedded usernames or passwords are not supported.'
  });
});
