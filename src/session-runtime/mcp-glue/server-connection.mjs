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

  return { applyMcpServerConnection, reconcileServers };
}
