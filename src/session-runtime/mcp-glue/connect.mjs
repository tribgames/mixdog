// MCP connection orchestration: the serialized full connect/reset, the
// non-superseding single-server toggle, and the turn gate on the initial
// connect. All mutable progress lives on the caller-owned `state`.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';
import { ensurePluginServerData } from './plugin-servers.mjs';

export function createMcpConnect({
  mcpClient,
  getMcpScopeId,
  getCurrentCwd = () => '',
  state,
  resolveEffectiveMcpServers,
  mcpStatus,
}) {
  const scopeOptions = () => ({ scopeId: getMcpScopeId() });
  // name -> the resolved config this runtime last (re)connected the server
  // with. Reconcile compares against it so only new or changed servers
  // reconnect (a cwd switch changes only cwd-following plugin servers).
  const applied = () => {
    if (!(state.mcpApplied instanceof Map)) state.mcpApplied = new Map();
    return state.mcpApplied;
  };
  const fingerprint = (cfg) => JSON.stringify(cfg);
  // Roots advertised by cwd-following servers track this runtime's cwd.
  const syncScopeRoot = () => mcpClient.setMcpScopeRoot?.(getMcpScopeId(), clean(getCurrentCwd?.()));
  // Abort the pending interactive OAuth login of one server's connect.
  const cancelMcpLogin = (name) => mcpClient.cancelMcpLogin?.(clean(name), scopeOptions());
  // Answer it with the redirect URL pasted from the browser.
  const completeMcpLogin = (name, callbackUrl) => mcpClient.completeMcpLogin(clean(name), callbackUrl, scopeOptions());

  // Connect/disconnect exactly one server in the live registry, leaving all
  // others untouched. Used by the enable/disable toggle so a single-server
  // change never triggers a full disconnectAll()/reconnect freeze. Only an
  // explicit sign-in passes `login` ({ openBrowser }): every other connect is
  // non-interactive and reports a server that needs one as sign-in required.
  async function applyMcpServerConnection(name, enabled, servers = resolveEffectiveMcpServers().servers, login = null) {
    const target = clean(name);
    if (!target) return;
    // Changing this server's state clears any stale failure record for it.
    if (Array.isArray(state.mcpFailures)) {
      state.mcpFailures = state.mcpFailures.filter((row) => row.name !== target);
    }
    const cfg = servers[target];
    if (enabled === false || !cfg || cfg.enabled === false) {
      applied().delete(target);
      await mcpClient.disconnectMcpServer?.(target, scopeOptions());
      return;
    }
    applied().set(target, fingerprint(cfg));
    // Close-then-connect as one generation-guarded op: a shutdown landing
    // between the close and the connect never resurrects the server.
    try {
      ensurePluginServerData(cfg);
      await mcpClient.reconnectSingleMcpServer(
        getMcpScopeId(),
        target,
        cfg,
        login ? { interactive: true, openBrowser: login.openBrowser } : {}
      );
    } catch (error) {
      const failure = { name: target, msg: error?.message || String(error) };
      if (error?.authRequired) failure.authRequired = true;
      const failures = Array.isArray(error?.failures) ? error.failures : [failure];
      state.mcpFailures = [...(state.mcpFailures || []), ...failures];
    }
  }

  // Bring the registry in line with the effective set: drop servers that are
  // gone or disabled, (re)connect servers that are new or whose resolved
  // config changed; untouched servers keep their connection.
  async function reconcileServers() {
    syncScopeRoot();
    const { servers } = resolveEffectiveMcpServers();
    const known = applied();
    const drops = [...known.keys()].filter((name) => !servers[name] || servers[name].enabled === false);
    const connects = Object.entries(servers)
      .filter(([name, cfg]) => cfg?.enabled !== false && known.get(name) !== fingerprint(cfg))
      .map(([name]) => name);
    await Promise.allSettled([
      ...drops.map((name) => applyMcpServerConnection(name, false, servers)),
      ...connects.map((name) => applyMcpServerConnection(name, true, servers)),
    ]);
  }

  async function connectConfiguredMcp({
    reset = false,
    only = null,
    enabled = true,
    reconcile = false,
    login = null,
  } = {}) {
    if (envFlag('MIXDOG_DISABLE_MCP')) {
      ++state.mcpConnectGeneration;
      state.mcpFailures = [];
      applied().clear();
      if (only) await mcpClient.disconnectMcpServer?.(only, scopeOptions());
      else await mcpClient.disconnectAll?.(scopeOptions());
      return mcpStatus();
    }
    // Scoped single-server toggle: non-superseding. It must NEVER cancel a
    // pending full {reset} (cwd-change/boot). So do not bump the generation;
    // just wait for any in-flight run, then bail if a newer full reset has
    // been requested in the meantime. Registering as in-flight makes a later
    // reset serialize behind us instead of interleaving disconnect/connect.
    if (only || reconcile) {
      // A disable/remove must not wait out an interactive login of the
      // connect it queues behind: cancel that login first.
      if (only && enabled === false) cancelMcpLogin(only);
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
        if (reconcile) await reconcileServers();
        else await applyMcpServerConnection(only, enabled, undefined, login);
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
      if (reset) {
        await mcpClient.disconnectAll?.(scopeOptions());
        applied().clear();
      }
      state.mcpFailures = [];
      syncScopeRoot();
      const { servers } = resolveEffectiveMcpServers();
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg?.enabled === false) applied().delete(name);
        else applied().set(name, fingerprint(cfg));
      }
      if (Object.keys(servers).length === 0) return;
      try {
        for (const cfg of Object.values(servers)) if (cfg?.enabled !== false) ensurePluginServerData(cfg);
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
      // The gate must outlast the slowest enabled server's own startup budget;
      // a server with its budget disabled (0) means the connect may never
      // settle, so the whole gate is disabled (handled below).
      const configs = Object.values(resolveEffectiveMcpServers().servers).filter((cfg) => cfg?.enabled !== false);
      const budgets = (configs.length > 0 ? configs : [{}])
        .map((cfg) => mcpClient.resolveMcpStartupTimeoutMs?.(cfg))
        .filter((value) => Number.isFinite(value));
      if (budgets.length > 0) budgetMs = budgets.includes(0) ? 0 : Math.max(...budgets);
    } catch {
      /* fall back to default budget */
    }
    if (maxWaitMs !== null && maxWaitMs !== undefined) {
      const requestedMaxWaitMs = Number(maxWaitMs);
      if (Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs >= 0) {
        budgetMs = Math.min(budgetMs, requestedMaxWaitMs);
      }
    }
    // Budget disabled (0/off) = no per-server startup timeout, so the connect
    // promise may never settle; never gate the turn on it — fall back to the
    // legacy fire-and-forget behavior (late servers use the deferred path).
    if (!(budgetMs > 0)) return;
    let timer = null;
    let expired = false;
    const budget = new Promise((resolveBudget) => {
      timer = setTimeout(() => {
        expired = true;
        resolveBudget();
      }, budgetMs);
    });
    try {
      // Follow replacement connects (a reconnect queued behind the captured
      // run installs a new in-flight promise) inside ONE fixed deadline.
      // Failures are already captured in state.mcpFailures, so rejections are
      // swallowed: this gate must never reject the turn.
      let current = inFlight;
      while (current && !expired) {
        await Promise.race([Promise.resolve(current).catch(() => {}), budget]);
        if (expired) break;
        // Let a queued reconnect install its promise before re-checking.
        await Promise.race([new Promise((resolveTick) => setImmediate(resolveTick)), budget]);
        current = state.mcpConnectInFlight;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { connectConfiguredMcp, awaitInitialMcpConnect, cancelMcpLogin, completeMcpLogin };
}
