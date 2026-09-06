// patch-binary-fetcher.mjs — fetches the prebuilt mixdog-patch native binary
// from the GitHub release manifest. apply_patch is native-only, so callers
// surface fetch failures as clean tool errors rather than silently switching
// engines. Caches under <dataDir>/patch-bin/. Mirrors graph-binary-fetcher.mjs.
//
// Public API:
//   ensurePatchBinary(dataDir) -> absolute path to the verified binary.
//     Throws on no-asset / download / verify failure.
//   findCachedPatchBinary(dataDir) -> path | null (sync, no network).
// Both accept an optional dependency object used by deterministic tests:
//   { bundledManifest, download }.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binSuffix,
  createBinaryDownloader,
  fetchRemoteManifest,
  findCachedBinary,
  installVerifiedBinary,
  platformKey,
  readBundledManifest,
  readJsonOrNull,
  singleFlight,
  validReleaseAsset,
  validSemver,
  validSha256,
} from '../../../shared/native-asset.mjs';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./patch-manifest.json', import.meta.url));
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/agent/orchestrator/tools/patch-manifest.json';

const LABEL = '[patch-fetcher]';
const RELEASE_ASSET = { name: 'mixdog-patch', tagPrefix: 'patch-v' };

function patchBinDir(dataDir) {
  return join(dataDir, 'patch-bin');
}

function binaryFileName(version) {
  return `mixdog-patch-${version}${binSuffix()}`;
}

function manifestVersion(manifest) {
  const value = manifest?.version;
  return validSemver(value) ? value.split('.').map(Number) : null;
}

function compareManifestVersions(a, b) {
  const av = manifestVersion(a);
  const bv = manifestVersion(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

function validCachedUpgrade(manifest, pkey) {
  return validReleaseAsset(manifest, pkey, RELEASE_ASSET);
}

function selectLocalManifest(dataDir, options = {}) {
  const bundled = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
  const cachedManifest = readJsonOrNull(join(patchBinDir(dataDir), 'manifest.json'));
  if (bundled) {
    // The installed manifest is the minimum policy. A cache may advance it,
    // but only with a strict newer semver and a trusted, fully hashed asset.
    if (compareManifestVersions(cachedManifest, bundled) === 1
      && validCachedUpgrade(cachedManifest, platformKey())) {
      return cachedManifest;
    }
    return bundled;
  }
  return validCachedUpgrade(cachedManifest, platformKey()) ? cachedManifest : null;
}

async function loadManifest(dataDir, options = {}) {
  const local = selectLocalManifest(dataDir, options);
  if (local) return local;
  return fetchRemoteManifest(MANIFEST_URL, { fetch: options.fetch, label: LABEL });
}

const downloadPatchBinary = createBinaryDownloader({ name: 'patch', label: LABEL });

export function findCachedPatchBinary(dataDir, options = {}) {
  try {
    const manifest = selectLocalManifest(dataDir, options);
    const asset = manifest?.assets?.[platformKey()];
    if (!manifestVersion(manifest) || !validSha256(asset?.sha256)) return null;
    return findCachedBinary({
      dir: patchBinDir(dataDir),
      fileName: binaryFileName(manifest.version),
      sha256: asset.sha256,
    });
  } catch {
    return null;
  }
}

export const ensurePatchBinary = singleFlight(async (dataDir, options = {}) => {
  const manifest = await loadManifest(dataDir, options);
  const pkey = platformKey();
  const asset = manifest.assets?.[pkey];
  if (!asset || !asset.url || !validSha256(asset.sha256) || !manifestVersion(manifest)) {
    // Unsupported platform/arch (e.g. win32-arm64): the manifest has no
    // downloadable asset for this {os}-{arch}. apply_patch is native-only
    // (no JS apply fallback), so this is terminal — surface a single clear,
    // actionable message instead of a cryptic crash downstream.
    const supported = Object.keys(manifest.assets || {}).join(', ') || '(none)';
    throw new Error(
      `${LABEL} no prebuilt mixdog-patch binary for platform ${pkey} `
      + `(unsupported platform/arch — apply_patch is native-only, no JS apply fallback). `
      + `Supported platforms: ${supported}. `
      + `Build it locally: cargo build --release in native/mixdog-patch.`,
    );
  }
  return installVerifiedBinary({
    dir: patchBinDir(dataDir),
    fileName: binaryFileName(String(manifest.version || '0')),
    asset,
    download: options.download || downloadPatchBinary,
    label: LABEL,
    pkey,
    gcPrefix: 'mixdog-patch',
  });
});
