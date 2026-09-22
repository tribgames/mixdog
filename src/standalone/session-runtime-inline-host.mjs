/**
 * In-process session runtime host.
 *
 * Sessions remain independent async actors, but share the daemon's V8 isolate
 * and ESM module cache. Native helpers and explicitly bounded worker pools keep
 * CPU-heavy parsing/search work off the daemon loop. Boot loaders, the runtime
 * registry and agent dispatch live under ./session-runtime-inline-host/.
 */
import { createInlineAgentDispatch } from './session-runtime-inline-host/agent-dispatch.mjs';
import { createInlineBootLoaders } from './session-runtime-inline-host/boot-loaders.mjs';
import { createRuntimeRecords } from './session-runtime-inline-host/runtime-records.mjs';
import { inlineStatus, inlineWorkloads } from './session-runtime-inline-host/telemetry.mjs';

export function createInlineSessionRuntimeHost({
  cwd = process.cwd(),
  log = () => {},
  measureBootPhase = async (_phase, task) => await task(),
  loadLocalModule = () => import('../tui/session-local.mjs'),
  loadAgentGraph = () =>
    Promise.all([
      import('../runtime/agent/orchestrator/config.mjs'),
      import('../runtime/agent/orchestrator/providers/registry.mjs'),
      import('../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs'),
    ]).then(([config, registry, dispatch]) => ({ config, registry, dispatch })),
  warmKeychain = async () => {
    const { default: keychain } = await import('../lib/keychain-cjs.cjs');
    await keychain.prewarmSecrets();
  },
  executeAgentControl = null,
} = {}) {
  let closed = false;
  let closePromise = null;

  function assertOpen(signal = null) {
    if (signal?.aborted) throw signal.reason || new Error('agent dispatch canceled');
    if (closed) throw new Error('session runtime host is closed');
  }

  const loaders = createInlineBootLoaders({
    measureBootPhase,
    loadLocalModule,
    loadAgentGraph,
    warmKeychain,
    assertOpen,
    isClosed: () => closed,
  });
  const records = createRuntimeRecords();
  const dispatch = createInlineAgentDispatch({
    assertOpen,
    agentGraph: loaders.agentGraph,
    prepareAgentProviders: loaders.prepareAgentProviders,
  });

  async function create(options = {}) {
    assertOpen();
    const module = await loaders.localModule();
    assertOpen();
    const runtime = await module.createLocalSessionRuntime({
      ...options,
      ...(options.cwd ? {} : { cwd }),
      ...(typeof executeAgentControl === 'function' ? { executeAgentControl } : {}),
    });
    if (closed) {
      try {
        await runtime.dispose?.('session runtime host is closed');
      } catch (error) {
        log(`late runtime dispose failed: ${error?.message || error}`);
      }
      assertOpen();
    }
    return records.adopt(runtime, { hintedSessionId: String(options.sessionId || '').trim() });
  }

  return {
    create,
    prewarmKeychain: loaders.prewarmKeychain,
    agentDispatch: dispatch.agentDispatch,
    async agentControl(args = {}, context = {}) {
      if (closed) throw new Error('session runtime host is closed');
      if (typeof executeAgentControl === 'function') {
        return await executeAgentControl(args, context);
      }
      throw new Error('canonical Agent control is unavailable');
    },
    notifySessionCompletion(ownerSessionId, text, meta = {}) {
      if (closed) return false;
      const runtime = records.ownerRuntime(ownerSessionId);
      return runtime?.deliverToolCompletion?.(String(ownerSessionId || ''), String(text || ''), meta) === true;
    },
    async agentSessionAction(_sessionId, _action, _args = []) {
      throw new Error('Agent sessions are owned by the canonical session service');
    },
    refreshRuntimeWorkload() {
      return Promise.resolve(this.workloads);
    },
    subscribeAgentSessionStates(_listener) {
      return () => {};
    },
    agentSessionState(_sessionId) {
      return null;
    },
    get workloads() {
      return inlineWorkloads(records.size);
    },
    async close(reason = 'session runtime host closed') {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.resolve().then(async () => {
        dispatch.abortAll(reason);
        await records.disposeAll(reason);
      });
      return closePromise;
    },
    get status() {
      return inlineStatus(records.size, !closed);
    },
  };
}
