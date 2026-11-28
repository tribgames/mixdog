// The npm half of the publication and the release assets it points at (release.yml publish-staged-release), in this order:
//   node scripts/ci/publish-npm.mjs upload-runtime <staged>
//     uploads the runtime archives the package's manifest names (<staged>/npm-runtime) to the hidden draft
//     (scripts/ci/release-assets.mjs uploadAssets) and exports their records as NPM_RUNTIME_ASSETS for the rest of the job
//     ($GITHUB_ENV): they are part of the asset set the draft is verified and published with.
//   node scripts/ci/publish-npm.mjs verify-public <staged>
//     once the release is public: downloads each archive from its public URL with the launcher's own client and no
//     credential, and requires the manifest's bytes. The package is never published pointing at an asset that is not there.
//   node scripts/ci/publish-npm.mjs publish <staged> <version>
//     publishes <staged>/npm-tarballs/mixdog-<version>.tgz; that version already published with these bytes counts as done.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { download } from '../../bin/download.mjs';
import { assetUrl, extractArchive, verifyArchive } from '../../bin/runtime.mjs';
import { findTarball, readTarball, runtimeManifestOf } from '../check-npm-packages.mjs';
import { platformOf } from '../npm-platforms.mjs';

const registry = 'https://registry.npmjs.org';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The runtime manifest inside the staged package: the bytes npm publishes are the truth of what the assets must be. */
export const stagedManifest = (staged) => runtimeManifestOf(readTarball(findTarball(join(staged, 'npm-tarballs'))));

/**
 * Uploads the archives of `manifest` from `runtimeDir` with `upload` (release-assets.mjs uploadAssets) and returns their
 * records once each is the manifest's length and SHA-256. Refuses a manifest of another repository or tag.
 */
export async function uploadRuntime({ manifest, runtimeDir, repository, tag, upload }) {
  if (manifest.repository !== repository || manifest.tag !== tag)
    throw new Error(`the package points at ${manifest.repository} ${manifest.tag}, not at this release, ${repository} ${tag}`);
  const entries = Object.values(manifest.targets);
  const records = await upload(entries.map((entry) => join(runtimeDir, entry.asset)));
  for (const entry of entries) {
    const record = records.find((candidate) => candidate.name === entry.asset);
    if (record?.size !== entry.length || record.digest !== `sha256:${entry.sha256}`)
      throw new Error(`the uploaded ${entry.asset} is not the archive the package names`);
  }
  return records;
}

/**
 * Downloads every archive of `manifest` from its public URL (`urlOf`) and requires its bytes and layout. Publication reaches
 * the download hosts a little after the release turns public, so a failed attempt is tried again after 5, 10, 20 and 40 s.
 */
export async function verifyPublic({ manifest, fetchArchive = download, urlOf = assetUrl, env = {}, sleep = defaultSleep, delays = [5000, 10000, 20000, 40000] }) {
  const scratch = mkdtempSync(join(tmpdir(), 'mixdog-runtime-public-'));
  try {
    await Promise.all(
      Object.entries(manifest.targets).map(async ([key, entry]) => {
        for (let attempt = 0; ; attempt += 1) {
          const file = join(scratch, `${key}-${attempt}`);
          const folder = join(scratch, `${key}-${attempt}.d`);
          try {
            await fetchArchive({ url: urlOf(manifest, entry), file, length: entry.length, env, userAgent: 'mixdog-release-check' });
            await verifyArchive(file, entry);
            await extractArchive(file, folder, entry.files, platformOf(key).platform);
            return;
          } catch (error) {
            if (attempt >= delays.length) throw new Error(`${entry.asset} is not publicly downloadable as the package names it: ${error.message}`);
            await sleep(delays[attempt]);
          } finally {
            rmSync(file, { force: true });
            rmSync(folder, { recursive: true, force: true });
          }
        }
      })
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function integrityOf(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

async function alreadyPublished({ name, version, integrity }) {
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
  return new Promise((resolvePublish, reject) => {
    const child = spawn(
      'npm',
      ['publish', resolve(pkg.file), '--provenance', '--access', 'public', '--ignore-scripts', '--registry', registry],
      { stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePublish() : reject(new Error(`npm publish ${pkg.name} exited ${code}`))));
  });
}

async function publish(staged, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Expected the release version');
  const file = join(staged, 'npm-tarballs', `mixdog-${version}.tgz`);
  const pkg = { name: 'mixdog', version, file, integrity: await integrityOf(file) };
  if (await alreadyPublished(pkg)) {
    console.log(`mixdog@${version} already contains the verified bytes`);
    return;
  }
  await publishNpmPackage(pkg);
  if (!(await alreadyPublished(pkg))) throw new Error(`Cannot confirm publication of mixdog@${version}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, staged, version] = process.argv.slice(2);
  if (!staged) throw new Error('Expected the staged npm folder');
  if (command === 'upload-runtime') {
    const { uploadAssets } = await import('./release-assets.mjs');
    const records = await uploadRuntime({
      manifest: stagedManifest(staged),
      runtimeDir: join(staged, 'npm-runtime'),
      repository: process.env.GITHUB_REPOSITORY,
      tag: process.env.RELEASE_TAG,
      upload: uploadAssets,
    });
    appendFileSync(process.env.GITHUB_ENV, `NPM_RUNTIME_ASSETS=${JSON.stringify(records)}\n`);
  } else if (command === 'verify-public') {
    await verifyPublic({ manifest: stagedManifest(staged) });
  } else if (command === 'publish') {
    await publish(staged, version);
  } else {
    throw new Error(`Unknown command ${command}: upload-runtime, verify-public or publish`);
  }
}
