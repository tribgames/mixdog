import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const rows = new Map();
const upserts = [];
mock.module('../../runtime/channels/lib/schedules-db.mjs', {
  namedExports: {
    listSchedules: async () => [...rows.values()],
    getSchedule: async (name) => rows.get(name) ?? null,
    upsertSchedule: async (def) => {
      upserts.push(def);
      const row = { ...def, ownerAgentId: def.ownerAgentId || 'lead' };
      rows.set(def.name, row);
      return row;
    },
    renameSchedule: async () => null,
    deleteSchedule: async () => true,
    setEnabled: async () => null,
  },
});

// The catalog read reaches the (mocked) stores only once a cluster exists.
const pgAdapter = await import('../../runtime/memory/lib/pg/adapter.mjs');
mock.module('../../runtime/memory/lib/pg/adapter.mjs', {
  namedExports: { ...pgAdapter, pgClusterExists: () => true },
});
const endpoints = new Map();
const endpointUpserts = [];
const webhooksDb = await import('../../runtime/channels/lib/webhooks-db.mjs');
mock.module('../../runtime/channels/lib/webhooks-db.mjs', {
  namedExports: {
    ...webhooksDb,
    listEndpoints: async () => [...endpoints.values()],
    loadEndpointConfig: async (name) => endpoints.get(name) ?? null,
    readEndpointSecret: async () => 'kept-secret',
    upsertEndpoint: async (def) => {
      endpointUpserts.push(def);
      const row = { ...def, ownerAgentId: def.ownerAgentId || 'lead' };
      endpoints.set(def.name, row);
      return row;
    },
  },
});

// Which bots exist: Mixy (created or not) and each bot's presence.
const bots = { mixy: true, deleted: new Set() };
const probe = {
  mixyExists: () => bots.mixy,
  presence: (id) => (bots.deleted.has(id) ? 'deleted' : 'present'),
};
const owner = await import('../routine-owner.mjs');
mock.module('../routine-owner.mjs', {
  namedExports: {
    ...owner,
    routineOwnerProblem: (id) => owner.routineOwnerProblem(id, probe),
    assertRoutineOwner: (id) => owner.assertRoutineOwner(id, probe),
  },
});

const { channelSetup, listSchedules, saveSchedule, saveWebhook } = await import('./channel-admin.mjs');

test('a new webhook defaults its owner to Mixy; an edit keeps it; a list row never carries the payload', async () => {
  const hook = { instructions: 'Triage the issue', parser: 'github' };
  const created = await saveWebhook({ ...hook, name: 'issues' });
  assert.equal(endpointUpserts.at(-1).ownerAgentId, 'lead');
  assert.equal(created.owner, 'lead');
  await saveWebhook({ ...hook, name: 'issues', owner: 'reviewer', overwrite: true });
  assert.equal(endpointUpserts.at(-1).ownerAgentId, 'reviewer');
  // The Webhooks page editor saves without an owner: the owner stays.
  await saveWebhook({ ...hook, name: 'issues', overwrite: true });
  assert.equal(endpointUpserts.at(-1).ownerAgentId, 'reviewer');
  await assert.rejects(saveWebhook({ ...hook, name: 'bad', owner: 'Not An Id' }), /not a valid agent id/);

  endpoints.set('legacy', {
    name: 'legacy',
    instructions: 'p',
    enabled: true,
    hasLastPayload: true,
    lastEventAt: new Date('2030-01-01T00:00:00Z'),
    lastFailedAt: new Date('2030-01-01T00:01:00Z'),
  });
  const { webhooks } = await channelSetup();
  const legacy = webhooks.find((row) => row.name === 'legacy');
  assert.equal(legacy.owner, 'lead', 'a row stored before ownership lists as Mixy’s');
  assert.equal(legacy.hasLastPayload, true);
  assert.equal(legacy.lastEventAt, '2030-01-01T00:00:00.000Z');
  assert.equal(legacy.lastFailedAt, '2030-01-01T00:01:00.000Z');
  assert.equal(Object.hasOwn(legacy, 'lastPayload'), false);
});

const base = { time: '0 9 * * 1-5', instructions: 'Check new issues' };

test('a new schedule defaults its owner to Mixy; an edit keeps the saved owner unless moved', async () => {
  const created = await saveSchedule({ ...base, name: 'new-issues' });
  assert.equal(upserts.at(-1).ownerAgentId, 'lead');
  assert.equal(created.owner, 'lead');

  await saveSchedule({ ...base, name: 'pr-sweep', owner: 'reviewer' });
  assert.equal(upserts.at(-1).ownerAgentId, 'reviewer');
  // The Schedules page editor saves without an owner: the owner stays.
  await saveSchedule({ ...base, name: 'pr-sweep', overwrite: true });
  assert.equal(upserts.at(-1).ownerAgentId, 'reviewer');
  // Moving it to another agent.
  await saveSchedule({ ...base, name: 'pr-sweep', owner: 'lead', overwrite: true });
  assert.equal(upserts.at(-1).ownerAgentId, 'lead');

  await assert.rejects(saveSchedule({ ...base, name: 'bad', owner: 'Not An Id' }), /not a valid agent id/);
  // A row stored before ownership lists as Mixy's.
  rows.set('legacy', { name: 'legacy', whenCron: '0 9 * * *', prompt: 'p', model: 'openai/gpt-5' });
  const legacy = (await listSchedules()).find((row) => row.name === 'legacy');
  assert.equal(legacy.owner, 'lead');
});

test("no model or workflow is stored or listed: a row from before lists as its owner's routine", async () => {
  await saveSchedule({ ...base, name: 'plain', owner: 'reviewer', workflow: 'solo' });
  for (const key of ['model', 'runAsAgent', 'workflow']) assert.equal(Object.hasOwn(upserts.at(-1), key), false, key);
  rows.set('old', {
    name: 'old',
    whenCron: '0 9 * * *',
    prompt: 'p',
    model: 'openai/gpt-5',
    workflow: 'solo',
    runAsAgent: false,
  });
  const old = (await listSchedules()).find((row) => row.name === 'old');
  assert.equal(old.owner, 'lead');
  for (const key of ['model', 'runAsAgent', 'workflow', 'ownerProblem']) {
    assert.equal(Object.hasOwn(old, key), false, key);
  }
  await saveWebhook({ instructions: 'Triage', parser: 'github', name: 'plain-hook', model: 'x/y', workflow: 'solo' });
  for (const key of ['model', 'workflow']) assert.equal(Object.hasOwn(endpointUpserts.at(-1), key), false, key);
});

test('with no bot, nothing can be made, and routines of a missing bot list as paused with the reason', async (t) => {
  t.after(() => {
    bots.mixy = true;
    bots.deleted.clear();
  });
  bots.mixy = false;
  await assert.rejects(saveSchedule({ ...base, name: 'blocked' }), /^Error: Create the representative bot first\.$/);
  await assert.rejects(
    saveWebhook({ instructions: 'Triage', parser: 'github', name: 'blocked-hook' }),
    /Create the representative bot first/
  );
  assert.equal(rows.has('blocked'), false);
  bots.deleted.add('writer');
  await assert.rejects(saveSchedule({ ...base, name: 'gone', owner: 'writer' }), /no longer exists/);
  rows.set('mixy-owned', { name: 'mixy-owned', whenCron: '0 9 * * *', prompt: 'p' });
  rows.set('writer-owned', { name: 'writer-owned', whenCron: '0 9 * * *', prompt: 'p', ownerAgentId: 'writer' });
  rows.set('reviewer-owned', { name: 'reviewer-owned', whenCron: '0 9 * * *', prompt: 'p', ownerAgentId: 'reviewer' });
  const listed = new Map((await listSchedules()).map((row) => [row.name, row.ownerProblem]));
  assert.equal(listed.get('mixy-owned'), 'no-mixy');
  assert.equal(listed.get('writer-owned'), 'owner-deleted');
  assert.equal(listed.get('reviewer-owned'), undefined);
  // Once Mixy exists, its routines run as Mixy again.
  bots.mixy = true;
  const after = new Map((await listSchedules()).map((row) => [row.name, row.ownerProblem]));
  assert.equal(after.get('mixy-owned'), undefined);
});
