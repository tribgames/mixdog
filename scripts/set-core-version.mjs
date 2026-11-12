#!/usr/bin/env node
// Sets the release version of the Rust workspace: `native/core/Cargo.toml` [workspace.package] `version` (what `mixdogd
// --version` prints) and the same version of every workspace crate in `native/core/Cargo.lock`, so a `--locked` build
// accepts it. Deploy runs it beside `npm version`; `scripts/check-release-version.mjs` is the check that the three
// versions (root, desktop, workspace) agree afterwards.
//   node scripts/set-core-version.mjs 1.4.6
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { workspaceVersion } from './check-release-version.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @returns {Promise<{from: string, lockEntries: number}>} */
export async function setCoreVersion(version, root = DEFAULT_ROOT) {
  if (!STRICT.test(version)) throw new Error(`not a strict MAJOR.MINOR.PATCH version: ${version}`);
  const manifestPath = join(root, 'native/core/Cargo.toml');
  const lockPath = join(root, 'native/core/Cargo.lock');
  const from = await workspaceVersion(manifestPath);

  const manifest = await readFile(manifestPath, 'utf8');
  const section = /(\[workspace\.package\][\s\S]*?^\s*version\s*=\s*")[^"]+(")/m;
  if (!section.test(manifest)) throw new Error(`no [workspace.package] version in ${manifestPath}`);
  await writeFile(manifestPath, manifest.replace(section, `$1${version}$2`));

  // A workspace crate has no `source` line; a registry crate that happens to carry the same version has one.
  const entry = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "[^"]+"\\r?\\nversion = ")${escape(from)}("\\r?\\n)(?!source = )`, 'g');
  let lockEntries = 0;
  const lock = (await readFile(lockPath, 'utf8')).replace(entry, (_, head, tail) => {
    lockEntries += 1;
    return `${head}${version}${tail}`;
  });
  await writeFile(lockPath, lock);
  return { from, lockEntries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { from, lockEntries } = await setCoreVersion(process.argv[2] ?? '');
    console.log(`[set-core-version] ${from} -> ${process.argv[2]} (${lockEntries} Cargo.lock entries)`);
  } catch (error) {
    console.error(`[set-core-version] ${error.message}`);
    process.exitCode = 1;
  }
}