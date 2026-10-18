import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const forgotten = [];
mock.module('../../runtime/session-search/session-search-ingest.mjs', {
  namedExports: {
    forgetSessionSearch: async (id) => {
      forgotten.push(id);
    },
  },
});
const { createSessionSwitching } = await import('./session-switch.mjs');
const { getStoreDir } = await import('../../runtime/agent/orchestrator/session/store/session-paths.mjs');

// Deletion reads session files from the store dir: keep the catalog lookups
// inside a scratch data dir.
const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-session-switch-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const leadRow = (id, messages = [{ role: 'user', content: 'hi' }]) => ({
  id,
  owner: 'cli',
  sourceType: 'lead',
  messages,
});

function fixture({ current = null, rows = [] } = {}) {
  // Deletion reads only the session's own file: persist exactly these rows.
  const storeDir = getStoreDir();
  for (const file of readdirSync(storeDir)) rmSync(join(storeDir, file), { force: true });
  for (const row of rows) writeFileSync(join(storeDir, `${row.id}.json`), JSON.stringify(row));
  const calls = [];
  const cleaned = [];
  const state = {
    session: current,
    route: { provider: 'p', model: 'm', effort: 'low' },
    desktop: null,
    cwd: 'C:\\one',
  };
  const mgr = {
    listSessions: () => rows,
    listOwnedAgentSessionIds: (id) => (id === 'parent' ? ['child-a', 'child-a', 'parent', 'bad id!', ' child-b '] : []),
    deleteSession: (id) => {
      calls.push(['delete', id]);
      return true;
    },
    closeSession: (id, reason, opts) => {
      calls.push(['close', id, reason, opts]);
      return true;
    },
    prefetchSession: (id) => {
      calls.push(['prefetch', id]);
      return true;
    },
  };
  const api = createSessionSwitching(
    {
      getSession: () => state.session,
      setSession: (session) => {
        state.session = session;
      },
      getRoute: () => state.route,
      setRoute: (route) => {
        state.route = route;
        calls.push(['setRoute', route]);
      },
      getConfig: () => ({}),
      getMode: () => 'full',
      getCurrentCwd: () => state.cwd,
      getMcpScopeId: () => null,
      getDesktopSession: () => state.desktop,
      setDesktopSession: (desktop) => {
        state.desktop = desktop;
      },
      mgr,
      statusRoutes: { clearGatewaySessionRoute: (id) => calls.push(['clearRoute', id]) },
      agentTool: { closeAll: (reason, opts) => calls.push(['closeAll', reason, opts]) },
      createCurrentSession: async () => {
        calls.push(['create']);
        state.session = { id: 'fresh', messages: [] };
        return state.session;
      },
      refreshRouteEffort: async () => calls.push(['refreshEffort']),
      invalidateContextStatusCache: () => calls.push(['invalidateContext']),
      invalidatePreSessionToolSurface: () => calls.push(['invalidateTools']),
      applyResolvedCwd: async (cwd) => {
        calls.push(['cwd', cwd]);
        state.cwd = cwd;
      },
      resolveRoute: (_config, next) => ({ provider: 'lead-p', model: 'lead-m', ...next }),
      applyDeferredToolSurface: () => {},
      getStandaloneTools: () => [],
      clearRoutePreparation: () => calls.push(['clearPrep']),
      cleanupDeletedSessionWorktree: async (id) => cleaned.push([id, state.session?.id ?? null, state.cwd]),
    },
    {
      ingestSessionIntoMemory: async (session) => calls.push(['ingest', session.id]),
      closeSurfaceSession: (session, reason, opts) => calls.push(['closeSurface', session.id, reason, opts]),
      cancelBackgroundTasks: (opts) => calls.push(['cancelTasks', opts]),
    }
  );
  return { api, calls, state, cleaned };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a deleted session hands its worktree to the autoCleanup policy; a bound current one leaves it first', async () => {
  const other = fixture({ current: { id: 'other' }, rows: [leadRow('parent')] });
  assert.equal(await other.api.deleteSession('parent'), true);
  await settled();
  assert.deepEqual(other.cleaned, [['parent', 'other', 'C:\\one']]);

  const bound = {
    id: 'parent',
    messages: [{ role: 'user', content: 'hi' }],
    workspace: {
      projectPath: 'C:\\project',
      repoCommonDir: 'C:\\project\\.git',
      cwd: 'C:\\worktrees\\fix',
      worktreeId: 'fix',
      branch: 'mixdog/fix',
      baseCommit: null,
      mergeTarget: 'main',
      revision: 2,
      transition: { state: 'idle', txId: null },
    },
  };
  const current = fixture({ current: bound, rows: [leadRow('parent')] });
  current.state.cwd = 'C:\\worktrees\\fix';
  assert.equal(await current.api.deleteSession('parent'), true);
  await settled();
  const order = current.calls.map((call) => call[0]);
  assert.ok(order.indexOf('cwd') < order.indexOf('create'), 'the replacement starts in the project folder');
  assert.deepEqual(
    current.calls.find((call) => call[0] === 'cwd'),
    ['cwd', 'C:\\project']
  );
  // Cleanup runs once the replacement exists and nothing runs in the worktree.
  assert.deepEqual(current.cleaned, [['parent', 'fresh', 'C:\\project']]);
  forgotten.length = 0;
});

test('deleteSession refuses malformed or unlisted ids without touching the store', async () => {
  const { api, calls } = fixture({ rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('bad id!'), false);
  assert.equal(await api.deleteSession('unknown'), false);
  assert.deepEqual(calls, []);
});

test('an agent session is listed and can be deleted directly like an ordinary session', async () => {
  const child = {
    ...leadRow('child'),
    owner: 'agent',
    agent: 'worker',
    sourceType: 'agent',
    visibility: 'agent-only',
    parentSessionId: 'parent',
  };
  const { api, calls } = fixture({ current: { id: 'other' }, rows: [child] });
  assert.equal(api.listSessions()[0].id, 'child');
  assert.equal(await api.deleteSession('child'), true);
  assert.deepEqual(
    calls.filter(([name]) => name === 'delete'),
    [['delete', 'child']]
  );
  assert.equal(
    calls.some(([name]) => name === 'closeAll'),
    false
  );
  forgotten.length = 0;
});

test('deleting a session that is not current leaves linked child sessions untouched', async () => {
  const { api, calls } = fixture({ current: { id: 'other' }, rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('parent'), true);
  assert.deepEqual(calls, [
    ['close', 'parent', 'desktop-session-delete', { tombstone: false }],
    ['cancelTasks', { reason: 'desktop-session-delete', notify: false, executionSessionId: 'parent' }],
    ['clearRoute', 'parent'],
    ['delete', 'parent'],
  ]);
  assert.deepEqual(forgotten, ['parent']);
});

test('deleting the current session tombstones only that session and recreates', async () => {
  const current = { id: 'parent', messages: [{ role: 'user', content: 'hi' }] };
  const { api, calls, state } = fixture({ current, rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('parent'), true);
  assert.deepEqual(calls, [
    ['cancelTasks', { reason: 'desktop-session-delete', notify: false, executionSessionId: 'parent' }],
    ['clearRoute', 'parent'],
    ['close', 'parent', 'desktop-session-delete', { tombstone: true }],
    ['invalidateContext'],
    ['invalidateTools'],
    ['create'],
  ]);
  assert.equal(state.session.id, 'fresh');
});

test('switchContext closes the open session, retargets cwd and returns to the configured lead route', async () => {
  const current = { id: 'scratch', messages: [] };
  const { api, calls, state } = fixture({ current });
  assert.equal(await api.switchContext({ cwd: 'C:\\two', desktopSession: { classification: 'project' } }), true);
  assert.deepEqual(calls, [
    ['clearPrep'],
    ['closeSurface', 'scratch', 'desktop-context-switch', { tombstone: true }],
    ['ingest', 'scratch'],
    ['cancelTasks', { reason: 'desktop-context-switch', notify: false, executionSessionId: 'scratch' }],
    ['clearRoute', 'scratch'],
    ['cwd', 'C:\\two'],
    ['setRoute', { provider: 'lead-p', model: 'lead-m' }],
    ['refreshEffort'],
    ['invalidateContext'],
    ['invalidateTools'],
  ]);
  assert.equal(state.session, null);
  assert.deepEqual(state.desktop, { classification: 'project' });
});

test('switchContext for a resume keeps the route the resumed session will install', async () => {
  const { api, calls, state } = fixture({ current: { id: 'talked', messages: [{ role: 'user', content: 'x' }] } });
  await api.switchContext({ cwd: 'C:\\two', desktopSession: 'not-an-object', forResume: true });
  assert.ok(!calls.some(([name]) => name === 'setRoute' || name === 'refreshEffort'));
  assert.deepEqual(
    calls.find(([name]) => name === 'closeSurface'),
    ['closeSurface', 'talked', 'desktop-context-switch', { tombstone: false }]
  );
  assert.equal(state.desktop, null);
});

test('newSession ingests and closes the open conversation, then returns the fresh id', async () => {
  const { api, calls } = fixture({ current: { id: 'talked', messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(await api.newSession(), 'fresh');
  assert.deepEqual(calls, [
    ['closeSurface', 'talked', 'cli-new', { tombstone: false }],
    ['ingest', 'talked'],
    ['invalidateContext'],
    ['create'],
  ]);
});

test('prefetchSession and sessionStoreDir delegate to the manager and store', () => {
  const { api, calls } = fixture();
  assert.equal(api.prefetchSession('warm'), true);
  assert.deepEqual(calls, [['prefetch', 'warm']]);
  assert.equal(typeof api.sessionStoreDir(), 'string');
});
