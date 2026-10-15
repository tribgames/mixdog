// After a Skill / MCP / Plugin mutation: rebuild what new sessions see,
// notify the other runtimes sharing the data dir, and (for MCP toggles) run
// the heavy reconnect off the toggle's critical path.
import { publishGlobalExtensionChange, subscribeGlobalExtensionChanges } from './global-extensions.mjs';

export function createExtensionSync({
  connectConfiguredMcp,
  cancelMcpLogin,
  invalidatePreSessionToolSurface,
  refreshEmptySessionToolPolicy,
  reloadFullConfig,
  invalidateSkills,
}) {
  // Per-server MCP toggle serialization. The synchronous config adopt in
  // setMcpServerEnabled has already made the intent durable; the heavy
  // connectConfiguredMcp process spawn/handshake runs here. Rapid re-toggles
  // on one server update `desired` and ride the in-flight chain so it
  // converges to the last requested state without replacing any addressed
  // session.
  const mcpToggleChains = new Map(); // name -> { desired, running }

  async function refreshSurface(kind) {
    invalidatePreSessionToolSurface();
    // Existing conversations retain their stable prompt/session identity.
    // Empty sessions can safely rebuild their policy in place; MCP has its own
    // first-turn/late-tool reconciliation against the live connection registry.
    if ((kind === 'skills' || kind === 'plugins') && typeof refreshEmptySessionToolPolicy === 'function') {
      await refreshEmptySessionToolPolicy();
    }
  }

  // Apply per-server MCP changes in order, then reconcile: a configured server
  // added, renamed or removed can move a plugin server to another name, and
  // only the reconcile connects it there and drops the stale name. Servers
  // whose resolved config is unchanged stay untouched.
  async function applyMcpChanges(changes) {
    for (const { name, enabled } of changes) await connectConfiguredMcp({ only: name, enabled });
    return connectConfiguredMcp({ reconcile: true });
  }

  async function refreshState(kind, detail = null) {
    reloadFullConfig?.();
    if (kind === 'skills' || kind === 'plugins') invalidateSkills?.();
    const mcpChanges = kind === 'mcp' ? detail?.mcpChanges : null;
    if (Array.isArray(mcpChanges)) {
      await applyMcpChanges(mcpChanges);
    } else if (kind === 'plugins') {
      // Plugin servers are derived from the registry: connect what is new or
      // changed, drop what is gone or disabled, leave the rest connected.
      await connectConfiguredMcp({ reconcile: true });
    } else if (kind === 'mcp') {
      await connectConfiguredMcp({ reset: true });
    }
    await refreshSurface(kind);
  }

  const subscription = subscribeGlobalExtensionChanges(refreshState);
  const publish = (kind, detail = null) => publishGlobalExtensionChange(kind, subscription.id, detail);

  function scheduleMcpToggle(serverName, enabled) {
    const chain = mcpToggleChains.get(serverName) || { desired: enabled, running: null };
    chain.desired = enabled;
    mcpToggleChains.set(serverName, chain);
    // A disable riding the chain would otherwise wait out an explicit sign-in
    // (beginMcpOAuthLogin) of this server still in flight.
    if (enabled === false) cancelMcpLogin?.(serverName);
    if (!chain.running) {
      chain.running = (async () => {
        let status;
        try {
          let want;
          do {
            want = chain.desired;
            status = await connectConfiguredMcp({ only: serverName, enabled: want });
          } while (chain.desired !== want);
          await refreshSurface('mcp');
        } finally {
          chain.running = null;
        }
        return status;
      })();
    }
    return chain.running;
  }

  /** Skills/plugins invalidate the skill cache; every kind rebuilds the
   *  pre-session surface and notifies the other runtimes. */
  async function announce(kind, { invalidate = kind !== 'mcp', detail = null } = {}) {
    if (invalidate) invalidateSkills?.();
    await refreshSurface(kind);
    await publish(kind, detail);
  }

  /** Reconnect MCP after a config write, then announce. With `only`, just that
   *  server is (re)connected (or disconnected when `enabled` is false) and
   *  `drop` names (e.g. a renamed/removed server) are disconnected; every other
   *  server stays untouched. Without `only`, every configured server reconnects. */
  async function reconnectMcpAndAnnounce({ only = null, enabled = true, drop = [] } = {}) {
    if (only || drop.length > 0) {
      // Other runtimes receive the same scoped change list, not a full reset.
      const mcpChanges = [
        ...drop.map((name) => ({ name, enabled: false })),
        ...(only ? [{ name: only, enabled }] : []),
      ];
      const status = await applyMcpChanges(mcpChanges);
      await announce('mcp', { detail: { mcpChanges } });
      return status;
    }
    const status = await connectConfiguredMcp({ reset: true });
    await announce('mcp');
    return status;
  }

  /** After a plugin registry change: reconcile this runtime's MCP connections
   *  with the derived server set first, then let peers do the same. */
  async function reconcilePluginsAndAnnounce() {
    const status = await connectConfiguredMcp({ reconcile: true });
    await announce('plugins');
    return status;
  }

  return {
    refreshSurface,
    publish,
    scheduleMcpToggle,
    announce,
    reconnectMcpAndAnnounce,
    reconcilePluginsAndAnnounce,
    dispose: () => subscription.unsubscribe(),
  };
}
