// Deleting a session reads only the files it must prove ownership of, never the
// whole store, and leaves nothing a still-running turn could write back.
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const searchIngest = await import('../../../runtime/session-search/session-search-ingest.mjs');
mock.module('../../../runtime/session-search/session-search-ingest.mjs', {
  namedExports: { ...searchIngest, forgetSessionSearch: async () => {} },
});

const { createSessionSwitching } = await import('../session-switch.mjs');
const mgr = await import('../../../runtime/agent/orchestrator/session/manager.mjs');
const { saveSession, saveSessionAsync } = await import('../../../runtime/agent/orchestrator/session/store.mjs');
const { _sessionSummary, _writeSummaryIndex } = await import(
  '../../../runtime/agent/orchestrator/session/store-summary-index.mjs'
);
const { createLeadWorkerIndex } = await import('../../services/agent-tool/lead-worker-index.mjs');

const roots = [];
const previousDataDir = process.env.MIXDOG_DATA_DIR;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function useDataDir() {
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
 *  more than the files prove). */
function seed(root, records, indexed = records) {
  for (const record of records) writeFileSync(fileOf(root, record.id), JSON.stringify(record));
  _writeSummaryIndex(indexed.map(_sessionSummary).filter(Boolean));
}

function makeApi({ currentId = 'someone_else', agentTool = {} } = {}) {
  return createSessionSwitching(
    {
      getSession: () => ({ id: currentId, messages: [] }),
      setSession: () => {},
      mgr,
      statusRoutes: { clearGatewaySessionRoute: () => {} },
      agentTool: { closeAll: () => {}, ...agentTool },
      cleanupDeletedSessionWorktree: async () => {},
    },
    { ingestSessionIntoMemory: async () => {}, closeSurfaceSession: () => {}, cancelBackgroundTasks: () => {} }
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
  process.env.MIXDOG_DATA_DIR = useDataDir();
  mgr.listSessions();
  process.env.MIXDOG_DATA_DIR = root;
  mgr.listSessions();
}

for (const restart of [false, true]) {
  test(`deleting a Lead reads only its own and its children's files${restart ? ' after a restart' : ''}`, async () => {
    const root = useDataDir();
    const unrelated = Array.from({ length: 200 }, (_, i) => child(`other_child_${i}`, 'other_lead'));
    const records = [
      lead('lead_1'),
      child('child_idx', 'lead_1'),
      child('child_link', 'lead_1'),
      lead('other_lead'),
      ...unrelated,
    ];
    // child_link is known only through agent-workers.json, not the summary index.
    seed(
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
    for (const id of ['lead_1', 'child_idx', 'child_link']) assert.equal(existsSync(fileOf(root, id)), false, id);
    for (const record of [lead('other_lead'), ...unrelated]) assert.equal(existsSync(fileOf(root, record.id)), true);
    const allowed = new Set(['lead_1', 'child_idx', 'child_link'].map((id) => fileOf(root, id)));
    assert.ok(reads.size > 0);
    for (const path of reads) assert.ok(allowed.has(path), `unexpected read of ${path}`);
    assert.equal(await api.deleteSession('lead_1'), false, 'a second delete of the same id');
  });
}

test('a child naming the Lead without a canonical agent record is never deleted', async () => {
  const root = useDataDir();
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
  seed(root, records, claims);
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
  assert.equal(existsSync(fileOf(root, 'child_ok')), false);
  for (const id of ['child_user', 'child_foreign', 'child_ambiguous']) {
    assert.equal(existsSync(fileOf(root, id)), true, `${id} must survive`);
  }
});

test('a deleted session whose turn is still running is not recreated when the turn settles', async () => {
  const root = useDataDir();
  const live = lead('lead_running');
  seed(root, [live]);
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
    assert.equal(
      JSON.parse(readFileSync(join(root, 'lead-workers.json'), 'utf8')).workers?.[live.id],
      undefined
    );
    assert.equal(await api.deleteSession(live.id), false, 'the same id cannot be deleted twice');
  } finally {
    leadIndex.dispose();
  }
});
