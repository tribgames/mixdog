// Startup readiness: poll /health until the server answers, the child exits,
// or the startup deadline / caller signal aborts. Resolves the connection
// details once the spec's onReady hook has run.
import { setTimeout as delay } from 'node:timers/promises';

export async function awaitServerReady({ state, spec, fetchFn, waitSignal, pollMs, owner }) {
  while (true) {
    waitSignal.throwIfAborted();
    if (state.spawnError) throw state.spawnError;
    if (state.exited) {
      throw new Error(
        `[local-provider] llama-server exited during startup: ${owner.lastExit?.log || owner.lastExit?.exitCode}`
      );
    }
    try {
      const response = await fetchFn(`http://127.0.0.1:${state.port}/health`, {
        headers: { Authorization: `Bearer ${state.apiKey}` },
        signal: AbortSignal.any([waitSignal, AbortSignal.timeout(2_000)]),
      });
      const ok = response.ok;
      await response.body?.cancel();
      waitSignal.throwIfAborted();
      if (ok && !state.exited) {
        state.loadTimeMs = performance.now() - state.loadStartedAt;
        await spec.onReady?.(
          { baseURL: state.baseURL, apiKey: state.apiKey, loadTimeMs: state.loadTimeMs },
          waitSignal
        );
        waitSignal.throwIfAborted();
        if (state.exited) throw new Error('[local-provider] server exited while reading capabilities');
        state.ready = true;
        owner.lastError = null;
        return { baseURL: state.baseURL, apiKey: state.apiKey };
      }
    } catch {
      if (waitSignal.aborted) throw waitSignal.reason;
      // Connection refusal while loading is expected; the startup deadline
      // and child exit, not an HTTP probe, decide whether startup failed.
    }
    await delay(pollMs, null, { signal: waitSignal });
  }
}
