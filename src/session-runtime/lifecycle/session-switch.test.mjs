import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionSwitching } from './session-switch.mjs';

// listLeadSessions reads heartbeat sidecars from the store dir: keep the
// catalog lookups inside a scratch data dir.
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
  const calls = [];
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
    },
    {
      ingestSessionIntoMemory: async (session) => calls.push(['ingest', session.id]),
      closeSurfaceSession: (session, reason, opts) => calls.push(['closeSurface', session.id, reason, opts]),
      cancelBackgroundTasks: (opts) => calls.push(['cancelTasks', opts]),
    }
  );
  return { api, calls, state };
}

test('deleteSession refuses malformed or unlisted ids without touching the store', async () => {
  const { api, calls } = fixture({ rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('bad id!'), false);
  assert.equal(await api.deleteSession('unknown'), false);
  assert.deepEqual(calls, []);
});

test('deleting a session that is not current unlinks it and every valid linked child once', async () => {
  const { api, calls } = fixture({ current: { id: 'other' }, rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('parent'), true);
  assert.deepEqual(calls, [
    ['delete', 'parent'],
    ['delete', 'child-a'],
    ['delete', 'child-b'],
  ]);
});

test('deleting the current session releases its work, tombstones parent and children, and recreates', async () => {
  const current = { id: 'parent', messages: [{ role: 'user', content: 'hi' }] };
  const { api, calls, state } = fixture({ current, rows: [leadRow('parent')] });
  assert.equal(await api.deleteSession('parent'), true);
  assert.deepEqual(calls, [
    ['cancelTasks', { reason: 'desktop-session-delete', notify: false, callerSessionId: 'parent' }],
    ['closeAll', 'desktop-session-delete', { callerSessionId: 'parent' }],
    ['clearRoute', 'parent'],
    ['close', 'parent', 'desktop-session-delete', { tombstone: true }],
    ['close', 'child-a', 'desktop-session-delete', { tombstone: true }],
    ['close', 'child-b', 'desktop-session-delete', { tombstone: true }],
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
    ['ingest', 'scratch'],
    ['cancelTasks', { reason: 'desktop-context-switch', notify: false, callerSessionId: 'scratch' }],
    ['closeAll', 'desktop-context-switch', { callerSessionId: 'scratch' }],
    ['clearRoute', 'scratch'],
    ['closeSurface', 'scratch', 'desktop-context-switch', { tombstone: true }],
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
    ['ingest', 'talked'],
    ['closeSurface', 'talked', 'cli-new', { tombstone: false }],
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
