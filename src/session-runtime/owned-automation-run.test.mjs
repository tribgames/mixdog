import '../../scripts/test-data-dir.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import {
  recoverRoutineDeliveries,
  redeliverRoutine,
  retryRoutineDelivery,
  runOwnedAutomation,
} from './owned-automation-run.mjs';
import { createHeldRequests } from './held-requests.mjs';
import { ROUTINE_LIMITS, routineBackoffRemaining } from '../runtime/shared/routine-limits.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { createNoticeSurface } from '../tui/session/notice-surface.mjs';

/** An open home thread: delivery whose live surface feeds a real notice
 *  surface, plus the stored thread and every wake. */
function liveHome(t, homeId, { busy = () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routine-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { toasts: [], items: [] };
  const surface = createNoticeSurface({
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    isDisposed: () => false,
    pushItem: (item) => state.items.push(item),
    replaceItems: (items) => items,
  });
  const session = { id: homeId, messages: [], generation: 1 };
  const wakes = [];
  let saves = 0;
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => (id === homeId ? session : null),
    saveSession: async () => {
      saves++;
    },
    turnInFlight: () => false,
    queue: createRoutineResultQueue(join(dir, 'routine-results.json')),
    live: () => ({
      busy,
      // As the session service's pushLiveSessionNotice: always a transcript row.
      notice: (id, { text, tone, ...options }) =>
        id === homeId ? surface.pushNotice(text, tone, { ...options, transcript: true }) !== null : false,
      wake: (id) => wakes.push(id),
    }),
    retryLater: () => {},
    log: () => {},
  });
  return { state, session, wakes, delivery, saves: () => saves };
}

test('a home mid-turn gets no running row', async (t) => {
  const home = liveHome(t, 'sess_home_lead', { busy: () => true });
  assert.equal(
    home.delivery.announce({ name: 'digest' }, { runId: 'run_x', kind: 'schedule', state: 'running' }),
    false
  );
  assert.deepEqual(home.state.items, []);
});

/** The routines' own records (backoff state, `resultDelivery`), in memory. */
function records(rows) {
  const byName = new Map(rows.map((row) => [row.name, { resultDelivery: null, ...row }]));
  return {
    byName,
    state: async (name) => (byName.has(name) ? structuredClone(byName.get(name)) : null),
    list: async () => [...byName.values()].map((row) => structuredClone(row)),
    recordDelivery: async (name, runId, entry) => {
      const row = byName.get(name);
      const map = { ...(row.resultDelivery || {}) };
      if (entry) map[runId] = entry;
      else delete map[runId];
      row.resultDelivery = Object.keys(map).length ? map : null;
    },
  };
}

/** Home threads over a temp-file queue; `delivery.enqueue` is a run's `deliver`. */
function homes(t, ids, { queue, agentPresence } = {}) {
  let path = null;
  if (!queue) {
    const dir = mkdtempSync(join(tmpdir(), 'routine-runs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    path = join(dir, 'routine-results.json');
  }
  const sessions = new Map(ids.map((id) => [id, { id, messages: [], generation: 1 }]));
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => sessions.get(id) || null,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: queue || createRoutineResultQueue(path),
    live: () => null,
    retryLater: () => {},
    agentPresence,
    log: () => {},
  });
  const posted = (id) => (sessions.get(id)?.messages || []).map((message) => message.meta.transcript.messageId);
  return { sessions, delivery, posted, path };
}

const quiet = { log: () => {} };

test("a run is the turn in its bot's thread: its outcome is returned, nothing else is posted", async () => {
  const delivered = [];
  const announced = [];
  const record = records([{ name: 'daily', ownerAgentId: 'lead' }]);
  const deps = {
    ...quiet,
    ...record,
    ownerProblem: async () => '',
    deliver: async (_row, item) => delivered.push(item),
    announce: async (_row, run) => announced.push(run),
  };
  const outcome = await runOwnedAutomation(
    'schedule',
    { name: 'daily', ownerAgentId: 'lead' },
    async () => ({ sessionId: 'sess_home_lead', result: 'All green.' }),
    deps
  );
  assert.deepEqual(outcome, { sessionId: 'sess_home_lead', result: 'All green.' });
  await assert.rejects(
    runOwnedAutomation(
      'schedule',
      { name: 'daily', ownerAgentId: 'lead' },
      async () => {
        throw new Error('the routine turn failed');
      },
      deps
    ),
    /the routine turn failed/
  );
  assert.deepEqual([delivered, announced], [[], []], 'no result card, no running row: the reply is the result');
  assert.equal(record.byName.get('daily').resultDelivery, null);
});

test('a routine whose bot is missing never runs: it is a paused skip, recorded, attended or not', async () => {
  const skips = [];
  for (const [owner, problem] of [
    [null, 'no-mixy'],
    ['writer', 'owner-deleted'],
  ]) {
    for (const attended of [false, true]) {
      const outcome = await runOwnedAutomation(
        'webhook',
        { name: 'hook', ownerAgentId: owner },
        () => assert.fail('a routine without its bot must not run anywhere'),
        {
          ...quiet,
          attended,
          ownerProblem: async (id) => {
            assert.equal(id, owner);
            return problem;
          },
          recordSkip: async (name) => skips.push(name),
        }
      );
      assert.equal(outcome.skipped, true);
      assert.equal(outcome.reason, 'owner');
      assert.equal(outcome.ownerProblem, problem);
    }
  }
  assert.equal(skips.length, 4);
});

test('a second run of the same routine while one is going is an overlap skip', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deps = { ...quiet, attended: true, ownerProblem: async () => '', active: new Set() };
  const first = runOwnedAutomation(
    'schedule',
    { name: 'slow' },
    async () => {
      await gate;
      return { sessionId: 'sess_home_lead', result: 'ok' };
    },
    deps
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runOwnedAutomation('schedule', { name: 'slow' }, () => assert.fail('overlap'), deps);
  assert.equal(second.reason, 'overlap');
  release();
  assert.equal((await first).result, 'ok');
  assert.equal(deps.active.size, 0);
});

test('an unattended fire of a routine that is switched off (paused by the user or after failures) is skipped', async () => {
  const skips = [];
  const base = {
    ...quiet,
    attended: false,
    ownerProblem: async () => '',
    active: new Set(),
    list: async () => [],
    recordDelivery: async () => {},
    recordSkip: async (name) => skips.push(name),
  };
  const off = await runOwnedAutomation(
    'schedule',
    { name: 'r_fail' },
    () => assert.fail('a paused routine must not run'),
    { ...base, state: async () => ({ enabled: false, consecutiveFailures: 2 }) }
  );
  assert.equal(off.skipped, true);
  assert.equal(off.reason, 'paused');
  assert.deepEqual(skips, ['r_fail']);
  assert.equal(base.active.size, 0);
  // "Run now" (attended) still runs a switched-off routine; an enabled one runs unattended.
  const now = await runOwnedAutomation('schedule', { name: 'r_fail' }, async () => ({ result: 'ok' }), {
    ...base,
    attended: true,
    state: async () => ({ enabled: false }),
  });
  assert.equal(now.result, 'ok');
  const on = await runOwnedAutomation('schedule', { name: 'r_ok' }, async () => ({ result: 'ok' }), {
    ...base,
    state: async () => ({ enabled: true }),
  });
  assert.equal(on.result, 'ok');
});

test('a fire whose previous run waits on a held approval is skipped and recorded, not queued behind it', async () => {
  const held = createHeldRequests({
    deliver: async () => {},
    push: () => {},
    record: async () => {},
    runOf: () => ({ kind: 'schedule', agentId: 'lead', name: 'hourly' }),
    log: () => {},
  });
  const skips = [];
  const deps = {
    ...quiet,
    attended: false,
    ownerProblem: async () => '',
    active: new Set(),
    state: async () => null,
    list: async () => [],
    recordDelivery: async () => {},
    recordSkip: async (name) => skips.push(name),
  };
  const ask = held.hold({ kind: 'approval', name: 'shell', sessionId: 'sess_run', reason: 'x' });
  const first = runOwnedAutomation(
    'schedule',
    { name: 'hourly' },
    () => ask.then(() => ({ sessionId: 's', result: 'ok' })),
    deps
  );
  await new Promise((resolve) => setImmediate(resolve));
  for (let fire = 0; fire < 3; fire += 1) {
    const next = await runOwnedAutomation('schedule', { name: 'hourly' }, () => assert.fail('piled up'), deps);
    assert.equal(next.reason, 'overlap');
  }
  assert.deepEqual(skips, ['hourly', 'hourly', 'hourly']);
  const [pending] = held.pending();
  held.resolve(pending.id, { approved: true });
  assert.equal((await first).result, 'ok');
  assert.equal(deps.active.size, 0);
  const after = await runOwnedAutomation(
    'schedule',
    { name: 'hourly' },
    async () => ({ sessionId: 's', result: 'next' }),
    deps
  );
  assert.equal(after.result, 'next', 'the next fire runs once the held run ended');
});

test("a result left on a record by a run from before is recovered once into the owner's thread", async (t) => {
  const entry = {
    state: 'failed',
    error: 'disk full',
    at: '2030-01-01T00:00:00.000Z',
    result: { ok: true, text: 'All green.', runSessionId: 'sess_run_1' },
  };
  const record = records([{ name: 'daily', ownerAgentId: 'lead', resultDelivery: { run_old: entry } }]);
  const h = homes(t, ['sess_home_lead']);
  const deliver = (row, item) => h.delivery.enqueue(row, item);
  assert.equal(await recoverRoutineDeliveries({ schedule: { ...record, deliver }, webhook: { ...records([]) } }), 0);
  await h.delivery.drain('sess_home_lead');
  assert.deepEqual(h.posted('sess_home_lead'), ['routine_run_old']);
  assert.equal(record.byName.get('daily').resultDelivery, null, 'cleared once queued');
  // A duplicate replay of the same run (a clear that never landed) posts nothing.
  await record.recordDelivery('daily', 'run_old', entry);
  await redeliverRoutine('schedule', await record.state('daily'), { ...record, deliver });
  await h.delivery.drain('sess_home_lead');
  assert.deepEqual(h.posted('sess_home_lead'), ['routine_run_old']);
});

test('the app retry re-queues a refused result and reports one still refused', async (t) => {
  const record = records([
    {
      name: 'issues',
      ownerAgentId: 'reviewer',
      resultDelivery: {
        run_w1: {
          state: 'failed',
          error: 'disk full',
          at: '2030-01-01T00:00:00.000Z',
          result: { ok: false, text: 'no model' },
        },
      },
    },
  ]);
  await assert.rejects(
    retryRoutineDelivery('webhook', 'issues', {
      ...record,
      deliver: async () => {
        throw new Error('still full');
      },
      onDeliveryFailed: () => {},
      log: () => {},
    }),
    /the result still could not be delivered \(still full\)/
  );
  assert.equal(record.byName.get('issues').resultDelivery.run_w1.error, 'still full');
  const h = homes(t, ['sess_home_reviewer']);
  const done = await retryRoutineDelivery('webhook', 'issues', {
    ...record,
    deliver: (row, item) => h.delivery.enqueue(row, item),
  });
  assert.deepEqual(done, { name: 'issues', delivered: 1 });
  await h.delivery.drain('sess_home_reviewer');
  const [message] = h.sessions.get('sess_home_reviewer').messages;
  assert.equal(message.meta.routine.kind, 'webhook');
  assert.equal(message.meta.routine.status, 'failed');
  assert.equal(record.byName.get('issues').resultDelivery, null);
});

test("a deleted owner's results move to Mixy's home instead of its archived thread", async (t) => {
  const h = homes(t, ['sess_home_lead', 'sess_home_writer'], {
    agentPresence: (id) => (id === 'writer' ? 'deleted' : 'present'),
  });
  await h.delivery.enqueue({ name: 'digest', ownerAgentId: 'writer' }, { runId: 'run_d1', ok: true, text: 'done' });
  await h.delivery.drain('sess_home_writer');
  await h.delivery.drain('sess_home_lead');
  assert.deepEqual(h.posted('sess_home_writer'), [], 'never into the deleted agent thread');
  assert.deepEqual(h.posted('sess_home_lead'), ['routine_run_d1']);
});

test('a reset home thread never gets a replayed result again, but gets new ones', async (t) => {
  const h = homes(t, ['sess_home_lead']);
  await h.delivery.drain(await h.delivery.enqueue({ name: 'daily' }, { runId: 'run_r1', ok: true, text: 'one' }));
  assert.deepEqual(h.posted('sess_home_lead'), ['routine_run_r1']);
  // "대화 새로 시작": the fixed home id stays, its messages are cleared.
  h.sessions.get('sess_home_lead').messages = [];
  await h.delivery.drain(await h.delivery.enqueue({ name: 'daily' }, { runId: 'run_r1', ok: true, text: 'one' }));
  assert.deepEqual(h.posted('sess_home_lead'), [], 'the replay is a no-op');
  await h.delivery.drain(await h.delivery.enqueue({ name: 'daily' }, { runId: 'run_r2', ok: true, text: 'two' }));
  assert.deepEqual(h.posted('sess_home_lead'), ['routine_run_r2']);
});

test('a home queue is bounded: the oldest results drop behind one "omitted" notice', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-bound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queue = createRoutineResultQueue(join(dir, 'q.json'), { limit: 3 });
  const h = homes(t, [], { queue });
  for (let index = 1; index <= 5; index += 1) {
    await h.delivery.enqueue({ name: 'hourly' }, { runId: `run_${index}`, ok: true, text: `#${index}` });
  }
  assert.deepEqual(
    (await queue.items('sess_home_lead')).map((item) => item.runId),
    ['run_3', 'run_4', 'run_5']
  );
  assert.equal((await queue.omitted('sess_home_lead')).count, 2);
  h.sessions.set('sess_home_lead', { id: 'sess_home_lead', messages: [], generation: 1 });
  await h.delivery.drain('sess_home_lead');
  const items = restoreTranscriptItems(h.sessions.get('sess_home_lead').messages, { sessionId: 'sess_home_lead' });
  assert.deepEqual(
    items.map((item) => item.text),
    ['⏱ Routine results omitted: 2', '⏱ Schedule · hourly — #3', '⏱ Schedule · hourly — #4', '⏱ Schedule · hourly — #5']
  );
  assert.deepEqual(items[0].routine, { omitted: 2 });
  assert.equal(await queue.omitted('sess_home_lead'), null, 'the notice is posted once');
  assert.deepEqual(await queue.pendingHomes(), []);
  assert.equal(ROUTINE_LIMITS.homeQueueLimit, 200);
});

test('failures in a row back unattended fires off exponentially; a person can still run it', async () => {
  const now = Date.parse('2030-01-01T00:10:00.000Z');
  const minute = 60_000;
  const state = (failures, agoMs) => ({
    consecutiveFailures: failures,
    lastFailedAt: new Date(now - agoMs).toISOString(),
  });
  assert.equal(routineBackoffRemaining(state(0, 0), now), 0);
  assert.equal(routineBackoffRemaining(state(1, 0), now), minute);
  assert.equal(routineBackoffRemaining(state(3, minute), now), 3 * minute, '4 min after the 3rd, 1 gone');
  assert.equal(routineBackoffRemaining(state(2, 3 * minute), now), 0, 'waited out');

  const record = records([{ name: 'flaky', ...state(2, 30_000) }]);
  const skips = [];
  const deps = {
    ...quiet,
    ...record,
    now: () => now,
    recordSkip: async (name) => skips.push(name),
    ownerProblem: async () => '',
  };
  const fired = await runOwnedAutomation('schedule', { name: 'flaky' }, () => assert.fail('backing off'), deps);
  assert.deepEqual(fired, { name: 'flaky', skipped: true, reason: 'backoff', sessionId: null, result: '' });
  assert.deepEqual(skips, ['flaky'], 'the skip is recorded, never as a failure');
  const manual = await runOwnedAutomation(
    'schedule',
    { name: 'flaky' },
    async () => ({ sessionId: 's1', result: 'ok' }),
    { ...deps, attended: true }
  );
  assert.equal(manual.result, 'ok');
  assert.equal(ROUTINE_LIMITS.pauseAfterFailures, 5);
});
