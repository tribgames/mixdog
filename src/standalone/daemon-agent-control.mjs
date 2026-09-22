// The canonical `agent` tool for this daemon: one standalone agent bound to the
// live session service, plus the control entry the session runtime host calls
// for agent spawn/send/close. Built on first use because the provider and
// orchestrator graphs behind it are the heaviest import in the process, and
// rebuilt on failure so a transient import error is not cached forever.
//
// Inputs: `getSessionService` / `getSessionRuntimeHost` (both are wired after
// this control exists — the host takes `execute` as a constructor option), and
// `cwd`. Output: { canonicalAgentTool, execute }.

export function createCanonicalAgentControl({ getSessionService, getSessionRuntimeHost, cwd }) {
  let canonicalAgentToolPromise = null;

  function canonicalAgentTool() {
    if (!getSessionService()) {
      return Promise.reject(new Error('canonical session service is not ready'));
    }
    canonicalAgentToolPromise ??= Promise.all([
      import('./agent-tool.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
      import('../runtime/agent/orchestrator/providers/registry.mjs'),
    ])
      .then(([agentModule, cfgMod, reg]) => {
        const sessionService = getSessionService();
        return agentModule.createStandaloneAgent({
          cfgMod,
          reg,
          mgr: sessionService.agentManager,
          dataDir: cfgMod.getPluginData(),
          cwd,
          awaitKeychainPrewarm: async () => {},
          isKeychainPrewarmReady: () => true,
          sessionSurface: sessionService.agentSurface,
          notifySessionCompletion(ownerSessionId, text, meta = {}) {
            return getSessionRuntimeHost()?.notifySessionCompletion?.(ownerSessionId, text, meta) === true;
          },
        });
      })
      .catch((error) => {
        canonicalAgentToolPromise = null;
        throw error;
      });
    return canonicalAgentToolPromise;
  }

  async function execute(args = {}, context = {}) {
    const tool = await canonicalAgentTool();
    const sessionService = getSessionService();
    const parentSessionId = String(context?.callerSessionId || '').trim();
    await sessionService.rehydrateAgentSessions();
    const scopedContext = {
      ...context,
      callerSessionId: parentSessionId || null,
      ownerSessionId: sessionService.rootOwnerSessionId(parentSessionId),
    };
    if (String(args?.type || '') === '__close_all') {
      await tool.closeAll?.(String(args?.reason || 'agent owner closed'), { callerSessionId: parentSessionId || null });
      await sessionService.cancelAgentDescendants(parentSessionId, String(args?.reason || 'agent owner closed'));
      return 'agent close all: ok';
    }
    return await tool.execute(args, scopedContext);
  }

  return { canonicalAgentTool, execute };
}
