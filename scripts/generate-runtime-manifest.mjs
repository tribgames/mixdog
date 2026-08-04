#!/usr/bin/env node
// generate-runtime-manifest.mjs
// Aggregator step run after all matrix build jobs succeed.
// Reads release assets via gh CLI, filters mixdog-runtime-*.tar.gz,
// fetches sha256 from .sha256 sidecar files, and emits runtime-manifest.json
// to both dist/ and src/runtime/memory/data/ (for the workflow branch sync).
//
// Environment:
//   GITHUB_TOKEN  — PAT or GITHUB_TOKEN secret with contents:read
//   RELEASE_TAG   — e.g. "runtime-v0.4.0" (falls back to process.argv[2])
//   GITHUB_REPOSITORY — auto-set by Actions (e.g. "owner/repo")
//   RUNTIME_RELEASE_REPOSITORY — override repo for gh commands

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const RELEASE_TAG = process.env.RELEASE_TAG ?? process.argv[2];
const REPO = process.env.RUNTIME_RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY || '';

if (!RELEASE_TAG) {
  console.error('ERROR: RELEASE_TAG env var or argv[2] required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. List release assets via gh CLI
// ---------------------------------------------------------------------------
console.log(`Listing assets for release: ${RELEASE_TAG} (repo: ${REPO})`);

let assetsJson;
try {
  assetsJson = execSync(
    `gh release view ${RELEASE_TAG} --repo ${REPO} --json assets`,
    { encoding: 'utf8', env: process.env }
  );
} catch (err) {
  console.error('gh release view failed:', err.message);
  process.exit(1);
}

const { assets } = JSON.parse(assetsJson);

// Filter tarball assets
const tarballs = assets.filter(a => /^mixdog-runtime-.+\.tar\.gz$/.test(a.name));
console.log(`Found ${tarballs.length} tarball(s):`, tarballs.map(a => a.name));

if (tarballs.length === 0) {
  console.error('No mixdog-runtime-*.tar.gz assets found on release.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Parse version strings from a filename
//    Format: mixdog-runtime-{os}-{arch}-pg{major}.{minor}-pgvector{vec}.tar.gz
// ---------------------------------------------------------------------------
const PG_RE = /pg(\d+)\.(\d+)/;
const VEC_RE = /pgvector(\d+(?:\.\d+)+)/;

let pgMajor = 16, pgMinor = 4, pgvectorVersion = '0.7.4';
for (const t of tarballs) {
  const pgM = PG_RE.exec(t.name);
  const vM  = VEC_RE.exec(t.name);
  if (pgM) { pgMajor = parseInt(pgM[1], 10); pgMinor = parseInt(pgM[2], 10); }
  if (vM)  { pgvectorVersion = vM[1]; }
  break; // all tarballs share the same version; just read the first
}

// ---------------------------------------------------------------------------
// 3. Fetch sha256 sidecar content for each tarball
// ---------------------------------------------------------------------------
async function fetchSha256(sha256AssetName, _downloadUrl) {
  // Try matching .sha256 sidecar from the asset list first
  const sidecar = assets.find(a => a.name === sha256AssetName);
  if (!sidecar) {
    throw new Error(`Missing required checksum sidecar: ${sha256AssetName}`);
  }

  const tmpDir = resolve(tmpdir(), 'mixdog-manifest-sha256');
  mkdirSync(tmpDir, { recursive: true });
  execSync(
    `gh release download ${RELEASE_TAG} --repo ${REPO} --pattern ${sha256AssetName} --dir "${tmpDir}" --clobber`,
    { encoding: 'utf8', env: process.env }
  );
  const content = readFileSync(resolve(tmpDir, sha256AssetName), 'utf8').trim();
  // Format: "<hex>  <filename>"
  const checksum = content.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(checksum)) {
    throw new Error(`Invalid checksum in sidecar ${sha256AssetName}: ${checksum}`);
  }
  return checksum.toLowerCase();
}

// ---------------------------------------------------------------------------
// 4. Build asset map
// ---------------------------------------------------------------------------
const PLATFORM_RE = /mixdog-runtime-([a-z0-9]+)-([a-z0-9]+)-/;

const assetsMap = {};

for (const tarball of tarballs) {
  const m = PLATFORM_RE.exec(tarball.name);
  if (!m) { console.warn(`Skipping unrecognised tarball: ${tarball.name}`); continue; }
  const key = `${m[1]}-${m[2]}`; // e.g. "linux-x64"

  const sha256Key = `${tarball.name}.sha256`;
  const sha256 = await fetchSha256(sha256Key, tarball.url);

  assetsMap[key] = {
    url:    tarball.url,
    sha256,
    size:   tarball.size ?? 0,
  };
}

// A partial release must never produce a publishable or bundled manifest.
const EXPECTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
const missing = EXPECTED.filter(p => !assetsMap[p]);
if (missing.length > 0) {
  console.error(`Missing required runtime asset(s): ${missing.join(', ')}`);
  process.exit(1);
}

for (const p of EXPECTED) {
  const asset = assetsMap[p];
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    console.error(`Invalid asset URL for ${p}: ${asset.url}`);
    process.exit(1);
  }
  if (url.protocol !== 'https:' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0) {
    console.error(`Invalid release metadata for ${p}: ${JSON.stringify(asset)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 5. Assemble manifest
// ---------------------------------------------------------------------------
const manifest = {
  schema_version: 1,
  generated_at:   new Date().toISOString(),
  release_tag:    RELEASE_TAG,
  pg: {
    major: pgMajor,
    minor: pgMinor,
  },
  pgvector: {
    version: pgvectorVersion,
  },
  assets: assetsMap,
};

const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
console.log('Manifest:', manifestJson);

// ---------------------------------------------------------------------------
// 6. Write outputs
// ---------------------------------------------------------------------------
const distDir = resolve(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });

const distPath   = resolve(distDir, 'runtime-manifest.json');
const bundledPath = resolve(ROOT, 'src', 'runtime', 'memory', 'data', 'runtime-manifest.json');

writeFileSync(distPath, manifestJson);
console.log(`Written: ${distPath}`);

mkdirSync(dirname(bundledPath), { recursive: true });
writeFileSync(bundledPath, manifestJson);
console.log(`Written: ${bundledPath}`);

console.log('generate-runtime-manifest.mjs complete.');
