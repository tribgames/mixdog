import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { readJsonStateSync, unsupportedState, updateJsonAtomicSync } from '../shared/atomic-file.mjs';

const MAX_REGISTRY_BYTES = 1024 * 1024;
const cache = new Map();
const registryPath = (dataDir) => join(dataDir, 'local-provider', 'registered-models.json');

export const HUGGING_FACE_REPOSITORY_ID = /^[\w.-]+\/[\w.-]+$/;

/** Pinned Hugging Face download URL for one repository file at an exact revision. */
export function huggingFaceFileUrl(repository, revision, remoteFilename) {
  return `https://huggingface.co/${repository}/resolve/${revision}/${remoteFilename.split('/').map(encodeURIComponent).join('/')}`;
}

function validateModel(entry) {
  if (
    !entry ||
    !/^hf-[a-f0-9]{24}$/.test(entry.id || '') ||
    entry.filename !== `${entry.id}.gguf` ||
    !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    !Number.isSafeInteger(entry.contextWindow) ||
    entry.contextWindow < 512 ||
    entry.contextWindow > 32768 ||
    !Number.isSafeInteger(entry.estimatedVramBytes) ||
    entry.estimatedVramBytes < entry.size ||
    entry.minimumVramBytes !== entry.estimatedVramBytes ||
    !/^[a-f0-9]{40}$/.test(entry.revision || '') ||
    !HUGGING_FACE_REPOSITORY_ID.test(entry.repository || '') ||
    typeof entry.remoteFilename !== 'string' ||
    entry.remoteFilename.split('/').some((part) => !part || part === '.' || part === '..') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in an untrusted remote file name
    /[\\\x00-\x1f]/.test(entry.remoteFilename)
  ) {
    throw new Error('[local-provider] invalid registered model metadata');
  }
  const url = huggingFaceFileUrl(entry.repository, entry.revision, entry.remoteFilename);
  if (entry.url !== url) throw new Error('[local-provider] registered model URL does not match its pinned source');
  return entry;
}

// Each candidate (the index or its backup) is bounded by its own bytes.
function registryText(content) {
  if (content.length > MAX_REGISTRY_BYTES) throw new Error('[local-provider] registered model index is too large');
  return content.toString('utf8');
}

function parseRegistry(value) {
  // A newer build's index is left in place (reads as no models), not discarded.
  if (Number.isSafeInteger(value?.schema) && value.schema > 1) {
    throw unsupportedState(`[local-provider] registered model index schema ${value.schema} is newer than this build`);
  }
  if (value?.schema !== 1 || !Array.isArray(value.models) || value.models.length > 256) {
    throw new Error('[local-provider] invalid registered model index');
  }
  const models = value.models.map(validateModel);
  if (new Set(models.map((entry) => entry.id)).size !== models.length)
    throw new Error('[local-provider] duplicate registered model ids');
  return models;
}

export function registeredLocalModels(dataDir = resolvePluginData()) {
  const path = registryPath(dataDir);
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (cache.get(path)?.stamp === stamp) return cache.get(path).models.map((entry) => ({ ...entry }));
  // A damaged index (empty, NUL-filled, truncated, invalid) never blocks the
  // provider: its bytes are kept as <file>.corrupt-<ts>, the last good copy
  // (<file>.bak) is restored when there is one, else no model is registered.
  // The downloaded weights are untouched.
  const models = readJsonStateSync(path, { validate: parseRegistry, decode: registryText, fallback: [] });
  cache.set(path, { stamp, models });
  return models.map((entry) => ({ ...entry }));
}

// Read-modify-write under the index lock. A damaged index was recovered by the
// read first; a newer build's index makes the write refuse instead of
// replacing it (and its backup) with this build's format.
function mutateRegistry(dataDir, change) {
  registeredLocalModels(dataDir);
  const path = registryPath(dataDir);
  let result;
  updateJsonAtomicSync(
    path,
    (raw) => {
      const next = change(raw == null ? [] : parseRegistry(raw));
      if (!next) return undefined;
      result = next.result;
      return { schema: 1, models: next.models };
    },
    { backup: true }
  );
  cache.delete(path);
  return result;
}

export function registerLocalModel(entry, dataDir = resolvePluginData()) {
  validateModel(entry);
  let existing;
  const registered = mutateRegistry(dataDir, (models) => {
    existing = models.find((model) => model.id === entry.id);
    if (existing) return null;
    if (models.length >= 256) throw new Error('[local-provider] registered model limit reached');
    return { models: [...models, entry], result: entry };
  });
  if (!existing) return registered;
  if (existing.contextWindow !== entry.contextWindow)
    throw new Error('[local-provider] this model is already registered with another context size');
  return existing;
}

export function forgetRegisteredLocalModel(modelId, dataDir = resolvePluginData()) {
  mutateRegistry(dataDir, (models) =>
    models.some((entry) => entry.id === modelId)
      ? { models: models.filter((entry) => entry.id !== modelId), result: undefined }
      : null
  );
}
