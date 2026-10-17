// The npm manifest and lockfile a desktop-installed server runtime installs
// its modules from (`npm ci --omit=dev --ignore-scripts` on the server): the
// runtime's production dependencies exactly as the root lockfile pins them,
// plus the desktop service bundle's externals (node-pty) as the desktop
// lockfile pins them, with their own dependency closure.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FIELDS_DROPPED = new Set(['dev', 'devOptional', 'extraneous', 'link']);

/** The generated lockfile's name in out/server/deps. electron-builder drops
 *  every file named `package-lock.json` from the packaged app by default, so
 *  the build writes it under this name and the payload ships it to the server
 *  as `server-deps/package-lock.json` (ssh/remote-install-payload.ts). */
export const REMOTE_SERVER_LOCKFILE = 'server-package-lock.json';

function lockEntry(entry) {
  const copy = {};
  for (const [key, value] of Object.entries(entry)) if (!LOCK_FIELDS_DROPPED.has(key)) copy[key] = value;
  if (entry.devOptional) copy.optional = true;
  return copy;
}

function packageName(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** Node's lookup inside a lockfile: `name` as seen from the package at `fromKey`. */
function resolveInLock(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const parent = base.lastIndexOf('/node_modules/');
    base = parent < 0 ? '' : base.slice(0, parent);
  }
}

export function remoteServerDependencies({ runtimePackage, runtimeLock, desktopLock, externals }) {
  const name = 'mixdog-remote-runtime';
  const version = String(runtimePackage.version);
  const dependencies = { ...runtimePackage.dependencies };
  const packages = {};
  for (const [key, entry] of Object.entries(runtimeLock.packages)) {
    if (!key?.startsWith('node_modules/') || entry.dev || entry.link) continue;
    packages[key] = lockEntry(entry);
  }
  const placed = new Map();
  // Place a desktop-lock package where node resolves it from `parentKey` in
  // the merged tree: reuse an equal version, hoist when free, else nest.
  const place = (sourceKey, parentKey) => {
    const entry = desktopLock.packages[sourceKey];
    const pkg = packageName(sourceKey);
    const visible = resolveInLock(packages, parentKey, pkg);
    if (visible && packages[visible].version === entry.version) return;
    const memo = `${sourceKey}>${parentKey}`;
    if (placed.has(memo)) return;
    const hoisted = `node_modules/${pkg}`;
    const key = !visible && !packages[hoisted] ? hoisted : `${parentKey ? `${parentKey}/` : ''}node_modules/${pkg}`;
    if (packages[key]) throw new Error(`Server lockfile conflict for ${pkg} at ${key}`);
    placed.set(memo, key);
    packages[key] = lockEntry(entry);
    const required = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const dependency of Object.keys(required)) {
      const source = resolveInLock(desktopLock.packages, sourceKey, dependency);
      if (!source) {
        if (entry.optionalDependencies?.[dependency]) continue;
        throw new Error(`Desktop lockfile has no ${dependency} for ${pkg}`);
      }
      place(source, key);
    }
  };
  for (const external of externals) {
    const source = desktopLock.packages[`node_modules/${external}`];
    if (!source) throw new Error(`Desktop lockfile has no ${external}`);
    if (dependencies[external] && packages[`node_modules/${external}`]?.version !== source.version) {
      throw new Error(`The runtime pins ${external} differently from the desktop`);
    }
    dependencies[external] = source.version;
    place(`node_modules/${external}`, '');
  }
  const sortedDependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
  const sortedPackages = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const packageJson = {
    name,
    version,
    private: true,
    description: 'Modules of a desktop-installed Mixdog server runtime',
    dependencies: sortedDependencies,
    ...(runtimePackage.overrides ? { overrides: runtimePackage.overrides } : {}),
  };
  const packageLock = {
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version, dependencies: sortedDependencies }, ...sortedPackages },
  };
  return { packageJson, packageLock };
}

/** Write {package.json,server-package-lock.json} into `outDir` (the build's out/server/deps). */
export function writeRemoteServerDependencies({ rootDir, desktopDir, outDir, externals }) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const { packageJson, packageLock } = remoteServerDependencies({
    runtimePackage: readJson(join(rootDir, 'package.json')),
    runtimeLock: readJson(join(rootDir, 'package-lock.json')),
    desktopLock: readJson(join(desktopDir, 'package-lock.json')),
    externals,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(outDir, REMOTE_SERVER_LOCKFILE), `${JSON.stringify(packageLock, null, 2)}\n`);
  return outDir;
}
