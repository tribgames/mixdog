#!/usr/bin/env node
// Verifies that the dependency versions the desktop ships match the lockfile: every package.json of the
// prepared real-file runtime (.runtime/native-modules, which electron-builder maps to
// resources/runtime.asar.unpacked/node_modules) against the root package-lock.json. A stale install or a reused
// prepared-runtime cache otherwise ships old versions unnoticed.
//
//   node apps/desktop/scripts/verify-runtime-versions.mjs [<native-modules dir>]
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareShippedVersions, lockKeyForPackageJson } from '../../../scripts/verify-runtime-dependency-versions.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');

/** Every package.json under `modulesDir` (a `node_modules` tree) as { key, version, source }. */
export async function readRuntimePackages(modulesDir) {
  const shipped = [];
  for (const entry of await readdir(modulesDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== 'package.json') continue;
    const path = join(entry.parentPath, entry.name);
    const key = lockKeyForPackageJson(`node_modules/${relative(modulesDir, path).split(sep).join('/')}`);
    if (!key) continue;
    shipped.push({ key, version: JSON.parse(await readFile(path, 'utf8')).version, source: 'native-modules' });
  }
  return shipped;
}

export async function verifyRuntimeVersions({
  lockfile = join(rootDir, 'package-lock.json'),
  modulesDir = join(desktopDir, '.runtime', 'native-modules'),
} = {}) {
  const [lock, shipped] = await Promise.all([
    readFile(lockfile, 'utf8').then(JSON.parse),
    readRuntimePackages(modulesDir),
  ]);
  if (shipped.length === 0) throw new Error(`${modulesDir} lists no package.json files; refusing to pass.`);
  return compareShippedVersions({ lockPackages: lock.packages, shipped });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mismatches = await verifyRuntimeVersions(process.argv[2] ? { modulesDir: resolve(process.argv[2]) } : {});
    if (mismatches.length > 0) {
      process.stderr.write('Packaged runtime dependency versions differ from the lockfile:\n');
      for (const mismatch of mismatches) process.stderr.write(`  - ${mismatch}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('Packaged runtime dependency versions match the lockfile.\n');
    }
  } catch (error) {
    process.stderr.write(`Runtime dependency version check failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
