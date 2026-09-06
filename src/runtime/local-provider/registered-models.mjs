import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { writeJsonAtomicSync } from '../shared/atomic-file.mjs';

const MAX_REGISTRY_BYTES = 1024 * 1024;
const cache = new Map();
const registryPath = (dataDir) => join(dataDir, 'local-provider', 'registered-models.json');

function validateModel(entry) {
  if (!entry || !/^hf-[a-f0-9]{24}$/.test(entry.id || '')
      || entry.filename !== `${entry.id}.gguf`
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
      || !Number.isSafeInteger(entry.size) || entry.size <= 0
      || !Number.isSafeInteger(entry.contextWindow) || entry.contextWindow < 512 || entry.contextWindow > 32768
      || !Number.isSafeInteger(entry.estimatedVramBytes) || entry.estimatedVramBytes < entry.size
      || entry.minimumVramBytes !== entry.estimatedVramBytes
      || !/^[a-f0-9]{40}$/.test(entry.revision || '')
      || !/^[\w.-]+\/[\w.-]+$/.test(entry.repository || '')
      || typeof entry.remoteFilename !== 'string' || entry.remoteFilename.split('/').some((part) => !part || part === '.' || part === '..')
      || /[\\\x00-\x1f]/.test(entry.remoteFilename)) {
    throw new Error('[local-provider] invalid registered model metadata');
  }
  const url = `https://huggingface.co/${entry.repository}/resolve/${entry.revision}/${entry.remoteFilename.split('/').map(encodeURIComponent).join('/')}`;
  if (entry.url !== url) throw new Error('[local-provider] registered model URL does not match its pinned source');
  return entry;
}

export function registeredLocalModels(dataDir = resolvePluginData()) {
  const path = registryPath(dataDir);
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.size > MAX_REGISTRY_BYTES) throw new Error('[local-provider] registered model index is too large');
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (cache.get(path)?.stamp === stamp) return cache.get(path).models.map((entry) => ({ ...entry }));
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.schema !== 1 || !Array.isArray(value.models) || value.models.length > 256) {
    throw new Error('[local-provider] invalid registered model index');
  }
  const models = value.models.map(validateModel);
  if (new Set(models.map((entry) => entry.id)).size !== models.length) throw new Error('[local-provider] duplicate registered model ids');
  cache.set(path, { stamp, models });
  return models.map((entry) => ({ ...entry }));
}

export function registerLocalModel(entry, dataDir = resolvePluginData()) {
  validateModel(entry);
  const models = registeredLocalModels(dataDir);
  const existing = models.find((model) => model.id === entry.id);
  if (existing) {
    if (existing.contextWindow !== entry.contextWindow) throw new Error('[local-provider] this model is already registered with another context size');
    return existing;
  }
  if (models.length >= 256) throw new Error('[local-provider] registered model limit reached');
  const path = registryPath(dataDir);
  writeJsonAtomicSync(path, { schema: 1, models: [...models, entry] });
  cache.delete(path);
  return entry;
}

export function forgetRegisteredLocalModel(modelId, dataDir = resolvePluginData()) {
  const models = registeredLocalModels(dataDir);
  if (!models.some((entry) => entry.id === modelId)) return;
  const path = registryPath(dataDir);
  writeJsonAtomicSync(path, { schema: 1, models: models.filter((entry) => entry.id !== modelId) });
  cache.delete(path);
}
