// MCP connection orchestration: the serialized full connect/reset, the
// non-superseding single-server toggle, and the turn gate on the initial
// connect. All mutable progress lives on the caller-owned `state`.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { envFlag } from '../../runtime/shared/env.mjs';
import { awaitInitialConnect } from './initial-connect-gate.mjs';
import { ensurePluginServerData } from './plugin-servers.mjs';
import { createServerConnection } from './server-connection.mjs';

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

  const { applyMcpServerConnection, reconcileServers } = createServerConnection({
    mcpClient,
    state,
    resolveEffectiveMcpServers,
    getMcpScopeId,
    scopeOptions,
    applied,
    fingerprint,
    syncScopeRoot,
  });

  // Wait for a prior run (its failures were already captured in state).
  async function settled(prior) {
    if (!prior) return;
    try {
      await prior;
    } catch {
      /* prior run's failures already captured */
    }
  }

  // Register `run` as the in-flight connect so a later reset serializes
  // behind it instead of interleaving disconnect/connect.
  async function trackInFlight(run) {
    state.mcpConnectInFlight = run;
    try {
      await run;
    } finally {
      if (state.mcpConnectInFlight === run) state.mcpConnectInFlight = null;
    }
  }

  // Scoped single-server toggle (or reconcile): non-superseding. It must NEVER
  // cancel a pending full {reset} (cwd-change/boot). So do not bump the
  // generation; just wait for any in-flight run, then bail if a newer full
  // reset has been requested in the meantime.
  async function connectScoped({ only, enabled, reconcile, login }) {
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
    await trackInFlight(
      (async () => {
        await settled(prev);
        if (gen !== state.mcpConnectGeneration) return;
        if (reconcile) await reconcileServers();
        else await applyMcpServerConnection(only, enabled, undefined, login);
      })()
    );
  }

  // Serialize reconnects: boot connect, cwd-change reset, and rapid cwd
  // switches must never interleave their disconnect/connect phases, or an
  // older run finishing after a newer reset could re-add stale servers into
  // the shared client registry. Approach: a generation token + a single
  // in-flight promise. Each call bumps the generation, waits for any prior
  // run to finish, then bails if a newer call has superseded it — leaving the
  // latest requested effective-server-set in the registry.
  async function connectAll({ reset }) {
    const gen = ++state.mcpConnectGeneration;
    await settled(state.mcpConnectInFlight);
    if (gen !== state.mcpConnectGeneration) return;
    await trackInFlight(
      (async () => {
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
      })()
    );
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
    if (only || reconcile) await connectScoped({ only, enabled, reconcile, login });
    else await connectAll({ reset });
    return mcpStatus();
  }

  return {
    connectConfiguredMcp,
    awaitInitialMcpConnect: (maxWaitMs) =>
      awaitInitialConnect({ state, mcpClient, resolveEffectiveMcpServers }, maxWaitMs),
    cancelMcpLogin,
    completeMcpLogin,
  };
}
