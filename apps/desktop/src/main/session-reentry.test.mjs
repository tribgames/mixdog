import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { SessionHost } from './session-host.ts';
import { setTranscriptReadDiagnosticSink } from '../shared/transcript-read-diagnostics.ts';

async function sessionFixture(t) {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval', 'setTimeout'],
    now: 1_800_000_000_000,
  });
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-session-reentry-'));
  const id = 'reentered_session';
  const ctx = { clientToken: 'reentry-view' };
  let stored = { sessionId: id, items: [], queued: [], busy: false, projectionStamp: '0' };
  let sink, runtime, heldRead, updateWaiter;
  let reads = 0;
  const updates = [];
  const persist = (items) => {
    stored = { ...stored, items, projectionStamp: String(Number(stored.projectionStamp) + 1) };
  };
  const service = createSessionService({
    idleEvictMs: 100,
    evictSweepMs: 100,
    sessionExists: async (sessionId) => sessionId === id,
    readStoredSession: async () => stored,
    async createSessionRuntime() {
      let state = stored;
      let listener = () => {};
      const append = (kind, text, itemId) => {
        persist([...state.items, { id: itemId, kind, text }]);
        state = stored;
        listener();
      };
      runtime = {
        getState: () => state,
        subscribe(next) { listener = next; return () => { listener = () => {}; }; },
        resume: async () => true,
        async submitAsync(prompt, options) {
          append('user', prompt, options.id);
          append('assistant', `reply: ${prompt}`, `${options.id}-reply`);
          return true;
        },
        append,
        async dispose() {},
      };
      return runtime;
    },
    onFrame(frame, targets) {
      if (targets?.has(ctx.clientToken)) sink?.(frame);
    },
  });
  const host = await SessionHost.create({
    userDataPath: directory, resourcesPath: directory, appPath: directory, packaged: false,
  }, {
    async attachSessionClient({ onFrame }) {
      sink = onFrame;
      const call = (method) => (args) => service.handleCall(`session.${method}`, args, ctx);
      return {
        list: call('list'), create: call('create'),
        subscribe: call('subscribe'), unsubscribe: call('unsubscribe'),
        submit: call('submit'), abort: call('abort'),
        approve: call('approve'), configure: call('configure'),
        async read(args) {
          reads++;
          const result = await service.handleCall('session.read', args, ctx);
          if (heldRead) {
            const pending = heldRead;
            heldRead = null;
            pending.captured.resolve();
            await pending.release.promise;
          }
          return result;
        },
        async close() { service.releaseClient(ctx.clientToken); },
      };
    },
    async loadProjects() { return {}; },
    async loadSessionStore() { return {}; },
    async loadStatuslineSegments() { return {}; },
    async executeCodeGraphTool() { return {}; },
  });
  host.subscribeSessionStates((update) => {
    updates.push(update);
    updateWaiter?.resolve(update);
    updateWaiter = null;
  });
  t.after(async () => {
    await host.dispose();
    await service.stop('test complete');
    await rm(directory, { recursive: true, force: true });
  });
  return {
    id, host, service, updates,
    get runtime() { return runtime; },
    get reads() { return reads; },
    texts: () => updates.at(-1)?.snapshot?.items.map((item) => item.text),
    persist(text) {
      persist([...stored.items, { id: stored.projectionStamp, kind: 'assistant', text }]);
    },
    nextUpdate() {
      updateWaiter = Promise.withResolvers();
      return updateWaiter.promise;
    },
    holdRead() {
      const pending = { captured: Promise.withResolvers(), release: Promise.withResolvers() };
      heldRead = pending;
      return pending;
    },
  };
}

for (const reopenBeforeSubmit of [true, false]) {
  test(`an evicted session delivers new prompts and replies (reopen first: ${reopenBeforeSubmit})`, async (t) => {
    const f = await sessionFixture(t);
    await f.host.setVisibleSessions([f.id]);
    await f.host.submitToSession(f.id, 'first', { id: 'first' });
    // The old runtime must have advanced well beyond a newly loaded runtime.
    for (let index = 0; index < 12; index++) {
      f.runtime.append('assistant', `old progress ${index}`, `progress-${index}`);
      t.mock.timers.tick(20);
    }
    assert.equal(f.texts().at(-1), 'old progress 11');
    await f.host.setVisibleSessions([]);
    t.mock.timers.tick(10_000);
    assert.equal(f.service.size, 0);

    // No subscriber receives the eviction notice. The host intentionally
    // retains its previous live baseline, just as a hidden pane does.
    f.persist('persisted after leaving');
    if (reopenBeforeSubmit) {
      await f.host.setVisibleSessions([f.id]);
      assert.equal(f.texts().at(-1), 'persisted after leaving');
      assert.equal(f.service.size, 0, 'viewing stored content does not recreate a runtime');

      f.persist('cold refresh');
      const refreshed = f.nextUpdate();
      t.mock.timers.tick(1_000);
      await refreshed;
      assert.equal(f.texts().at(-1), 'cold refresh');
    }
    assert.equal(await f.host.submitToSession(f.id, 'next', { id: 'next' }), true);
    if (!reopenBeforeSubmit) await f.host.setVisibleSessions([f.id]);
    assert.deepEqual(f.texts().slice(-2), ['next', 'reply: next']);

    const reads = f.reads;
    t.mock.timers.tick(1_000);
    assert.equal(f.reads, reads, 'live publication stops stored-view polling');
  });
}

test('a delayed stored reply cannot overwrite a newly materialized turn', async (t) => {
  const f = await sessionFixture(t);
  f.persist('stored answer');
  await f.host.setVisibleSessions([f.id]);
  const held = f.holdRead();
  const reading = f.host.prefetchSession(f.id);
  await held.captured.promise;
  await f.host.submitToSession(f.id, 'new turn', { id: 'new-turn' });
  held.release.resolve();
  await reading;
  assert.deepEqual(f.texts().slice(-2), ['new turn', 'reply: new turn']);
});

test('cold refresh ticks do not stack reads while that session is still loading', async (t) => {
  const f = await sessionFixture(t);
  f.persist('stored answer');
  await f.host.setVisibleSessions([f.id]);
  const held = f.holdRead();
  const reads = f.reads;
  t.mock.timers.tick(1_000);
  await held.captured.promise;
  t.mock.timers.tick(5_000);
  assert.equal(f.reads, reads + 1);
  held.release.resolve();
  // Unchanged content intentionally emits no frame. Drain the read completion,
  // rather than waiting for a publication that the transport must suppress.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  assert.equal(f.reads, reads + 2, 'refresh resumes after the preceding read settles');
});

test('read tracing measures a held host read and propagates its correlation without changing the result', async (t) => {
  const f = await sessionFixture(t);
  f.persist('private saved answer');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const records = [];
  const restore = setTranscriptReadDiagnosticSink((entry) => records.push(entry));
  t.after(restore);
  const held = f.holdRead();
  const reading = f.host.prefetchSession(f.id, undefined, 'read-host-1');
  await held.captured.promise;
  assert.deepEqual(records.map(r => r.stage), ['host-start', 'host-read-start']);
  now = 321;
  held.release.resolve();
  assert.equal(await reading, true);
  assert.equal(records.find(r => r.stage === 'host-read-result').durationMs, 321);
  assert.deepEqual(records.map(r => r.stage), [
    'host-start', 'host-read-start', 'host-read-result', 'host-projected', 'host-published',
  ]);
  assert.equal(f.updates.at(-1).readTraceId, 'read-host-1');
  assert.deepEqual(f.texts(), ['private saved answer']);
  assert.equal(JSON.stringify(records).includes('private saved answer'), false);
});

test('a traced host read preserves its original rejection', async (t) => {
  const f = await sessionFixture(t);
  const failure = new Error('private read failure');
  t.mock.method(f.host.sessionClient, 'read', async () => { throw failure; });
  const records = [];
  const restore = setTranscriptReadDiagnosticSink((entry) => records.push(entry));
  t.after(restore);
  await assert.rejects(f.host.prefetchSession(f.id, undefined, 'read-host-failure'), error => error === failure);
  assert.equal(records.at(-1).stage, 'host-failed');
  assert.equal(records.some(r => r.stage === 'host-published'), false);
});
