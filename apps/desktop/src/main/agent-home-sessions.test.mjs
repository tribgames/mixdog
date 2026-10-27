import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentHomeSessions } from './agent-home-sessions.ts';
import { desktopSessionSummaries } from './desktop-state.ts';

const AGENTS = [
  { id: 'maintainer', locked: true, route: { provider: 'openai', model: 'gpt-5' } },
  {
    id: 'github-watcher',
    custom: true,
    kind: 'bot',
    route: { provider: 'anthropic', model: 'claude-x', effort: 'high' },
  },
  { id: 'off', custom: true, kind: 'bot', disabled: true, route: { provider: 'openai', model: 'gpt-5' } },
];

function missing(sessionId) {
  return new Error(`session ${sessionId} is not available`);
}

/** A host whose daemon store is `stored`, and whose creates take a tick. */
function fakeHost({
  agents = AGENTS,
  stored = new Set(),
  known = [],
  presence = {},
  routes = {},
  retired = new Set(),
  archivedNames = {},
  mixy = true,
} = {}) {
  const calls = { creates: [], archived: [], presence: [], routes: [], named: [] };
  const deps = {
    listAgents: async () => agents,
    mixyCreated: async () => mixy,
    readSession: async (sessionId) => {
      if (!stored.has(sessionId)) throw missing(sessionId);
      return routes[sessionId] || {};
    },
    setRoute: async (sessionId, route) => {
      calls.routes.push([sessionId, route]);
    },
    isRetired: async (sessionId) => retired.has(sessionId),
    setRetired: async (sessionId, value) => {
      if (value) retired.add(sessionId);
      else retired.delete(sessionId);
    },
    nameRetired: async (sessionId, name) => {
      calls.named.push([sessionId, name]);
    },
    archivedAgentName: async (agentId) => archivedNames[agentId] ?? '',
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
    clearSession: async (sessionId, archiveAs) => {
      calls.clears ??= [];
      calls.clears.push([sessionId, archiveAs, calls.archived.some(([id, on]) => id === archiveAs && on)]);
      // The daemon copies a thread with turns to `archiveAs` before the wipe.
      if (calls.withTurns !== false) stored.add(archiveAs);
    },
    mintArchiveId: () => {
      calls.minted = (calls.minted ?? 0) + 1;
      return `sess_archive_${calls.minted}`;
    },
  };
  return { homes: createAgentHomeSessions(deps), deps, calls, stored, retired };
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

test('a reset keeps the fixed home id and moves the old chat to a new id archived first', async () => {
  const { homes, calls } = fakeHost({ stored: new Set(['sess_home_github-watcher']) });
  const reset = await homes.reset('github-watcher');
  assert.deepEqual(reset, { sessionId: 'sess_home_github-watcher', archivedSessionId: 'sess_archive_1' });
  // Cleared in place under the fixed id; the copy was archived before it existed.
  assert.deepEqual(calls.clears, [['sess_home_github-watcher', 'sess_archive_1', true]]);
  assert.deepEqual(calls.archived.at(-1), ['sess_archive_1', true]);
  assert.equal(calls.creates.length, 0, 'no second home thread');
  // Every later open (this window or a phone) lands on the same, now empty, id.
  assert.deepEqual(await homes.open('github-watcher'), { sessionId: 'sess_home_github-watcher' });
  // Mixy resets the same way.
  assert.equal((await homes.reset('lead')).sessionId, 'sess_home_lead');
});

test('a reset of a chat with no turns keeps no archive, and a failed clear un-archives the id', async () => {
  const empty = fakeHost({ stored: new Set(['sess_home_lead']) });
  empty.calls.withTurns = false;
  assert.deepEqual(await empty.homes.reset('lead'), { sessionId: 'sess_home_lead', archivedSessionId: null });
  assert.deepEqual(empty.calls.archived.at(-1), ['sess_archive_1', false]);

  const failing = fakeHost({ stored: new Set(['sess_home_lead']) });
  failing.deps.clearSession = async () => {
    throw new Error('running a turn');
  };
  const homes = createAgentHomeSessions(failing.deps);
  await assert.rejects(homes.reset('lead'), /running a turn/);
  assert.deepEqual(failing.calls.archived.at(-1), ['sess_archive_1', false]);
});

test('a reset and a concurrent open share one flight: never two home threads', async () => {
  const { homes, calls } = fakeHost();
  const [opened, reset] = await Promise.all([homes.open('github-watcher'), homes.reset('github-watcher')]);
  assert.equal(opened.sessionId, reset.sessionId);
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

test('a Mixy the user never created gets no thread, from any surface; an existing one still opens', async () => {
  // Issue #243: a Mixy row shown by mistake created her chat on a click.
  const absent = fakeHost({ mixy: false });
  await assert.rejects(absent.homes.open('lead'), /Create the representative bot first/);
  assert.deepEqual(absent.calls.creates, [], 'nothing created');
  // Other bots are not affected.
  assert.equal((await absent.homes.open('github-watcher')).sessionId, 'sess_home_github-watcher');
  // A thread already on disk is never recreated, so opening it is no creation.
  const kept = fakeHost({ mixy: false, stored: new Set(['sess_home_lead']) });
  assert.deepEqual(await kept.homes.open('lead'), { sessionId: 'sess_home_lead' });
  assert.deepEqual(kept.calls.creates, []);
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

test('the catalog keeps the bots whose sent work a session holds, and drops junk', () => {
  const [handed, plain, junk] = desktopSessionSummaries([
    { id: 'sess_task', title: 'T', messageCount: 2, cwd: '/tasks', handedBy: ['mailer', 'reviewer'] },
    { id: 'sess_plain', title: 'P', messageCount: 2, cwd: '/tasks' },
    { id: 'sess_junk', title: 'J', messageCount: 2, cwd: '/tasks', handedBy: ['', 7, 'mailer', null] },
  ]);
  assert.deepEqual(handed.handedBy, ['mailer', 'reviewer']);
  assert.equal('handedBy' in plain, false);
  assert.deepEqual(junk.handedBy, ['mailer']);
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

test('a deleted agent leaves every room with its home: on an explicit delete and on a deletion seen later, never a present one', async () => {
  const forgotten = [];
  const { deps } = fakeHost({
    known: HOMES,
    presence: { 'github-watcher': 'present', gone: 'deleted', off: 'present' },
  });
  deps.forgetRoomMember = async (id) => void forgotten.push(id);
  const wired = createAgentHomeSessions(deps);
  await wired.retire(['gone']);
  assert.deepEqual(forgotten, ['gone']);
  forgotten.length = 0;
  await wired.reconcile();
  assert.deepEqual(forgotten, ['gone']);
});

test('the delete path archives a blank home that no summary or store row lists', async () => {
  // Opened, never messaged, then deleted: nothing lists the session at all.
  const { homes, calls } = fakeHost({ known: [], presence: { 'github-watcher': 'deleted' } });
  await homes.retire(['github-watcher']);
  assert.deepEqual(calls.archived, [['sess_home_github-watcher', true]]);
});

test("a deleted bot's chat is archived under the name the archived bot left, never untitled", async () => {
  const archivedNames = { 'github-watcher': 'GitHub 감시' };
  const { homes, calls, retired } = fakeHost({
    presence: { 'github-watcher': 'deleted', gone: 'deleted' },
    archivedNames,
  });
  await homes.retire(['github-watcher']);
  // Titled before it is archived, so the archived row lists with the name.
  assert.deepEqual(calls.named, [['sess_home_github-watcher', 'GitHub 감시']]);
  assert.deepEqual(calls.archived, [['sess_home_github-watcher', true]]);
  assert.equal(retired.has('sess_home_github-watcher'), true);
  // The reconcile path (a chat's setup tool) names it the same way; an agent
  // that left no name (deleted before archiving existed) keeps its title.
  const viaTool = fakeHost({
    known: ['sess_home_github-watcher', 'sess_home_gone'],
    presence: { 'github-watcher': 'deleted', gone: 'deleted' },
    archivedNames,
  });
  await viaTool.homes.reconcile();
  assert.deepEqual(viaTool.calls.named, [['sess_home_github-watcher', 'GitHub 감시']]);
  // Already retired: never renamed again.
  await viaTool.homes.reconcile();
  assert.equal(viaTool.calls.named.length, 1);
});

test("a bot made again under a deleted one's id owns its thread again", async () => {
  const { homes, retired } = fakeHost({ retired: new Set(['sess_home_github-watcher']) });
  await homes.open('github-watcher');
  assert.equal(retired.has('sess_home_github-watcher'), false);
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

test('a confirmed deletion archives once: no rewrites, and a hand restore stays restored', async () => {
  const host = fakeHost({ known: HOMES, presence: { 'github-watcher': 'present', gone: 'deleted', off: 'present' } });
  await host.homes.reconcile();
  assert.deepEqual(host.calls.archived, [['sess_home_gone', true]]);
  // Later checks (an archived home, or one the user restored by hand) write nothing.
  await host.homes.reconcile();
  await host.homes.reconcile();
  assert.deepEqual(host.calls.archived, [['sess_home_gone', true]]);
  // The record is persisted: a restarted host over the same metadata agrees.
  const restarted = fakeHost({ known: HOMES, presence: { gone: 'deleted' }, retired: host.retired });
  await restarted.homes.reconcile();
  assert.deepEqual(restarted.calls.archived, []);
  // An explicit delete event always archives.
  await restarted.homes.retire(['gone']);
  assert.deepEqual(restarted.calls.archived, [['sess_home_gone', true]]);
});

test("a restored bot's home leaves 보관됨 and is no longer a deleted bot's chat; Mixy is never touched", async () => {
  const host = fakeHost({ known: ['sess_home_gone'], presence: { gone: 'deleted' }, archivedNames: { gone: 'Gone' } });
  await host.homes.retire(['gone']);
  assert.deepEqual(host.calls.named, [['sess_home_gone', 'Gone']]);
  await host.homes.restore('gone');
  assert.equal(host.retired.has('sess_home_gone'), false);
  assert.deepEqual(host.calls.archived, [
    ['sess_home_gone', true],
    ['sess_home_gone', false],
  ]);
  await host.homes.restore('lead');
  assert.equal(host.calls.archived.length, 2);
});

test('an agent that exists again clears the record, so its next deletion archives', async () => {
  let state = 'deleted';
  const host = fakeHost({ known: ['sess_home_gone'], presence: () => ({ gone: state }) });
  await host.homes.reconcile();
  state = 'present';
  await host.homes.reconcile();
  assert.equal(host.retired.has('sess_home_gone'), false);
  state = 'deleted';
  await host.homes.reconcile();
  assert.deepEqual(host.calls.archived, [
    ['sess_home_gone', true],
    ['sess_home_gone', true],
  ]);
});

test("reopening a thread moves it onto its definition's current model and effort", async () => {
  const id = 'sess_home_github-watcher';
  // The definition is anthropic/claude-x at high effort.
  const stale = fakeHost({ stored: new Set([id]), routes: { [id]: { provider: 'openai', model: 'gpt-5' } } });
  await stale.homes.open('github-watcher');
  assert.deepEqual(stale.calls.routes, [[id, { provider: 'anthropic', model: 'claude-x', effort: 'high' }]]);
  const effortOnly = fakeHost({
    stored: new Set([id]),
    routes: { [id]: { provider: 'anthropic', model: 'claude-x', effort: 'low' } },
  });
  await effortOnly.homes.open('github-watcher');
  assert.equal(effortOnly.calls.routes.length, 1);
  // A thread already on the definition's route is left alone; so is Mixy.
  const current = fakeHost({
    stored: new Set([id, 'sess_home_lead']),
    routes: { [id]: { provider: 'anthropic', model: 'claude-x', effort: 'high' } },
  });
  await current.homes.open('github-watcher');
  await current.homes.open('lead');
  assert.deepEqual(current.calls.routes, []);
  // A first open creates on the route; no refresh is needed.
  const fresh = fakeHost();
  await fresh.homes.open('github-watcher');
  assert.deepEqual(fresh.calls.routes, []);
});

test('a refused route refresh never blocks opening the thread', async () => {
  const id = 'sess_home_github-watcher';
  const host = fakeHost({ stored: new Set([id]), routes: { [id]: { provider: 'openai', model: 'gpt-5' } } });
  const homes = createAgentHomeSessions({
    ...host.deps,
    setRoute: async () => {
      throw new Error('provider is signed out');
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await homes.open('github-watcher'), { sessionId: id });
  } finally {
    console.warn = warn;
  }
});

test("Mixy's thread keeps sess_home_lead and runs on Mixy's own route, never the Lead's", async () => {
  const id = 'sess_home_lead';
  const mixyRoute = { provider: 'openai-oauth', model: 'gpt-6' };
  // A migrated Mixy with history: reused as is, switched to its own model.
  const host = fakeHost({ stored: new Set([id]), routes: { [id]: { provider: 'anthropic-oauth', model: 'opus' } } });
  const homes = createAgentHomeSessions({ ...host.deps, mixyRoute: async () => mixyRoute });
  assert.deepEqual(await homes.open('lead'), { sessionId: id });
  assert.deepEqual(host.calls.creates, [], 'the thread with its history is reused, never recreated');
  assert.deepEqual(host.calls.routes, [[id, mixyRoute]]);
  // No thread yet (the 대표 에이전트 dialog's first greeting): made on Mixy's route.
  const fresh = fakeHost();
  const created = createAgentHomeSessions({ ...fresh.deps, mixyRoute: async () => mixyRoute });
  await created.open('lead');
  assert.deepEqual(fresh.calls.creates[0].params.provider, 'openai-oauth');
  assert.equal(fresh.calls.creates[0].params.sessionProfile, undefined, 'Mixy stays the Lead role');
  // Mixy with no own route: its thread keeps whatever it runs on.
  const plain = fakeHost({ stored: new Set([id]), routes: { [id]: { provider: 'anthropic-oauth', model: 'opus' } } });
  await createAgentHomeSessions({ ...plain.deps, mixyRoute: async () => null }).open('lead');
  assert.deepEqual(plain.calls.routes, []);
});

test("clearing Mixy's route moves its existing thread onto Main's when it is reopened", async () => {
  const id = 'sess_home_lead';
  const main = { provider: 'anthropic-oauth', model: 'claude-main' };
  // getLeadHomeRoute answers Main's route once Mixy's own is cleared.
  const host = fakeHost({ stored: new Set([id]), routes: { [id]: { provider: 'openai-oauth', model: 'gpt-6' } } });
  await createAgentHomeSessions({ ...host.deps, mixyRoute: async () => main }).open('lead');
  assert.deepEqual(host.calls.routes, [[id, main]]);
});

test('a migrated bot reopens its existing thread (history kept) on its own stored route', async () => {
  const id = 'sess_home_github-watcher';
  const host = fakeHost({
    stored: new Set([id]),
    routes: { [id]: { provider: 'anthropic', model: 'claude-x', effort: 'high' } },
  });
  assert.deepEqual(await host.homes.open('github-watcher'), { sessionId: id });
  assert.deepEqual(host.calls.creates, []);
  assert.deepEqual(host.calls.routes, [], 'already on its route');
  // A reclassified pre-1.3 agent is no contact: its old thread is not resolved
  // as a bot home (it lists in Sessions instead) and is never archived.
  await assert.rejects(
    fakeHost({ stored: new Set(['sess_home_old-helper']) }).homes.open('old-helper'),
    /not available/
  );
});

test('reopening a contact brings its thread back from the archive', async () => {
  const { homes, calls } = fakeHost({ stored: new Set(['sess_home_github-watcher']) });
  await homes.open('github-watcher');
  assert.deepEqual(calls.archived, [['sess_home_github-watcher', false]]);
});
