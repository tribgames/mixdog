import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { localProviderDiskStatus, partialAssetBytes } from './asset-storage.mjs';
import { localProviderHardwareStatus } from './hardware.mjs';
import { registeredLocalModels } from './registered-models.mjs';
import { localModelState } from './model-state.mjs';
import { localContextSettings } from './context-settings.mjs';
export { detectLocalProviderHardware } from './hardware.mjs';

export const LOCAL_PROVIDER_ID = 'mixdog-local';
export const LOCAL_PROVIDER_BUILTIN_ID = 'localProvider';

const MANIFEST_PATH = fileURLToPath(new URL('./data/manifest.json', import.meta.url));
export const LOCAL_PROVIDER_MANIFEST = Object.freeze(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));

export function localProviderRuntimeRoot(dataDir = resolvePluginData()) {
  return join(dataDir, 'local-provider', 'runtime');
}

export function localProviderModelRoot(dataDir = resolvePluginData()) {
  return join(dataDir, 'local-provider', 'models');
}

function localProviderRuntimePlatformKey(platform = process.platform, arch = process.arch) {
  return platform === 'win32' && arch === 'x64' ? 'win32-x64-nvidia' : '';
}

export function localProviderRuntimePlatformEntry(options = {}) {
  const key = localProviderRuntimePlatformKey(options.platform, options.arch);
  const entry = key ? LOCAL_PROVIDER_MANIFEST.runtime?.platforms?.[key] : null;
  return entry ? { key, ...entry } : null;
}

export function localProviderRuntimeDirectory(dataDir = resolvePluginData()) {
  return join(localProviderRuntimeRoot(dataDir), LOCAL_PROVIDER_MANIFEST.runtime.version);
}

export function localProviderRuntimeExecutable(dataDir = resolvePluginData(), options = {}) {
  const entry = localProviderRuntimePlatformEntry(options);
  return entry ? join(localProviderRuntimeDirectory(dataDir), entry.executable) : '';
}

function localProviderModelEntries(dataDir = resolvePluginData()) {
  return [...LOCAL_PROVIDER_MANIFEST.models, ...registeredLocalModels(dataDir)];
}

export function localProviderModelEntry(modelId, dataDir = resolvePluginData()) {
  return localProviderModelEntries(dataDir).find((entry) => entry.id === String(modelId || '')) || null;
}

export function localProviderModelPath(entry, dataDir = resolvePluginData()) {
  return join(localProviderModelRoot(dataDir), entry.filename);
}

export function exactLocalProviderFile(path, size) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size === size;
  } catch {
    return false;
  }
}

function recommendationFor(hardware) {
  const installedVram = Number(hardware?.gpu?.memoryBytes || 0);
  const candidates = LOCAL_PROVIDER_MANIFEST.models.filter((entry) => entry.recommended === true);
  return candidates.find((entry) => installedVram >= Number(entry.minimumVramBytes || 0))
    || null;
}

function publicModel(entry, dataDir, hardware) {
  const state = localModelState(entry.id);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    sizeBytes: entry.size,
    remainingDownloadBytes: entry.size - partialAssetBytes(localProviderModelPath(entry, dataDir), entry.size),
    estimatedVramBytes: entry.estimatedVramBytes,
    minimumVramBytes: entry.minimumVramBytes,
    ...localContextSettings(entry, dataDir),
    supportsFunctionCalling: state.capabilities?.tools ?? entry.supportsFunctionCalling ?? null,
    supportsReasoning: entry.supportsReasoning ?? null,
    supportsImages: false,
    supportsReasoningSettings: false,
    architecture: entry.architecture || null,
    compatibility: entry.compatibility || 'Bundled model',
    revision: entry.revision || null,
    ...state,
    license: entry.license,
    source: entry.source,
    recommended: recommendationFor(hardware)?.id === entry.id,
    compatible: Number(hardware?.gpu?.memoryBytes || 0) >= Number(entry.minimumVramBytes || 0),
    installed: exactLocalProviderFile(localProviderModelPath(entry, dataDir), entry.size),
    present: existsSync(localProviderModelPath(entry, dataDir)),
  };
}

export function localProviderCatalogStatus({
  dataDir = resolvePluginData(),
  hardware = localProviderHardwareStatus(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const platformEntry = localProviderRuntimePlatformEntry({ platform, arch });
  const executable = localProviderRuntimeExecutable(dataDir, { platform, arch });
  const models = localProviderModelEntries(dataDir).map((entry) => publicModel(entry, dataDir, hardware));
  return {
    available: Boolean(
      platformEntry
      && hardware?.gpu?.vendor === 'NVIDIA'
      && models.some((entry) => entry.compatible),
    ),
    runtime: {
      installed: Boolean(executable && existsSync(executable)),
      version: LOCAL_PROVIDER_MANIFEST.runtime.version,
      downloadBytes: platformEntry?.downloadBytes || 0,
      source: LOCAL_PROVIDER_MANIFEST.runtime.source,
      license: LOCAL_PROVIDER_MANIFEST.runtime.license,
      backend: platformEntry?.backend || '',
    },
    hardware,
    disk: localProviderDiskStatus(dataDir),
    models,
    recommendation: models.find((entry) => entry.recommended) || null,
  };
}

export function installedLocalProviderModels({ dataDir = resolvePluginData() } = {}) {
  const status = localProviderCatalogStatus({ dataDir });
  return status.models.filter((entry) => entry.installed).map((entry) => ({
    id: entry.id,
    name: entry.name,
    display: entry.name,
    description: entry.description,
    contextWindow: entry.contextWindow,
    maxContextWindow: entry.maxContextWindow,
    runtimeContextWindow: entry.runtimeContextWindow,
    supportsFunctionCalling: entry.supportsFunctionCalling,
    supportsReasoning: entry.supportsReasoning,
    mode: 'chat',
    family: entry.architecture || (entry.id.startsWith('qwen') ? 'qwen' : ''),
    supportsImages: false,
    supportsReasoningSettings: false,
    latest: true,
  }));
}
