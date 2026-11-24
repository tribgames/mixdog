#!/usr/bin/env node

/**
 * Version-neutral digest of the Rust workspace manifest and lockfiles for release cache keys.
 *
 * Deploy rewrites the workspace version in native/core/Cargo.toml and the version of every workspace crate in
 * native/core/Cargo.lock and native/mixdog-main-native/Cargo.lock (scripts/set-core-version.mjs), so hashFiles() over
 * them misses on every release. Only the versions of the crates that live in the repository (a lock entry with no
 * `source`) and the [workspace.package] version are blanked; every dependency, feature and patch stays in the digest.
 *   node scripts/cargo-cache-key.mjs <Cargo.toml|Cargo.lock>...
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CARGO_CACHE_SCHEMA = 1;

export function neutralCargoManifest(text) {
  return text.replace(/(\[workspace\.package\][\s\S]*?^\s*version\s*=\s*")[^"]+(")/m, (_, head, tail) => `${head}${tail}`);
}

export function neutralCargoLock(text) {
  return text.replace(
    /(\[\[package\]\]\r?\nname = "[^"]+"\r?\nversion = ")[^"]+("\r?\n)(?!source = )/g,
    (_, head, tail) => `${head}${tail}`
  );
}

export function cargoCacheKey(files) {
  const digest = createHash('sha256');
  digest.update(`cargo-v${CARGO_CACHE_SCHEMA}`);
  for (const { name, text } of files) {
    digest.update('\0');
    digest.update(name === 'Cargo.lock' ? neutralCargoLock(text) : neutralCargoManifest(text));
  }
  return digest.digest('hex');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('Usage: cargo-cache-key.mjs <Cargo.toml|Cargo.lock>...');
  const files = await Promise.all(
    paths.map(async (path) => ({ name: basename(path), text: await readFile(resolve(path), 'utf8') }))
  );
  process.stdout.write(`${cargoCacheKey(files)}\n`);
}
