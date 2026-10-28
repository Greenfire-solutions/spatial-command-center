#!/usr/bin/env node
/*
 * Copies just enough of node_modules for the packaged app. Used by package.sh.
 *
 *   copy-deps.mjs packages <projectRoot> <destNodeModules> name [name...]
 *       each named package and everything it depends on, whole
 *   copy-deps.mjs files <projectRoot> <destNodeModules> <traceFile>
 *       only the files listed in a trace (see trace-register.mjs), plus the
 *       package.json files Node reads on the way to them
 *
 * TypeScript sources, type declarations, source maps and READMEs are left out
 * of both: nothing at run time reads them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, rootArg, destArg, ...rest] = process.argv.slice(2);
if (!mode || !rootArg || !destArg) {
  console.error('usage: copy-deps.mjs packages|files <projectRoot> <destNodeModules> ...');
  process.exit(2);
}
const root = path.resolve(rootArg);
const modules = path.join(root, 'node_modules');
const dest = path.resolve(destArg);

const SKIP = /(\.d\.[cm]?ts|\.[cm]?ts|\.map|\.tsbuildinfo)$|(^|\/)(README|CHANGELOG|HISTORY)(\.[a-z]+)?$/i;

const target = (source) => path.join(dest, path.relative(modules, source));

const findPackageDir = (name, fromDir) => {
  for (let dir = fromDir; dir.startsWith(root); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) break;
  }
  return null;
};

const copyTree = (from, to) => {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination);
    else if (entry.isFile() && !SKIP.test(entry.name)) {
      mkdirSync(to, { recursive: true });
      copyFileSync(source, destination);
    }
  }
};

if (mode === 'packages') {
  const seen = new Set();
  const queue = rest.map((name) => [name, root]);
  while (queue.length) {
    const [name, fromDir] = queue.shift();
    const dir = findPackageDir(name, fromDir);
    if (!dir) {
      console.error(`copy-deps: ${name} is not installed (needed from ${path.relative(root, fromDir) || '.'})`);
      process.exit(1);
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    copyTree(dir, target(dir));
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies || {})) queue.push([dep, dir]);
    for (const dep of Object.keys(manifest.optionalDependencies || {})) {
      if (findPackageDir(dep, dir)) queue.push([dep, dir]);
    }
  }
  console.log(`copy-deps: ${seen.size} packages`);
} else if (mode === 'files') {
  const traced = new Set(readFileSync(rest[0], 'utf8').split('\n').filter(Boolean)
    .map((line) => (line.startsWith('file:') ? fileURLToPath(line) : line)));
  let count = 0;
  for (const file of traced) {
    if (!file.startsWith(modules + path.sep) || !existsSync(file)) continue;
    mkdirSync(path.dirname(target(file)), { recursive: true });
    copyFileSync(file, target(file));
    count += 1;
    /* Node reads every package.json between the file and node_modules to
     * learn the module type and the package's exports map. */
    for (let dir = path.dirname(file); dir.length > modules.length; dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest) && !existsSync(target(manifest))) copyFileSync(manifest, target(manifest));
    }
    /* A package's licence travels with any part of it that is shipped. */
    const parts = path.relative(modules, file).split(path.sep);
    const pkgRoot = path.join(modules, ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1));
    for (const name of readdirSync(pkgRoot)) {
      if (/^(licen[cs]e|copying)/i.test(name) && statSync(path.join(pkgRoot, name)).isFile()) {
        copyFileSync(path.join(pkgRoot, name), target(path.join(pkgRoot, name)));
      }
    }
  }
  console.log(`copy-deps: ${count} traced files`);
} else {
  console.error(`copy-deps: unknown mode ${mode}`);
  process.exit(2);
}
