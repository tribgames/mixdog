import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeWebSearch } from './native-web-search.mjs';
import { createProviderReadiness } from './provider-readiness.mjs';
import { createLifecycleApi } from './lifecycle-api.mjs';
import { dispatchWebSearchRuntimeTool } from './runtime-tool-routing.mjs';
import {
  executeInternalTool,
  getInternalTools,
  setInternalToolsProvider,
} from '../runtime/agent/orchestrator/internal-tools.mjs';
import { executeTool } from '../runtime/agent/orchestrator/session/loop/tool-exec.mjs';

function createSearchRuntime(t, id, model) {
  const route = { provider: 'grok-oauth', model };
  const session = { id, mcpScopeId: `search-scope-${id}`, cwd: process.cwd(), owner: 'cli' };
  const rt = {
    closeRequested: false,
    config: { providers: {}, webSearchRoute: route },
    startupProviderCatalogRefreshStarted: true,
  };
  const requests = [];
  const reg = {
    initProviders: async () => {},
    getProvider: () => ({
      send: async (messages, selectedModel, _tools, options) => {
        options.signal?.throwIfAborted();
        requests.push({ messages, model: selectedModel, signal: options.signal });
        await new Promise(setImmediate);
        return { content: `${id}:${selectedModel}`, model: selectedModel };
      },
    }),
  };
  const readiness = createProviderReadiness({
    rt,
    keychain: { prewarmSecrets: async () => {} },
    getReg: () => reg,
    getWarmProviderModelCache: () => () => {},
  });
  const { runNativeWebSearch } = createNativeWebSearch({
    getRoute: () => route,
    getWebSearchRoute: () => route,
    setWebSearchRoute: () => {},
    getConfig: () => rt.config,
    getSession: () => session,
    getReg: () => reg,
    ensureFullConfig: () => rt.config,
    awaitKeychainPrewarm: readiness.awaitKeychainPrewarm,
    ensureProvidersReady: readiness.ensureProvidersReady,
    ensureProviderEnabled: (config) => config.providers,
    normalizeWebSearchProviderId: (value) => value,
    normalizeWebSearchRouteConfig: (value) => value,
    isDefaultWebSearchRouteConfig: () => false,
    isWebSearchCapableProvider: () => true,
    webSearchCapableFor: () => true,
  });
  const dispose = setInternalToolsProvider({
    scopeId: session.mcpScopeId,
    tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }],
    executor: (name, args, callerCtx) =>
      dispatchWebSearchRuntimeTool(name, args, callerCtx, {
        getWebSearchModule: async () => ({
          handleToolCall: (_name, input, options) => options.nativeWebSearch(input),
        }),
        getCurrentCwd: () => session.cwd,
        getSession: () => session,
        notifyFnForSession: () => () => {},
        runNativeWebSearch,
      }),
  });
  t.after(dispose);
  const lifecycle = createLifecycleApi({
    getSession: () => null,
    setCloseRequested: (value) => {
      rt.closeRequested = value;
    },
    disposeInternalTools: dispose,
    prewarmTimers: {},
    warmupTimers: {},
    flushAllConfigSavesAsync: async () => {},
    hooks: {},
    channels: { stop: async () => {} },
    mcpClient: {},
    closePatchRuntimeIfLoaded: () => null,
    getMemoryModPromise: () => null,
    invalidateContextStatusCache() {},
    clearRuntimeNotifications() {},
    withTeardownDeadline: async (pending) => await pending,
  });
  return { rt, session, requests, lifecycle };
}

test('a newer runtime closing cannot break another session native web search', async (t) => {
  const active = createSearchRuntime(t, 'active', 'grok-4.6');
  const newer = createSearchRuntime(t, 'newer', 'grok-4.5');
  const controller = new AbortController();
  const search = (runtime) =>
    executeTool(
      'web_search',
      { prompt: 'scope regression' },
      runtime.session.cwd,
      runtime.session.id,
      runtime.session,
      { signal: controller.signal }
    );
  const initial = await Promise.all([search(active), search(newer)]);
  assert.deepEqual(
    initial.map((text) => JSON.parse(text).content),
    ['active:grok-4.6', 'newer:grok-4.5']
  );
  await newer.lifecycle.close('idle-eviction', { keepBackgroundWork: true });
  assert.equal(newer.rt.closeRequested, true);
  assert.deepEqual(getInternalTools(newer.session.mcpScopeId), []);
  assert.equal(active.rt.closeRequested, false);
  assert.equal(JSON.parse(await search(active)).content, 'active:grok-4.6');
  assert.equal(active.requests.length, 2);
  assert.equal(newer.requests.length, 1);
  assert.equal(active.requests[1].signal, controller.signal);
  await assert.rejects(executeInternalTool('web_search', {}, { scopeId: newer.session.mcpScopeId }), /not registered/);
  controller.abort(new Error('search cancelled'));
  await assert.rejects(search(active), /search cancelled/);
  assert.equal(active.requests.length, 2);
});

test('a resumed session and its worker use the replacement runtime scope', async (t) => {
  const old = createSearchRuntime(t, 'old-owner', 'grok-4.5');
  await old.lifecycle.close('idle-eviction', { keepBackgroundWork: true, detach: true });
  const resumed = createSearchRuntime(t, 'resumed-owner', 'grok-4.6');
  for (const caller of [
    { ...resumed.session, id: old.session.id },
    { ...resumed.session, id: 'worker', owner: 'agent', agent: 'worker' },
  ]) {
    const result = await executeTool('web_search', { prompt: 'resumed search' }, caller.cwd, caller.id, caller);
    assert.equal(JSON.parse(result).content, 'resumed-owner:grok-4.6');
  }
  assert.equal(old.requests.length, 0);
  assert.equal(resumed.requests.length, 2);
});
