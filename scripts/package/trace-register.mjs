/*
 * package.sh runs the unit tests once with this preloaded, to learn exactly
 * which files inside node_modules the tests load. Those files, and nothing
 * else, go into the zip's node_modules, so the tests run from inside the zip
 * without npm and without the 300 MB of development packages.
 */
import Module, { register } from 'node:module';
import { appendFileSync } from 'node:fs';

register(new URL('./trace-hooks.mjs', import.meta.url));

const original = Module._resolveFilename;
Module._resolveFilename = function traced(...args) {
  const resolved = original.apply(this, args);
  if (typeof resolved === 'string' && resolved.includes('/node_modules/')) {
    appendFileSync(process.env.SCC_TRACE_FILE, resolved + '\n');
  }
  return resolved;
};
