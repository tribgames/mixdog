// Native helper shutdown for session-runtime teardown: the patch server, the
// spawn/search transports, and a deadline race so terminal restore never waits
// on a hung child.
import { performance } from 'node:perf_hooks';
import { bootProfile } from './boot-profile.mjs';

export async function closePatchRuntimeIfLoaded(options = {}) {
  const closer = globalThis.__mixdogCloseNativePatchServers;
  if (typeof closer !== 'function' || globalThis.__mixdogNativePatchRuntimeTouched !== true) return;
  bootProfile('patch-runtime:close:start');
  const startedAt = performance.now();
  try {
    await closer(options);
  } catch {
    // Best-effort shutdown only; terminal restore must continue.
  } finally {
    bootProfile('patch-runtime:close:done', { ms: (performance.now() - startedAt).toFixed(1) });
  }
}

export async function closeNativeToolTransports(reason = 'process-exit') {
  const [spawnClient, searchClient] = await Promise.all([
    import('../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs'),
    import('../runtime/agent/orchestrator/tools/builtin/native-search-client.mjs'),
  ]);
  await Promise.allSettled([
    spawnClient.shutdownNativeSpawnServer?.(reason),
    searchClient.shutdownNativeSearchServer?.(reason),
  ]);
}

export function withTeardownDeadline(promise, ms, fallback = false) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
