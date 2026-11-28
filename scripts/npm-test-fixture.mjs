// Packages and runtimes for the tests of the npm launcher (scripts/npm-launcher.test.mjs, scripts/npm-runtime.test.mjs,
// scripts/staged-swap.test.mjs): a package folder with the real bin/ files and a runtime manifest, and a runtime folder of
// the user's cache marked ready the way bin/runtime.mjs marks it.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROGRAMS, READY_FILE, programFile, runtimeCacheRoot, runtimeFolder } from '../bin/runtime.mjs';
import { writePackageFiles } from './npm-runtime-assets.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const LAUNCHER_FILES = Object.freeze([
  'download.mjs',
  'invocation.mjs',
  'mixdog-runtime.mjs',
  'mixdog.mjs',
  'native-layout.mjs',
  'rename.mjs',
  'runtime.mjs',
  'staged-swap.mjs',
]);

/** The programs of `platform` holding `text`, as runtime contents (path -> bytes). */
export const programContents = (platform, text = '') =>
  Object.fromEntries(PROGRAMS.map((name) => [programFile(name, platform), text]));

/** The manifest entry of a runtime of `key` whose files hold `contents`, for archive bytes of `sha256`. */
export function runtimeEntry({ key, version, contents, sha256 = '0'.repeat(64), length = 1, buildId = 'build-1' }) {
  const files = Object.fromEntries(Object.entries(contents).map(([path, data]) => [path, Buffer.byteLength(data)]));
  return { asset: `mixdog-runtime-${key}.tar.gz`, length, sha256, version, buildId, files };
}

/** Writes the runtime of `key` with `contents` into the cache of `data`, marked ready for `entry`; returns its folder. */
export function writeReadyRuntime({ data, key, entry, contents }) {
  const folder = runtimeFolder(runtimeCacheRoot(data), key, entry);
  const programs = new Set(PROGRAMS.map((name) => programFile(name, key.split('-')[0])));
  for (const [path, value] of Object.entries(contents)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), value, { mode: programs.has(path) ? 0o755 : 0o644 });
  }
  const { asset, length, sha256, version, buildId, files } = entry;
  writeFileSync(join(folder, READY_FILE), JSON.stringify({ key, asset, length, sha256, version, buildId, files }));
  return folder;
}

/** A package of `version` in `dir`: the real launcher, the skill entry, the 1.4.5 command and `manifest` (else one of `targets`). */
export function writePackage(dir, { version, targets, manifest = { schema: 1, repository: 'o/r', tag: `v${version}`, targets } }) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mixdog', version, type: 'module' }));
  for (const file of LAUNCHER_FILES) copyFileSync(join(root, 'bin', file), join(dir, 'bin', file));
  writeFileSync(join(dir, 'src', 'skill-script-entry.mjs'), '');
  writePackageFiles(dir, manifest);
  return dir;
}