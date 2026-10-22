#!/usr/bin/env node
// Verifies that the dependency versions packed into the desktop runtime match
// the lockfiles: every package.json inside apps/desktop/.runtime/runtime.asar
// (and its .unpacked sidecar) against the root package-lock.json, and the
// shipped node-pty against apps/desktop/package-lock.json. A stale install or
// a reused prepared-runtime cache otherwise ships old versions unnoticed.

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DESKTOP_PTY_PACKAGE = '@homebridge/node-pty-prebuilt-multiarch';
const DESKTOP_PTY_LOCK_KEY = `node_modules/${DESKTOP_PTY_PACKAGE}`;

/**
 * The package-lock `packages` key of an installed package's package.json, or
 * null when the path is not `node_modules/<name>[/node_modules/<name>...]/package.json`
 * (nested package.json files such as `dist/package.json` markers are ignored).
 */
export function lockKeyForPackageJson(path) {
  const segments = String(path).replaceAll('\\', '/').replace(/^\/+/, '').split('/');
  if (segments.pop() !== 'package.json' || segments.length === 0) return null;
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== 'node_modules' || !segments[index + 1]) return null;
    if (segments[index + 1].startsWith('@')) {
      if (!segments[index + 2]) return null;
      index += 3;
    } else {
      index += 2;
    }
  }
  return segments.join('/');
}

/**
 * Compare shipped package versions with the lockfile.
 * `shipped` is a list of { key, version, source }; `lockPackages` is the
 * lockfile's `packages` map. The root package itself is installed under
 * node_modules/<its name> but is not a lock entry, so it is compared with the
 * lockfile's root version.
 */
export function compareShippedVersions({ lockPackages, shipped }) {
  const root = lockPackages[''] ?? {};
  const rootKey = root.name ? `node_modules/${root.name}` : null;
  const mismatches = [];
  for (const { key, version, source } of shipped) {
    let entry = lockPackages[key];
    // A linked or workspace entry carries `link: true` and `resolved` (the
    // target's lock key) instead of a version.
    if (entry?.link) {
      entry = lockPackages[entry.resolved];
      if (!entry) {
        mismatches.push(`${key}: lockfile link target ${lockPackages[key].resolved} is missing (${source})`);
        continue;
      }
    }
    const expected = key === rootKey && !lockPackages[key] ? root.version : entry?.version;
    if (expected === undefined) {
      mismatches.push(`${key}: shipped ${version} but absent from the lockfile (${source})`);
    } else if (version === undefined) {
      mismatches.push(`${key}: shipped manifest has no version, lockfile ${expected} (${source})`);
    } else if (version !== expected) {
      mismatches.push(`${key}: shipped ${version}, lockfile ${expected} (${source})`);
    }
  }
  return mismatches;
}

/** The shipped desktop node-pty version against the desktop lockfile. */
export function compareDesktopPtyVersion({ desktopLockPackages, shippedVersion, source }) {
  const expected = desktopLockPackages[DESKTOP_PTY_LOCK_KEY]?.version;
  if (expected === undefined) return [`${DESKTOP_PTY_PACKAGE}: absent from the desktop lockfile`];
  if (shippedVersion !== expected) {
    return [`${DESKTOP_PTY_PACKAGE}: shipped ${shippedVersion}, desktop lockfile ${expected} (${source})`];
  }
  return [];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// @electron/asar is a devDependency of apps/desktop, the only install CI has.
export const desktopRequire = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'package.json')
);

/** Every packed package.json in runtime.asar, as { key, version, source }. */
export async function readArchivePackages(archive) {
  const asar = desktopRequire('@electron/asar');
  const shipped = [];
  for (const entry of asar.listPackage(archive, { isPack: false })) {
    const archivePath = entry.replaceAll('\\', '/').replace(/^\/+/, '');
    const key = lockKeyForPackageJson(archivePath);
    if (!key) continue;
    // Unpacked files are read from the sidecar by readSidecarPackages.
    if (asar.statFile(archive, archivePath.replaceAll('/', sep)).unpacked) continue;
    const { version } = JSON.parse(asar.extractFile(archive, archivePath.replaceAll('/', sep)).toString('utf8'));
    shipped.push({ key, version, source: 'runtime.asar' });
  }
  return shipped;
}

/** Every package.json under runtime.asar.unpacked, as { key, version, source }. */
export async function readSidecarPackages(sidecar) {
  const shipped = [];
  for (const entry of await readdir(sidecar, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== 'package.json') continue;
    const path = join(entry.parentPath, entry.name);
    const key = lockKeyForPackageJson(path.slice(sidecar.length));
    if (!key) continue;
    shipped.push({ key, version: (await readJson(path)).version, source: 'runtime.asar.unpacked' });
  }
  return shipped;
}

export async function verifyRuntimeDependencyVersions({ rootDir, desktopDir, runtimeDir }) {
  const archive = join(runtimeDir, 'runtime.asar');
  const [rootLock, desktopLock, archivePackages, sidecarPackages, pty] = await Promise.all([
    readJson(join(rootDir, 'package-lock.json')),
    readJson(join(desktopDir, 'package-lock.json')),
    readArchivePackages(archive),
    readSidecarPackages(`${archive}.unpacked`),
    readJson(join(runtimeDir, 'desktop-node-pty', 'package.json')),
  ]);
  const shipped = [...archivePackages, ...sidecarPackages];
  if (archivePackages.length === 0) throw new Error(`${archive} lists no package.json files; refusing to pass.`);
  return [
    ...compareShippedVersions({ lockPackages: rootLock.packages, shipped }),
    ...compareDesktopPtyVersion({
      desktopLockPackages: desktopLock.packages,
      shippedVersion: pty.version,
      source: 'desktop-node-pty',
    }),
  ];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const desktopDir = join(rootDir, 'apps', 'desktop');
  const runtimeDir = process.argv[2] ? resolve(process.argv[2]) : join(desktopDir, '.runtime');
  try {
    const mismatches = await verifyRuntimeDependencyVersions({ rootDir, desktopDir, runtimeDir });
    if (mismatches.length > 0) {
      process.stderr.write(`Packaged runtime dependency versions differ from the lockfiles:\n`);
      for (const mismatch of mismatches) process.stderr.write(`  - ${mismatch}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('Packaged runtime dependency versions match the lockfiles.\n');
    }
  } catch (error) {
    process.stderr.write(`Runtime dependency version check failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
