// `session list`: sub-agent (agent-only) and archived sessions are left out
// unless asked for, and paging stays full and gap-free however many rows a
// page has to skip.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionControl } from './daemon-session-control.mjs';
import { SCAN_ROWS } from '../session-runtime/bot-status.mjs';
import { registerSessionSidebarHost } from '../runtime/shared/session-sidebar-host.mjs';
import {
  byActivityThenId,
  decodeCatalogCursor,
  encodeCatalogCursor,
  isAfterCursor,
} from '../runtime/agent/orchestrator/session/catalog-db/schema.mjs';

const CONTEXT = { callerSessionId: 'caller', callerScope: { kind: 'human' } };

// Newest first: 7 ordinary, 2 archived, more sub-agents than one scan used to
// read (SCAN_ROWS), 5 ordinary, 1 archived, 1 home chat of bot "mailer".
function rows() {
  const list = [];
  const add = (id, extra = {}) => list.push({ id, lastUsedAt: 1_000_000 - list.length, ...extra });
  for (let i = 0; i < 7; i++) add(`sess_o${i}`);
  add('sess_arch0');
  add('sess_arch1');
  for (let i = 0; i < SCAN_ROWS + 100; i++) {
    add(`sess_sub${i}`, { owner: 'agent', agent: 'worker', ownerSessionId: 'sess_o0', visibility: 'agent-only' });
  }
  for (let i = 7; i < 12; i++) add(`sess_o${i}`);
  add('sess_arch2');
  add('sess_home_mailer');
  return list;
}
const ARCHIVED = { sess_arch0: 1, sess_arch1: 2, sess_arch2: 3 };
const ORDINARY = [...Array.from({ length: 12 }, (_, i) => `sess_o${i}`), 'sess_home_mailer'];

function catalogService(list = rows()) {
  const sorted = [...list].sort(byActivityThenId);
  return {
    listSessionCatalog: async ({ page }) => {
      const after = decodeCatalogCursor(page.cursor);
      const rest = sorted.filter((row) => isAfterCursor(row, after));
      const sessions = rest.slice(0, page.limit);
      return { sessions, nextCursor: rest.length > page.limit ? encodeCatalogCursor(sessions.at(-1)) : null };
    },
  };
}

function withDesktop(t, archived = ARCHIVED) {
  const unregister = registerSessionSidebarHost(async () => {}, { state: () => ({ archived }) });
  t.after(unregister);
}

async function pages(execute, args, context = CONTEXT) {
  const seen = [];
  let cursor = null;
  do {
    const page = await execute({ action: 'list', ...args, ...(cursor ? { cursor } : {}) }, context);
    seen.push(page.sessions);
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

test('list leaves out sub-agent and archived sessions with full pages across long filtered runs', async (t) => {
  withDesktop(t);
  const execute = createSessionControl({ getSessionService: () => catalogService() });
  const seen = await pages(execute, { limit: 5 });
  assert.deepEqual(
    seen.map((page) => page.length),
    [5, 5, 3],
    'no short page while more rows match'
  );
  assert.deepEqual(
    seen.flat().map((row) => row.id),
    ORDINARY
  );
  assert.equal(
    seen.flat().some((row) => row.archived),
    false
  );
});

test('a catalog of hidden rows stops at the scan cap with a cursor to continue from', async (t) => {
  withDesktop(t);
  const list = [];
  const add = (id, extra = {}) => list.push({ id, lastUsedAt: 10_000_000 - list.length, ...extra });
  for (let i = 0; i < 10_500; i++) add(`sess_hidden${i}`, { owner: 'agent', visibility: 'agent-only' });
  add('sess_visible');
  let scanned = 0;
  const service = catalogService(list);
  const counting = {
    listSessionCatalog: async (request) => {
      const page = await service.listSessionCatalog(request);
      scanned += page.sessions.length;
      return page;
    },
  };
  const execute = createSessionControl({ getSessionService: () => counting });
  const first = await execute({ action: 'list', limit: 5 }, CONTEXT);
  assert.deepEqual(first.sessions, []);
  assert.equal(typeof first.nextCursor, 'string');
  assert.ok(scanned >= 10_000 && scanned < 10_500, `scanned ${scanned}`);
  const second = await execute({ action: 'list', limit: 5, cursor: first.nextCursor }, CONTEXT);
  assert.deepEqual(
    second.sessions.map((row) => row.id),
    ['sess_visible']
  );
  assert.equal(second.nextCursor, null);
});

test('include_agents and include_archived bring the left-out rows back, archived ones marked', async (t) => {
  withDesktop(t);
  const execute = createSessionControl({ getSessionService: () => catalogService() });
  const archived = (await pages(execute, { limit: 100, include_archived: true })).flat();
  assert.deepEqual(
    archived.filter((row) => row.archived).map((row) => row.id),
    ['sess_arch0', 'sess_arch1', 'sess_arch2']
  );
  assert.equal(archived.length, ORDINARY.length + 3);
  assert.equal(
    archived.some((row) => row.id.startsWith('sess_sub')),
    false
  );

  const agents = (await execute({ action: 'list', limit: 20, include_agents: true }, CONTEXT)).sessions;
  assert.deepEqual(
    agents.slice(0, 9).map((row) => row.id),
    ['sess_o0', 'sess_o1', 'sess_o2', 'sess_o3', 'sess_o4', 'sess_o5', 'sess_o6', 'sess_sub0', 'sess_sub1']
  );

  const everything = (await pages(execute, { limit: 100, include_agents: true, include_archived: true })).flat();
  assert.equal(everything.length, rows().length);
  assert.equal(new Set(everything.map((row) => row.id)).size, everything.length, 'no row twice');
});

/** A list over `list` whose live sessions are `live`, each row read by id. */
function liveControl(list, live) {
  const byId = new Map(list.map((row) => [row.id, row]));
  return createSessionControl({
    getSessionService: () => catalogService(list),
    liveWork: async () => live,
    readRow: async (id) => byId.get(id) ?? null,
  });
}

test('a live session past any catalog scan cap still leads the first page', async (t) => {
  withDesktop(t);
  const list = [];
  for (let i = 0; i < 10_002; i++) list.push({ id: `sess_row${i}`, lastUsedAt: 100_000 - i, status: 'idle' });
  const execute = liveControl(list, { own: new Map([['sess_row10001', 500_000]]), agents: new Set() });
  const page = await execute({ action: 'list', limit: 1 }, CONTEXT);
  assert.deepEqual(page.sessions, [
    { id: 'sess_row10001', status: 'running', lastUsedAt: new Date(500_000).toISOString(), working: true },
  ]);
});

test('more live sessions than limit: the newest work leads, filtered like the list', async (t) => {
  withDesktop(t);
  const list = rows();
  const own = new Map([
    ['sess_o3', 10],
    ['sess_sub5', 3_000_000],
    ['sess_o9', 2_000_000],
    ['sess_arch1', 4_000_000],
    ['sess_gone', 5_000_000],
  ]);
  const execute = liveControl(list, { own, agents: new Set() });
  const page = (await execute({ action: 'list', limit: 2 }, CONTEXT)).sessions;
  // The archived and sub-agent rows are left out as the list leaves them out;
  // a live id with no listed session has no row.
  assert.deepEqual(
    page.map((row) => row.id),
    ['sess_o9', 'sess_o3']
  );
  const withAgents = (await execute({ action: 'list', limit: 2, include_agents: true }, CONTEXT)).sessions;
  assert.deepEqual(
    withAgents.map((row) => row.id),
    ['sess_sub5', 'sess_o9']
  );
});

test('live work leads the first page and reads running for every caller, and paging still reaches every row', async (t) => {
  withDesktop(t);
  // An agent deep in the catalog (its last settled activity is its first
  // prompt) still running per the pool, and a Lead whose agent works for it.
  const live = { own: new Map([['sess_sub2000', 2_000_000]]), agents: new Set(['sess_o11']) };
  const execute = liveControl(rows(), live);
  const human = (await execute({ action: 'list', limit: 5, include_agents: true }, CONTEXT)).sessions;
  assert.deepEqual(
    human.map((row) => row.id),
    ['sess_sub2000', 'sess_o11', 'sess_o0', 'sess_o1', 'sess_o2']
  );
  assert.deepEqual(
    [human[0].status, human[0].working, human[0].lastUsedAt],
    ['running', true, new Date(2_000_000).toISOString()]
  );
  assert.deepEqual([human[1].status, human[1].working], [undefined, true], 'its agents work; its own turn does not');
  assert.equal(human[2].working, undefined);

  const bot = { callerSessionId: 'caller', callerScope: { kind: 'agent', agentId: 'mailer' } };
  const asBot = (await execute({ action: 'list', limit: 5, include_agents: true }, bot)).sessions;
  assert.deepEqual(asBot[0], { id: 'sess_sub2000', status: 'running', working: true }, 'not only for its own rows');

  const walked = (await pages(execute, { limit: 5, include_agents: true, include_archived: true })).flat();
  assert.equal(new Set(walked.map((row) => row.id)).size, rows().length, 'no row skipped');

  // A first page of live rows only continues at the top of the catalog order.
  const first = await execute({ action: 'list', limit: 1, include_agents: true }, CONTEXT);
  assert.deepEqual(
    first.sessions.map((row) => row.id),
    ['sess_sub2000']
  );
  const second = await execute({ action: 'list', limit: 1, include_agents: true, cursor: first.nextCursor }, CONTEXT);
  assert.deepEqual(
    second.sessions.map((row) => row.id),
    ['sess_o0']
  );
});

test("a bot's list selects the same rows as the human's, by the same filters", async (t) => {
  withDesktop(t);
  const execute = createSessionControl({ getSessionService: () => catalogService() });
  const bot = { callerSessionId: 'caller', callerScope: { kind: 'agent', agentId: 'mailer' } };
  for (const args of [{}, { include_archived: true }, { include_agents: true, include_archived: true }]) {
    const ids = async (context) => (await pages(execute, { limit: 100, ...args }, context)).flat().map((row) => row.id);
    assert.deepEqual(await ids(bot), await ids(CONTEXT), JSON.stringify(args));
  }
  const own = (await execute({ action: 'list', limit: 100 }, bot)).sessions;
  assert.deepEqual(
    own.filter((row) => row.bot).map((row) => row.id),
    ['sess_home_mailer']
  );
  assert.equal(
    own.some((row) => row.archived),
    false
  );
});

test('without a desktop nothing reads as archived; flags must be booleans', async () => {
  const execute = createSessionControl({ getSessionService: () => catalogService() });
  const listed = (await pages(execute, { limit: 100 })).flat();
  assert.equal(listed.length, ORDINARY.length + 3);
  assert.equal(
    listed.some((row) => row.archived),
    false
  );
  await assert.rejects(execute({ action: 'list', include_agents: 'yes' }, CONTEXT), /include_agents must be a boolean/);
  await assert.rejects(execute({ action: 'list', include_archived: 1 }, CONTEXT), /include_archived must be a boolean/);
});
