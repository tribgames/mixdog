import { existsSync } from 'node:fs';

import { resolvePluginData } from '../shared/plugin-paths.mjs';
import {
  exactLocalProviderFile,
  localProviderModelEntry,
  localProviderModelPath,
  localProviderRuntimeDirectory,
  localProviderRuntimeExecutable,
} from './catalog.mjs';
import { createLocalServerProcess } from './server-process.mjs';
import { detectLocalProviderHardware, selectLocalProviderGpu } from './hardware.mjs';
import { createLocalRequestQueue, DEFAULT_LOCAL_IDLE_TTL_SECONDS } from './request-queue.mjs';
import { recordLocalModelLoad } from './model-state.mjs';

const server = createLocalServerProcess({
  onExit(diagnostic) {
    if (!diagnostic.expected) {
      process.stderr.write(`[local-provider] llama-server exit ${JSON.stringify(diagnostic)}\n`);
    }
  },
});
let exitHookInstalled = false;
const requests = createLocalRequestQueue({ unload: () => server.stop() });

export const runLocalProviderRequest = (operation, options) => requests.run(operation, options);
export const configureLocalProviderIdleTtl = (seconds) => requests.configure(
  Number.isInteger(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : DEFAULT_LOCAL_IDLE_TTL_SECONDS,
);

export function localProviderServerStatus() {
  return { ...server.status(), ...requests.status() };
}

export function stopLocalProviderServer() {
  return requests.stop();
}

export async function ensureLocalProviderServer(modelId, {
  dataDir = resolvePluginData(),
  signal,
} = {}) {
  signal?.throwIfAborted();
  const entry = localProviderModelEntry(modelId, dataDir);
  if (!entry) throw new Error(`[local-provider] unknown model: ${modelId}`);
  const executable = localProviderRuntimeExecutable(dataDir);
  const weights = localProviderModelPath(entry, dataDir);
  if (!executable || !existsSync(executable)) {
    throw new Error('[local-provider] runtime is not installed');
  }
  if (!exactLocalProviderFile(weights, entry.size)) {
    throw new Error(`[local-provider] model is not installed: ${entry.name}`);
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => server.killOnOwnerExit());
  }
  return server.ensure({
    key: `${executable}|${weights}`,
    modelId: entry.id,
    executable,
    cwd: localProviderRuntimeDirectory(dataDir),
    prepare: async (startupSignal) => {
      const hardware = await detectLocalProviderHardware({ refresh: true });
      startupSignal?.throwIfAborted();
      const gpu = selectLocalProviderGpu(hardware, entry);
      return { gpu, env: { CUDA_VISIBLE_DEVICES: gpu.uuid } };
    },
    onReady: async ({ baseURL, apiKey, loadTimeMs }, startupSignal) => {
      let props = {};
      try {
        const response = await fetch(`${baseURL.replace(/\/v1$/, '')}/props`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.any([startupSignal, AbortSignal.timeout(2_000)]),
        });
        if (response.ok) props = await response.json();
        else await response.body?.cancel();
      } catch { /* an unavailable capability endpoint stays unknown */ }
      recordLocalModelLoad(entry.id, props, loadTimeMs);
    },
    args: (port, apiKey) => [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--api-key', apiKey,
    '--model', weights,
    '--alias', entry.id,
    '--ctx-size', String(entry.contextWindow),
    '--parallel', '1',
    '--split-mode', 'none',
    '--main-gpu', '0',
    '--n-gpu-layers', '99',
    '--flash-attn', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--jinja',
    '--no-webui',
    ],
  }, { signal });
}
