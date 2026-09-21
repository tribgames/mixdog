import { join } from 'node:path';
import { LOCAL_PROVIDER_MANIFEST, exactLocalProviderFile, localProviderRuntimeRoot } from './catalog.mjs';
import { partialAssetBytes } from './asset-storage.mjs';

// Partial files are durable evidence after a process restart. They do not
// prove validity: the installer still owns digest verification on resume.
const pausedEntry = (phase, modelId, receivedBytes, totalBytes) => ({
  phase,
  modelId,
  state: 'paused',
  stage: 'paused',
  receivedBytes,
  totalBytes,
  percent: Math.min(99, Math.round((receivedBytes / totalBytes) * 100)),
});

export function resumableLocalInstallations(catalog, live, dataDir) {
  const entries = [...live];
  for (const model of catalog.models) {
    const receivedBytes = model.sizeBytes - model.remainingDownloadBytes;
    if (
      model.installed ||
      receivedBytes <= 0 ||
      entries.some((entry) => entry.phase === 'model' && entry.modelId === model.id)
    )
      continue;
    entries.push(pausedEntry('model', model.id, receivedBytes, model.sizeBytes));
  }
  if (!catalog.runtime.installed && !entries.some((entry) => entry.phase === 'runtime')) {
    const assets = LOCAL_PROVIDER_MANIFEST.runtime.platforms['win32-x64-nvidia'].assets;
    const receivedBytes = assets.reduce((sum, asset) => {
      const path = join(localProviderRuntimeRoot(dataDir), '.downloads', asset.name);
      return sum + (exactLocalProviderFile(path, asset.size) ? asset.size : partialAssetBytes(path, asset.size));
    }, 0);
    if (receivedBytes > 0) entries.push(pausedEntry('runtime', null, receivedBytes, catalog.runtime.downloadBytes));
  }
  return entries;
}
