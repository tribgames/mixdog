import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SessionAddressError,
  beginCanonicalClose,
  bindSessionAddress,
  finishCanonicalClose,
  initSessionAddress,
} from './session-address.mjs';
import { sessionAdopter } from './boot/infrastructure.mjs';
import { SessionClosedError } from '../runtime/agent/orchestrator/session/manager/session-errors.mjs';

let importSeq = 0;

// createCurrentSession over a fake manager/store. Only the provider-facing
// preparation and the actual construction are stubbed; the address, admission
// and record decisions under test are the real ones.
async function harness(t, { prepare } = {}) {
  const calls = { created: [], prepared: 0, resumed: [] };
  const rt = { session: null, reservedSessionId: null, sessionCreatePromise: null, mode: 'full' };
  initSessionAddress(rt);
  const store = new Map();
  const mgr = { getSession: (id) => store.get(id) || null };
  const adoptSession = sessionAdopter({
    rt,
    bindRuntimeNotificationSession() {},
    goalRuntime: null,
    applyResolvedCwd() {},
  });
  t.mock.module('./session-create/route-prep.mjs', {
    namedExports: {
      elapsedMs: () => '0',
      prepareRoute: async () => {
        calls.prepared += 1;
        await prepare?.();
        return { coreMemoryContext: null, providerImpl: {} };
      },
    },
  });
  t.mock.module('./session-create/materialize.mjs', {
    namedExports: {
      materializeSession(deps) {
        const id = rt.reservedSessionId || `minted_${calls.created.length + 1}`;
        const record = { id, closed: false, tools: [], messages: [] };
        store.set(id, record);
        calls.created.push(id);
        deps.adoptSession(record);
        rt.reservedSessionId = null;
      },
      prewarmWsTransport() {},
    },
  });
  t.mock.module('./session-create/session-start-hook.mjs', {
    namedExports: { dispatchSessionStart: async () => {} },
  });
  const { createSessionCreator } = await import(`./session-create.mjs?case=${++importSeq}`);
  const createCurrentSession = createSessionCreator(
    {
      rt,
      mgr,
      adoptSession,
      resumeAddressedSession: async (id) => {
        calls.resumed.push(id);
        const record = store.get(id);
        if (!record || record.closed) return null;
        adoptSession(record);
        return { id };
      },
    },
    {}
  );
  return { rt, store, calls, createCurrentSession };
}

test('a reserved address materializes its conversation exactly once', async (t) => {
  const h = await harness(t);
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  const first = await h.createCurrentSession('reservation');
  assert.equal(first.id, 'sess_a');
  assert.equal(h.rt.reservedSessionId, null, 'the one-shot token is spent');
  assert.equal((await h.createCurrentSession('turn')).id, 'sess_a');
  assert.deepEqual(h.calls.created, ['sess_a']);
});

test('setSession(null) on an addressed runtime with a CLOSED record never mints or overwrites', async (t) => {
  const h = await harness(t);
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  await h.createCurrentSession('reservation');
  const record = h.store.get('sess_a');
  record.closed = true;
  record.generation = 7;
  h.rt.session = null; // what closeCanonicalSession's setSession(null) leaves behind
  await assert.rejects(h.createCurrentSession('turn'), SessionClosedError);
  assert.deepEqual(h.calls.created, ['sess_a'], 'no second conversation');
  assert.equal(h.store.get('sess_a'), record, 'the closed record is untouched');
  assert.equal(record.generation, 7);
  assert.equal(h.rt.admission, 'terminal');
  assert.equal(h.rt.addressedSessionId, 'sess_a');
  // Terminal stays terminal for every later attempt.
  await assert.rejects(h.createCurrentSession('turn'), SessionClosedError);
  assert.deepEqual(h.calls.created, ['sess_a']);
});

test('an evicted OPEN conversation resumes under the same id instead of being recreated', async (t) => {
  const h = await harness(t);
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  await h.createCurrentSession('reservation');
  h.rt.session = null; // idle eviction / manager-only unload of the live object
  const again = await h.createCurrentSession('turn');
  assert.equal(again.id, 'sess_a');
  assert.equal(h.rt.session.id, 'sess_a');
  assert.deepEqual(h.calls.resumed, ['sess_a']);
  assert.deepEqual(h.calls.created, ['sess_a']);
  assert.equal(h.calls.prepared, 1, 'a resume does not redo provider preparation');
});

test('a missing or unreadable record is an explicit failure, never a new conversation', async (t) => {
  const h = await harness(t);
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  await h.createCurrentSession('reservation');
  h.rt.session = null;
  h.store.delete('sess_a');
  await assert.rejects(h.createCurrentSession('turn'), SessionAddressError);
  assert.deepEqual(h.calls.created, ['sess_a']);
});

test('liveSession: a closed record under the live object fails instead of nulling it for recreation', async (t) => {
  const h = await harness(t);
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  const live = await h.createCurrentSession('reservation');
  h.store.get('sess_a').closed = true;
  await assert.rejects(h.createCurrentSession('turn'), SessionClosedError);
  assert.equal(h.rt.session, live, 'the live object is not silently dropped');
  assert.deepEqual(h.calls.created, ['sess_a']);
});

test('liveSession: a missing record under the live object fails instead of nulling it for recreation', async (t) => {
  const m = await harness(t);
  m.rt.reservedSessionId = 'sess_b';
  bindSessionAddress(m.rt, 'sess_b');
  await m.createCurrentSession('reservation');
  m.store.delete('sess_b');
  await assert.rejects(m.createCurrentSession('turn'), SessionAddressError);
  assert.deepEqual(m.calls.created, ['sess_b']);
});

test('close during the reservation prewarm await: no creation, adoption or later provider work', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, { prepare: () => gate });
  h.rt.reservedSessionId = 'sess_a';
  bindSessionAddress(h.rt, 'sess_a');
  const pending = h.createCurrentSession('reservation');
  const outcome = pending.then(
    () => 'created',
    (error) => error
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.prepared, 1, 'the prewarm is parked on its await');
  // The service cancels the (still empty) worker: fence, then durable close.
  finishCanonicalClose(h.rt, beginCanonicalClose(h.rt, 'sess_a'), true);
  release();
  const error = await outcome;
  assert.ok(error instanceof SessionClosedError, `expected SessionClosedError, got ${error}`);
  assert.deepEqual(h.calls.created, []);
  assert.equal(h.rt.session, null);
  assert.equal(h.rt.sessionCreatePromise, null);
});

test('a runtime that was never addressed keeps its ordinary create-on-demand behavior', async (t) => {
  const h = await harness(t);
  const first = await h.createCurrentSession('turn');
  assert.equal(first.id, 'minted_1');
  h.store.get('minted_1').closed = true;
  const second = await h.createCurrentSession('turn');
  assert.equal(second.id, 'minted_2');
});
