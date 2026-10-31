// Connecting, disconnecting and reconciling individual MCP servers in the live
// registry. The caller (connect.mjs) owns the serialization and the shared state.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { ensurePluginServerData } from './plugin-servers.mjs';

export function createServerConnection({
  mcpClient,
  state,
  resolveEffectiveMcpServers,
  getMcpScopeId,
  scopeOptions,
  applied,
  fingerprint,
  syncScopeRoot,
}) {
  // Connect/disconnect exactly one server in the live registry, leaving all
  // others untouched. Used by the enable/disable toggle so a single-server
  // change never triggers a full disconnectAll()/reconnect freeze. Only an
  // explicit sign-in passes `login` ({ openBrowser }): every other connect is
  // non-interactive and reports a server that needs one as sign-in required.
  // Answers the connect's failure (recorded in state.mcpFailures), null once
  // it connected or disconnected. The server's fingerprint is recorded only
  // once it connected, so one that failed is connected again by the next
  // reconcile although its config is unchanged.
  async function applyMcpServerConnection(name, enabled, servers = resolveEffectiveMcpServers().servers, login = null) {
    const target = clean(name);
    if (!target) return null;
    // Changing this server's state clears any stale failure record for it.
    if (Array.isArray(state.mcpFailures)) {
      state.mcpFailures = state.mcpFailures.filter((row) => row.name !== target);
    }
    const cfg = servers[target];
    applied().delete(target);
    if (enabled === false || !cfg || cfg.enabled === false) {
      await mcpClient.disconnectMcpServer?.(target, scopeOptions());
      return null;
    }
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
      applied().set(target, fingerprint(cfg));
      return null;
    } catch (error) {
      const failure = { name: target, msg: error?.message || String(error) };
      if (error?.authRequired) failure.authRequired = true;
      const failures = Array.isArray(error?.failures) ? error.failures : [failure];
      state.mcpFailures = [...(state.mcpFailures || []), ...failures];
      return failure;
    }
  }

  // Bring the registry in line with the effective set: drop servers that are
  // gone or disabled, (re)connect servers that are new or whose resolved
  // config changed; untouched servers keep their connection. A server whose
  // last connect failed is retried too (one the full connect recorded as
  // connected included): reconcile also runs when a sign-in or a stored
  // credential changed (possibly in another process), which leaves its
  // config, and so its fingerprint, as it was; so is a connection the client
  // reports dead. Answers the failures of this run that are not a needed
  // sign-in (that waits on the user, whose sign-in reconciles again); they
  // stay in the status, which the change step checks to retry them.
  async function reconcileServers() {
    syncScopeRoot();
    const { servers } = resolveEffectiveMcpServers();
    const known = applied();
    const dead = (mcpClient.getMcpServerStatus?.(getMcpScopeId()) || [])
      .filter((row) => row.alive === false || row.connected === false)
      .map((row) => row.name);
    const failed = new Set([
      ...(Array.isArray(state.mcpFailures) ? state.mcpFailures : []).map((row) => row.name),
      ...dead,
    ]);
    const drops = [...new Set([...known.keys(), ...failed])].filter(
      (name) => !servers[name] || servers[name].enabled === false
    );
    const connects = Object.entries(servers)
      .filter(([name, cfg]) => cfg?.enabled !== false && (known.get(name) !== fingerprint(cfg) || failed.has(name)))
      .map(([name]) => name);
    const results = await Promise.allSettled([
      ...drops.map((name) => applyMcpServerConnection(name, false, servers)),
      ...connects.map((name) => applyMcpServerConnection(name, true, servers)),
    ]);
    return results.flatMap((one) => {
      if (one.status === 'rejected') return [{ msg: one.reason?.message || String(one.reason) }];
      return one.value && !one.value.authRequired ? [one.value] : [];
    });
  }

  return { applyMcpServerConnection, reconcileServers };
}
