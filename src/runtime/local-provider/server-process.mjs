import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { redactedLog, spawnServerState } from './server-process/child-state.mjs';
import { awaitServerReady } from './server-process/readiness.mjs';

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// One process owner for all sessions. Serialized starts/stops prevent model
// switches from overlapping; a cancelled queued caller never starts a child.
export function createLocalServerProcess({
  spawnFn = spawn,
  fetchFn = fetch,
  portFn = freeLoopbackPort,
  startTimeoutMs = 3 * 60_000,
  stopTimeoutMs = 5_000,
  pollMs = 500,
  onExit = () => {},
} = {}) {
  // The owner record: which child is current and what the last one reported.
  const owner = { current: null, lastExit: null, lastError: null };
  let chain = Promise.resolve();
  const pendingStarts = new Set();

  function serialize(operation) {
    const next = chain.then(operation, operation);
    chain = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  async function stopState(state) {
    if (!state || state.exited) return;
    state.expectedExit = true;
    const timer = new AbortController();
    try {
      state.child.kill();
      await Promise.race([state.exit, delay(stopTimeoutMs, null, { signal: timer.signal })]);
      if (!state.exited) {
        state.child.kill('SIGKILL');
        await Promise.race([state.exit, delay(stopTimeoutMs, null, { signal: timer.signal })]);
        if (!state.exited) throw new Error('[local-provider] llama-server did not exit after termination');
      }
    } finally {
      timer.abort();
    }
  }

  async function prepareLaunch(spec, signal) {
    try {
      return (await spec.prepare?.(signal)) || {};
    } catch (error) {
      owner.lastError = signal?.aborted ? null : String(error?.message || error);
      throw error;
    }
  }

  async function start(spec, signal) {
    signal?.throwIfAborted();
    const { current } = owner;
    if (current?.key === spec.key && current.ready && !current.exited) {
      return { baseURL: current.baseURL, apiKey: current.apiKey };
    }
    await stopState(current);
    signal?.throwIfAborted();
    const launch = await prepareLaunch(spec, signal);
    signal?.throwIfAborted();
    const port = await portFn();
    signal?.throwIfAborted();
    const state = spawnServerState({ spawnFn, spec, launch, port, owner, onExit });
    const startup = AbortSignal.timeout(startTimeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, startup]) : startup;
    try {
      return await awaitServerReady({ state, spec, fetchFn, waitSignal, pollMs, owner });
    } catch (error) {
      let failure = error;
      if (signal?.aborted) failure = signal.reason;
      else if (startup.aborted) {
        failure = new Error(`[local-provider] llama-server did not become ready: ${redactedLog(state).trim()}`, {
          cause: error,
        });
      }
      owner.lastError = signal?.aborted ? null : String(failure?.message || failure);
      await stopState(state);
      throw failure;
    }
  }

  return {
    ensure(spec, { signal } = {}) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      pendingStarts.add(controller);
      const pending = serialize(() => start(spec, combined)).finally(() => pendingStarts.delete(controller));
      return awaitWithSignal(pending, combined);
    },
    stop() {
      // Do not queue cancellation behind the loading work it must interrupt.
      for (const controller of pendingStarts) {
        controller.abort(new Error('[local-provider] server start cancelled by stop'));
      }
      return serialize(() => stopState(owner.current));
    },
    status() {
      const { current, lastExit, lastError } = owner;
      return {
        running: Boolean(current?.ready && !current.exited),
        starting: Boolean(current && !current.ready && !current.exited),
        activeModel: current?.modelId || null,
        gpu: current?.gpu ? { ...current.gpu } : null,
        loadTimeMs: current?.loadTimeMs ?? null,
        lastExit: lastExit ? { ...lastExit } : null,
        lastError,
      };
    },
    // Only the owning process's exit hook calls this synchronous fallback.
    killOnOwnerExit() {
      const { current } = owner;
      if (current && !current.exited) {
        current.expectedExit = true;
        try {
          current.child.kill();
        } catch {}
      }
    },
  };
}
