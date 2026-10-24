import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// "Run now" holds the schedule's name from its read of the row through its
// outcome stamps, so a rename in between is refused instead of moving the row
// the run read or taking its stamps.
const rows = new Map();
const stamps = [];
const holds = new Map();

/** Make the next store call `key` wait until released; `reached` resolves once it is called. */
function hold(key) {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  holds.set(key, { reach: reached.resolve, wait: release.promise });
  return { reached: reached.promise, release: release.resolve };
}
async function gate(key) {
  const held = holds.get(key);
  if (!held) return;
  holds.delete(key);
  held.reach();
  await held.wait;
}

const realSchedulesDb = await import('../runtime/channels/lib/schedules-db.mjs');
mock.module('../runtime/channels/lib/schedules-db.mjs', {
  namedExports: {
    ...realSchedulesDb,
    getSchedule: async (name) => {
      await gate('read');
      return rows.get(name) ?? null;
    },
    renameSchedule: async (oldName, def) => {
      await gate('move');
      const old = rows.get(oldName);
      if (!old) return null;
      rows.delete(oldName);
      const next = { ...old, ...def };
      rows.set(def.name, next);
      return next;
    },
    markScheduleSuccess: async (name) => {
      await gate('success');
      stamps.push(['success', name]);
    },
    markScheduleFailure: async (name) => {
      await gate('failure');
      stamps.push(['failure', name]);
    },
    markScheduleSkipped: async (name) => stamps.push(['skipped', name]),
  },
});
let turn = async () => ({ sessionId: 'sess_run', result: 'done' });
mock.module('./routine-home-turn.mjs', {
  namedExports: { runRoutineTurn: (...args) => turn(...args) },
});
const pgAdapter = await import('../runtime/memory/lib/pg/adapter.mjs');
mock.module('../runtime/memory/lib/pg/adapter.mjs', {
  namedExports: { ...pgAdapter, pgClusterExists: () => true },
});
const owner = await import('./routine-owner.mjs');
const probe = { mixyExists: () => true, presence: () => 'present' };
mock.module('./routine-owner.mjs', {
  namedExports: {
    ...owner,
    routineOwnerProblem: (id) => owner.routineOwnerProblem(id, probe),
    assertRoutineOwner: (id) => owner.assertRoutineOwner(id, probe),
  },
});
const { createChannelConfigApi } = await import('./channel-config-api.mjs');

const api = createChannelConfigApi({ channels: { status: () => ({ running: false }) }, reloadChannelsSoon() {} });
const renameAToB = () =>
  api.saveSchedule({ name: 'a', newName: 'b', time: '0 9 * * *', instructions: 'Report', overwrite: true });
const refusedAsRunning = (error) => error.code === 'SCHEDULE_RENAME_RUNNING' && error.details?.name === 'a';

function reset() {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'Report', whenCron: '0 9 * * *', ownerAgentId: 'lead' });
  stamps.length = 0;
  holds.clear();
  turn = async () => ({ sessionId: 'sess_run', result: 'done' });
}

test('a rename while "Run now" is still reading the row is refused, and the run goes on under the name it read', async () => {
  reset();
  const read = hold('read');
  const run = api.runScheduleNow('a');
  await read.reached;
  await assert.rejects(renameAToB(), refusedAsRunning);
  read.release();
  assert.equal((await run).ok, true);
  assert.deepEqual([...rows.keys()], ['a'], 'nothing moved');
  assert.deepEqual(stamps, [['success', 'a']]);
  assert.equal((await renameAToB()).name, 'b', 'the name is free once the run settles');
});

test('a rename while "Run now" writes its success stamp is refused until the stamp is on the row', async () => {
  reset();
  const success = hold('success');
  const run = api.runScheduleNow('a');
  await success.reached;
  await assert.rejects(renameAToB(), refusedAsRunning);
  success.release();
  await run;
  assert.deepEqual(stamps, [['success', 'a']]);
  assert.deepEqual([...rows.keys()], ['a']);
  assert.equal((await renameAToB()).name, 'b');
});

test('a rename while a failed "Run now" writes its failure stamp is refused until the stamp is on the row', async () => {
  reset();
  turn = async () => {
    throw new Error('provider down');
  };
  const failure = hold('failure');
  const run = api.runScheduleNow('a');
  await failure.reached;
  await assert.rejects(renameAToB(), refusedAsRunning);
  failure.release();
  await assert.rejects(run, /provider down/);
  assert.deepEqual(stamps, [['failure', 'a']]);
  assert.equal((await renameAToB()).name, 'b');
});

const refusedRun = /still running; this run was skipped/;

test('"Run now" while a rename holds the name is refused and never runs', async () => {
  reset();
  let runs = 0;
  turn = async () => {
    runs++;
    return { sessionId: 's', result: '' };
  };
  const move = hold('move');
  const renaming = renameAToB();
  await move.reached;
  await assert.rejects(api.runScheduleNow('a'), refusedRun);
  move.release();
  await renaming;
  assert.equal(runs, 0);
  assert.deepEqual([...rows.keys()], ['b']);
});
