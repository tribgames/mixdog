// Lazy, shared boot work for the inline host: the session-local module, the
// agent dispatch graph, the keychain warm-up and provider preparation. Each
// loader memoizes its promise and forgets it on failure so the next caller
// retries; host closure is checked at every resumption point.

export function createInlineBootLoaders({
  measureBootPhase,
  loadLocalModule,
  loadAgentGraph,
  warmKeychain,
  assertOpen,
  isClosed,
}) {
  let localModulePromise = null;
  let keychainPrewarmPromise = null;
  let agentGraphPromise = null;
  let preparedProviderSignature = null;
  let providerPreparePromise = null;

  function measured(phase, task) {
    return Promise.resolve().then(() => measureBootPhase(phase, task));
  }

  function prewarmKeychain() {
    if (isClosed()) return Promise.reject(new Error('session runtime host is closed'));
    keychainPrewarmPromise ??= measured('keychain-prewarm', () => {
      assertOpen();
      return warmKeychain();
    })
      .then(() => ({ ready: true }))
      .catch((error) => {
        keychainPrewarmPromise = null;
        throw error;
      });
    return keychainPrewarmPromise;
  }

  function localModule() {
    localModulePromise ??= measured('session-local-import', async () => {
      // Runtime initialization reads credentials synchronously. Let the
      // bounded asynchronous keychain warm-up finish first, otherwise cold
      // DPAPI reads block the daemon's registration and event-stream routes.
      await prewarmKeychain();
      assertOpen();
      return loadLocalModule();
    }).catch((error) => {
      localModulePromise = null;
      throw error;
    });
    return localModulePromise;
  }

  function agentGraph() {
    agentGraphPromise ??= measured('agent-dispatch-graph-import', () => {
      assertOpen();
      return loadAgentGraph();
    }).then(
      (graph) => graph,
      (error) => {
        agentGraphPromise = null;
        throw error;
      }
    );
    return agentGraphPromise;
  }

  async function prepareAgentProviders(signal) {
    await prewarmKeychain();
    assertOpen(signal);
    const { config, registry } = await agentGraph();
    assertOpen(signal);
    const providers = config.loadConfig()?.providers || {};
    const signature = JSON.stringify(providers);
    if (preparedProviderSignature === signature) return;
    if (providerPreparePromise) {
      await providerPreparePromise;
      assertOpen(signal);
      if (preparedProviderSignature === signature) return;
      return prepareAgentProviders(signal);
    }
    const pending = Promise.resolve()
      .then(() => {
        // Preparation is shared by dispatches once admitted; only host closure
        // retires that shared work, not an individual waiter's cancellation.
        assertOpen();
        return registry.initProviders(providers);
      })
      .then(() => {
        preparedProviderSignature = signature;
      });
    const tracked = pending.finally(() => {
      if (providerPreparePromise === tracked) providerPreparePromise = null;
    });
    providerPreparePromise = tracked;
    await tracked;
  }

  return { prewarmKeychain, localModule, agentGraph, prepareAgentProviders };
}
