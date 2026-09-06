import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { localProviderModelEntry, localProviderModelPath, localProviderModelRoot } from './catalog.mjs';
import { downloadVerifiedLocalAsset, sha256File } from './asset-installer.mjs';
import { trackLocalInstallation, localProviderInstallStatus, forgetLocalInstallations } from './install-progress.mjs';
import { localProviderServerStatus, runLocalProviderRequest } from './server.mjs';
import { forgetRegisteredLocalModel } from './registered-models.mjs';
import { forgetLocalModelState, recordLocalModelVerification } from './model-state.mjs';

export function createModelMaintenance({
  dataDir = resolvePluginData(), serverStatus = localProviderServerStatus,
  exclusive = runLocalProviderRequest, fetchFn = fetch, now = Date.now,
} = {}) {
  const confirmations = new Map();
  const entryFor = (id) => {
    const entry = localProviderModelEntry(id, dataDir);
    if (!entry) throw new Error('[local-provider] unknown model');
    return entry;
  };
  function filesFor(entry) {
    const path = resolve(localProviderModelPath(entry, dataDir));
    const root = resolve(localProviderModelRoot(dataDir));
    if (dirname(path) !== root) throw new Error('[local-provider] model path escapes managed storage');
    return [path, `${path}.part`].flatMap((file) => {
      let stat;
      try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(dirname(file)) !== realpathSync(root)) {
        throw new Error('[local-provider] refusing a non-regular or redirected model file');
      }
      return [{ path: file, size: stat.size, mtimeMs: stat.mtimeMs }];
    });
  }
  function guard(entry, ownPhase = null) {
    const status = serverStatus();
    if ((status.running || status.starting) && status.activeModel === entry.id) {
      throw new Error('[local-provider] unload this model before repairing or deleting it; active conversations are protected');
    }
    if (localProviderInstallStatus(dataDir).some((job) => job.modelId === entry.id
        && ['running', 'cancelling'].includes(job.state) && job.phase !== ownPhase)) {
      throw new Error('[local-provider] this model has an active installation or maintenance job');
    }
  }
  return {
    details(modelId) {
      const entry = entryFor(modelId), files = filesFor(entry);
      for (const [token, item] of confirmations) if (item.expiresAt < now()) confirmations.delete(token);
      if (confirmations.size >= 100) throw new Error('[local-provider] too many pending deletion confirmations');
      const confirmationToken = randomUUID();
      confirmations.set(confirmationToken, { modelId, files, expiresAt: now() + 5 * 60_000 });
      return { modelId, name: entry.name, files, sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        source: entry.source, sha256: entry.sha256, confirmationToken,
        recoverability: 'Files are permanently deleted, not moved to the Recycle Bin. Recovery requires downloading the model again.' };
    },
    start(modelId, operation, { onComplete } = {}) {
      if (operation !== 'verify' && operation !== 'repair') throw new TypeError('operation must be verify or repair.');
      const entry = entryFor(modelId);
      if (operation === 'repair') guard(entry);
      else if (localProviderInstallStatus(dataDir).some((job) => job.modelId === modelId
          && ['running', 'cancelling'].includes(job.state))) throw new Error('[local-provider] wait for the current model job');
      const pending = trackLocalInstallation(dataDir, { phase: operation, modelId }, (publish, signal) =>
        exclusive(async (operationSignal) => {
          const path = localProviderModelPath(entry, dataDir);
          if (operation === 'repair') {
            guard(entry, operation);
            filesFor(entry);
            await downloadVerifiedLocalAsset(entry, path, { fetchFn, force: true, signal: operationSignal, onProgress: publish });
            recordLocalModelVerification(modelId, { valid: true, sizeBytes: entry.size, sha256: entry.sha256 });
            await onComplete?.();
            return { modelId, valid: true };
          }
          publish({ stage: 'verifying', percent: null });
          const files = filesFor(entry);
          const file = files.find((item) => item.path === resolve(path));
          if (!file) throw new Error('[local-provider] model file is missing');
          const actual = await sha256File(path, operationSignal);
          const valid = file.size === entry.size && actual === entry.sha256;
          recordLocalModelVerification(modelId, { valid, sizeBytes: file.size, sha256: actual });
          if (!valid) throw new Error('[local-provider] model integrity check failed; use Repair to download the pinned asset again');
          return { modelId, valid };
        }, { signal }));
      // Job status owns completion and errors; the command itself is nonblocking.
      void pending.catch(() => {});
      return localProviderInstallStatus(dataDir).find((job) => job.phase === operation && job.modelId === modelId);
    },
    async delete(confirmationToken) {
      const receipt = confirmations.get(confirmationToken);
      if (!receipt || receipt.expiresAt < now()) throw new Error('[local-provider] deletion confirmation expired; inspect the model again');
      const entry = entryFor(receipt.modelId);
      guard(entry);
      return exclusive(async () => {
        if (confirmations.get(confirmationToken) !== receipt || receipt.expiresAt < now()) {
          throw new Error('[local-provider] deletion confirmation expired or was already consumed');
        }
        guard(entry);
        const files = filesFor(entry);
        if (JSON.stringify(files) !== JSON.stringify(receipt.files)) throw new Error('[local-provider] model files changed; request a new deletion confirmation');
        confirmations.delete(confirmationToken);
        for (const file of files) unlinkSync(file.path);
        forgetRegisteredLocalModel(entry.id, dataDir);
        forgetLocalInstallations(entry.id, dataDir);
        forgetLocalModelState(entry.id);
        return { modelId: entry.id, deletedFiles: files.map((file) => file.path), recoverability: 'Redownload required; no Recycle Bin copy.' };
      });
    },
  };
}

const services = new Map();
export function modelMaintenance(dataDir = resolvePluginData()) {
  if (!services.has(dataDir)) services.set(dataDir, createModelMaintenance({ dataDir }));
  return services.get(dataDir);
}
