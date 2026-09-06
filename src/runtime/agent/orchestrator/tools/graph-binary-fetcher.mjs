// graph-binary-fetcher.mjs — fetches the prebuilt mixdog-graph native binary
// from the GitHub release manifest. The code graph has NO JS parse fallback,
// so the binary is required; ensureGraphBinary downloads + sha256-verifies it
// on first use and caches it under <dataDir>/graph-bin/. Mirrors the runtime
// fetcher pattern (memory/lib/runtime-fetcher.mjs) but for a single binary —
// no tar extraction.
//
// Public API:
//   ensureGraphBinary(dataDir) -> absolute path to the verified binary.
//     Throws if no asset matches the platform, or download/verify fails.
//   findCachedGraphBinary(dataDir) -> path | null (sync, no network).

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
} from '../../../shared/native-asset.mjs';

// Bundled fallback manifest shipped with Mixdog. CI rewrites this on each
// release with the per-platform asset URLs + sha256.
const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('./graph-manifest.json', import.meta.url));

// GitHub raw fallback — only consulted when neither cached nor bundled exists.
const MANIFEST_URL = 'https://raw.githubusercontent.com/tribgames/mixdog/main/src/runtime/agent/orchestrator/tools/graph-manifest.json';

const LABEL = '[graph-fetcher]';
const RELEASE_ASSET = { name: 'mixdog-graph', tagPrefix: 'graph-v' };

function graphBinDir(dataDir) {
  return join(dataDir, 'graph-bin');
}

function binaryFileName(version) {
  return `mixdog-graph-${version}${binSuffix()}`;
}

function validGraphAsset(manifest, pkey) {
  return validReleaseAsset(manifest, pkey, RELEASE_ASSET);
}

function selectLocalManifest(dataDir, options = {}) {
  const bundled = readBundledManifest(BUNDLED_MANIFEST_PATH, options);
  if (bundled) return bundled;
  const cached = readJsonOrNull(join(graphBinDir(dataDir), 'manifest.json'));
  return validGraphAsset(cached, platformKey()) ? cached : null;
}

async function loadManifest(dataDir, options = {}) {
  // Bundled manifest FIRST: it always matches the installed mixdog version.
  // A stale cached manifest.json from an older install must never shadow it
  // (caused sha256 mismatches on already-installed machines after upgrades).
  const local = selectLocalManifest(dataDir, options);
  if (local) return local;
  return fetchRemoteManifest(MANIFEST_URL, { fetch: options.fetch, label: LABEL });
}

const downloadGraphBinary = createBinaryDownloader({ name: 'graph', label: LABEL });

// Sync, network-free lookup of an already-cached binary. Used by the sync
// _graphBinaryPath() resolver before falling back to an async fetch.
export function findCachedGraphBinary(dataDir, options = {}) {
  try {
    const manifest = selectLocalManifest(dataDir, options);
    const pkey = platformKey();
    if (!validGraphAsset(manifest, pkey)) return null;
    return findCachedBinary({
      dir: graphBinDir(dataDir),
      fileName: binaryFileName(manifest.version),
      sha256: manifest.assets[pkey].sha256,
    });
  } catch {
    return null;
  }
}

export const ensureGraphBinary = singleFlight(async (dataDir, options = {}) => {
  const manifest = await loadManifest(dataDir, options);
  const pkey = platformKey();
  if (!validGraphAsset(manifest, pkey)) {
    // Unsupported platform/arch (e.g. win32-arm64): the manifest has no
    // downloadable asset for this {os}-{arch}. The code graph has NO JS
    // parsing fallback, so this is terminal — surface a single clear,
    // actionable message instead of a cryptic crash downstream.
    const supported = Object.keys(manifest.assets || {}).join(', ') || '(none)';
    throw new Error(
      `${LABEL} no prebuilt mixdog-graph binary for platform ${pkey} `
      + `(unsupported platform/arch — there is no JS parsing fallback). `
      + `Supported platforms: ${supported}. `
      + `Build it locally: cargo build --release in native/mixdog-graph.`,
    );
  }
  return installVerifiedBinary({
    dir: graphBinDir(dataDir),
    fileName: binaryFileName(String(manifest.version || '0')),
    asset: manifest.assets[pkey],
    download: options.download || downloadGraphBinary,
    label: LABEL,
    pkey,
    gcPrefix: 'mixdog-graph',
  });
});
