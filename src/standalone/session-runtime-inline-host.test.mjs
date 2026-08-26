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
        id: state.sessionId,
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
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

test('inline host keeps session actors in the daemon process and releases them', async () => {
  const events = [];
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:\\project',
    loadLocalModule: async () => createFakeLocalModule(events),
  });

  const first = await host.create({ sessionId: 'session-a' });
  const second = await host.create({ sessionId: 'session-b', cwd: 'D:\\other' });

  assert.equal(host.status.mode, 'in-process');
  assert.equal(host.status.worker.pid, process.pid);
  assert.equal(host.status.worker.runtimes, 2);
  assert.equal(events[0][1].cwd, 'C:\\project');
  assert.equal(events[1][1].cwd, 'D:\\other');
  assert.equal(
    await host.agentControl({ type: 'list' }, { callerSessionId: 'session-a' }),
    '{"type":"list"}',
  );

  await first.dispose('idle');
  assert.equal(host.status.worker.runtimes, 1);
  await host.close('done');
  assert.equal(host.status.active, false);
  assert.equal(host.status.worker.runtimes, 0);
  assert.equal(events.some(([type, reason]) => type === 'dispose' && reason === 'done'), true);
  void second;
});

test('inline host prewarm deliberately leaves the memory process cold', async () => {
  const events = [];
  const host = createInlineSessionRuntimeHost({
    loadLocalModule: async () => createFakeLocalModule(events),
  });

  await host.prewarm();
  await host.prewarm();

  assert.deepEqual(
    events.filter(([type]) => type === 'prewarm').map(([, target]) => target).sort(),
    ['agent-loop', 'keychain', 'runtime'],
  );
  await host.close('done');
});

