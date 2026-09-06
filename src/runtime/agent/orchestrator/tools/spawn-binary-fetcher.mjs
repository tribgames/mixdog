// spawn-binary-fetcher.mjs — installs the prebuilt mixdog-spawn binary from
// the bundled manifest only (no remote manifest fallback: the spawn release is
// pinned to the installed Mixdog version). Caches under <dataDir>/spawn-bin/.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binSuffix,
  createBinaryDownloader,
  findCachedBinary,
  installVerifiedBinary,
  platformKey,
  readBundledManifest,
  singleFlight,
  validReleaseAsset,
} from '../../../shared/native-asset.mjs';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./spawn-manifest.json', import.meta.url));

const LABEL = '[spawn-fetcher]';
const RELEASE_ASSET = { name: 'mixdog-spawn', tagPrefix: 'spawn-v' };

function spawnBinDir(dataDir) {
  return join(dataDir, 'spawn-bin');
}

function binaryFileName(version) {
  return `mixdog-spawn-${version}${binSuffix()}`;
}

function validSpawnAsset(manifest, pkey) {
  return validReleaseAsset(manifest, pkey, RELEASE_ASSET);
}

const downloadSpawnBinary = createBinaryDownloader({ name: 'spawn', label: LABEL });

export function findCachedSpawnBinary(dataDir, options = {}) {
  try {
    const manifest = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
    const pkey = platformKey();
    if (!validSpawnAsset(manifest, pkey)) return null;
    return findCachedBinary({
      dir: spawnBinDir(dataDir),
      fileName: binaryFileName(manifest.version),
      sha256: manifest.assets[pkey].sha256,
    });
  } catch {
    return null;
  }
}

export const ensureSpawnBinary = singleFlight(async (dataDir, options = {}) => {
  const manifest = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
  const pkey = platformKey();
  if (!validSpawnAsset(manifest, pkey)) {
    const supported = Object.keys(manifest?.assets || {}).join(', ') || '(none; spawn release not synchronized)';
    throw new Error(
      `${LABEL} no verified mixdog-spawn binary for ${pkey}. `
      + `Supported platforms: ${supported}. No local-build or Node shell fallback is permitted.`,
    );
  }
  return installVerifiedBinary({
    dir: spawnBinDir(dataDir),
    fileName: binaryFileName(manifest.version),
    asset: manifest.assets[pkey],
    download: options.download || downloadSpawnBinary,
    label: LABEL,
    pkey,
    gcPrefix: 'mixdog-spawn-',
  });
});
