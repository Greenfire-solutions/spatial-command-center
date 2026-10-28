'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { IPC_CHANNELS } = require('../constants.cjs');

/*
 * preload.cjs cannot import project files: Electron's sandboxed preload runs
 * before the module graph exists, so the channel names are deliberately
 * repeated there as literals. That duplication is a correctness hazard — a
 * renamed channel in constants.cjs would leave the preload silently talking to
 * a channel nobody handles, and the failure would look like an unresponsive
 * browser source rather than a typo.
 *
 * This test reads the preload as text and asserts the two lists are identical.
 */
test('preload channel literals match the main-process channel constants', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');

  const channelBlock = preloadSource.slice(
    preloadSource.indexOf('const CHANNELS = Object.freeze({'),
    preloadSource.indexOf('});', preloadSource.indexOf('const CHANNELS = Object.freeze({'))
  );
  assert.ok(channelBlock, 'the preload declares a CHANNELS map');

  const preloadChannels = new Set(
    [...channelBlock.matchAll(/'([^']*spatial-browser:[^']*)'/g)].map((match) => match[1])
  );
  const mainChannels = new Set(Object.values(IPC_CHANNELS));

  const missingFromPreload = [...mainChannels].filter((channel) => !preloadChannels.has(channel));
  const unknownInPreload = [...preloadChannels].filter((channel) => !mainChannels.has(channel));

  assert.deepEqual(
    missingFromPreload,
    [],
    `constants.cjs declares channels the preload never exposes: ${missingFromPreload.join(', ')}`
  );
  assert.deepEqual(
    unknownInPreload,
    [],
    `the preload uses channels the main process does not declare: ${unknownInPreload.join(', ')}`
  );
  assert.equal(preloadChannels.size, mainChannels.size, 'both sides declare the same number of channels');
});

test('every declared channel is actually handled or listened for', () => {
  const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'ipc.cjs'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const wired = ipcSource + mainSource;

  // Channels the main process sends outward rather than receiving.
  const outbound = new Set([IPC_CHANNELS.FRAME, IPC_CHANNELS.METADATA, IPC_CHANNELS.EVENT]);

  for (const [name, channel] of Object.entries(IPC_CHANNELS)) {
    const referenced = wired.includes(`IPC_CHANNELS.${name}`);
    assert.ok(
      referenced,
      `${channel} (IPC_CHANNELS.${name}) is declared but never wired in ipc.cjs or main.cjs`
    );
    if (!outbound.has(channel)) {
      assert.ok(
        wired.includes(`handle(IPC_CHANNELS.${name}`) ||
          wired.includes(`ipcMain.on(IPC_CHANNELS.${name}`),
        `${channel} has no handler or listener`
      );
    }
  }
});
