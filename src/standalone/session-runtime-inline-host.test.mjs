import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  drainSessionStore,
  saveSessionAsync,
  saveSessionAsyncDeferred,
} from '../runtime/agent/orchestrator/session/store.mjs';
import { createInlineSessionRuntimeHost } from './session-runtime-inline-host.mjs';

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createFakeLocalModule(events) {
  return {
    async createLocalSessionRuntime(options = {}) {
      events.push(['create', options]);
      const listeners = new Set();
      const state = { sessionId: options.sessionId || null };
      return {
        get id() { return state.sessionId; },
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
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('inline host keeps session actors in the daemon process and releases them', async () => {
  const events = [];
  const host = createInlineSessionRuntimeHost({
    cwd: 'C:\\project',
    loadLocalModule: async () => createFakeLocalModule(events),
    executeAgentControl: async (args) => JSON.stringify(args),
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
  const completionMeta = { type: 'agent_task_result', execution_id: 'task-agent-1' };
  assert.equal(host.notifySessionCompletion(
    'session-a',
    'Agent handoff',
    completionMeta,
  ), true);
  assert.deepEqual(
    events.find(([type]) => type === 'completion'),
    ['completion', 'session-a', 'Agent handoff', completionMeta],
  );

  await first.dispose('idle');
  assert.equal(host.status.worker.runtimes, 1);
  await host.close('done');
  assert.equal(host.status.active, false);
  assert.equal(host.status.worker.runtimes, 0);
  assert.equal(events.some(([type, reason]) => type === 'dispose' && reason === 'done'), true);
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
    warmKeychain: async () => { events.push(['prewarm', 'keychain']); },
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

test.skip('retired Agent session surface is not part of the canonical session host', async () => {
  const events = [];
  const session = {
    id: 'agent-a',
    provider: 'test-provider',
    model: 'test-model',
    cwd: 'E:\\agent-project',
  };
  const host = createInlineSessionRuntimeHost({
    loadLocalModule: async () => createFakeLocalModule(events),
    loadAgentSessionManager: async () => ({
      getSession: (sessionId) => sessionId === session.id ? session : null,
    }),
  });

  assert.equal(host.agentSessionState(session.id), null);
  assert.equal(await host.agentSessionAction(session.id, 'submitAsync', [
    'hello agent',
    { id: 'desktop-agent-message' },
  ]), true);
  assert.equal(host.agentSessionState(session.id)?.sessionId, session.id);
  assert.deepEqual(events[0], ['create', {
    provider: session.provider,
    model: session.model,
    cwd: session.cwd,
    toolMode: 'full',
    desktopSession: null,
  }]);
  assert.deepEqual(events[1], ['resume', session.id]);
  assert.deepEqual(events[2], [
    'submit',
    'hello agent',
    { id: 'desktop-agent-message' },
  ]);

  await host.close('done');
  assert.equal(events.some(([type, reason]) => type === 'dispose' && reason === 'done'), true);
});

test.skip('retired Agent store projection is not part of the canonical session host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-inline-agent-publication-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const host = createInlineSessionRuntimeHost();
  const unsubscribe = host.subscribeAgentSessionStates(() => {});
  const session = {
    id: `sess_inline_agent_${process.pid}_${Date.now()}`,
    owner: 'agent',
    agent: 'worker',
    provider: 'test-provider',
    model: 'test-model',
    cwd: 'C:\\project',
    status: 'running',
    messages: [{ role: 'user', content: 'Reply exactly DONE' }],
    generation: 0,
    closed: false,
  };

  try {
    await new Promise((resolve) => setImmediate(resolve));
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    await waitFor(
      () => host.agentSessionState(session.id)?.items?.length === 1,
      'initial Agent projection',
    );

    session.status = 'idle';
    session.messages.push({ role: 'assistant', content: 'DONE' });
    await saveSessionAsyncDeferred(session, { expectedGeneration: session.generation });
    await waitFor(
      () => host.agentSessionState(session.id)?.items?.length === 2,
      'terminal Agent projection',
    );

    const snapshot = host.agentSessionState(session.id);
    assert.equal(Boolean(snapshot.busy), false);
    assert.equal(snapshot.items[1].kind, 'assistant');
    assert.equal(snapshot.items[1].text, 'DONE');
  } finally {
    unsubscribe();
    await host.close('done');
    drainSessionStore();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skip('retired Agent dispatch projector is not part of the canonical session host', async () => {
  const allowRequesting = deferred();
  const allowReasoning = deferred();
  const allowReset = deferred();
  const allowTerminal = deferred();
  const allowCommit = deferred();
  const resetAcks = [];
  const session = {
    id: `sess_inline_agent_stream_${process.pid}_${Date.now()}`,
    owner: 'agent',
    agent: 'worker',
    provider: 'test-provider',
    model: 'test-model',
    cwd: 'C:\\project',
    messages: [{ role: 'user', content: 'Reply exactly DONE' }],
  };
  const host = createInlineSessionRuntimeHost({
    loadAgentGraph: async () => ({
      config: { loadConfig: () => ({ providers: {} }) },
      registry: { initProviders: async () => {} },
      dispatch: {
        makeAgentDispatch: () => async (call) => {
          const requiredCallbacks = [
            'onSessionStart',
            'onStageChange',
            'onReasoningDelta',
            'onTextDelta',
            'onTextReset',
            'onAssistantMessageCommitted',
          ];
          for (const name of requiredCallbacks) {
            if (typeof call?.[name] !== 'function') {
              throw new TypeError(`missing formal Agent projection callback ${name}`);
            }
          }

          call.onSessionStart(session);
          call.onStageChange(session, 'requesting');
          await allowRequesting.promise;

          call.onStageChange(session, 'streaming');
          call.onReasoningDelta(session, 'inspect first');
          await allowReasoning.promise;

          call.onTextDelta(session, 'PARTIAL');
          await allowReset.promise;
          resetAcks.push(call.onTextReset(session, { chars: 99 }));
          resetAcks.push(call.onTextReset(session, { chars: 3 }));
          await allowTerminal.promise;
          resetAcks.push(call.onTextReset(session, { chars: 4 }));
          call.onTextDelta(session, 'DONE');
          session.messages.push({ role: 'assistant', content: 'DONE' });
          call.onAssistantMessageCommitted(session);
          await allowCommit.promise;
          return 'DONE';
        },
      },
    }),
  });

  try {
    const dispatch = host.agentDispatch({
      dispatchId: `dispatch_${session.id}`,
      agent: 'worker',
      params: { prompt: 'Reply exactly DONE' },
    });
    await waitFor(
      () => {
        const snapshot = host.agentSessionState(session.id);
        return snapshot?.busy === true
          && snapshot?.spinner?.mode === 'requesting'
          && snapshot?.agentStage === 'requesting';
      },
      'requesting Agent stage',
    );
    const requesting = host.agentSessionState(session.id);
    assert.equal(requesting.thinking, null);
    assert.equal(requesting.streamingTail, null);
    assert.equal(requesting.items[0].kind, 'user');
    assert.equal(requesting.items[0].text, 'Reply exactly DONE');

    allowRequesting.resolve();
    await waitFor(
      () => {
        const snapshot = host.agentSessionState(session.id);
        return snapshot?.thinking === 'inspect first'
          && snapshot?.spinner?.mode === 'thinking'
          && snapshot?.spinner?.thinking === true
          && snapshot?.agentStage === 'streaming';
      },
      'reasoning Agent frame',
    );
    const reasoning = host.agentSessionState(session.id);
    assert.equal(reasoning.busy, true);
    assert.equal(reasoning.streamingTail, null);

    allowReasoning.resolve();
    await waitFor(
      () => host.agentSessionState(session.id)?.streamingTail?.text === 'PARTIAL',
      'partial Agent assistant frame',
    );
    const partial = host.agentSessionState(session.id);
    assert.equal(partial.busy, true);
    assert.equal(partial.thinking, null);
    assert.equal(partial.spinner.mode, 'responding');
    assert.equal(partial.agentStage, 'streaming');
    assert.equal(partial.items[0].kind, 'user');
    assert.equal(partial.items[0].text, 'Reply exactly DONE');

    allowReset.resolve();
    await waitFor(
      () => host.agentSessionState(session.id)?.streamingTail?.text === 'PART',
      'exact Agent text retraction',
    );
    assert.deepEqual(resetAcks, [false, true]);

    allowTerminal.resolve();
    await waitFor(
      () => {
        const snapshot = host.agentSessionState(session.id);
        const assistant = snapshot?.items
          ?.filter((item) => item.kind === 'assistant')
          .map((item) => item.text);
        return snapshot?.busy === true
          && snapshot?.streamingTail == null
          && assistant?.length === 1
          && assistant[0] === 'DONE';
      },
      'committed Agent assistant transcript before settle',
    );
    const committed = host.agentSessionState(session.id);
    assert.equal(committed.busy, true);
    assert.equal(committed.streamingTail, null);
    assert.equal(committed.thinking, null);
    assert.equal(committed.spinner?.mode, 'responding');
    assert.deepEqual(
      committed.items.filter((item) => item.kind === 'assistant').map((item) => item.text),
      ['DONE'],
    );

    allowCommit.resolve();
    assert.equal(await dispatch, 'DONE');
    await waitFor(
      () => host.agentSessionState(session.id)?.busy === false,
      'terminal Agent callback projection',
    );
    const terminal = host.agentSessionState(session.id);
    assert.deepEqual(resetAcks, [false, true, true]);
    assert.equal(terminal.spinner, null);
    assert.equal(terminal.streamingTail, null);
    assert.equal(terminal.thinking, null);
    assert.equal(Object.hasOwn(terminal, 'agentStage'), false);
    assert.deepEqual(
      terminal.items.filter((item) => item.kind === 'assistant').map((item) => item.text),
      ['DONE'],
    );
  } finally {
    allowRequesting.resolve();
    allowReasoning.resolve();
    allowReset.resolve();
    allowTerminal.resolve();
    allowCommit.resolve();
    await host.close('done');
  }
});

