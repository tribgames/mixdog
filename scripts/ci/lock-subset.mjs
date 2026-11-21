#!/usr/bin/env node
// A package.json and package-lock.json that hold only the named root dependencies of this repository and everything they need,
// with the versions and integrity hashes the repository's own lockfile pins, so `npm ci` in the folder installs exactly those
// packages. release-gate.yml `core-tests` uses it: the Rust tests read the checkout's node_modules for pptxgenjs and jszip only
// (mixdog-office tests/pptx_script.rs), and the root tree's other packages (sharp, onnxruntime-node, esbuild, ...) are what makes
// a full install slow.
//
// Usage: node scripts/ci/lock-subset.mjs <output folder> [--from <package folder>] <package>...
//   --from names another package of the repository (apps/desktop: its devDependency @electron/asar, which
//   scripts/verify-runtime-dependency-versions.test.mjs reads); a dependency or a devDependency of that package may be named.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The edge type npm gives each name an entry depends on. A name in several fields gets one edge, and Arborist loads peers,
// then dependencies, then optionalDependencies, each replacing the last.
function edgesOut(entry) {
  const edges = new Map();
  for (const name of Object.keys(entry.peerDependencies ?? {}))
    edges.set(name, entry.peerDependenciesMeta?.[name]?.optional ? 'peerOptional' : 'peer');
  for (const name of Object.keys(entry.dependencies ?? {})) edges.set(name, 'prod');
  for (const name of Object.keys(entry.optionalDependencies ?? {})) edges.set(name, 'optional');
  return edges;
}

// Flags that describe the old root's tree; `optional` is computed again for the new root below.
const TREE_FLAGS = ['dev', 'optional', 'devOptional', 'peer'];

// The lockfile entry `from` (a key of `packages`, '' for the root) resolves `name` to: the nearest node_modules folder above it
// that holds the package, as Node does.
function resolveDependency(packages, from, name) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut < 0 ? '' : base.slice(0, cut);
  }
}

export function lockSubset({ lock, manifest, names }) {
  if (lock.lockfileVersion !== 3)
    throw new Error(`lockfileVersion ${lock.lockfileVersion} is not supported (3 expected)`);
  const rootDependencies = {};
  for (const name of names) {
    const spec = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    if (spec === undefined) throw new Error(`${name} is not a dependency of the package.json`);
    rootDependencies[name] = spec;
  }
  const packages = { '': { name: 'ci-subset', version: '0.0.0', dependencies: rootDependencies } };
  const walk = (key) => {
    if (key in packages) return;
    const entry = lock.packages[key];
    // `npm ci` installs what the hash says: an entry without one would install whatever the registry serves.
    if (!entry.link && !entry.integrity) throw new Error(`${key} has no integrity hash in the lockfile`);
    packages[key] = Object.fromEntries(Object.entries(entry).filter(([flag]) => !TREE_FLAGS.includes(flag)));
    for (const [name, type] of edgesOut(entry)) {
      const next = resolveDependency(lock.packages, key, name);
      if (next) walk(next);
      // An optional dependency (a platform binary) may be absent; a required one, a peer included, may not.
      else if (type === 'prod') throw new Error(`${key} needs ${name}, which the lockfile does not hold`);
      else if (type === 'peer')
        throw new Error(`${key} has the required peer ${name}, which the lockfile does not hold`);
    }
  };
  const roots = names.map((name) => {
    const key = resolveDependency(lock.packages, '', name);
    if (!key) throw new Error(`${name} is not in the lockfile`);
    walk(key);
    return key;
  });
  // `npm ci` takes `optional` from the lockfile rather than computing it, and checks os/cpu only on entries without it: a
  // package the new root reaches through required edges alone is required, every other one is optional.
  const required = new Set();
  const markRequired = (key) => {
    if (required.has(key)) return;
    required.add(key);
    for (const [name, type] of edgesOut(lock.packages[key])) {
      const next = type === 'prod' || type === 'peer' ? resolveDependency(lock.packages, key, name) : undefined;
      if (next) markRequired(next);
    }
  };
  for (const key of roots) markRequired(key);
  for (const key of Object.keys(packages)) if (key && !required.has(key)) packages[key].optional = true;
  return {
    manifest: {
      name: 'ci-subset',
      version: '0.0.0',
      private: true,
      dependencies: rootDependencies,
      ...(manifest.overrides && { overrides: manifest.overrides }),
    },
    lock: { name: 'ci-subset', version: '0.0.0', lockfileVersion: 3, requires: true, packages },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...rest] = process.argv.slice(2);
  const from = rest[0] === '--from' ? rest[1] : '';
  const names = rest[0] === '--from' ? rest.slice(2) : rest;
  if (!out || names.length === 0)
    throw new Error('usage: lock-subset.mjs <output folder> [--from <package folder>] <package>...');
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const read = (name) => JSON.parse(readFileSync(join(root, from, name), 'utf8'));
  const result = lockSubset({ lock: read('package-lock.json'), manifest: read('package.json'), names });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(result.manifest, null, 2)}\n`);
  writeFileSync(join(out, 'package-lock.json'), `${JSON.stringify(result.lock, null, 2)}\n`);
  console.log(`${Object.keys(result.lock.packages).length - 1} packages for ${names.join(', ')}`);
}
