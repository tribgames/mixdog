import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentHomeSessions } from './agent-home-sessions.ts';
import { desktopSessionSummaries } from './desktop-state.ts';

const AGENTS = [
  { id: 'maintainer', locked: true, route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'github-watcher', custom: true, route: { provider: 'anthropic', model: 'claude-x', effort: 'high' } },
  { id: 'off', custom: true, disabled: true, route: { provider: 'openai', model: 'gpt-5' } },
];

function missing(sessionId) {
  return new Error(`session ${sessionId} is not available`);
}

/** A host whose daemon store is `stored`, and whose creates take a tick. */
function fakeHost({ agents = AGENTS, stored = new Set(), known = [], presence = {} } = {}) {
  const calls = { creates: [], archived: [], presence: [] };
  const deps = {
    listAgents: async () => agents,
    readSession: async (sessionId) => {
      if (!stored.has(sessionId)) throw missing(sessionId);
      return {};
    },
    createSession: async (sessionId, params) => {
      calls.creates.push({ sessionId, params });
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored.add(sessionId);
    },
    setArchived: async (sessionId, archived) => {
      calls.archived.push([sessionId, archived]);
    },
    knownSessionIds: () => known,
    agentPresence: async (ids) => {
      calls.presence.push(ids);
      return typeof presence === 'function' ? presence(ids) : presence;
    },
    taskWorkspace: async () => '/tasks',
  };
  return { homes: createAgentHomeSessions(deps), calls, stored };
}

test('an agent resolves to one fixed home thread, created once and reused forever', async () => {
  const { homes, calls } = fakeHost();
  const first = await homes.open('github-watcher');
  assert.equal(first.sessionId, 'sess_home_github-watcher');
  assert.equal(calls.creates.length, 1);
  assert.deepEqual(calls.creates[0].params, {
    provider: 'anthropic',
    model: 'claude-x',
    effort: 'high',
    sessionProfile: { homeAgent: 'github-watcher' },
    cwd: '/tasks',
    desktopSession: { classification: 'task', projectPath: null },
  });
  // Reopen, and a new host (restart) over the same store: the same thread.
  assert.deepEqual(await homes.open('github-watcher'), first);
  const restarted = fakeHost({ stored: new Set([first.sessionId]) });
  assert.deepEqual(await restarted.homes.open('github-watcher'), first);
  assert.equal(calls.creates.length, 1);
  assert.equal(restarted.calls.creates.length, 0);
});

test('concurrent first opens (this window and a phone) never fork the thread', async () => {
  const { homes, calls } = fakeHost();
  const opened = await Promise.all([homes.open('github-watcher'), homes.open('github-watcher')]);
  assert.equal(opened[0].sessionId, opened[1].sessionId);
  assert.equal(calls.creates.length, 1);
});

test('Mixy opens on the Lead configuration; unknown, disabled and system agents do not open', async () => {
  const { homes, calls } = fakeHost();
  assert.deepEqual(await homes.open('lead'), { sessionId: 'sess_home_lead' });
  assert.deepEqual(calls.creates[0].params, {
    cwd: '/tasks',
    desktopSession: { classification: 'task', projectPath: null },
  });
  for (const agentId of ['maintainer', 'off', 'nobody']) {
    await assert.rejects(homes.open(agentId), /not available/);
  }
  await assert.rejects(homes.open('Bad Id'), /invalid/);
});

test('the catalog stamps each home thread with its agent', () => {
  const rows = desktopSessionSummaries(
    ['sess_home_gone', 'sess_plain'].map((id) => ({ id, title: id, messageCount: 2, cwd: '/tasks' }))
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.agentHome]),
    [
      ['sess_home_gone', 'gone'],
      ['sess_plain', undefined],
    ]
  );
});

const HOMES = ['sess_home_github-watcher', 'sess_home_gone', 'sess_home_off', 'sess_home_lead', 'sess_plain'];

test("a deleted agent's thread is archived by its fixed id; present and switched-off agents keep theirs", async () => {
  const { homes, calls } = fakeHost({
    known: HOMES,
    presence: { 'github-watcher': 'present', gone: 'deleted', off: 'present' },
  });
  await homes.reconcile();
  // Mixy (the Lead) and ordinary sessions are never asked about.
  assert.deepEqual(calls.presence, [['github-watcher', 'gone', 'off']]);
  assert.deepEqual(calls.archived, [['sess_home_gone', true]]);
});

test('the delete path archives a blank home that no summary or store row lists', async () => {
  // Opened, never messaged, then deleted: nothing lists the session at all.
  const { homes, calls } = fakeHost({ known: [], presence: { 'github-watcher': 'deleted' } });
  await homes.retire(['github-watcher']);
  assert.deepEqual(calls.archived, [['sess_home_github-watcher', true]]);
});

test('a partial catalog archives nothing: list absence is never a deletion', async () => {
  // The agent list came back empty (a partial scan), the files are still there.
  const { homes, calls } = fakeHost({
    agents: [],
    known: HOMES,
    presence: { 'github-watcher': 'present', gone: 'present', off: 'present' },
  });
  await homes.reconcile();
  assert.deepEqual(calls.archived, []);
});

test('a directory-read failure archives nothing', async () => {
  for (const presence of [{ 'github-watcher': 'unknown', gone: 'unknown', off: 'unknown' }, null, 'garbage']) {
    const { homes, calls } = fakeHost({ known: HOMES, presence });
    await homes.reconcile();
    await homes.retire(['github-watcher']);
    assert.deepEqual(calls.archived, [], JSON.stringify(presence));
  }
  // A presence read that throws reaches the caller (logged there), archiving nothing.
  const failing = fakeHost({
    known: HOMES,
    presence: () => {
      throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
    },
  });
  await assert.rejects(failing.homes.reconcile(), /EIO/);
  assert.deepEqual(failing.calls.archived, []);
});

test('reopening a contact brings its thread back from the archive', async () => {
  const { homes, calls } = fakeHost({ stored: new Set(['sess_home_github-watcher']) });
  await homes.open('github-watcher');
  assert.deepEqual(calls.archived, [['sess_home_github-watcher', false]]);
});
