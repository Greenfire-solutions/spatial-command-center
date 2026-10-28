'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveApiKey, keyFilePath } = require('../api-key.cjs');

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scc-key-'));
const writeKey = (home, text) => {
  fs.mkdirSync(path.dirname(keyFilePath(home)), { recursive: true });
  fs.writeFileSync(keyFilePath(home), text);
};

test('no key anywhere means no key, not a crash', () => {
  assert.equal(resolveApiKey({ env: {}, home: tempHome() }), undefined);
});

test('the key file in the home folder is read, first line only', () => {
  const home = tempHome();
  writeKey(home, '\n  sk-ant-from-file  \nmy note about this key\n');
  assert.equal(resolveApiKey({ env: {}, home }), 'sk-ant-from-file');
});

test('the environment wins over the file', () => {
  const home = tempHome();
  writeKey(home, 'sk-ant-from-file\n');
  assert.equal(resolveApiKey({ env: { ANTHROPIC_API_KEY: ' sk-ant-env ' }, home }), 'sk-ant-env');
});

test('an empty key file counts as no key', () => {
  const home = tempHome();
  writeKey(home, '\n   \n');
  assert.equal(resolveApiKey({ env: {}, home }), undefined);
});
