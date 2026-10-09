import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import {
  exactLocalProviderFile,
  localProviderModelEntry,
  localProviderModelPath,
  localProviderRuntimePlatformEntry,
  localProviderRuntimeRoot,
} from './catalog.mjs';
import { partialAssetBytes } from './asset-storage.mjs';
import { forgetLocalInstallation, localProviderInstallStatus } from './install-progress.mjs';

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
    const assets = localProviderRuntimePlatformEntry()?.assets || [];
    const receivedBytes = assets.reduce((sum, asset) => {
      const path = join(localProviderRuntimeRoot(dataDir), '.downloads', asset.name);
      return sum + (exactLocalProviderFile(path, asset.size) ? asset.size : partialAssetBytes(path, asset.size));
    }, 0);
    if (receivedBytes > 0) entries.push(pausedEntry('runtime', null, receivedBytes, catalog.runtime.downloadBytes));
  }
  return entries;
}

/** Drop a paused or failed installation row together with the downloads only
 *  that installation produced. Installed weights and runtimes are untouched;
 *  a failed verification only forgets its row. */
export function discardLocalInstallation(phase, modelId = null, dataDir = resolvePluginData()) {
  const owner = phase === 'runtime' ? null : modelId;
  if (
    localProviderInstallStatus(dataDir).some(
      (job) =>
        (job.phase === 'runtime') === (phase === 'runtime') &&
        (job.modelId || null) === (owner || null) &&
        ['running', 'cancelling'].includes(job.state)
    )
  )
    throw new Error('[local-provider] stop the installation before discarding it');
  forgetLocalInstallation(phase, owner, dataDir);
  if (phase === 'runtime') {
    for (const asset of localProviderRuntimePlatformEntry()?.assets || []) {
      const path = join(localProviderRuntimeRoot(dataDir), '.downloads', asset.name);
      rmSync(path, { force: true });
      rmSync(`${path}.part`, { force: true });
    }
  } else if (phase === 'model' || phase === 'repair') {
    const entry = localProviderModelEntry(modelId, dataDir);
    if (!entry) throw new Error('[local-provider] unknown model');
    rmSync(`${localProviderModelPath(entry, dataDir)}.part`, { force: true });
  } else if (phase !== 'verify') {
    throw new TypeError('phase must be runtime, model, verify or repair.');
  }
}
