import { sleep as delay } from '../../runtime/shared/sleep.mjs';
import {
  TRANSIENT_MEMORY_RPC_BACKOFF_MS,
  isConnResetLikeError,
  isMemoryWorkerNotReadyError,
  isTransientMemoryRpcError,
  requestJson,
} from './rpc.mjs';

// Client registration with the shared daemon (so it can reap itself once
// every client leaves) plus the transient-RPC recovery policy.
export function createClientRegistry({ state, start }) {
  function invalidateAfterTransient(err) {
    state.portCache = null;
    state.registeredWithPort = null;
    if (!isMemoryWorkerNotReadyError(err)) return;
    state.startPromise = null;
    const proc = state.child;
    state.child = null;
    if (!proc || proc.killed) return;
    try {
      proc.kill();
    } catch {}
  }
  function shouldRetry(err, { readOnlyRpc = false } = {}) {
    if (isMemoryWorkerNotReadyError(err)) return true;
    if (readOnlyRpc && isConnResetLikeError(err)) return true;
    return false;
  }
  async function withTransientRetry(run, { readOnlyRpc = false } = {}) {
    try {
      return await run();
    } catch (err) {
      if (!shouldRetry(err, { readOnlyRpc })) throw err;
      invalidateAfterTransient(err);
      await delay(TRANSIENT_MEMORY_RPC_BACKOFF_MS);
      return await run();
    }
  }
  // Returns the port the pending RPC should target. An internal respawn moves
  // the daemon to a fresh port, so callers MUST use the returned value rather
  // than the port they captured before registering.
  //
  // The register RPC is side-effect-free from the caller's point of view: a
  // refused/reset connection means the daemon never received it, and a
  // draining 503 means it refused it. So a register-phase transient is
  // ALWAYS safe to recover from by respawning and retrying — even ahead of a
  // pending WRITE RPC, which the outer retry must not blanket-retry itself.
  async function ensureClientRegistered(port) {
    if (!port || state.registeredWithPort === port) return port;
    let curPort = port;
    for (let attempt = 0; ; attempt++) {
      try {
        await requestJson({
          port: curPort,
          method: 'POST',
          path: '/client/register',
          body: { clientPid: process.pid },
          timeoutMs: 2000,
        });
        state.registeredWithPort = curPort;
        return curPort;
      } catch (err) {
        // Benign failures (e.g. a timeout against a busy-but-live daemon) are
        // not fatal: registration is best-effort and the idle TTL backstops a
        // missed register. Only recover from a genuine gone/dying daemon.
        if (!isTransientMemoryRpcError(err)) return curPort;
        if (attempt >= 3) throw err;
        invalidateAfterTransient(err);
        await delay(TRANSIENT_MEMORY_RPC_BACKOFF_MS);
        const started = await start();
        curPort = started.port;
      }
    }
  }
  async function deregisterClient() {
    const port = state.registeredWithPort || state.portCache;
    state.registeredWithPort = null;
    if (!port) return;
    try {
      await requestJson({
        port,
        method: 'POST',
        path: '/client/deregister',
        body: { clientPid: process.pid },
        timeoutMs: 1500,
      });
    } catch {
      /* best-effort; sweep + idle TTL reap us anyway */
    }
  }
  return { ensureClientRegistered, deregisterClient, withTransientRetry };
}
