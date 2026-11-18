#!/usr/bin/env node
// Unpacks the bundled PostgreSQL runtime for this machine into a folder and prints the variable the #[ignore]d memory and
// composed-core tests read (`MIXDOG_PG_RUNTIME=<folder>`, nextest profiles `services-pg` and `pg`; native/core/.config/nextest.toml).
//
// The asset is the one the repository's own manifest names for this platform (src/runtime/memory/data/runtime-manifest.json, the
// file `ensure_runtime` of mixdog-services reads and the runtime release publishes), checked against the manifest's sha256 before
// it is unpacked, so a CI run tests the runtime the product ships. It needs the network (a GitHub release download) and `tar`.
// The runtime's postmaster refuses to run as root or as an elevated Windows user: the runner must be neither.
//
// Usage: node scripts/ci/provision-pg-runtime.mjs <folder>      (from the repository root)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The manifest names its assets the way Node names a platform and an architecture.
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

export function assetFor(manifest, key) {
  const asset = manifest.assets?.[key];
  if (!asset?.url || !asset.sha256) throw new Error(`the runtime manifest has no asset (url and sha256) for ${key}; it has ${Object.keys(manifest.assets ?? {}).join(', ')}`);
  return asset;
}

export function verifySha256(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error(`the downloaded runtime is ${actual}, the manifest says ${expected}`);
}

async function download(url) {
  let failure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      failure = error;
      console.error(`[pg-runtime] download failed (attempt ${attempt}/3): ${error.message}`);
      await new Promise((done) => setTimeout(done, attempt * 5000));
    }
  }
  throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = process.argv[2];
  if (!folder) throw new Error('usage: provision-pg-runtime.mjs <folder>');
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, 'src/runtime/memory/data/runtime-manifest.json'), 'utf8'));
  const asset = assetFor(manifest, platformKey());
  const bytes = await download(asset.url);
  verifySha256(bytes, asset.sha256);
  const destination = resolve(folder);
  mkdirSync(destination, { recursive: true });
  const archive = join(destination, 'runtime.tar.gz');
  writeFileSync(archive, bytes);
  const untar = spawnSync('tar', ['-xzf', 'runtime.tar.gz'], { cwd: destination, stdio: 'inherit' });
  if (untar.status !== 0) throw new Error(`tar exited ${untar.status}`);
  // The tests start `<runtime>/bin/initdb` and `pg_ctl`; an archive that nests its tree one folder down is not this layout.
  const initdb = join(destination, 'bin', process.platform === 'win32' ? 'initdb.exe' : 'initdb');
  if (!existsSync(initdb)) throw new Error(`${initdb} is missing after unpacking ${asset.url}`);
  console.log(`MIXDOG_PG_RUNTIME=${destination}`);
}
