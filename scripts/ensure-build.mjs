#!/usr/bin/env node
/*
 * Builds the app only when it has to: when there is no build yet, or when a
 * source file is newer than the build (an update). A buyer's first start used
 * to stop at "Renderer build not found"; now `npm start` and the double-click
 * launcher both build first, with a plain message.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'dist', 'index.html');
const inputs = ['src', 'index.html', 'xr.html', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js', 'package-lock.json'];

const newest = (target) => {
  if (!existsSync(target)) return 0;
  const info = statSync(target);
  if (!info.isDirectory()) return info.mtimeMs;
  let latest = 0;
  for (const name of readdirSync(target)) latest = Math.max(latest, newest(path.join(target, name)));
  return latest;
};

export const needsBuild = () => {
  if (!existsSync(built)) return 'first';
  const builtAt = statSync(built).mtimeMs;
  return inputs.some((input) => newest(path.join(root, input)) > builtAt) ? 'update' : null;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reason = needsBuild();
  if (!reason) {
    console.log('Already built.');
  } else {
    console.log(reason === 'first'
      ? 'First time only: building the app (about 1 to 3 minutes).'
      : 'The app was updated: rebuilding it (about 1 to 3 minutes).');
    const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(vite)) {
      console.error('The app\'s parts are not installed yet. Run "npm install" first, or double-click Start Spatial Command Center.');
      process.exit(1);
    }
    const result = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    console.log('Built.');
  }
}
