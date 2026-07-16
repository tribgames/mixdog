import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _normalizeSummaryIndex,
  _sessionSummary,
} from '../src/runtime/agent/orchestrator/session/store-summary-index.mjs';
import { createLifecycleApi, resolveResumeCwd } from '../src/session-runtime/lifecycle-api.mjs';
import { createCwdPlugins } from '../src/session-runtime/cwd-plugins.mjs';
import {
  normalizeDesktopSessionMetadata,
  resumeSession as resumeStoredSession,
} from '../src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs';
import {
  drainSessionStore,
  deleteSession,
  loadSession,
  listStoredSessionSummaries,
  markSessionClosed,
  saveSession,
  saveSessionAsync,
  setLiveSession,
} from '../src/runtime/agent/orchestrator/session/store.mjs';

test('desktop classification is optional and round-trips through the existing summary index', () => {
  const task = _sessionSummary({
    id: 'lead_task',
    owner: 'cli',
    agent: 'lead',
    cwd: '/app/workspace',
    desktopSession: { classification: 'task', projectPath: null },
  });
  const project = _normalizeSummaryIndex({
    rows: [{
      id: 'lead_project',
      cwd: '/project',
      desktopSession: { classification: 'project', projectPath: '/project' },
    }],
  }).rows[0];
  const legacy = _normalizeSummaryIndex({ rows: [{ id: 'legacy', cwd: '/old' }] }).rows[0];
  const malformed = _normalizeSummaryIndex({
    rows: [{ id: 'malformed', desktopSession: { classification: 'worker' } }],
  }).rows[0];

  assert.deepEqual(task.desktopSession, { classification: 'task', projectPath: null });
  assert.deepEqual(project.desktopSession, { classification: 'project', projectPath: '/project' });
  assert.equal(legacy.desktopSession, null);
  assert.equal(malformed.desktopSession, null);
});

test('authoritative summary refresh repairs a stale index and skips malformed session files', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-summary-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: 1,
      rows: [{
        id: 'desktop_old',
        updatedAt: 1,
        cwd: '/old',
        desktopSession: { classification: 'task', projectPath: null },
      }],
    }));
    writeFileSync(join(sessions, 'desktop_new.json'), JSON.stringify({
      id: 'desktop_new',
      owner: 'user',
      agent: 'lead',
      updatedAt: 20,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Newly persisted desktop task' }],
    }));
    writeFileSync(join(sessions, 'cli_only.json'), JSON.stringify({
      id: 'cli_only',
      owner: 'user',
      updatedAt: 10,
      cwd: '/cli',
      messages: [{ role: 'user', content: 'CLI only' }],
    }));
    writeFileSync(join(sessions, 'broken.json'), '{"id":');

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.deepEqual(rows.map((row) => row.id), ['desktop_new', 'cli_only']);
    assert.deepEqual(
      rows.find((row) => row.id === 'desktop_new').desktopSession,
      { classification: 'task', projectPath: null },
    );
    assert.equal(rows.find((row) => row.id === 'cli_only').desktopSession, null);
    const repaired = JSON.parse(readFileSync(join(root, 'session-summaries.json'), 'utf8'));
    assert.deepEqual(repaired.rows.map((row) => row.id), ['desktop_new', 'cli_only']);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('cached summaries reflect local lifecycle mutations and forced refresh reconciles disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-cache-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'indexed.json'), JSON.stringify({
      id: 'indexed', owner: 'user', updatedAt: 10, messages: [],
    }));
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: 1, rows: [{ id: 'indexed', owner: 'user', updatedAt: 10 }],
    }));

    assert.deepEqual(listStoredSessionSummaries().map((row) => row.id), ['indexed']);

    saveSession({
      id: 'cached_new', owner: 'user', updatedAt: 20,
      messages: [{ role: 'user', content: 'Cached local session' }],
    }, { sync: true });
    assert.deepEqual(
      listStoredSessionSummaries().map((row) => row.id),
      ['cached_new', 'indexed'],
    );

    await saveSessionAsync({
      id: 'cached_async', owner: 'user', updatedAt: 25,
      messages: [{ role: 'user', content: 'Cached async session' }],
    });
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'cached_async'), true);
    assert.equal(deleteSession('cached_async'), true);

    assert.notEqual(markSessionClosed('cached_new', 'test'), null);
    assert.equal(
      listStoredSessionSummaries().find((row) => row.id === 'cached_new').closed,
      true,
    );
    assert.equal(deleteSession('cached_new'), true);
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'cached_new'), false);

    writeFileSync(join(sessions, 'external.json'), JSON.stringify({
      id: 'external', owner: 'user', updatedAt: 30, messages: [],
    }));
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'external'), false);
    assert.deepEqual(
      listStoredSessionSummaries({ refreshFromStorage: true }).map((row) => row.id),
      ['external', 'indexed'],
    );
    unlinkSync(join(sessions, 'external.json'));
    assert.deepEqual(
      listStoredSessionSummaries({ refreshFromStorage: true }).map((row) => row.id),
      ['indexed'],
    );
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('authoritative refresh trusts disk over stale live state while preserving unsettled local writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-races-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'authoritative.json'), JSON.stringify({
      id: 'authoritative',
      owner: 'user',
      closed: true,
      status: 'closed',
      updatedAt: 40,
      desktopSession: { classification: 'project', projectPath: '/disk-project' },
      messages: [],
    }));
    setLiveSession({
      id: 'authoritative',
      owner: 'agent:stale',
      closed: false,
      updatedAt: 99,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [],
    });
    let rows = listStoredSessionSummaries({ refreshFromStorage: true });
    const authoritative = rows.find((row) => row.id === 'authoritative');
    assert.equal(authoritative.closed, true);
    assert.equal(authoritative.owner, 'user');
    assert.deepEqual(authoritative.desktopSession, { classification: 'project', projectPath: '/disk-project' });

    unlinkSync(join(sessions, 'authoritative.json'));
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'authoritative'),
      false,
    );

    saveSession({
      id: 'pending_desktop',
      owner: 'user',
      updatedAt: 50,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Visible before debounce flush' }],
    });
    assert.equal(existsSync(join(sessions, 'pending_desktop.json')), false);
    rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_desktop'), true);
    assert.equal(listStoredSessionSummaries().some((row) => row.id === 'pending_desktop'), true);
    assert.equal(deleteSession('pending_desktop'), false);
    await new Promise((resolve) => setTimeout(resolve, 225));
    assert.equal(existsSync(join(sessions, 'pending_desktop.json')), false);
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'pending_desktop'),
      false,
    );

    const first = saveSessionAsync({
      id: 'worker_deleted',
      owner: 'user',
      updatedAt: 60,
      messages: [{ role: 'user', content: 'First queued worker write' }],
    });
    const second = saveSessionAsync({
      id: 'worker_deleted',
      owner: 'user',
      updatedAt: 61,
      messages: [{ role: 'user', content: 'Latest queued worker write' }],
    });
    deleteSession('worker_deleted');
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(join(sessions, 'worker_deleted.json')), false);
    assert.equal(
      listStoredSessionSummaries({ refreshFromStorage: true }).some((row) => row.id === 'worker_deleted'),
      false,
    );
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

test('authoritative refresh rejects filename and embedded session id mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-identity-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'cli_transcript.json'), JSON.stringify({
      id: 'cli_transcript',
      owner: 'user',
      updatedAt: 10,
      messages: [{ role: 'user', content: 'Legitimate CLI transcript' }],
    }));
    // Without filename/id validation this duplicate row could lend desktop
    // metadata to cli_transcript, then resume the legitimate CLI-owned file.
    writeFileSync(join(sessions, 'desktop_spoof.json'), JSON.stringify({
      id: 'cli_transcript',
      owner: 'user',
      updatedAt: 30,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Spoofed desktop authorization' }],
    }));
    writeFileSync(join(sessions, 'desktop_good.json'), JSON.stringify({
      id: 'desktop_good',
      owner: 'user',
      updatedAt: 20,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Legitimate desktop task' }],
    }));
    writeFileSync(join(sessions, 'duplicate_copy.json'), JSON.stringify({
      id: 'desktop_good',
      owner: 'user',
      updatedAt: 40,
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Mismatched duplicate' }],
    }));

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.deepEqual(rows.map((row) => row.id), ['desktop_good', 'cli_transcript']);
    assert.equal(rows.find((row) => row.id === 'desktop_good').preview, 'Legitimate desktop task');
    assert.equal(rows.find((row) => row.id === 'cli_transcript').desktopSession, null);
    assert.equal(loadSession('cli_transcript').messages[0].content, 'Legitimate CLI transcript');
    assert.equal(loadSession('desktop_spoof'), null);
    assert.equal(loadSession('duplicate_copy'), null);
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative refresh fails closed when the session directory is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-unreadable-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
      version: 1,
      rows: [{
        id: 'stale_desktop',
        updatedAt: 1,
        desktopSession: { classification: 'task', projectPath: null },
      }],
    }));
    // A non-directory at the authoritative storage path deterministically
    // exercises readdir failure on Windows and POSIX.
    writeFileSync(join(root, 'sessions'), 'not a directory');

    assert.deepEqual(listStoredSessionSummaries({ refreshFromStorage: true }), []);
    assert.deepEqual(
      listStoredSessionSummaries({ rebuildIfMissing: false }).map((row) => row.id),
      ['stale_desktop'],
    );
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative refresh includes a desktop session still in the debounce window', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-pending-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    saveSession({
      id: 'desktop_pending',
      owner: 'user',
      agent: 'lead',
      updatedAt: 50,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Immediate desktop task' }],
    });

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'desktop_pending'), true);
    assert.equal(rows.find((row) => row.id === 'desktop_pending').preview, 'Immediate desktop task');
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid existing disk identities block same-id pending and live state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-live-blocked-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'pending_mismatch.json'), JSON.stringify({
      id: 'different_transcript',
      owner: 'user',
      messages: [{ role: 'user', content: 'Mismatched disk transcript' }],
    }));
    writeFileSync(join(sessions, 'pending_malformed.json'), '{"id":');

    for (const id of ['pending_mismatch', 'pending_malformed']) {
      saveSession({
        id,
        owner: 'user',
        agent: 'lead',
        updatedAt: 60,
        cwd: '/app/workspace',
        desktopSession: { classification: 'task', projectPath: null },
        messages: [{ role: 'user', content: `Pending replacement ${id}` }],
      });
    }

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_mismatch'), false);
    assert.equal(rows.some((row) => row.id === 'pending_malformed'), false);
    assert.equal(loadSession('pending_mismatch'), null);
    assert.equal(loadSession('pending_malformed'), null);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFileSync failure blocks same-id pending and live state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-read-error-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const readErrorPath = join(root, 'sessions', 'pending_read_error.json');
  try {
    mkdirSync(join(root, 'sessions'), { recursive: true });
    // A directory with a .json storage name is visible to readdirSync and
    // existsSync, but readFileSync itself fails on supported desktop platforms.
    // This deterministically exercises the I/O catch before JSON.parse.
    mkdirSync(readErrorPath);
    saveSession({
      id: 'pending_read_error',
      owner: 'user',
      agent: 'lead',
      updatedAt: 70,
      cwd: '/app/workspace',
      desktopSession: { classification: 'task', projectPath: null },
      messages: [{ role: 'user', content: 'Pending replacement after read error' }],
    });

    const rows = listStoredSessionSummaries({ refreshFromStorage: true });
    assert.equal(rows.some((row) => row.id === 'pending_read_error'), false);
    assert.equal(loadSession('pending_read_error'), null);
  } finally {
    // Remove the deliberate directory collision so draining the pending test
    // save can complete without changing production failure behavior.
    rmSync(readErrorPath, { recursive: true, force: true });
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('session creation accepts only explicit desktop classification metadata', () => {
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'task', projectPath: '/ignored' }, '/cwd'),
    { classification: 'task', projectPath: null },
  );
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'project' }, '/project'),
    { classification: 'project', projectPath: '/project' },
  );
  assert.deepEqual(
    normalizeDesktopSessionMetadata({ classification: 'project', projectPath: '  /project/trimmed  ' }, '/fallback'),
    { classification: 'project', projectPath: '/project/trimmed' },
  );
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project', projectPath: {} }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project', projectPath: '\0bad' }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'project' }, null), null);
  assert.equal(normalizeDesktopSessionMetadata({ classification: 'worker' }, '/cwd'), null);
  assert.equal(normalizeDesktopSessionMetadata({}, '/cwd'), null);
  assert.equal(normalizeDesktopSessionMetadata(null, '/cwd'), null);
});

test('desktop resume pins projects and unclassified tasks to their host-managed scope', () => {
  assert.equal(resolveResumeCwd({
    cwd: '/stale',
    desktopSession: { classification: 'project', projectPath: '/project' },
  }, '/app/workspace'), '/project');
  assert.equal(resolveResumeCwd({
    cwd: '/transient',
    desktopSession: { classification: 'task', projectPath: null },
  }, '/app/workspace'), '/app/workspace');
  assert.equal(resolveResumeCwd({ cwd: '/cli' }, '/current'), '/cli');
});

test('runtime resume returns the persisted transcript and restores desktop task scope', async () => {
  let current = null;
  let cwd = '/app/workspace';
  let route = { provider: 'test', model: 'model' };
  const messages = [
    { role: 'user', content: 'Persisted question' },
    { role: 'assistant', content: 'Persisted answer' },
  ];
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getRoute: () => route,
    setRoute: (value) => { route = value; },
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => cwd,
    desktopSession: { classification: 'task', projectPath: null },
    setSessionNeedsCwdRefresh: () => {},
    mgr: {
      resumeSession: async (id, _preset, options) => {
        assert.deepEqual(options, {
          desktopSession: { classification: 'task', projectPath: null },
        });
        return {
          id,
          provider: 'test',
          model: 'model',
          cwd: '/stale-task-cwd',
          desktopSession: { classification: 'task', projectPath: null },
          messages,
        };
      },
    },
    statusRoutes: {},
    createCurrentSession: async () => {},
    refreshRouteEffort: async () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    applyResolvedCwd: (value) => { cwd = value; },
    resolveRoute: (_config, value) => value,
    applyDeferredToolSurface: () => {},
    standaloneTools: [],
  });

  const resumed = await runtime.resume('desktop_task');
  assert.deepEqual(resumed.messages, messages);
  assert.equal(resumed.cwd, '/app/workspace');
  assert.equal(current.cwd, '/app/workspace');
});

test('desktop context switches retain runtime resources while durably closing the old session', async () => {
  let current = {
    id: 'old',
    messages: [{ role: 'user', content: 'keep me' }],
    liveTurnMessages: [],
  };
  let cwd = '/old';
  let desktopSession = { classification: 'task', projectPath: null };
  const closed = [];
  const cleanup = [];
  let releaseMcp;
  const mcpReset = new Promise((resolve) => { releaseMcp = resolve; });
  const runtime = createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getDesktopSession: () => desktopSession,
    setDesktopSession: (value) => { desktopSession = value; },
    getCurrentCwd: () => cwd,
    mgr: { closeSession: (...args) => { closed.push(args); return true; } },
    cancelBackgroundTasks: (options) => cleanup.push(['background', options]),
    agentTool: { closeAll: (reason) => cleanup.push(['agents', reason]) },
    statusRoutes: { clearGatewaySessionRoute: (id) => cleanup.push(['route', id]) },
    applyResolvedCwd: async (value, options) => {
      cleanup.push(['cwd:start', value, options]);
      await mcpReset;
      cwd = value;
      cleanup.push(['cwd:ready', value]);
    },
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
  });

  let settled = false;
  const switching = runtime.switchContext({
    cwd: '/project',
    desktopSession: { classification: 'project', projectPath: '/project' },
  });
  switching.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(cleanup.slice(0, 4), [
    ['background', {
      reason: 'desktop-context-switch',
      notify: false,
      callerSessionId: 'old',
    }],
    ['agents', 'desktop-context-switch'],
    ['route', 'old'],
    ['cwd:start', '/project', { markRefresh: false, waitForMcpReset: true }],
  ]);
  releaseMcp();
  await switching;

  assert.deepEqual(closed, [['old', 'desktop-context-switch', { tombstone: false }]]);
  assert.equal(current, null);
  assert.equal(cwd, '/project');
  assert.deepEqual(desktopSession, { classification: 'project', projectPath: '/project' });
});

test('desktop cwd application awaits project MCP reset before becoming ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-mcp-order-'));
  const oldCwd = join(root, 'old');
  const nextCwd = join(root, 'next');
  mkdirSync(oldCwd);
  mkdirSync(nextCwd);
  let currentCwd = oldCwd;
  let projectKey = '';
  let releaseReset;
  const resetGate = new Promise((resolve) => { releaseReset = resolve; });
  const events = [];
  const cwdPlugins = createCwdPlugins({
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (value) => { currentCwd = value; },
    getSession: () => null,
    getLastProjectMcpKey: () => projectKey,
    setLastProjectMcpKey: (value) => { projectKey = value; },
    isCodeGraphPrewarmLazy: () => true,
    isCodeGraphFirstTurnPrewarmDone: () => false,
    getCodeGraphPrewarmDelayMs: () => 0,
    connectConfiguredMcp: async (options) => {
      events.push(['reset:start', options]);
      await resetGate;
      events.push(['reset:done']);
    },
    invalidatePreSessionToolSurface: () => events.push(['surface:invalidated']),
    scheduleCodeGraphPrewarm: () => {},
    hooks: { dispatch: () => {} },
    hookCommonPayload: (value) => value,
    bootProfile: () => {},
    readProjectMcpServers: () => ({}),
    writeLastSessionCwd: () => {},
    clean: (value) => String(value || '').trim(),
    resolve,
    statSync,
  });
  try {
    let ready = false;
    const applying = cwdPlugins.applyResolvedCwd(nextCwd, { waitForMcpReset: true });
    applying.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    assert.deepEqual(events, [['reset:start', { reset: true }]]);
    releaseReset();
    assert.equal(await applying, resolve(nextCwd));
    assert.deepEqual(events, [
      ['reset:start', { reset: true }],
      ['reset:done'],
      ['surface:invalidated'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production runtime composition supplies mutable desktop session bindings', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url)),
    'utf8',
  );
  const composition = source.slice(
    source.indexOf('const lifecycleApi = createLifecycleApi({'),
    source.indexOf('const resourceApi = createResourceApi({'),
  );
  assert.match(composition, /getDesktopSession:\s*\(\)\s*=>\s*desktopSession/);
  assert.match(composition, /setDesktopSession:\s*\(v\)\s*=>\s*\{\s*desktopSession = v;\s*\}/);
});

test('summary metadata rejects non-string project paths instead of leaking objects', () => {
  const withoutFallback = _sessionSummary({
    id: 'bad_project_path',
    desktopSession: { classification: 'project', projectPath: { untrusted: true } },
  });
  const withFallback = _normalizeSummaryIndex({
    rows: [{
      id: 'legacy_project_path',
      cwd: '  /legacy/project  ',
      desktopSession: { classification: 'project', projectPath: null },
    }],
  }).rows[0];

  assert.equal(withoutFallback.desktopSession, null);
  assert.deepEqual(withFallback.desktopSession, {
    classification: 'project',
    projectPath: '/legacy/project',
  });
});

test('desktop-guarded resume refuses legacy/cross-class rows while the historical path still accepts legacy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-resume-guard-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const project = {
      id: 'desktop_project_guard',
      cwd: '/project',
      desktopSession: { classification: 'project', projectPath: '/project' },
      messages: [{ role: 'user', content: 'Project transcript' }],
      tools: [],
    };
    const legacy = {
      id: 'legacy_cli_guard',
      cwd: '/cli',
      messages: [{ role: 'user', content: 'CLI transcript' }],
      tools: [],
    };
    writeFileSync(join(sessions, `${project.id}.json`), JSON.stringify(project));
    writeFileSync(join(sessions, `${legacy.id}.json`), JSON.stringify(legacy));

    const expectedTask = { desktopSession: { classification: 'task', projectPath: null } };
    assert.equal(await resumeStoredSession(project.id, 'full', expectedTask), null);
    assert.equal(await resumeStoredSession(legacy.id, 'full', expectedTask), null);
    assert.deepEqual(JSON.parse(readFileSync(join(sessions, `${project.id}.json`), 'utf8')), project);
    assert.deepEqual(JSON.parse(readFileSync(join(sessions, `${legacy.id}.json`), 'utf8')), legacy);
    const resumedLegacy = await resumeStoredSession(legacy.id, 'full');
    assert.equal(resumedLegacy.id, legacy.id);
    assert.equal(resumedLegacy.desktopSession, undefined);
  } finally {
    drainSessionStore();
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    } catch {
      // The save worker acknowledges the session write before its best-effort
      // summary-index flush has fully released Windows filesystem handles.
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }
});
