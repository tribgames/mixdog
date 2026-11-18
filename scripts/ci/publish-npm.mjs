import { execFileSync } from 'node:child_process';
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
  const matches = typeof sri === 'string' && sri.trim().split(/\s+/).some((token) => token.split('?')[0] === integrity);
  if (metadata.name !== name || metadata.version !== version || !matches) {
    throw new Error(`${name}@${version} is occupied without the verified tarball's SHA-512 integrity`);
  }
  return true;
}

// Preflight every version before publishing anything; publish dependencies before the main package.
for (const pkg of packages) pkg.exists = await alreadyPublished(pkg);
for (const pkg of packages) {
  if (pkg.exists) {
    console.log(`${pkg.name}@${version} already contains the verified bytes`);
    continue;
  }
  execFileSync('npm', ['publish', `./${pkg.file}`, '--provenance', '--access', 'public',
    '--ignore-scripts', '--registry', registry], { stdio: 'inherit' });
  if (!(await alreadyPublished(pkg))) throw new Error(`Cannot confirm publication of ${pkg.name}@${version}`);
}
