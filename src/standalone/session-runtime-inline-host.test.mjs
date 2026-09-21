import assert from 'node:assert/strict';
import test from 'node:test';

import { createInlineSessionRuntimeHost } from './session-runtime-inline-host.mjs';

function createFakeLocalModule(events) {
  return {
    async createLocalSessionRuntime(options = {}) {
      events.push(['create', options]);
      const listeners = new Set();
      const state = { sessionId: options.sessionId || null };
      return {
        get id() {
          return state.sessionId;
        },
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async resume(sessionId) {
          events.push(['resume', sessionId]);
          state.sessionId = sessionId;
          return true;
        },
        async submitAsync(prompt, options) {
          events.push(['submit', prompt, options]);
          return true;
        },
        deliverToolCompletion(sessionId, text, meta) {
          events.push(['completion', sessionId, text, meta]);
          return state.sessionId === sessionId;
        },
        async dispose(reason) {
          events.push(['dispose', reason]);
        },
        async agentControl(args) {
          return JSON.stringify(args);
        },
      };
    },
    async preloadSessionRuntimeModule() {
      events.push(['prewarm', 'runtime']);
    },
    async preloadAgentLoopRuntime() {
      events.push(['prewarm', 'agent-loop']);
    },
    async preloadKeychainSecrets() {
      events.push(['prewarm', 'keychain']);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('runtime creation cannot start after a pending module import outlives the host', async () => {
  const entered = deferred();
  const loaded = deferred();
  const events = [];
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {},
    loadLocalModule: () => {
      entered.resolve();
      return loaded.promise;
    },
  });
  const rejected = assert.rejects(host.create(), /session runtime host is closed/);
  await entered.promise;
  await host.close();
  loaded.resolve(createFakeLocalModule(events));
  await rejected;
  assert.deepEqual(events, []);
  assert.equal(host.status.worker.runtimes, 0);
});

test('a runtime acquired after host closure is disposed rather than retained', async () => {
  const entered = deferred();
  const created = deferred();
  const disposed = [];
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {},
    loadLocalModule: async () => ({
      createLocalSessionRuntime: () => {
        entered.resolve();
        return created.promise;
      },
    }),
  });
  const rejected = assert.rejects(host.create(), /session runtime host is closed/);
  await entered.promise;
  await host.close();
  created.resolve({
    async dispose(reason) {
      disposed.push(reason);
    },
  });
  await rejected;
  assert.equal(disposed.length, 1);
  assert.equal(host.status.worker.runtimes, 0);
});

test('concurrent host close calls join disposal of already-owned runtimes', async () => {
  const entered = deferred();
  const disposed = deferred();
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {},
    loadLocalModule: async () => ({
      createLocalSessionRuntime: async () => ({
        deliverToolCompletion: () => true,
        async dispose() {
          entered.resolve();
          await disposed.promise;
        },
      }),
    }),
  });
  await host.create({ sessionId: 'closing-owner' });
  const first = host.close();
  await entered.promise;
  let secondReturned = false;
  const second = host.close().then(() => {
    secondReturned = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(secondReturned, false);
    assert.equal(host.notifySessionCompletion('closing-owner', 'late completion'), false);
  } finally {
    disposed.resolve();
    await Promise.all([first, second]);
  }
});

test('an agent dispatch canceled during graph loading cannot prepare providers afterwards', async () => {
  const entered = deferred();
  const loaded = deferred();
  let initialized = 0;
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {},
    loadAgentGraph: () => {
      entered.resolve();
      return loaded.promise;
    },
  });
  const controller = new AbortController();
  const reason = new Error('dispatch canceled during import');
  const rejected = assert.rejects(
    host.agentDispatch({ dispatchId: 'canceled-import', agent: 'cycle1-agent' }, { signal: controller.signal }),
    (error) => error === reason
  );
  await entered.promise;
  controller.abort(reason);
  loaded.resolve({
    config: { loadConfig: () => ({ providers: {} }) },
    registry: {
      initProviders: async () => {
        initialized += 1;
      },
    },
    dispatch: {},
  });
  await rejected;
  await host.close();
  assert.equal(initialized, 0);
});

test('cold session creation waits asynchronously for shared credentials and respects shutdown', async () => {
  const warm = deferred();
  const events = [];
  let warmCalls = 0;
  const host = createInlineSessionRuntimeHost({
    warmKeychain: async () => {
      warmCalls += 1;
      await warm.promise;
    },
    loadLocalModule: async () => createFakeLocalModule(events),
  });
  const first = host.create({ sessionId: 'cold-a' });
  const second = host.create({ sessionId: 'cold-b' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmCalls, 1);
  assert.deepEqual(events, []);
  warm.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    events.map((event) => event[1].sessionId),
    ['cold-a', 'cold-b']
  );
  await host.close('done');

  const pendingWarm = deferred();
  const closingHost = createInlineSessionRuntimeHost({
    warmKeychain: () => pendingWarm.promise,
    loadLocalModule: async () => {
      throw new Error('must not load after close');
    },
  });
  const pending = closingHost.create();
  const rejected = assert.rejects(pending, /session runtime host is closed/);
  await closingHost.close('cancelled during warm-up');
  pendingWarm.resolve();
  await rejected;
});

test('inline host keeps session actors in the daemon process and releases them', async () => {
  const events = [];
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:\\project',
    loadLocalModule: async () => createFakeLocalModule(events),
    warmKeychain: async () => {},
    executeAgentControl: async (args) => JSON.stringify(args),
  });

  const first = await host.create({ sessionId: 'session-a' });
  const second = await host.create({ sessionId: 'session-b', cwd: 'D:\\other' });

  assert.equal(host.status.mode, 'in-process');
  assert.equal(host.status.worker.pid, process.pid);
  assert.equal(host.status.worker.runtimes, 2);
  assert.equal(events[0][1].cwd, 'C:\\project');
  assert.equal(events[1][1].cwd, 'D:\\other');
  assert.equal(await host.agentControl({ type: 'list' }, { callerSessionId: 'session-a' }), '{"type":"list"}');
  const completionMeta = { type: 'agent_task_result', execution_id: 'task-agent-1' };
  assert.equal(host.notifySessionCompletion('session-a', 'Agent handoff', completionMeta), true);
  assert.deepEqual(
    events.find(([type]) => type === 'completion'),
    ['completion', 'session-a', 'Agent handoff', completionMeta]
  );

  await first.dispose('idle');
  assert.equal(host.status.worker.runtimes, 1);
  await host.close('done');
  assert.equal(host.status.active, false);
  assert.equal(host.status.worker.runtimes, 0);
  assert.equal(
    events.some(([type, reason]) => type === 'dispose' && reason === 'done'),
    true
  );
  void second;
});

test('inline host prewarms only keychain without loading session or agent graphs', async () => {
  const events = [];
  const phases = [];
  const host = createInlineSessionRuntimeHost({
    loadLocalModule: async () => {
      events.push(['load', 'session']);
      return createFakeLocalModule(events);
    },
    loadAgentGraph: async () => {
      events.push(['load', 'agent']);
      return {};
    },
    warmKeychain: async () => {
      events.push(['prewarm', 'keychain']);
    },
    measureBootPhase: async (phase, task) => {
      phases.push(phase);
      return await task();
    },
  });

  await host.prewarmKeychain();
  await host.prewarmKeychain();

  assert.deepEqual(events, [['prewarm', 'keychain']]);
  assert.deepEqual(phases, ['keychain-prewarm']);
  await host.close('done');
});
