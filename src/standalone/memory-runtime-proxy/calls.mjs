import { memoryAbortError, requestJson } from './rpc.mjs';
import { isMemoryReadOnlyToolCall, prepareMemoryToolArgumentsForWire } from './tool-wire.mjs';

const NOT_AVAILABLE = 'memory runtime is not available';

// The RPC surface the proxy exposes: every call resolves a registered daemon
// port first (starting/respawning as needed), then posts to its route.
export function createMemoryCalls({ state, cwd, start, discovery, registry }) {
  async function resolveRegisteredPort(checkpoint = () => {}) {
    checkpoint();
    await start();
    checkpoint();
    let port = state.portCache || (await discovery.findLivePort({ allowStarting: true }));
    if (!port) throw new Error(NOT_AVAILABLE);
    // ensureClientRegistered may respawn onto a fresh daemon/port; target the
    // port it hands back so the RPC and registration always hit the same one.
    port = await registry.ensureClientRegistered(port);
    if (!port) throw new Error(NOT_AVAILABLE);
    return port;
  }
  async function retain() {
    const started = await start();
    const port = await registry.ensureClientRegistered(started.port);
    return { ...started, port };
  }
  async function requestMemoryPath(path, body, { timeoutMs = 30_000, readOnlyRpc = false } = {}) {
    return await registry.withTransientRetry(
      async () => {
        const started = await retain();
        return await requestJson({ port: started.port, method: 'POST', path, body, timeoutMs });
      },
      { readOnlyRpc }
    );
  }
  async function appendEntry(data = {}) {
    return await requestMemoryPath('/entry', data, { timeoutMs: 3_000 });
  }
  async function ingestTranscript(filePath, { cwd: transcriptCwd } = {}) {
    return await requestMemoryPath('/ingest-transcript', {
      filePath,
      ...(transcriptCwd ? { cwd: transcriptCwd } : {}),
    });
  }
  async function recordTraceEvents(events = []) {
    return await requestMemoryPath('/admin/trace-record', { events }, { timeoutMs: 5_000 });
  }
  // Abort support: the signal rejects locally at every checkpoint and, once
  // the daemon has the call, also cancels it remotely by call id.
  async function handleToolCall(name, args = {}, signalOrOptions = null) {
    const signal = signalOrOptions?.signal || signalOrOptions || null;
    const readOnlyRpc = isMemoryReadOnlyToolCall(name, args);
    const wireArgs = prepareMemoryToolArgumentsForWire(name, args);
    const callId = `mem_${process.pid}_${state.nextCallId++}`;
    let activePort = null;
    let rpcStarted = false;
    const throwIfAborted = () => {
      if (signal?.aborted) throw memoryAbortError(signal.reason);
    };
    const cancelRemote = () => {
      if (!activePort || !rpcStarted) return;
      void requestJson({
        port: activePort,
        method: 'POST',
        path: '/api/cancel',
        body: { callId },
        timeoutMs: 1500,
      }).catch(() => {});
    };
    throwIfAborted();
    try {
      signal?.addEventListener?.('abort', cancelRemote, { once: true });
    } catch {}
    try {
      return await registry.withTransientRetry(
        async () => {
          const port = await resolveRegisteredPort(throwIfAborted);
          activePort = port;
          throwIfAborted();
          rpcStarted = true;
          return await requestJson({
            port,
            method: 'POST',
            path: '/api/tool',
            body: { name, arguments: wireArgs || {} },
            timeoutMs: Math.max(1000, Number(process.env.MIXDOG_MEMORY_TOOL_TIMEOUT_MS) || 180_000),
            headers: { 'X-Mixdog-Call-Id': callId },
            signal,
          });
        },
        { readOnlyRpc }
      );
    } finally {
      try {
        signal?.removeEventListener?.('abort', cancelRemote);
      } catch {}
    }
  }
  async function buildSessionCoreMemoryPayload(sessionCwd) {
    return await registry.withTransientRetry(
      async () => {
        const port = await resolveRegisteredPort();
        return await requestJson({
          port,
          method: 'POST',
          path: '/session-start/core-memory',
          body: { cwd: sessionCwd || cwd },
          timeoutMs: 30_000,
        });
      },
      { readOnlyRpc: true }
    );
  }
  return {
    retain,
    appendEntry,
    ingestTranscript,
    recordTraceEvents,
    handleToolCall,
    buildSessionCoreMemoryPayload,
  };
}
