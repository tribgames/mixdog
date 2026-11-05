#!/usr/bin/env node
// One release version: the root package.json `version` is the source. The desktop package.json and the
// Rust workspace (`native/core/Cargo.toml` [workspace.package] version, which `mixdogd --version` prints
// and `server-manifest.json` carries) must equal it, so they cannot diverge. The server manifest's `build`
// is a digest of the staged binaries (apps/desktop/src/main/ssh/server-manifest.mjs), derived at staging
// time from binaries whose version stage-core verifies against this same value.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The version of the Rust workspace every `mixdogd` is built from. */
export async function workspaceVersion(manifestPath = join(repoRoot, 'native/core/Cargo.toml')) {
  const text = await readFile(manifestPath, 'utf8');
  const section = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
  const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  if (!version) throw new Error(`no [workspace.package] version in ${manifestPath}`);
  return version;
}

const packageVersion = async (file) => JSON.parse(await readFile(file, 'utf8')).version;

/** Returns the release version, or throws naming every place that differs from it. */
export async function checkReleaseVersion(root = repoRoot) {
  const release = await packageVersion(join(root, 'package.json'));
  const found = {
    'apps/desktop/package.json': await packageVersion(join(root, 'apps/desktop/package.json')),
    'native/core/Cargo.toml [workspace.package]': await workspaceVersion(join(root, 'native/core/Cargo.toml')),
  };
  const wrong = Object.entries(found).filter(([, version]) => version !== release);
  if (wrong.length > 0) {
    const list = wrong.map(([where, version]) => `${where} is ${version}`).join('; ');
    throw new Error(`release version is ${release} (package.json), but ${list}`);
  }
  return release;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(`[release-version] ${await checkReleaseVersion()}`);
  } catch (error) {
    console.error(`[release-version] ${error.message}`);
    process.exitCode = 1;
  }
}
