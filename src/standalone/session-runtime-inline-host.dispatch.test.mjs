import assert from 'node:assert/strict';
import test from 'node:test';

import { createInlineSessionRuntimeHost } from './session-runtime-inline-host.mjs';

// Pins the inline host's agent-dispatch plumbing and completion routing: the
// per-agent dispatcher cache, parameter forwarding, provider preparation once
// per config signature, duplicate dispatch ids, and owner-runtime lookup for
// tool-completion delivery.
function createHarness({ providers = { openai: { key: 'a' } } } = {}) {
  const events = [];
  const dispatchCalls = [];
  const runtimes = [];
  const graph = {
    config: { loadConfig: () => ({ providers }) },
    registry: {
      initProviders: async (value) => {
        events.push(['initProviders', value]);
      },
    },
    dispatch: {
      makeAgentDispatch: (options) => {
        events.push(['makeAgentDispatch', options]);
        return async (args) => {
          dispatchCalls.push(args);
          return `answer for ${args.prompt}`;
        };
      },
    },
  };
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:/work',
    loadLocalModule: async () => ({
      async createLocalSessionRuntime(options = {}) {
        const state = { sessionId: options.sessionId || null };
        const runtime = {
          getState: () => state,
          setSessionId: (id) => {
            state.sessionId = id;
          },
          deliverToolCompletion(sessionId, text, meta) {
            events.push(['completion', sessionId, text, meta]);
            return true;
          },
          async dispose(reason) {
            events.push(['dispose', reason]);
          },
        };
        runtimes.push(runtime);
        return runtime;
      },
    }),
    loadAgentGraph: async () => graph,
    warmKeychain: async () => events.push('keychain'),
    executeAgentControl: async (args, context) => ['control', args, context],
  });
  return { host, events, dispatchCalls, runtimes };
}

test('agentDispatch caches one dispatcher per agent and forwards the call parameters', async () => {
  const h = createHarness();
  const first = await h.host.agentDispatch({
    dispatchId: 'd1',
    agent: 'worker',
    options: { preset: 'fast' },
    params: { prompt: 'hello', preset: 'p1', cwd: 'D:/proj', idleTimeoutMs: 5000 },
  });
  assert.equal(first, 'answer for hello');
  const second = await h.host.agentDispatch({
    dispatchId: 'd2',
    agent: 'worker',
    params: { prompt: 'again', idleTimeoutMs: -1 },
  });
  assert.equal(second, 'answer for again');
  assert.deepEqual(
    h.events.filter((event) => event[0] === 'makeAgentDispatch'),
    [['makeAgentDispatch', { agent: 'worker', preset: 'fast' }]]
  );
  assert.equal(h.dispatchCalls.length, 2);
  assert.equal(h.dispatchCalls[0].prompt, 'hello');
  assert.equal(h.dispatchCalls[0].preset, 'p1');
  assert.equal(h.dispatchCalls[0].cwd, 'D:/proj');
  assert.equal(h.dispatchCalls[0].idleTimeoutMs, 5000);
  assert.ok(h.dispatchCalls[0].parentSignal instanceof AbortSignal);
  assert.equal(h.dispatchCalls[1].preset, undefined);
  assert.equal(h.dispatchCalls[1].cwd, undefined);
  assert.equal('idleTimeoutMs' in h.dispatchCalls[1], false);
  // Providers were prepared once for the unchanged config signature.
  assert.deepEqual(
    h.events.filter((event) => event[0] === 'initProviders'),
    [['initProviders', { openai: { key: 'a' } }]]
  );
});

test('agentDispatch rejects a missing or already-running dispatch id and aborts with the caller signal', async () => {
  const h = createHarness();
  await assert.rejects(h.host.agentDispatch({ agent: 'worker' }), /agent dispatch id is required/);
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = createInlineSessionRuntimeHost({
    loadAgentGraph: async () => {
      await gate;
      return { config: { loadConfig: () => ({}) }, registry: { initProviders: async () => {} }, dispatch: {} };
    },
    warmKeychain: async () => {},
  });
  const running = slow.agentDispatch({ dispatchId: 'dup', agent: 'w', params: {} }, { signal: controller.signal });
  await assert.rejects(
    slow.agentDispatch({ dispatchId: 'dup', agent: 'w', params: {} }),
    /agent dispatch dup is already running/
  );
  controller.abort(new Error('caller gave up'));
  release();
  await assert.rejects(running, /caller gave up/);
  await slow.close();
});

test('notifySessionCompletion routes to the runtime that owns the session, hinted or discovered', async () => {
  const h = createHarness();
  const hinted = await h.host.create({ sessionId: 'sess_hint' });
  const discovered = await h.host.create({});
  discovered.setSessionId('sess_found');
  assert.equal(h.host.notifySessionCompletion('sess_hint', 'done', { kind: 'task' }), true);
  assert.equal(h.host.notifySessionCompletion('sess_found', 'done 2', {}), true);
  assert.equal(h.host.notifySessionCompletion('sess_missing', 'x', {}), false);
  assert.deepEqual(
    h.events.filter((event) => event[0] === 'completion'),
    [
      ['completion', 'sess_hint', 'done', { kind: 'task' }],
      ['completion', 'sess_found', 'done 2', {}],
    ]
  );
  assert.equal(h.host.status.worker.runtimes, 2);
  assert.equal(h.host.workloads.worker.runtimes, 2);
  await hinted.dispose('bye');
  assert.equal(h.host.status.worker.runtimes, 1);
  assert.equal(h.host.notifySessionCompletion('sess_hint', 'late', {}), false);
  await h.host.close('test over');
  assert.equal(h.host.status.active, false);
  assert.equal(h.host.notifySessionCompletion('sess_found', 'after close', {}), false);
});

test('agentControl forwards to the injected executor and the placeholder actions stay inert', async () => {
  const h = createHarness();
  assert.deepEqual(await h.host.agentControl({ op: 'list' }, { sessionId: 's' }), [
    'control',
    { op: 'list' },
    { sessionId: 's' },
  ]);
  await assert.rejects(h.host.agentSessionAction('s', 'resume', []), /owned by the canonical session service/);
  assert.equal(h.host.agentSessionState('s'), null);
  assert.equal(typeof h.host.subscribeAgentSessionStates(() => {}), 'function');
  assert.equal((await h.host.refreshRuntimeWorkload()).mode, 'in-process');
  const bare = createInlineSessionRuntimeHost({ warmKeychain: async () => {} });
  await assert.rejects(bare.agentControl({}), /canonical Agent control is unavailable/);
  await bare.close();
  await assert.rejects(bare.agentControl({}), /session runtime host is closed/);
});
