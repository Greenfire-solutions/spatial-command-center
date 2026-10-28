'use strict';

const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Where the optional Anthropic API key comes from.
 *
 * A developer sets ANTHROPIC_API_KEY in their shell. A person who double-clicks
 * the app has no shell, so the key can also live in a plain text file in their
 * home folder: ~/Spatial Command Center Data/anthropic-api-key.txt.
 * The environment wins when both exist. No key is fine: the AI agent then shows
 * as offline and everything else works.
 */
const KEY_FOLDER_NAME = 'Spatial Command Center Data';
const KEY_FILE_NAME = 'anthropic-api-key.txt';

const keyFilePath = (home = os.homedir()) => path.join(home, KEY_FOLDER_NAME, KEY_FILE_NAME);

const resolveApiKey = ({ env = process.env, home = os.homedir(), read = readFileSync } = {}) => {
  const fromEnv = String(env.ANTHROPIC_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    /* First non-empty line only, so a note under the key does not break it. */
    const line = String(read(keyFilePath(home), 'utf8'))
      .split(/\r?\n/).map((part) => part.trim()).find(Boolean);
    return line || undefined;
  } catch {
    return undefined;
  }
};

module.exports = { resolveApiKey, keyFilePath, KEY_FOLDER_NAME, KEY_FILE_NAME };
