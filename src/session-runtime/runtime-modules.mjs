// Lazy runtime modules: memory, web search and the code graph stay cold until
// a feature first needs them, then load once per session runtime.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getStandaloneMemoryRuntime } from './services/memory-runtime-proxy.mjs';
import { bootProfile } from './boot-profile.mjs';
import { CODE_GRAPH_RUNTIME, WEB_SEARCH_RUNTIME, pluginDataDir } from './runtime-paths.mjs';

const MEMORY_RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url));

export function createLazyRuntimeModules({ rt, cfgMod }) {
  rt.memoryModPromise = null;
  rt.webSearchModPromise = null;
  rt.codeGraphModPromise = null;

  async function getMemoryModule() {
    const startedAt = performance.now();
    rt.memoryModPromise ??= Promise.resolve().then(() => {
      const runtime = getStandaloneMemoryRuntime({
        entry: MEMORY_RUNTIME_ENTRY,
        dataDir: process.env.MIXDOG_DATA_DIR || pluginDataDir(cfgMod),
      });
      // Session teardown must never stop a process shared by every other live
      // session. The daemon owns the actual stop()/deregister lifecycle.
      return {
        init: () => runtime.init(),
        handleToolCall: (...args) => runtime.handleToolCall(...args),
        buildSessionCoreMemoryPayload: (...args) => runtime.buildSessionCoreMemoryPayload(...args),
        warmupEmbedding: () => runtime.warmupEmbedding(),
      };
    });
    const mod = await rt.memoryModPromise;
    if (typeof mod?.init === 'function') {
      await mod.init();
    }
    bootProfile('memory-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getWebSearchModule() {
    const startedAt = performance.now();
    rt.webSearchModPromise ??= import(WEB_SEARCH_RUNTIME);
    const mod = await rt.webSearchModPromise;
    bootProfile('web-search-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getCodeGraphModule() {
    const startedAt = performance.now();
    rt.codeGraphModPromise ??= import(CODE_GRAPH_RUNTIME);
    const mod = await rt.codeGraphModPromise;
    bootProfile('code-graph-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  return { getMemoryModule, getWebSearchModule, getCodeGraphModule };
}
