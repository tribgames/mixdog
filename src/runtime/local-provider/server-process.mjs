import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
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
  let current = null;
  let lastExit = null;
  let lastError = null;
  let chain = Promise.resolve();
  const pendingStarts = new Set();

  function serialize(operation) {
    const next = chain.then(operation, operation);
    chain = next.then(() => {}, () => {});
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

  async function start(spec, signal) {
    signal?.throwIfAborted();
    if (current?.key === spec.key && current.ready && !current.exited) {
      return { baseURL: current.baseURL, apiKey: current.apiKey };
    }
    await stopState(current);
    signal?.throwIfAborted();
    let launch;
    try {
      launch = await spec.prepare?.(signal) || {};
    } catch (error) {
      lastError = signal?.aborted ? null : String(error?.message || error);
      throw error;
    }
    signal?.throwIfAborted();
    const port = await portFn();
    signal?.throwIfAborted();
    const apiKey = randomBytes(32).toString('hex');
    const loadStartedAt = performance.now();
    const child = spawnFn(spec.executable, spec.args(port, apiKey, launch), {
      cwd: spec.cwd,
      env: { ...process.env, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let resolveExit;
    const state = {
      child, key: spec.key, modelId: spec.modelId, apiKey, gpu: launch.gpu || null,
      baseURL: `http://127.0.0.1:${port}/v1`,
      ready: false, exited: false, expectedExit: false, log: '',
      spawnError: null,
      exit: new Promise((resolve) => { resolveExit = resolve; }),
    };
    current = state;
    const appendLog = (chunk) => {
      state.log = `${state.log}${String(chunk)}`.slice(-16_384);
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);
    const recordExit = (exitCode, exitSignal) => {
      if (state.exited) return;
      state.exited = true;
      state.ready = false;
      lastExit = {
        at: new Date().toISOString(), modelId: state.modelId,
        exitCode, signal: exitSignal || null, expected: state.expectedExit,
        log: state.log.replaceAll(apiKey, '[redacted]'),
      };
      if (!state.expectedExit) {
        lastError = `[local-provider] llama-server exited (${exitCode ?? exitSignal ?? 'spawn error'}): ${lastExit.log.trim()}`;
      }
      if (current === state) current = null;
      resolveExit();
      try { onExit({ ...lastExit }); } catch { /* diagnostics cannot break lifecycle */ }
    };
    child.once('error', (error) => {
      state.spawnError = error;
      appendLog(error.message);
      recordExit(null, null);
    });
    child.once('exit', recordExit);
    const startup = AbortSignal.timeout(startTimeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, startup]) : startup;
    try {
      while (true) {
        waitSignal.throwIfAborted();
        if (state.spawnError) throw state.spawnError;
        if (state.exited) {
          throw new Error(`[local-provider] llama-server exited during startup: ${lastExit?.log || lastExit?.exitCode}`);
        }
        try {
          const response = await fetchFn(`http://127.0.0.1:${port}/health`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.any([waitSignal, AbortSignal.timeout(2_000)]),
          });
          const ok = response.ok;
          await response.body?.cancel();
          waitSignal.throwIfAborted();
          if (ok && !state.exited) {
            state.loadTimeMs = performance.now() - loadStartedAt;
            await spec.onReady?.({ baseURL: state.baseURL, apiKey, loadTimeMs: state.loadTimeMs }, waitSignal);
            waitSignal.throwIfAborted();
            if (state.exited) throw new Error('[local-provider] server exited while reading capabilities');
            state.ready = true;
            lastError = null;
            return { baseURL: state.baseURL, apiKey };
          }
        } catch (error) {
          if (waitSignal.aborted) throw waitSignal.reason;
          // Connection refusal while loading is expected; the startup deadline
          // and child exit, not an HTTP probe, decide whether startup failed.
        }
        await delay(pollMs, null, { signal: waitSignal });
      }
    } catch (error) {
      const failure = signal?.aborted ? signal.reason
        : startup.aborted
          ? new Error(`[local-provider] llama-server did not become ready: ${state.log.replaceAll(apiKey, '[redacted]').trim()}`, { cause: error })
          : error;
      lastError = signal?.aborted ? null : String(failure?.message || failure);
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
      const pending = serialize(() => start(spec, combined))
        .finally(() => pendingStarts.delete(controller));
      return awaitWithSignal(pending, combined);
    },
    stop() {
      // Do not queue cancellation behind the loading work it must interrupt.
      for (const controller of pendingStarts) {
        controller.abort(new Error('[local-provider] server start cancelled by stop'));
      }
      return serialize(() => stopState(current));
    },
    status() {
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
      if (current && !current.exited) {
        current.expectedExit = true;
        try { current.child.kill(); } catch {}
      }
    },
  };
}
