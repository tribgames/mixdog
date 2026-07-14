import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PATCH_PLATFORMS = {
  'darwin-arm64': 'mixdog-patch-darwin-arm64',
  'darwin-x64': 'mixdog-patch-darwin-x64',
  'linux-arm64': 'mixdog-patch-linux-arm64',
  'linux-x64': 'mixdog-patch-linux-x64',
  'win32-x64': 'mixdog-patch-win32-x64.exe',
};

export const GRAPH_PLATFORMS = {
  'darwin-arm64': 'mixdog-graph-darwin-arm64',
  'darwin-x64': 'mixdog-graph-darwin-x64',
  'linux-arm64': 'mixdog-graph-linux-arm64',
  'linux-x64': 'mixdog-graph-linux-x64',
  'win32-x64': 'mixdog-graph-win32-x64.exe',
};

const RUNTIME_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];
const STRICT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/i;
export const MAX_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_DOWNLOAD_TIMEOUT_MS = 300_000;
const PATCH_MANIFEST_PATH = 'src/runtime/agent/orchestrator/tools/patch-manifest.json';
const PATCH_CARGO_PATH = 'native/mixdog-patch/Cargo.toml';
const RUNTIME_MANIFEST_PATH = 'src/runtime/memory/data/runtime-manifest.json';
const GRAPH_MANIFEST_PATH = 'src/runtime/agent/orchestrator/tools/graph-manifest.json';
const PACKAGE_PATH = 'package.json';

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

export function validatePatchManifest(manifest, cargoToml) {
  assertPlainObject(manifest, 'Patch manifest');
  assertExactKeys(manifest, ['version', '_comment', 'assets'], 'Patch manifest');
  if (typeof manifest.version !== 'string' || !STRICT_VERSION.test(manifest.version)) {
    throw new Error(`Patch manifest version is not strict MAJOR.MINOR.PATCH: ${manifest.version}`);
  }
  if (typeof manifest._comment !== 'string' || !manifest._comment) {
    throw new Error('Patch manifest _comment must be a non-empty string');
  }
  assertPlainObject(manifest.assets, 'Patch manifest assets');
  assertExactKeys(manifest.assets, Object.keys(PATCH_PLATFORMS), 'Patch manifest assets');

  let inPackage = false;
  let cargoVersion;
  for (const line of String(cargoToml).split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
    if (section) {
      inPackage = section === 'package';
      continue;
    }
    if (inPackage) {
      const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/)?.[1];
      if (version) {
        cargoVersion = version;
        break;
      }
    }
  }
  if (!cargoVersion) throw new Error('Could not read [package] version from native/mixdog-patch/Cargo.toml');
  if (cargoVersion !== manifest.version) {
    throw new Error(`Patch Cargo version ${cargoVersion} does not match manifest version ${manifest.version}`);
  }

  for (const [platform, filename] of Object.entries(PATCH_PLATFORMS)) {
    const asset = manifest.assets[platform];
    assertPlainObject(asset, `Patch asset ${platform}`);
    assertExactKeys(asset, ['url', 'sha256'], `Patch asset ${platform}`);
    if (typeof asset.url !== 'string') throw new Error(`${platform}: patch asset URL must be a string`);
    let url;
    try {
      url = new URL(asset.url);
    } catch {
      throw new Error(`${platform}: invalid patch asset URL`);
    }
    const expectedPath = `/tribgames/mixdog/releases/download/patch-v${manifest.version}/${filename}`;
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== expectedPath
    ) {
      throw new Error(`${platform}: patch asset URL must be https://github.com${expectedPath}`);
    }
    if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
      throw new Error(`${platform}: invalid patch asset sha256`);
    }
  }
  return manifest;
}

export function validateRuntimeManifest(manifest) {
  assertPlainObject(manifest, 'Runtime manifest');
  if (!manifest.release_tag || !manifest.assets || typeof manifest.assets !== 'object') {
    throw new Error(`${RUNTIME_MANIFEST_PATH} is missing release_tag or assets`);
  }
  assertPlainObject(manifest.assets, 'Runtime manifest assets');
  assertExactKeys(manifest.assets, RUNTIME_PLATFORMS, 'Runtime manifest assets');
  for (const [platform, asset] of Object.entries(manifest.assets)) {
    if (typeof asset?.url !== 'string' || new URL(asset.url).protocol !== 'https:') {
      throw new Error(`${platform}: invalid HTTPS asset URL`);
    }
    if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
      throw new Error(`${platform}: invalid sha256`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
      throw new Error(`${platform}: invalid size`);
    }
  }
  return manifest;
}

export function validateGraphManifest(manifest, packageJson) {
  assertPlainObject(manifest, 'Graph manifest');
  assertExactKeys(manifest, ['version', '_comment', 'assets'], 'Graph manifest');
  if (typeof manifest.version !== 'string' || !STRICT_VERSION.test(manifest.version)) {
    throw new Error(`Graph manifest version is not strict MAJOR.MINOR.PATCH: ${manifest.version}`);
  }
  if (typeof manifest._comment !== 'string' || !manifest._comment) {
    throw new Error('Graph manifest _comment must be a non-empty string');
  }
  assertPlainObject(packageJson, 'package.json');
  if (typeof packageJson.version !== 'string' || !STRICT_VERSION.test(packageJson.version)) {
    throw new Error(`package.json version is not strict MAJOR.MINOR.PATCH: ${packageJson.version}`);
  }
  assertPlainObject(manifest.assets, 'Graph manifest assets');
  assertExactKeys(manifest.assets, Object.keys(GRAPH_PLATFORMS), 'Graph manifest assets');

  for (const [platform, filename] of Object.entries(GRAPH_PLATFORMS)) {
    const asset = manifest.assets[platform];
    assertPlainObject(asset, `Graph asset ${platform}`);
    assertExactKeys(asset, ['url', 'sha256'], `Graph asset ${platform}`);
    if (typeof asset.url !== 'string') throw new Error(`${platform}: graph asset URL must be a string`);
    let url;
    try {
      url = new URL(asset.url);
    } catch {
      throw new Error(`${platform}: invalid graph asset URL`);
    }
    const expectedPath = `/tribgames/mixdog/releases/download/graph-v${manifest.version}/${filename}`;
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== expectedPath
    ) {
      throw new Error(`${platform}: graph asset URL must be https://github.com${expectedPath}`);
    }
    if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
      throw new Error(`${platform}: invalid graph asset sha256`);
    }
  }
  return manifest;
}

async function downloadAndVerify(label, asset, fetchImpl, timeoutMs, maxAssetBytes) {
  console.log(`Downloading and verifying ${label}`);
  const controller = new AbortController();
  const response = await fetchImpl(asset.url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'mixdog-release-asset-guard' },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const hash = createHash('sha256');
  let downloaded = 0;
  const byteCeiling = Math.min(asset.size ?? Number.POSITIVE_INFINITY, maxAssetBytes);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (downloaded + chunk.byteLength > byteCeiling) {
        const error = new Error(`byte ceiling exceeded (${byteCeiling} bytes)`);
        controller.abort(error);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      hash.update(chunk);
      downloaded += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const digest = hash.digest('hex');
  if (asset.size !== undefined && downloaded !== asset.size) {
    throw new Error(`size mismatch (manifest ${asset.size}, downloaded ${downloaded})`);
  }
  if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error(`sha256 mismatch (manifest ${asset.sha256}, downloaded ${digest})`);
  }
}

export async function verifyAssetDownloads(
  assets,
  {
    fetchImpl = globalThis.fetch,
    attempts = 3,
    timeoutMs = 300_000,
    maxAssetBytes = MAX_ASSET_BYTES,
    retryDelay = (attempt) => (
    new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 2_000 : 6_000))
    ),
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error(`Download attempts must be between 1 and 5, got ${attempts}`);
  }
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1 || maxAssetBytes > MAX_ASSET_BYTES) {
    throw new Error(`Asset byte ceiling must be between 1 and ${MAX_ASSET_BYTES}, got ${maxAssetBytes}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DOWNLOAD_TIMEOUT_MS) {
    throw new Error(`Download timeout must be between 1 and ${MAX_DOWNLOAD_TIMEOUT_MS}, got ${timeoutMs}`);
  }
  for (const [label, asset] of Object.entries(assets)) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await downloadAndVerify(label, asset, fetchImpl, timeoutMs, maxAssetBytes);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`${label}: attempt ${attempt}/${attempts} failed: ${error.message}`);
        if (attempt < attempts) await retryDelay(attempt);
      }
    }
    if (lastError) {
      throw new Error(`${label}: verification failed after ${attempts} attempts: ${lastError.message}`);
    }
  }
}

export async function verifyReleaseAssets({
  patchManifestPath = PATCH_MANIFEST_PATH,
  cargoPath = PATCH_CARGO_PATH,
  runtimeManifestPath = RUNTIME_MANIFEST_PATH,
  graphManifestPath = GRAPH_MANIFEST_PATH,
  packagePath = PACKAGE_PATH,
  downloadOptions,
} = {}) {
  const [patchSource, cargoToml, runtimeSource, graphSource, packageSource] = await Promise.all([
    readFile(patchManifestPath, 'utf8'),
    readFile(cargoPath, 'utf8'),
    readFile(runtimeManifestPath, 'utf8'),
    readFile(graphManifestPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);
  const patchManifest = validatePatchManifest(JSON.parse(patchSource), cargoToml);
  const runtimeManifest = validateRuntimeManifest(JSON.parse(runtimeSource));
  const graphManifest = validateGraphManifest(JSON.parse(graphSource), JSON.parse(packageSource));
  await verifyAssetDownloads(patchManifest.assets, downloadOptions);
  console.log(`Verified all bundled patch assets for patch-v${patchManifest.version}.`);
  await verifyAssetDownloads(runtimeManifest.assets, downloadOptions);
  console.log(`Verified all bundled runtime assets for ${runtimeManifest.release_tag}.`);
  await verifyAssetDownloads(graphManifest.assets, downloadOptions);
  console.log(`Verified all bundled graph assets for graph-v${graphManifest.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyReleaseAssets();
}
