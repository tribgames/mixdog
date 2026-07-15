import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifecycleApi } from '../src/session-runtime/lifecycle-api.mjs';
import {
  _clearWebSocketPoolForTest,
  _seedWebSocketEntryForTest,
  closeOpenaiWsPoolForSession,
} from '../src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs';

function socket() {
  return {
    closed: [],
    close(_code, reason) {
      this.closed.push(reason);
    },
  };
}

function lifecycleFor(session) {
  let current = session;
  return createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getRoute: () => ({}),
    setRoute: () => {},
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => '/test',
    setCloseRequested: () => {},
    getMemoryModPromise: () => null,
    setMemoryModPromise: () => {},
    setSessionNeedsCwdRefresh: () => {},
    hooks: { dispatch: () => {}, flushRules: () => {} },
    hookCommonPayload: (payload) => payload,
    mgr: {
      closeSession: (id, reason) => {
        closeOpenaiWsPoolForSession(id, `session-close:${reason}`);
        return true;
      },
    },
    statusRoutes: { clearGatewaySessionRoute: () => {} },
    channels: { stop: () => null },
    agentTool: { closeAll: () => {} },
    mcpClient: { disconnectAll: () => null },
    warmupTimers: {},
    prewarmTimers: {},
    flushConfigSave: () => {},
    flushBackendSave: () => {},
    flushOutputStyleSave: () => {},
    withTeardownDeadline: (promise) => promise,
    closePatchRuntimeIfLoaded: () => null,
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    notificationListeners: { clear: () => {} },
    remoteStateListeners: { clear: () => {} },
  });
}

test('lifecycle drains the OpenAI WS pool only for process exit', async () => {
  _clearWebSocketPoolForTest();
  globalThis.__mixdogOpenaiWsRuntimeLoaded = true;
  const replacementSocket = socket();
  const retainedSocket = socket();
  _seedWebSocketEntryForTest({ poolKey: 'replacement', auth: {}, cacheKey: '', entry: { socket: replacementSocket } });
  _seedWebSocketEntryForTest({ poolKey: 'retained', auth: {}, cacheKey: '', entry: { socket: retainedSocket } });

  await lifecycleFor({ id: 'replacement', messages: [], liveTurnMessages: [] }).close('engine-replace');

  assert.deepEqual(replacementSocket.closed, ['session-close:engine-replace']);
  assert.deepEqual(retainedSocket.closed, []);

  await lifecycleFor({ id: 'exit-session', messages: [], liveTurnMessages: [] }).close('cli-exit');

  assert.deepEqual(retainedSocket.closed, ['cli-exit']);
});
