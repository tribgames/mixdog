// MCP connection orchestration: the serialized full connect/reset, the
// non-superseding single-server toggle, and the turn gate on the initial
// connect. All mutable progress lives on the caller-owned `state`.
import { clean } from '../session-text.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';

export function createMcpConnect({ mcpClient, getMcpScopeId, state, resolveEffectiveMcpServers, mcpStatus }) {
  const scopeOptions = () => ({ scopeId: getMcpScopeId() });

  // Connect/disconnect exactly one server in the live registry, leaving all
  // others untouched. Used by the enable/disable toggle so a single-server
  // change never triggers a full disconnectAll()/reconnect freeze.
  async function applyMcpServerConnection(name, enabled) {
    const target = clean(name);
    if (!target) return;
    const { servers } = resolveEffectiveMcpServers();
    // Definitions stay in their original source. Enabled state is folded from
    // Mixdog's per-project override for both global and `.mcp.json` entries, so
    // acting on the effective entry keeps live state aligned without rewriting
    // a shared project file.
    // Changing this server's state clears any stale failure record for it.
    if (Array.isArray(state.mcpFailures)) {
      state.mcpFailures = state.mcpFailures.filter((row) => row.name !== target);
    }
    if (enabled === false) {
      await mcpClient.disconnectMcpServer?.(target, scopeOptions());
      return;
    }
    const cfg = servers[target];
    if (!cfg) return;
    // Drop any existing live entry first so connectMcpServers doesn't overwrite
    // the registry Map entry and leak the old transport/process.
    await mcpClient.disconnectMcpServer?.(target, scopeOptions());
    try {
      await mcpClient.connectMcpServers({ [target]: cfg }, scopeOptions());
    } catch (error) {
      const failures = Array.isArray(error?.failures)
        ? error.failures
        : [{ name: target, msg: error?.message || String(error) }];
      state.mcpFailures = [...(state.mcpFailures || []), ...failures];
    }
  }

  async function connectConfiguredMcp({ reset = false, only = null, enabled = true } = {}) {
    if (envFlag('MIXDOG_DISABLE_MCP')) {
      ++state.mcpConnectGeneration;
      state.mcpFailures = [];
      if (only) await mcpClient.disconnectMcpServer?.(only, scopeOptions());
      else await mcpClient.disconnectAll?.(scopeOptions());
      return mcpStatus();
    }
    // Scoped single-server toggle: non-superseding. It must NEVER cancel a
    // pending full {reset} (cwd-change/boot). So do not bump the generation;
    // just wait for any in-flight run, then bail if a newer full reset has
    // been requested in the meantime. Registering as in-flight makes a later
    // reset serialize behind us instead of interleaving disconnect/connect.
    if (only) {
      // Atomically capture the current generation AND the prior in-flight
      // promise in the same synchronous step, then chain our op onto it. No
      // await sits between the capture and the `state.mcpConnectInFlight = run`
      // assignment, so concurrent {only} calls queue FIFO instead of resuming
      // together and clobbering the in-flight slot. We never bump the
      // generation; a {reset} does, so any {only} queued behind a reset sees
      // the newer generation when its turn comes and bails.
      const gen = state.mcpConnectGeneration;
      const prev = state.mcpConnectInFlight;
      const run = (async () => {
        if (prev) {
          try {
            await prev;
          } catch {
            /* prior run's failures already captured */
          }
        }
        if (gen !== state.mcpConnectGeneration) return;
        await applyMcpServerConnection(only, enabled);
      })();
      state.mcpConnectInFlight = run;
      try {
        await run;
      } finally {
        if (state.mcpConnectInFlight === run) state.mcpConnectInFlight = null;
      }
      return mcpStatus();
    }
    // Serialize reconnects: boot connect, cwd-change reset, and rapid cwd
    // switches must never interleave their disconnect/connect phases, or an
    // older run finishing after a newer reset could re-add stale servers into
    // the shared client registry. Approach: a generation token + a single
    // in-flight promise. Each call bumps the generation, waits for any prior
    // run to finish, then bails if a newer call has superseded it — leaving the
    // latest requested effective-server-set in the registry.
    const gen = ++state.mcpConnectGeneration;
    if (state.mcpConnectInFlight) {
      try {
        await state.mcpConnectInFlight;
      } catch {
        /* prior run's failures already captured */
      }
    }
    if (gen !== state.mcpConnectGeneration) return mcpStatus();
    const run = (async () => {
      if (reset) await mcpClient.disconnectAll?.(scopeOptions());
      state.mcpFailures = [];
      const { servers } = resolveEffectiveMcpServers();
      if (Object.keys(servers).length === 0) return;
      try {
        await mcpClient.connectMcpServers(servers, scopeOptions());
      } catch (error) {
        state.mcpFailures = Array.isArray(error?.failures)
          ? error.failures
          : [{ name: 'mcp', msg: error?.message || String(error) }];
      }
    })();
    state.mcpConnectInFlight = run;
    try {
      await run;
    } finally {
      if (state.mcpConnectInFlight === run) state.mcpConnectInFlight = null;
    }
    return mcpStatus();
  }

  // Turn gate: await the in-flight INITIAL connect, bounded by both the global
  // server startup budget and the caller's TTFT grace. A server still
  // connecting after the grace flows through the existing late-tool deferred
  // announcement path unchanged.
  async function awaitInitialMcpConnect(maxWaitMs = undefined) {
    const inFlight = state.mcpConnectInFlight;
    if (!inFlight) return;
    let budgetMs = 10000;
    try {
      const resolved = mcpClient.resolveMcpStartupTimeoutMs?.({});
      if (Number.isFinite(resolved)) budgetMs = resolved;
    } catch {
      /* fall back to default budget */
    }
    if (maxWaitMs !== null && maxWaitMs !== undefined) {
      const requestedMaxWaitMs = Number(maxWaitMs);
      if (Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs >= 0) {
        budgetMs = Math.min(budgetMs, requestedMaxWaitMs);
      }
    }
    // Swallow the in-flight rejection: failures are already captured in
    // state.mcpFailures, and this gate must never reject the turn.
    const settled = Promise.resolve(inFlight).catch(() => {});
    // Budget disabled (0/off) = no per-server startup timeout, so the connect
    // promise may never settle; never gate the turn on it — fall back to the
    // legacy fire-and-forget behavior (late servers use the deferred path).
    if (!(budgetMs > 0)) return;
    let timer = null;
    const budget = new Promise((resolveBudget) => {
      timer = setTimeout(resolveBudget, budgetMs);
    });
    try {
      await Promise.race([settled, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { connectConfiguredMcp, awaitInitialMcpConnect };
}
