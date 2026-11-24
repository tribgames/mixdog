import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import { PLATFORMS, platformPackageName } from '../npm-platforms.mjs';

const registry = 'https://registry.npmjs.org';
const [dir, version] = process.argv.slice(2);
if (!dir || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
  throw new Error('Expected the verified tarball directory and release version');
}

const packages = [];
for (const name of [...PLATFORMS.map(({ key }) => platformPackageName(key)), 'mixdog']) {
  const file = join(dir, `${name}-${version}.tgz`);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  packages.push({ name, file, integrity: `sha512-${hash.digest('base64')}` });
}

async function alreadyPublished({ name, integrity }) {
  const response = await fetch(`${registry}/${name}/${version}`, {
    headers: { 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Cannot check ${name}@${version}: HTTP ${response.status}`);
  const metadata = await response.json();
  const sri = metadata.dist?.integrity;
  const matches =
    typeof sri === 'string' &&
    sri
      .trim()
      .split(/\s+/)
      .some((token) => token.split('?')[0] === integrity);
  if (metadata.name !== name || metadata.version !== version || !matches) {
    throw new Error(`${name}@${version} is occupied without the verified tarball's SHA-512 integrity`);
  }
  return true;
}

function publishNpmPackage(pkg) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['publish', `./${pkg.file}`, '--provenance', '--access', 'public', '--ignore-scripts', '--registry', registry],
      { stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm publish ${pkg.name} exited ${code}`))));
  });
}

async function publish(pkg) {
  if (pkg.exists) {
    console.log(`${pkg.name}@${version} already contains the verified bytes`);
    return;
  }
  await publishNpmPackage(pkg);
  if (!(await alreadyPublished(pkg))) throw new Error(`Cannot confirm publication of ${pkg.name}@${version}`);
}

// Preflight every version before publishing anything; the platform packages publish side by side, and the main
// package (which depends on them) only after every one of them succeeded.
await Promise.all(packages.map(async (pkg) => (pkg.exists = await alreadyPublished(pkg))));
const main = packages.at(-1);
const settled = await Promise.allSettled(packages.slice(0, -1).map(publish));
const failed = settled.find((result) => result.status === 'rejected');
if (failed) throw failed.reason;
await publish(main);
