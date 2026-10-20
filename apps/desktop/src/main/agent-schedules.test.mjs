import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentHomeSessions } from './agent-home-sessions.ts';
import { disableAgentSchedules } from './agent-schedules.ts';

function host(schedules, webhooks = []) {
  const calls = [];
  const invoke = async (method, args) => {
    calls.push([method, args]);
    if (method === 'getChannelSetup') return { schedules, webhooks };
    return { ok: true };
  };
  return { calls, invoke };
}

test("a deleted agent's webhooks are switched off too, by the same retry-safe rule", async () => {
  const { calls, invoke } = host(
    [{ name: 'pr-sweep', owner: 'reviewer', enabled: true }],
    [
      { name: 'issues', owner: 'reviewer', enabled: true },
      { name: 'off-already', owner: 'reviewer', enabled: false },
      { name: 'mixy-hook', owner: 'lead', enabled: true },
    ]
  );
  await disableAgentSchedules(invoke, 'reviewer');
  assert.deepEqual(calls, [
    ['getChannelSetup', []],
    ['setScheduleEnabled', ['pr-sweep', false]],
    ['setWebhookEnabled', ['issues', false]],
  ]);
});

test("a deleted agent's schedules are switched off, never deleted", async () => {
  const { calls, invoke } = host([
    { name: 'pr-sweep', owner: 'reviewer', enabled: true },
    { name: 'paused', owner: 'reviewer', enabled: false },
    { name: 'mixy-daily', owner: 'lead', enabled: true },
    { name: 'legacy', enabled: true },
  ]);
  await disableAgentSchedules(invoke, 'reviewer');
  assert.deepEqual(calls, [
    ['getChannelSetup', []],
    ['setScheduleEnabled', ['pr-sweep', false]],
  ]);
});

test('a confirmed deletion switches off the agent schedules; a present agent keeps them', async () => {
  const disabled = [];
  const retired = new Set();
  const homes = createAgentHomeSessions({
    listAgents: async () => [],
    readSession: async () => ({}),
    createSession: async () => {},
    setRoute: async () => {},
    setArchived: async () => {},
    isRetired: async (sessionId) => retired.has(sessionId),
    setRetired: async (sessionId, value) => (value ? retired.add(sessionId) : retired.delete(sessionId)),
    knownSessionIds: () => [],
    archivedAgentName: async () => '',
    nameRetired: async () => {},
    agentPresence: async (ids) => Object.fromEntries(ids.map((id) => [id, id === 'gone' ? 'deleted' : 'present'])),
    taskWorkspace: async () => '/tasks',
    disableAgentSchedules: async (agentId) => {
      disabled.push(agentId);
    },
  });
  await homes.retire(['gone', 'kept']);
  assert.deepEqual(disabled, ['gone']);
});

test('a failed switch-off is retried by later checks without archiving a hand-restored home again', async () => {
  const archived = [];
  const retired = new Set();
  let failing = true;
  const schedules = [{ name: 'pr-sweep', owner: 'gone', enabled: true }];
  const webhooks = [{ name: 'issues', owner: 'gone', enabled: true }];
  const invoke = async (method, args) => {
    if (method === 'getChannelSetup') return { schedules, webhooks };
    if (failing) throw new Error('daemon restarting');
    const rows = method === 'setWebhookEnabled' ? webhooks : schedules;
    rows.find((row) => row.name === args[0]).enabled = args[1];
    return { ok: true };
  };
  const homes = createAgentHomeSessions({
    listAgents: async () => [],
    readSession: async () => ({}),
    createSession: async () => {},
    setRoute: async () => {},
    setArchived: async (sessionId, value) => archived.push([sessionId, value]),
    isRetired: async (sessionId) => retired.has(sessionId),
    setRetired: async (sessionId, value) => (value ? retired.add(sessionId) : retired.delete(sessionId)),
    knownSessionIds: () => ['sess_home_gone'],
    archivedAgentName: async () => '',
    nameRetired: async () => {},
    agentPresence: async (ids) => Object.fromEntries(ids.map((id) => [id, 'deleted'])),
    taskWorkspace: async () => '/tasks',
    disableAgentSchedules: (agentId) => disableAgentSchedules(invoke, agentId),
  });
  await homes.reconcile();
  assert.deepEqual(archived, [['sess_home_gone', true]]);
  assert.equal(retired.has('sess_home_gone'), true, 'the home is retired even though the switch-off failed');
  assert.equal(schedules[0].enabled, true);
  // The user restores the thread by hand; the next check only finishes the switch-off.
  archived.length = 0;
  failing = false;
  await homes.reconcile();
  assert.deepEqual(archived, [], 'a hand-restored home is not archived again');
  assert.equal(schedules[0].enabled, false);
  assert.equal(webhooks[0].enabled, false);
});
