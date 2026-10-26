// Deleting a session reads only the files it must prove ownership of, never the
// whole store, and leaves nothing a still-running turn could write back.
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import {
  cancelBackgroundTasks,
  cleanupBackgroundTasks,
  completeBackgroundTask,
  registerBackgroundTask,
} from '../../../runtime/shared/background-tasks.mjs';

const searchIngest = await import('../../../runtime/session-search/session-search-ingest.mjs');
mock.module('../../../runtime/session-search/session-search-ingest.mjs', {
  namedExports: { ...searchIngest, forgetSessionSearch: async () => {} },
});

const { createSessionSwitching } = await import('../session-switch.mjs');
const mgr = await import('../../../runtime/agent/orchestrator/session/manager.mjs');
const { saveSession, saveSessionAsync } = await import('../../../runtime/agent/orchestrator/session/store.mjs');
const { _sessionSummary, _writeSummaryIndex, settleSummaryIndexWrites } = await import(
  '../../../runtime/agent/orchestrator/session/store-summary-index.mjs'
);
const { createLeadWorkerIndex } = await import('../../services/agent-tool/lead-worker-index.mjs');
const { createCloseFlow } = await import('../../services/agent-tool/close-flow.mjs');

const roots = [];
const previousDataDir = process.env.MIXDOG_DATA_DIR;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function isolateDataDir() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-delete-'));
  roots.push(root);
  mkdirSync(join(root, 'sessions'));
  process.env.MIXDOG_DATA_DIR = root;
  return root;
}

const fileOf = (root, id) => join(root, 'sessions', `${id}.json`);
const lead = (id) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  updatedAt: 10,
  messages: [{ role: 'user', content: `hello ${id}` }],
});
const child = (id, ownerId) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  closed: false,
  generation: 0,
  updatedAt: 5,
  ownerSessionId: ownerId,
  parentSessionId: ownerId,
  messages: [{ role: 'user', content: 'task' }],
});

/** Persist records and a summary index describing `indexed` (which may claim
 *  more than the files prove). Earlier tests leave deferred summary-index
 *  flushes running, and a synchronous index write collides with their lock, so
 *  the writer is quiescent before reseeding. */
async function seed(root, records, indexed = records) {
  await settleSummaryIndexWrites();
  for (const record of records) writeFileSync(fileOf(root, record.id), JSON.stringify(record));
  _writeSummaryIndex(indexed.map(_sessionSummary).filter(Boolean));
}

function makeApi({ currentId = 'someone_else', agentTool = {} } = {}) {
  return createSessionSwitching(
    {
      getSession: () => ({ id: currentId, messages: [] }),
      setSession: () => {},
      getAddressedSessionId: () => currentId,
      markAddressTerminal: () => {},
      invalidateContextStatusCache: () => {},
      invalidatePreSessionToolSurface: () => {},
      mgr,
      statusRoutes: { clearGatewaySessionRoute: () => {} },
      agentTool: { closeAll: () => {}, ...agentTool },
      cleanupDeletedSessionWorktree: async () => {},
    },
    { ingestSessionIntoMemory: async () => {}, closeSurfaceSession: () => {}, cancelBackgroundTasks }
  );
}

/** Record every readFileSync of a session record while `fn` runs. */
async function readSessionFiles(root, fn) {
  const original = fs.readFileSync;
  const reads = new Set();
  const sessionsDir = join(root, 'sessions');
  fs.readFileSync = function (path, ...rest) {
    const text = String(path);
    if (text.startsWith(sessionsDir) && text.endsWith('.json')) reads.add(text);
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { result: await fn(), reads };
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
}

/** A process restart: the in-memory summary cache is rebuilt from disk. */
function simulateRestart(root) {
  process.env.MIXDOG_DATA_DIR = isolateDataDir();
  mgr.listSessions();
  process.env.MIXDOG_DATA_DIR = root;
  mgr.listSessions();
}

for (const restart of [false, true]) {
  test(`deleting a Lead reads and deletes only its own file${restart ? ' after a restart' : ''}`, async () => {
    const root = isolateDataDir();
    const unrelated = Array.from({ length: 200 }, (_, i) => child(`other_child_${i}`, 'other_lead'));
    const records = [
      lead('lead_1'),
      child('child_idx', 'lead_1'),
      child('child_link', 'lead_1'),
      lead('other_lead'),
      ...unrelated,
    ];
    // child_link is known only through agent-workers.json, not the summary index.
    await seed(
      root,
      records,
      records.filter((r) => r.id !== 'child_link')
    );
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: [{ sessionId: 'child_link', parentSessionId: 'lead_1', ownerSessionId: 'lead_1' }],
      })
    );
    if (restart) simulateRestart(root);
    else mgr.listSessions();
    const api = makeApi();

    const { result, reads } = await readSessionFiles(root, () => api.deleteSession('lead_1'));

    assert.equal(result, true);
    assert.equal(existsSync(fileOf(root, 'lead_1')), false);
    for (const id of ['child_idx', 'child_link']) assert.equal(existsSync(fileOf(root, id)), true, id);
    for (const record of [lead('other_lead'), ...unrelated]) assert.equal(existsSync(fileOf(root, record.id)), true);
    const allowed = new Set([fileOf(root, 'lead_1')]);
    assert.ok(reads.size > 0);
    for (const path of reads) assert.ok(allowed.has(path), `unexpected read of ${path}`);
    assert.equal(await api.deleteSession('lead_1'), false, 'a second delete of the same id');
  });
}

// The asynchronous save worker retains its startup data directory.
let executionRoot;
for (const current of [false, true]) {
  for (const owner of ['user', 'agent']) {
    test(`deleting ${current ? 'current' : 'stored'} ${owner} parent preserves delegated execution`, async () => {
      executionRoot ??= isolateDataDir();
      const root = executionRoot;
      const parent = { ...lead(`parent_execution_${owner}_${current}`), owner };
      const worker = child(`child_execution_${owner}_${current}`, parent.id);
      await seed(root, [parent, worker]);
      const stopped = [];
      const delegated = registerBackgroundTask({
        surface: 'agent',
        context: { callerSessionId: parent.id },
        meta: { sessionId: worker.id },
        cancel: () => stopped.push('child'),
      });
      registerBackgroundTask({
        surface: 'shell',
        context: { callerSessionId: parent.id },
        cancel: () => stopped.push('parent'),
      });
      try {
        const api = makeApi({
          currentId: current ? parent.id : 'someone_else',
          agentTool: { closeAll: () => stopped.push('close-all') },
        });
        assert.equal(await api.deleteSession(parent.id), true);
        assert.deepEqual(stopped, ['parent']);
        assert.equal(delegated.status, 'running');
        const messages = [...worker.messages, { role: 'assistant', content: 'finished after parent deletion' }];
        await saveSessionAsync({ ...worker, messages });
        completeBackgroundTask(delegated.taskId, { content: 'done' });
        assert.equal(delegated.status, 'completed');
        assert.deepEqual(JSON.parse(readFileSync(fileOf(root, worker.id), 'utf8')).messages, messages);
      } finally {
        cleanupBackgroundTasks({ force: true });
      }
    });
  }
}

test('protected historical agent history remains explicitly deletable', async () => {
  const root = isolateDataDir();
  const record = {
    ...child('historical_child', 'parent'),
    closed: true,
    status: 'closed',
    closedReason: 'terminal-reap',
  };
  await seed(root, [record]);
  assert.equal(await makeApi().deleteSession(record.id), true);
  assert.equal(existsSync(fileOf(root, record.id)), false);
});

test('a child naming the Lead without a canonical agent record is never deleted', async () => {
  const root = isolateDataDir();
  const foreign = child('child_foreign', 'lead_1');
  const records = [lead('lead_1'), child('child_ok', 'lead_1'), lead('child_user'), foreign];
  // The index claims all three are the Lead's children; their files disagree.
  const claims = [
    lead('lead_1'),
    child('child_ok', 'lead_1'),
    child('child_user', 'lead_1'),
    child('child_foreign', 'lead_1'),
    child('child_ambiguous', 'lead_1'),
  ];
  await seed(root, records, claims);
  // Another session's record under this file name.
  writeFileSync(fileOf(root, 'child_foreign'), JSON.stringify(child('different_id', 'lead_1')));
  // Duplicate top-level ids: ambiguous identity.
  writeFileSync(
    fileOf(root, 'child_ambiguous'),
    JSON.stringify(child('child_ambiguous', 'lead_1')).replace(/^\{/, '{"id":"another_id",')
  );
  const api = makeApi();

  assert.equal(await api.deleteSession('lead_1'), true);

  assert.equal(existsSync(fileOf(root, 'lead_1')), false);
  assert.equal(existsSync(fileOf(root, 'child_ok')), true);
  for (const id of ['child_user', 'child_foreign', 'child_ambiguous']) {
    assert.equal(existsSync(fileOf(root, id)), true, `${id} must survive`);
  }
});

for (const bulk of [false, true]) {
  test(`${bulk ? 'bulk teardown' : 'agent close'} stops runtimes without tombstoning conversations`, async () => {
    const root = isolateDataDir();
    const worker = child('child_retained', 'parent');
    await seed(root, [worker]);
    const flow = createCloseFlow({
      mgr,
      registry: {
        tags: new Map([['worker', worker.id]]),
        tagAgents: new Map([['worker', 'worker']]),
        tagCwds: new Map(),
        refreshTagsFromSessions() {},
        wantsSessionScan: () => false,
        resolveTag: () => worker.id,
        getLiveSession: () => worker,
        tagForSession: () => 'worker',
        forgetTerminalSession() {},
        removeWorkerRow() {},
        markReleased() {},
        agentSessionEntries: () => [{ tag: 'worker', session: worker }],
        flushWorkerIndexMutations() {},
        writeWorkerRows: (update) => update(new Map(), new Map()),
      },
      views: {},
    });
    if (bulk) {
      const result = await flow.closeAll('process-exit');
      assert.equal(result.failed.length, 0);
      assert.equal(result.closed.length, 1);
    } else {
      assert.equal((await flow.close({ sessionId: worker.id })).closed, true);
    }
    const stored = JSON.parse(readFileSync(fileOf(root, worker.id), 'utf8'));
    assert.equal(stored.closed, false);
    assert.deepEqual(stored.messages, worker.messages);
    assert.ok(mgr.listSessions().some((row) => row.id === worker.id));
  });
}

test('a deleted session whose turn is still running is not recreated when the turn settles', async () => {
  const root = isolateDataDir();
  const live = lead('lead_running');
  await seed(root, [live]);
  const leadIndex = createLeadWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    workerRowFromSession: (session, tag, extra) => ({ sessionId: session.id, tag, ...extra }),
  });
  try {
    const api = makeApi({ agentTool: { forgetLeadSession: leadIndex.forgetLeadSession } });
    leadIndex.upsertLeadSession(live, { status: 'running' });
    await leadIndex.flushLeadWorkerIndexWrites();
    const leadRows = () => leadIndex.readLeadWorkerRows().filter((row) => row.sessionId === live.id);
    assert.equal(leadRows().length, 1);

    // The long turn: it is mid-flight when the user deletes the session.
    let finishTurn;
    const turn = new Promise((resolve) => {
      finishTurn = resolve;
    }).then(async () => {
      saveSession(live, { sync: true });
      // A refused async save is how a late write learns its session is gone.
      await saveSessionAsync(live, {}).catch((error) => assert.equal(error.sessionAuthorityRefusal, 'deleted'));
      leadIndex.upsertLeadSession(live, { status: 'idle', stage: 'idle' });
    });

    assert.equal(await api.deleteSession(live.id), true);
    assert.equal(existsSync(fileOf(root, live.id)), false);
    assert.equal(leadRows().length, 0, 'the delete drops the running lead row');

    finishTurn();
    await turn;
    await leadIndex.flushLeadWorkerIndexWrites();

    assert.equal(existsSync(fileOf(root, live.id)), false, 'the settling turn must not rewrite the record');
    assert.equal(
      mgr.listSessions({ refreshFromStorage: true }).some((row) => row.id === live.id),
      false
    );
    assert.equal(leadRows().length, 0, 'no lead-workers row is recreated');
    assert.equal(JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8')).workers?.[live.id], undefined);
    assert.equal(await api.deleteSession(live.id), false, 'the same id cannot be deleted twice');
  } finally {
    leadIndex.dispose();
  }
});
