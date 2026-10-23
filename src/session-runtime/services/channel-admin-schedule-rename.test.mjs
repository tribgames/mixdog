import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A store with the real rename contract: the key moves, history stays, an
// occupied target rejects.
const rows = new Map();
const calls = { upsert: 0, rename: [] };
const realSchedulesDb = await import('../../runtime/channels/lib/schedules-db.mjs');
mock.module('../../runtime/channels/lib/schedules-db.mjs', {
  namedExports: {
    ...realSchedulesDb,
    listSchedules: async () => [...rows.values()],
    getSchedule: async (name) => rows.get(name) ?? null,
    upsertSchedule: async (def) => {
      calls.upsert += 1;
      rows.set(def.name, { ...def });
      return rows.get(def.name);
    },
    renameSchedule: async (oldName, def) => {
      calls.rename.push([oldName, def.name]);
      const old = rows.get(oldName);
      if (!old) return null;
      if (rows.has(def.name)) throw new Error(`A schedule named "${def.name}" already exists.`);
      rows.delete(oldName);
      const { nextFireAt, ...settings } = def; // next_fire_at stays on the row
      const next = { ...old, ...settings };
      rows.set(def.name, next);
      return next;
    },
    deleteSchedule: async () => true,
    setEnabled: async () => null,
  },
});
const running = new Set();
const realRuns = await import('../owned-automation-run.mjs');
mock.module('../owned-automation-run.mjs', {
  namedExports: {
    ...realRuns,
    // The engine-side reservation, observable through `running`.
    beginAutomationRename: (kind, name) => {
      const key = `${kind}:${name}`;
      if (running.has(key)) return null;
      running.add(key);
      return () => running.delete(key);
    },
  },
});
const pgAdapter = await import('../../runtime/memory/lib/pg/adapter.mjs');
mock.module('../../runtime/memory/lib/pg/adapter.mjs', {
  namedExports: { ...pgAdapter, pgClusterExists: () => true },
});
const owner = await import('../routine-owner.mjs');
const probe = { mixyExists: () => true, presence: () => 'present' };
mock.module('../routine-owner.mjs', {
  namedExports: {
    ...owner,
    routineOwnerProblem: (id) => owner.routineOwnerProblem(id, probe),
    assertRoutineOwner: (id) => owner.assertRoutineOwner(id, probe),
  },
});
const { saveSchedule } = await import('./channel-admin.mjs');
const { createChannelConfigApi } = await import('../channel-config-api.mjs');

const base = { time: '0 9 * * *', instructions: 'Report', overwrite: true };
const history = { lastSuccessAt: '2030-01-03T10:00:00.000Z', nextFireAt: '2030-01-07T10:00:00.000Z', enabled: false };

test('a rename keeps settings and history and leaves nothing under the old name', async () => {
  rows.set('daily', { name: 'daily', ownerAgentId: 'reviewer', prompt: 'old', whenCron: '0 8 * * *', ...history });
  await saveSchedule({ ...base, name: 'daily', newName: 'Morning Report', enabled: false, owner: 'reviewer' });
  assert.deepEqual([...rows.keys()], ['Morning Report']);
  const row = rows.get('Morning Report');
  assert.equal(row.ownerAgentId, 'reviewer');
  assert.equal(row.prompt, 'Report');
  assert.equal(row.enabled, false);
  assert.equal(row.lastSuccessAt, history.lastSuccessAt);
  assert.equal(row.nextFireAt, history.nextFireAt);
  assert.equal(calls.upsert, 0, 'renamed in place, not delete-and-create');
});

test('a rename onto an existing name is refused and changes nothing', async () => {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'a', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  rows.set('b', { name: 'b', prompt: 'b', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  const before = JSON.stringify([...rows]);
  const renames = calls.rename.length;
  await assert.rejects(saveSchedule({ ...base, name: 'a', newName: 'b' }), /A schedule named "b" already exists\./);
  assert.equal(JSON.stringify([...rows]), before);
  assert.equal(calls.rename.length, renames, 'the store is never asked');
  await assert.rejects(saveSchedule({ ...base, name: 'a', newName: 'bad/name' }), /schedule name must be/);
  await assert.rejects(saveSchedule({ ...base, name: 'ghost', newName: 'c' }), /does not exist/);
});

test('a running schedule is not renamed', async () => {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'a', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  running.add('schedule:a');
  await assert.rejects(saveSchedule({ ...base, name: 'a', newName: 'c' }), /is running/);
  assert.deepEqual([...rows.keys()], ['a']);
  running.clear();
});

test('saving with the same name (or an empty newName) stays an ordinary upsert', async () => {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'a', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  const renames = calls.rename.length;
  await saveSchedule({ ...base, name: 'a', newName: 'a' });
  await saveSchedule({ ...base, name: 'a', newName: ' ' });
  assert.equal(calls.upsert, 2);
  assert.equal(calls.rename.length, renames);
});

test('with the channels worker up, the worker performs the check and the move; a run there refuses the rename', async () => {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'a', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  const sent = [];
  let reply = {
    isError: true,
    content: [{ type: 'text', text: 'rename_schedule failed: Schedule "a" is running. Rename it after the run finishes.' }],
  };
  const channels = {
    status: () => ({ running: true }),
    execute: async (name, args) => {
      sent.push([name, args.name, args.def.name]);
      return reply;
    },
  };
  const api = createChannelConfigApi({ channels, reloadChannelsSoon() {} });
  const renames = calls.rename.length;
  await assert.rejects(api.saveSchedule({ ...base, name: 'a', newName: 'b' }), /^Error: Schedule "a" is running\./);
  assert.deepEqual(sent, [['rename_schedule', 'a', 'b']]);
  assert.equal(calls.rename.length, renames, 'the engine does not move the row itself');
  assert.equal(running.size, 0, 'the engine-side reservation is released');
  assert.deepEqual([...rows.keys()], ['a']);

  reply = { content: [{ type: 'text', text: JSON.stringify({ name: 'b', prompt: 'Report', whenCron: '0 9 * * *' }) }] };
  const saved = await api.saveSchedule({ ...base, name: 'a', newName: 'b' });
  assert.equal(saved.name, 'b');
  assert.equal(calls.rename.length, renames);

  // No worker: the engine path moves the row.
  const alone = createChannelConfigApi({ channels: { status: () => ({ running: false }) }, reloadChannelsSoon() {} });
  await alone.saveSchedule({ ...base, name: 'a', newName: 'c' });
  assert.equal(calls.rename.length, renames + 1);
  assert.deepEqual([...rows.keys()], ['c']);
});

test('an unanswered worker request (timeout / dead worker) releases the reservation and says the rename may have applied', async () => {
  rows.clear();
  rows.set('a', { name: 'a', prompt: 'a', whenCron: '0 8 * * *', ownerAgentId: 'lead' });
  let reloads = 0;
  const channels = {
    status: () => ({ running: true }),
    execute: async () => {
      throw Object.assign(new Error('request timed out after 120000ms'), { daemonTransportError: true });
    },
  };
  const api = createChannelConfigApi({ channels, reloadChannelsSoon: () => reloads++ });
  await assert.rejects(
    api.saveSchedule({ ...base, name: 'a', newName: 'b' }),
    /may or may not have applied.*timed out after 120000ms/
  );
  assert.equal(running.size, 0, 'the engine-side reservation is released');
  assert.equal(reloads, 1, 'the worker is asked to re-read the schedules');
});
