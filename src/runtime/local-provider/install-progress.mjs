import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePluginData } from '../shared/plugin-paths.mjs';

const roots = new Map();

function operationsFor(dataDir) {
  const key = resolve(dataDir);
  if (!roots.has(key)) roots.set(key, new Map());
  return roots.get(key);
}

export function localProviderInstallStatus(dataDir = resolvePluginData()) {
  return [...(roots.get(resolve(dataDir))?.values() || [])].map(({ status }) => ({ ...status }));
}

// Share work, not just a promise: every interested caller can observe the same
// installation. The status API also survives settings-dialog close/reopen.
export function trackLocalInstallation(dataDir, { phase, modelId }, operation, onProgress) {
  const operations = operationsFor(dataDir);
  const key = `${phase}:${modelId || ''}`;
  let entry = operations.get(key);
  if (!entry?.promise) {
    entry = {
      status: { jobId: randomUUID(), phase, modelId: modelId || null, state: 'running', stage: 'preparing', percent: null },
      listeners: new Set(),
      promise: null,
      controller: new AbortController(),
    };
    operations.set(key, entry);
    const publish = (update) => {
      entry.status = { ...entry.status, ...update, updatedAt: Date.now() };
      for (const listener of entry.listeners) {
        try { listener({ ...entry.status }); } catch { /* observer only */ }
      }
    };
    entry.publish = publish;
    entry.promise = Promise.resolve().then(() => operation((progress) => {
      publish({ ...progress, percent: Number.isFinite(progress.percent) ? Math.min(99, progress.percent) : null });
    }, entry.controller.signal)).then((result) => {
      publish({ state: 'complete', stage: 'complete', percent: 100 });
      return result;
    }, (error) => {
      publish(entry.controller.signal.aborted
        ? { state: 'paused', stage: 'paused', error: null }
        : { state: 'failed', error: String(error?.message || error) });
      throw error;
    }).finally(() => {
      entry.promise = null;
      entry.listeners.clear();
    });
  }
  if (typeof onProgress === 'function') {
    entry.listeners.add(onProgress);
    try { onProgress({ ...entry.status }); } catch { /* observer only */ }
  }
  return entry.promise;
}

export function cancelLocalInstallation(jobId, dataDir = resolvePluginData()) {
  if (typeof jobId !== 'string' || !jobId.trim()) throw new TypeError('jobId is required.');
  const entry = [...(roots.get(resolve(dataDir))?.values() || [])].find((item) => item.status.jobId === jobId);
  if (!entry) throw new Error('[local-provider] installation job not found; refresh status before cancelling');
  if (!entry.promise || entry.controller.signal.aborted) return { ...entry.status };
  entry.publish({ state: 'cancelling' });
  entry.controller.abort(new Error('[local-provider] installation paused by user'));
  return { ...entry.status };
}

export function forgetLocalInstallations(modelId, dataDir = resolvePluginData()) {
  const operations = roots.get(resolve(dataDir));
  for (const [key, entry] of operations || []) {
    if (entry.status.modelId !== modelId) continue;
    if (entry.promise) throw new Error('[local-provider] cannot forget an active model job');
    operations.delete(key);
  }
}
