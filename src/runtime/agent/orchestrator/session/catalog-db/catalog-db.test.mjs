// Session catalog DB, phase 2: in the daemon the catalog worker detects every
// storage change itself, feeds SQLite and answers ordinary listings from it;
// the daemon's own landed writes reach it as storage hints (ids only);
// anything it cannot answer falls back to the JSON path.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendLog,
  fileOf,
  indexRow,
  replace,
  rewriteInPlace,
  sessionsDir,
  useDataDir,
  writeBase,
} from '../store-summary-reader-catalog-fixture.mjs';
import {
  clearStoredSessionCatalog,
  listStoredSessionSummaries,
  listStoredSessionSummariesAsync,
  listStoredSessionOwnershipLinksAsync,
  listStoredSessionSummaryPage,
  verifyStoredSessionCatalog,
} from '../store-summary-reader.mjs';
import { _cacheSessionSummary } from '../store/summary-cache.mjs';
import { _hasUnsettledSummaryOps, settleSummaryIndexWrites } from '../store-summary-index.mjs';
import { settleSessionSummaryIndex } from '../store/listing.mjs';
import { deleteSession } from '../store/session-delete.mjs';
import { saveSession, saveSessionAsyncDeferred } from '../store.mjs';
import {
  closeSessionCatalogDb,
  configureSessionCatalogDbForTest,
  hintSessionCatalogStorage,
  postSessionCatalogHintForTest,
  sessionCatalogDb,
  SESSION_CATALOG_DB_FILE,
  SESSION_STORE_CONFIG_DEFAULTS,
} from './index.mjs';
import { sqliteVersionSupported } from './sqlite-gate.mjs';

let logs = [];
let options = {};

function configure(extra = {}) {
  options = { ...options, ...extra };
  configureSessionCatalogDbForTest({ ...options, log: (line) => logs.push(line) });
}

/** A fresh data dir (valid empty index base) and daemon-role catalog DB
 *  settings; the test runtime's SQLite is reported as a supported version. */
function setup(t, prefix, extra = {}) {
  useDataDir(prefix);
  writeBase([]);
  clearStoredSessionCatalog();
  logs = [];
  options = {
    writer: true,
    sqliteVersion: '3.51.3',
    shadowIntervalMs: 0,
    retryMs: 0,
    ...extra,
  };
  configure();
  t.after(async () => {
    await closeSessionCatalogDb();
    configureSessionCatalogDbForTest(null);
  });
}

const dataDir = () => process.env.MIXDOG_DATA_DIR;
const dbPath = () => join(dataDir(), SESSION_CATALOG_DB_FILE);
const db = () => sessionCatalogDb(dataDir());
/** Starts the DB (first request opens and backfills) and waits for it. */
async function ready() {
  await db().list();
  const status = await db().settled();
  assert.equal(status.phase, 'ready', JSON.stringify(status));
  return status;
}
/** The DB's answer, or null when it would fall back to JSON. */
const dbList = async () => (await db().list())?.rows ?? null;
const json = () => listStoredSessionSummaries();
const ids = (rows) => rows.map((row) => row.id);
const shadowLines = () => logs.filter((line) => line.startsWith('[session-catalog-db] shadow-verify'));

/** An index-updating writer (the store of any process): record, then row. */
function save(id, text, at, extra = {}) {
  replace(id, text);
  appendLog([{ ...indexRow(id, text), lastUsedAt: at, ...extra }]);
}

function seed() {
  save('lead_a', 'alpha', 500);
  save('lead_b', 'bravo', 400);
  save('lead_c', 'charlie', 300);
  save('agent_x', 'agent work', 450, { owner: 'agent', agent: 'worker', ownerSessionId: 'lead_a' });
  // A session file the index does not describe (row parsed from the file).
  replace('plain_d', 'delta');
}

const session = (id, text, at, extra = {}) => ({
  id,
  owner: 'user',
  agent: 'lead',
  updatedAt: at,
  lastUsedAt: at,
  messages: [{ role: 'user', content: text }],
  ...extra,
});

const rowOf = (rows, id) => rows.find((row) => row.id === id);

test('version gate and defaults', () => {
  for (const version of ['3.51.3', '3.52.0', '3.53.1', '4.0.0', '3.50.7', '3.50.12']) {
    assert.equal(sqliteVersionSupported(version), true, version);
  }
  for (const version of ['3.51.2', '3.50.6', '3.50.4', '3.45.1', '', 'garbage']) {
    assert.equal(sqliteVersionSupported(version), false, version);
  }
  assert.deepEqual(SESSION_STORE_CONFIG_DEFAULTS, { sqliteCatalog: true }, 'on unless switched off');
});

test('the writer is the daemon process itself, under Electron only', async (t) => {
  setup(t, 'mixdog-catalog-db-role-');
  configureSessionCatalogDbForTest({ log: (line) => logs.push(line) });
  assert.equal(sessionCatalogDb(dataDir()), null, 'not the daemon');
  const saved = { host: process.env.MIXDOG_DAEMON_HOST, pid: process.env.MIXDOG_SERVER_PID };
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_DAEMON_HOST', saved.host],
      ['MIXDOG_SERVER_PID', saved.pid],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MIXDOG_DAEMON_HOST = '1';
  process.env.MIXDOG_SERVER_PID = String(process.pid + 1);
  assert.equal(sessionCatalogDb(dataDir()), null, 'a child inherits the env, not the pid');
  process.env.MIXDOG_SERVER_PID = String(process.pid);
  assert.equal(
    sessionCatalogDb(dataDir()) !== null,
    Boolean(process.versions.electron),
    'the daemon under system Node stays on JSON'
  );
});

test('below the SQLite gate everything stays JSON', async (t) => {
  setup(t, 'mixdog-catalog-db-gate-', { sqliteVersion: '3.50.4' });
  seed();
  assert.equal(await db().list(), null);
  assert.equal(existsSync(dbPath()), false, 'no DB file');
  assert.match(logs.join('\n'), /disabled: SQLite 3\.50\.4 .*lacks the WAL-reset fix/);
  assert.deepEqual(await listStoredSessionSummariesAsync(), json());
  assert.equal(await db().list(), null, 'a final refusal is not retried');
});

test('usage ownership reads hidden closed agents on the worker without changing ordinary listings', async (t) => {
  setup(t, 'mixdog-catalog-db-usage-links-');
  save('lead_a', 'lead', 500);
  save('agent_a', 'closed work', 400, {
    owner: 'agent',
    agent: 'worker',
    ownerSessionId: 'lead_a',
    closed: true,
  });
  await ready();
  const answer = await db().list(null, { ownershipLinks: true });
  assert.deepEqual(answer.rows.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'agent_a', ownerSessionId: 'lead_a' },
    { id: 'lead_a', ownerSessionId: null },
  ]);
  assert.deepEqual(await listStoredSessionOwnershipLinksAsync(), answer.rows);
  assert.deepEqual((await dbList()).map((row) => row.id), ['lead_a']);
  writeFileSync(fileOf('unknown_child'), '{');
  hintSessionCatalogStorage(['unknown_child']);
  await db().list();
  await db().settled();
  assert.equal(await db().list(null, { ownershipLinks: true }), null);
  assert.equal(await listStoredSessionOwnershipLinksAsync(), null);
});

test('the worker detects storage changes itself; listings equal JSON in exact order', async (t) => {
  setup(t, 'mixdog-catalog-db-detect-', { backfillBatch: 2 });
  seed();
  writeFileSync(join(sessionsDir(), 'lead_b.hb'), '1\n');
  writeFileSync(join(sessionsDir(), 'agent_x.hb'), '1\n');
  assert.equal(await db().list(), null, 'until the backfill completes the JSON path answers');
  assert.deepEqual(await listStoredSessionSummariesAsync(), json());
  const status = await db().settled();
  assert.equal(status.lastBackfill.rows, 5, 'hidden agent rows are stored too');
  assert.match(shadowLines()[0], /^\[session-catalog-db\] shadow-verify ok json=4 db=4$/);
  const served = await dbList();
  assert.deepEqual(served, json());
  assert.ok(served.find((row) => row.id === 'lead_a').agentHeartbeatAt > 0, 'liveness overlays');
  assert.ok(served.find((row) => row.id === 'lead_b').heartbeatAt > 0);

  // Another process's JSON-only writes appear on the very next listing.
  const step = async (label) => assert.deepEqual(await dbList(), json(), label);
  save('lead_e', 'echo', 600);
  await step('index-updating create');
  assert.equal((await dbList())[0].title, 'indexed:echo');
  save('lead_e', 'echo two', 610);
  await step('index-updating update');
  unlinkSync(fileOf('lead_e'));
  appendLog([], ['lead_e']);
  await step('index-updating delete');
  replace('plain_f', 'foxtrot');
  await step('rename without the index');
  assert.ok(ids(await dbList()).includes('plain_f'));
  rewriteInPlace('plain_d', 'delta two');
  await verifyStoredSessionCatalog();
  await step('in-place rewrite found by the worker’s background pass');
  assert.equal((await dbList()).find((row) => row.id === 'plain_d').preview, 'delta two');
  unlinkSync(fileOf('plain_f'));
  await step('delete without the index');
  unlinkSync(join(sessionsDir(), 'lead_b.hb'));
  await step('liveness follows the sidecars');
  await db().settled();
  assert.ok(
    shadowLines().every((line) => line.includes(' ok ')),
    shadowLines().join('\n')
  );
});

test('storage hints: a hinted in-place change is on the next listing before any index append', async (t) => {
  setup(t, 'mixdog-catalog-db-hint-', { shadowIntervalMs: 60_000 });
  seed();
  await ready();
  // Both rewritten in place: no name change, their index rows still describe
  // the old bytes. Only lead_b is hinted.
  rewriteInPlace('lead_b', 'bravo two');
  rewriteInPlace('lead_c', 'charlie two');
  hintSessionCatalogStorage(['lead_b']);
  const served = await dbList();
  assert.equal(rowOf(served, 'lead_b').preview, 'bravo two', 'hinted: re-checked from storage');
  assert.equal(rowOf(served, 'lead_c').preview, 'charlie', 'not hinted: waits for the existing detection');
  // A lost hint: the worker's background verification finds it.
  await verifyStoredSessionCatalog();
  assert.equal(rowOf(await dbList(), 'lead_c').preview, 'charlie two');
  // A delete that has removed the file, hinted before any index change.
  unlinkSync(fileOf('lead_a'));
  hintSessionCatalogStorage(['lead_a']);
  assert.equal(ids(await dbList()).includes('lead_a'), false);
  assert.equal((await db().shadow()).fields, 0);
});

test('storage hints from the store: a landed save and a completed delete show on the next listing', async (t) => {
  setup(t, 'mixdog-catalog-db-hint-store-');
  seed();
  await ready();
  const record = session('own_n', 'saved by the daemon', 950, { title: 'mine' });
  saveSession(record, { sync: true });
  assert.ok(_hasUnsettledSummaryOps(), 'its index row is still queued');
  assert.equal((await dbList())[0].title, 'mine');
  await settleSummaryIndexWrites();
  await dbList();
  // Saved again: temp file + rename under the same name (the directory
  // name diff alone keeps the old entry).
  record.title = 'mine two';
  record.updatedAt = 960;
  saveSession(record, { sync: true });
  assert.ok(_hasUnsettledSummaryOps());
  assert.equal(rowOf(await dbList(), 'own_n').title, 'mine two');
  assert.equal(deleteSession('own_n'), true);
  assert.equal(ids(await dbList()).includes('own_n'), false);
  await settleSummaryIndexWrites();
  assert.deepEqual(await dbList(), json());
});

test('a hint for another data dir is ignored; a lost hint is recovered by the index', async (t) => {
  setup(t, 'mixdog-catalog-db-hint-dir-');
  seed();
  await ready();
  const other = mkdtempSync(join(tmpdir(), 'mixdog-catalog-db-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  rewriteInPlace('lead_b', 'bravo two');
  assert.deepEqual(await postSessionCatalogHintForTest(other, ['lead_b']), { hinted: 0 });
  assert.equal(rowOf(await dbList(), 'lead_b').preview, 'bravo', 'not re-checked');
  const status = await db().status();
  assert.equal(status.phase, 'ready', 'the open DB is untouched');
  assert.equal(readdirSync(other).length, 0, 'nothing opened in the other dir');
  // The writer's index append brings the change.
  appendLog([indexRow('lead_b', 'bravo two')]);
  assert.equal(rowOf(await dbList(), 'lead_b').title, 'indexed:bravo two');
  assert.deepEqual(await dbList(), json());
});

test('no row from a queued, failed or refused save', async (t) => {
  setup(t, 'mixdog-catalog-db-refused-');
  seed();
  await ready();
  _cacheSessionSummary(session('own_q', 'queued', 995));
  assert.equal(ids(await dbList()).includes('own_q'), false, 'not on disk: not listed (as at HEAD)');
  const saving = saveSessionAsyncDeferred(session('own_d', 'mine', 990));
  // Before the deferred save is promoted, the canonical record becomes a
  // different session's: the promotion is refused.
  writeFileSync(fileOf('own_d'), JSON.stringify(session('foreign_z', 'theirs', 980)));
  await assert.rejects(saving, (error) => error.code === 'ESESSIONNOTOWNED');
  const listed = await dbList();
  assert.equal(ids(listed).includes('own_d'), false);
  assert.equal(ids(listed).includes('foreign_z'), false);
  assert.deepEqual(listed, json());
  configure({ enabled: false });
  assert.deepEqual(await listStoredSessionSummariesAsync(), json(), 'the JSON fallback is the JSON listing');
});

test('the off-switch forces the JSON path; clearing it serves from the DB again', async (t) => {
  setup(t, 'mixdog-catalog-db-switch-');
  seed();
  await ready();
  writeFileSync(join(dataDir(), 'mixdog-config.json'), JSON.stringify({ sessionStore: { sqliteCatalog: false } }));
  assert.equal(await db().list(), null);
  assert.ok(logs.includes('[session-catalog-db] off-switch set: ordinary listings use JSON'));
  assert.deepEqual(await listStoredSessionSummariesAsync(), json());
  writeFileSync(join(dataDir(), 'mixdog-config.json'), JSON.stringify({ sessionStore: { sqliteCatalog: true } }));
  assert.deepEqual(await dbList(), json());
});

test('a DB error answers from JSON and the DB is reopened later', async (t) => {
  setup(t, 'mixdog-catalog-db-error-');
  seed();
  await ready();
  // An undecodable stored value makes the DB listing fail.
  assert.equal(await db().testExec("UPDATE sessions SET owner=X'7B' WHERE id='lead_a'"), 1);
  assert.equal(await db().list(), null);
  assert.ok(logs.some((line) => line.startsWith('[session-catalog-db] listing failed: ')));
  assert.deepEqual(await listStoredSessionSummariesAsync(), json());
  assert.equal(
    readdirSync(dataDir()).some((name) => name.includes('.corrupt-')),
    false,
    'not corruption'
  );
  // Retried: reopened, rebuilt from JSON, serving again.
  await ready();
  assert.deepEqual(await dbList(), json());
});

test('an interrupted backfill (worker crash) resumes without resurrecting a deleted session', async (t) => {
  setup(t, 'mixdog-catalog-db-resume-', { backfillBatch: 2, crashAfterBatches: 2 });
  seed();
  save('lead_g', 'golf', 200);
  assert.equal(await db().list(), null);
  await assert.rejects(db().settled(), /worker exited/);
  // The dead worker released the DB; two batches (4 rows) had landed.
  const landed = (() => {
    const handle = new DatabaseSync(dbPath());
    try {
      return handle
        .prepare('SELECT id FROM sessions WHERE lead_visible=1 ORDER BY id')
        .all()
        .map((row) => row.id);
    } finally {
      handle.close();
    }
  })();
  assert.ok(landed.length >= 2, JSON.stringify(landed));
  // A landed session is deleted between the interruption and the resume.
  const victim = landed[0];
  unlinkSync(fileOf(victim));
  appendLog([], [victim]);
  configure({ crashAfterBatches: undefined });
  assert.equal(await db().list(), null, 'the respawned worker reopens and resumes');
  const status = await db().settled();
  assert.equal(status.lastBackfill.kind, 'resume');
  assert.ok(status.lastBackfill.skipped >= 1, 'rows that landed before the crash are skipped');
  assert.equal(status.lastBackfill.removed, 1, 'the deleted session is removed, not resurrected');
  assert.equal(ids(await dbList()).includes(victim), false);
  assert.deepEqual(await dbList(), json());
  assert.match(shadowLines().at(-1), / ok /);
});

test('a shadow mismatch is logged, stops serving and rebuilds the DB from JSON', async (t) => {
  setup(t, 'mixdog-catalog-db-shadow-', { shadowIntervalMs: 60_000 });
  seed();
  await ready();
  assert.equal(shadowLines().length, 1, 'once after the backfill');
  for (const [index, id] of ['lead_e', 'lead_f'].entries()) {
    save(id, id, 700 + index);
    await dbList();
  }
  assert.equal(shadowLines().length, 1, 'later changes wait for the interval');

  await db().testExec("UPDATE sessions SET title='tampered' WHERE id='lead_b'");
  await db().testExec("DELETE FROM sessions WHERE id='lead_c'");
  const report = await db().shadow();
  assert.deepEqual([report.missing, report.extra, report.order, report.fields], [1, 0, 0, 1]);
  assert.equal(
    shadowLines().at(-1),
    '[session-catalog-db] shadow-verify mismatch json=6 db=5 missing=1 extra=0 order=0 fields=1 first=missing:lead_c fields:lead_b'
  );
  assert.ok(logs.includes('[session-catalog-db] listings use JSON until the DB is rebuilt'));
  const status = await db().settled();
  assert.equal(status.lastBackfill.kind, 'rebuild');
  assert.deepEqual(await dbList(), json());
  assert.match(shadowLines().at(-1), / ok /);
});

test('fencing: a held DB keeps a second writer on JSON and is never moved aside', async (t) => {
  setup(t, 'mixdog-catalog-db-fence-');
  seed();
  // Another process owns the DB.
  const other = new DatabaseSync(dbPath());
  other.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
  assert.equal(await db().list(), null);
  assert.equal((await db().status()).reason, 'locked');
  assert.match(logs.join('\n'), /locked: database is locked; catalog stays JSON/);
  assert.equal(
    readdirSync(dataDir()).some((name) => name.includes('.corrupt-')),
    false,
    'never moved aside'
  );
  assert.deepEqual(await listStoredSessionSummariesAsync(), json());
  other.close();
  // Released: the next attempt takes the DB over.
  await ready();
  assert.deepEqual(await dbList(), json());
  // Now this process holds it: nobody else can even read it.
  const intruder = new DatabaseSync(dbPath());
  try {
    intruder.exec('PRAGMA busy_timeout=100');
    assert.throws(() => intruder.prepare('SELECT count(*) FROM sessions').get(), /database is locked/);
  } finally {
    intruder.close();
  }
});

test('a corrupt DB is moved aside and rebuilt from JSON', async (t) => {
  setup(t, 'mixdog-catalog-db-corrupt-');
  writeFileSync(dbPath(), Buffer.from('this is not a sqlite database, just bytes'.repeat(200)));
  seed();
  await ready();
  assert.match(logs.join('\n'), /corrupt DB \(.*\) moved aside to .*session-catalog\.sqlite\.corrupt-/);
  assert.ok(readdirSync(dataDir()).some((name) => name.startsWith(`${SESSION_CATALOG_DB_FILE}.corrupt-`)));
  assert.deepEqual(await dbList(), json());
});

test('teardown closes the DB so the data dir can be removed', async (t) => {
  setup(t, 'mixdog-catalog-db-teardown-');
  seed();
  await ready();
  await dbList();
  await settleSessionSummaryIndex();
  rmSync(dataDir(), { recursive: true });
  assert.equal(existsSync(dataDir()), false);
});

test('a dead worker is respawned and reopened; repeated deaths give up for a while', async (t) => {
  setup(t, 'mixdog-catalog-db-respawn-', { backfillBatch: 1 });
  seed();
  await ready();
  // The worker dies (during a rebuild); the mismatch starts the rebuild,
  // which kills the thread before it answers.
  configure({ crashAfterBatches: 1 });
  await db().testExec("DELETE FROM sessions WHERE id='lead_c'");
  await assert.rejects(db().shadow(), /worker exited/);
  configure({ crashAfterBatches: undefined });
  // A hint while no worker runs is dropped: the respawned worker rescans.
  rewriteInPlace('lead_b', 'bravo two');
  hintSessionCatalogStorage(['lead_b']);
  assert.equal(await db().list(), null, 'reopening');
  await db().settled();
  assert.equal(rowOf(await dbList(), 'lead_b').preview, 'bravo two', 'the resync saw it');

  // Every reopen dies again: after more than 3 deaths in 10 min it gives up.
  configure({ crashAfterBatches: 1 });
  for (let attempt = 0; attempt < 8 && !logs.some((line) => line.includes('worker failed')); attempt++) {
    // A ready DB is made to rebuild; a fresh worker reopens and backfills.
    await db()
      .testExec("DELETE FROM sessions WHERE id='lead_b'")
      .catch(() => {});
    await db()
      .shadow()
      .catch(() => {});
    await db().list();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(logs.some((line) => /worker failed \d+ times in 10 min/.test(line)));
  assert.equal(await db().list(), null);
  assert.deepEqual(await listStoredSessionSummariesAsync(), json(), 'JSON answers meanwhile');
});

test('paging: one order (activity, then id) on both paths, ties across page boundaries', async (t) => {
  setup(t, 'mixdog-catalog-db-paging-');
  for (const id of ['tie_e', 'tie_a', 'tie_d', 'tie_b', 'tie_c']) save(id, id, 300);
  save('new_1', 'newest', 900);
  save('old_2', 'older', 100);
  save('old_1', 'oldest', 100);
  const expected = ['new_1', 'tie_a', 'tie_b', 'tie_c', 'tie_d', 'tie_e', 'old_1', 'old_2'];
  assert.deepEqual(ids(json()), expected, 'the JSON path orders ties by id');
  const walk = async () => {
    const result = {};
    for (const limit of [1, 2, 3, 8, 50]) {
      const seen = [];
      let cursor;
      for (let pages = 0; pages < 20; pages++) {
        const page = await listStoredSessionSummaryPage({ limit, cursor });
        seen.push(...ids(page.sessions));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      result[limit] = seen;
    }
    return result;
  };
  configure({ enabled: false });
  const jsonPages = await walk();
  configure({ enabled: true });
  await ready();
  const dbPages = await walk();
  for (const limit of [1, 2, 3, 8, 50]) {
    assert.deepEqual(jsonPages[limit], expected, `JSON pages of ${limit}`);
    assert.deepEqual(dbPages[limit], expected, `DB pages of ${limit}`);
  }
  const first = await db().list({ limit: 3, after: null });
  assert.deepEqual([ids(first.rows), first.more], [['new_1', 'tie_a', 'tie_b'], true], 'only the page crosses');
  await assert.rejects(listStoredSessionSummaryPage({ cursor: 'not-a-cursor' }), /invalid session catalog cursor/);
});
