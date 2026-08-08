// Lightweight agent host runtime contract: the daemon session-service surface
// (reserve/resume/submit/abort/peek/dispose) delegating turns to an injected
// manager, with busy/queued/turndone projection frames the spread adapter
// consumes. No network, no real provider.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createAgentHostRuntime } = await import('../src/standalone/agent-host-runtime.mjs');

function waitFor(predicate, message, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { rejectPromise(error); return; }
      if (value) { resolvePromise(value); return; }
      if (Date.now() - started > timeoutMs) { rejectPromise(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createFakeManager({ askDelayMs = 20 } = {}) {
  const sessions = new Map();
  const mgr = {
    calls: [],
    linkedSignal: null,
    getSession: (id) => sessions.get(id) || null,
    loadSession: (id) => sessions.get(id) || null,
    linkParentSignalToSession(id, signal) {
      mgr.calls.push(['link', id]);
      mgr.linkedSignal = signal;
      return true;
    },
    async updateSessionStatus(id, status) { mgr.calls.push(['status', id, status]); },
    async askSession(id, prompt, context, onToolCall, cwd) {
      mgr.calls.push(['ask', id, prompt, cwd]);
      const target = sessions.get(id);
      await new Promise((resolve) => setTimeout(resolve, askDelayMs));
      if (mgr.linkedSignal?.aborted) {
        throw Object.assign(new Error('agent host turn aborted'), { name: 'AbortError' });
      }
      target.messages.push(
        { role: 'user', content: String(prompt) },
        { role: 'assistant', content: `echo:${String(prompt)}` },
      );
      return {
        content: `echo:${String(prompt)}`,
        ...(String(prompt).includes('TRUNC')
          ? { terminationReason: 'truncated', iterations: 2, stopReason: 'length' }
          : {}),
      };
    },
    async resumeSession(id) {
      const restored = { id, messages: [{ role: 'assistant', content: 'restored' }], closed: false, agent: 'worker' };
      sessions.set(id, restored);
      mgr.calls.push(['resume', id]);
      return restored;
    },
    closeSession(id, reason, opts = {}) {
      mgr.calls.push(['close', id, reason, opts.tombstone]);
      return true;
    },
    _put(session) { sessions.set(session.id, session); },
  };
  return mgr;
}

function hostDeps(mgr) {
  return {
    mgr,
    cfgMod: { loadConfig: () => ({ providers: {} }) },
    reg: { initProviders: async () => {} },
    prepareAgentSession: ({ sessionId, agent }) => {
      const session = { id: sessionId || `sess_host_${Date.now()}`, messages: [], agent: agent || 'worker' };
      mgr._put(session);
      return { session };
    },
  };
}

const SPEC = {
  agent: 'worker',
  preset: { provider: 'prov', model: 'mod' },
  runtimeSpec: { scopeKey: 'scope', lane: 'agent' },
  agentTag: 'w-host',
  cwd: 'C:/tmp/host-cwd',
};

test('reserve -> submit runs a manager turn and publishes busy/turndone frames', async () => {
  const mgr = createFakeManager();
  const host = await createAgentHostRuntime({ agentSession: SPEC, cwd: 'C:/tmp' }, hostDeps(mgr));
  const frames = [];
  host.subscribe(() => frames.push(host.getState()));
  assert.equal(host.reserveSession('sess_reserved_1'), true);
  assert.equal(host.getState().sessionId, 'sess_reserved_1');

  assert.equal(await host.submitAsync('do the thing', { id: 'sub-1' }), true);
  await waitFor(() => host.getState().busy === false
    && host.getState().items.some((item) => item.kind === 'turndone'), 'turn completes');
  assert.ok(frames.some((frame) => frame.busy === true), 'a busy frame was published');
  assert.deepEqual(mgr.calls.filter(([kind]) => kind === 'ask').map(([, id, prompt, cwd]) => [id, prompt, cwd]),
    [['sess_reserved_1', 'do the thing', 'C:/tmp/host-cwd']]);

  const peek = host.peekSessionMessages('sess_reserved_1', {});
  assert.equal(peek.messageCount, 2);
  assert.match(String(peek.messages[1].content), /echo:do the thing/);
  const transcript = await host.peekSessionTranscript('sess_reserved_1', {});
  assert.equal(transcript.sessionId, 'sess_reserved_1');
  assert.ok(Array.isArray(transcript.items) && transcript.items.length >= 1);
});

test('busy submits queue and drain inside the same busy window', async () => {
  const mgr = createFakeManager({ askDelayMs: 40 });
  const host = await createAgentHostRuntime({ agentSession: SPEC }, hostDeps(mgr));
  host.reserveSession('sess_queue_1');
  await host.submitAsync('first', { id: 'a' });
  await waitFor(() => host.getState().busy === true, 'first turn starts');
  await host.submitAsync('second', { id: 'b' });
  await host.submitAsync('second', { id: 'b' });
  assert.equal(host.getState().queued.length, 1, 'duplicate submission ids queue once');
  await waitFor(() => host.getState().busy === false && host.getState().queued.length === 0, 'queue drains');
  const asks = mgr.calls.filter(([kind]) => kind === 'ask').map(([, , prompt]) => prompt);
  assert.deepEqual(asks, ['first', 'second']);
  assert.equal(host.getState().items.filter((item) => item.kind === 'turndone').length, 2);
});

test('abort cascades into the linked turn signal and marks an error turndone', async () => {
  const mgr = createFakeManager({ askDelayMs: 200 });
  const host = await createAgentHostRuntime({ agentSession: SPEC }, hostDeps(mgr));
  host.reserveSession('sess_abort_1');
  await host.submitAsync('slow work', { id: 'slow' });
  await waitFor(() => mgr.linkedSignal, 'turn links its abort signal');
  await host.abort();
  await waitFor(() => host.getState().busy === false, 'aborted turn settles');
  assert.ok(host.getState().items.some((item) => item.kind === 'turndone' && item.status === 'error'));
});

test('resume rebinds the stored session and dispose releases without a tombstone', async () => {
  const mgrForMeta = createFakeManager();
  const metaHost = await createAgentHostRuntime({ agentSession: SPEC }, hostDeps(mgrForMeta));
  metaHost.reserveSession('sess_meta_1');
  await metaHost.submitAsync('please TRUNC this', { id: 'meta' });
  await waitFor(() => metaHost.getState().busy === false, 'abnormal turn settles');
  const done = [...metaHost.getState().items].reverse().find((item) => item.kind === 'turndone');
  assert.equal(done?.terminationReason, 'truncated', 'turndone carries the abnormal reason');
  assert.equal(done?.stopReason, 'length');
  assert.equal(done?.iterations, 2);

  const mgr = createFakeManager();
  const host = await createAgentHostRuntime({ agentSession: SPEC }, hostDeps(mgr));
  assert.equal(await host.resume('sess_resume_1'), true);
  assert.equal(host.getState().sessionId, 'sess_resume_1');
  const peek = host.peekSessionMessages('sess_resume_1', {});
  assert.match(String(peek.messages[0].content), /restored/);

  await host.dispose('idle and unwatched');
  const close = mgr.calls.find(([kind]) => kind === 'close');
  assert.ok(close, 'dispose closes the manager session');
  assert.equal(close[3], false, 'release is resumable: tombstone=false');
  await assert.rejects(() => host.submitAsync('after dispose'), /disposed/);
});
