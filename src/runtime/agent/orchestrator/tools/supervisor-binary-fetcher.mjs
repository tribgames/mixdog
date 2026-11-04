// supervisor-binary-fetcher.mjs — installs the prebuilt mixdog-supervisor
// binary from the bundled manifest only (no remote manifest fallback: the
// supervisor release is pinned to the installed Mixdog version). Caches under
// <dataDir>/supervisor-bin/.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binSuffix,
  createBinaryDownloader,
  findCachedBinary,
  installVerifiedBinary,
  readBundledManifest,
  resolvePlatformKey,
  singleFlight,
  validReleaseAsset,
} from '../../../shared/native-asset.mjs';

const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./supervisor-manifest.json', import.meta.url));

const LABEL = '[supervisor-fetcher]';
const RELEASE_ASSET = { name: 'mixdog-supervisor', tagPrefix: 'supervisor-v' };

function supervisorBinDir(dataDir) {
  return join(dataDir, 'supervisor-bin');
}

function binaryFileName(version) {
  return `mixdog-supervisor-${version}${binSuffix()}`;
}

function validSupervisorAsset(manifest, pkey) {
  return validReleaseAsset(manifest, pkey, RELEASE_ASSET);
}

const downloadSupervisorBinary = createBinaryDownloader({ name: 'supervisor', label: LABEL });

export function findCachedSupervisorBinary(dataDir, options = {}) {
  try {
    const manifest = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
    const pkey = resolvePlatformKey((key) => validSupervisorAsset(manifest, key));
    if (!validSupervisorAsset(manifest, pkey)) return null;
    return findCachedBinary({
      dir: supervisorBinDir(dataDir),
      fileName: binaryFileName(manifest.version),
      sha256: manifest.assets[pkey].sha256,
    });
  } catch {
    return null;
  }
}

export const ensureSupervisorBinary = singleFlight(async (dataDir, options = {}) => {
  const manifest = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
  const pkey = resolvePlatformKey((key) => validSupervisorAsset(manifest, key));
  if (!validSupervisorAsset(manifest, pkey)) {
    const supported =
      Object.keys(manifest?.assets || {}).join(', ') || '(none; supervisor release not synchronized)';
    throw new Error(
      `${LABEL} no verified mixdog-supervisor binary for ${pkey}. ` +
        `Supported platforms: ${supported}. No local-build fallback is permitted.`
    );
  }
  return installVerifiedBinary({
    dir: supervisorBinDir(dataDir),
    fileName: binaryFileName(manifest.version),
    asset: manifest.assets[pkey],
    download: options.download || downloadSupervisorBinary,
    label: LABEL,
    pkey,
    gcPrefix: 'mixdog-supervisor-',
  });
});
