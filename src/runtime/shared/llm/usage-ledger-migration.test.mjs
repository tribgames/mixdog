import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';

// The original v1 storage contract, independent of the compact implementation.
const V1_SCHEMA = `
    PRAGMA journal_mode=WAL;
    CREATE TABLE events (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
        session_id TEXT NOT NULL, source_type TEXT NOT NULL,
        input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL, cache_write REAL NOT NULL,
        cost_usd REAL, cost_source TEXT NOT NULL, rates TEXT, origin TEXT NOT NULL, rank INTEGER NOT NULL,
        duration_ms REAL NOT NULL
    );
    CREATE INDEX events_time ON events(ts);
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('importedThrough','1789206254733'),('custom-note','preserve me');
    CREATE TABLE legacy_days (day TEXT PRIMARY KEY,document TEXT NOT NULL);
    INSERT INTO legacy_days VALUES ('2026-08-01','{"restored":true,"turns":4,"costUsd":0.123456}');
    CREATE TABLE day_sessions (
        day TEXT NOT NULL,rank INTEGER NOT NULL,session_id TEXT NOT NULL,tokens REAL NOT NULL,
        PRIMARY KEY(day,rank,session_id)
    );
    CREATE TABLE daily (
        day TEXT NOT NULL,rank INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
        kind TEXT NOT NULL,cost_source TEXT NOT NULL,conversation INTEGER NOT NULL,
        turns INTEGER NOT NULL,input REAL NOT NULL,output REAL NOT NULL,
        cache_read REAL NOT NULL,cache_write REAL NOT NULL,cost_usd REAL NOT NULL,
        duration_ms REAL NOT NULL,imported INTEGER NOT NULL,
        PRIMARY KEY(day,rank,provider,model,kind,cost_source,conversation)
    );
    PRAGMA user_version=1;
`;
function fixture(count = 500) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-usage-v1-')), 'ledger.sqlite');
  const db = new DatabaseSync(path);
  db.exec(V1_SCHEMA);
  const insert = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    let id = createHash('sha256').update(`request-${i}`).digest('hex');
    if (i === 0) id = '57def0d3-669e-4fdb-9f3d-781faec65adf';
    else if (i === 1) id = '요청/完整/é';
    let cost = 0.123456;
    if (i % 3 === 0) cost = null;
    else if (i % 3 === 1) cost = 0;
    insert.run(
      id,
      1789200000000 + i,
      '2026-09-12',
      'example-api',
      `모델/${i % 3}`,
      'api',
      `session-${i % 7}`,
      i % 2 ? 'lead' : 'memory-cycle',
      1234567890 + i,
      i * 11,
      i * 7,
      i * 3,
      cost,
      i % 3 === 0 ? 'unpriced' : 'catalog',
      i % 3 === 0 ? null : ' { "inputCostPerM": 3.125, "outputCostPerM": 0 }\n',
      'trace',
      0,
      i * 13
    );
  }
  db.exec(`
        INSERT INTO daily
        SELECT day,rank,provider,model,kind,cost_source,source_type='lead',COUNT(*),
            SUM(input),SUM(output),SUM(cache_read),SUM(cache_write),COALESCE(SUM(cost_usd),0),
            SUM(duration_ms),1 FROM events
        GROUP BY day,rank,provider,model,kind,cost_source,source_type;
        INSERT INTO day_sessions
        SELECT day,rank,session_id,SUM(input+output+cache_read+cache_write) FROM events
        WHERE source_type='lead' GROUP BY day,rank,session_id;
        COMMIT;
    `);
  return { path, db };
}
function snapshot(db) {
  return Object.fromEntries(
    ['events', 'daily', 'day_sessions', 'metadata', 'legacy_days'].map((name) => [
      name,
      db
        .prepare(`SELECT * FROM ${name}`)
        .all()
        .map((row) => JSON.stringify({ ...row }))
        .sort(),
    ])
  );
}

test('v1 migration preserves every value, totals and metadata, including a coherent WAL backup', () => {
  const original = fixture();
  const expected = snapshot(original.db);
  // Leave the original connection open: its committed rows may still be in
  // the WAL, so copying just the main .sqlite file would be an invalid backup.
  const ledger = new UsageLedger(original.path);
  original.db.close();
  const backupPath = ledger.migration.backupPath;
  const backupHash = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  try {
    assert.equal(ledger.migration.records, 500);
    assert.deepEqual(snapshot(ledger.db), expected);
    assert.deepEqual(
      ledger.db
        .prepare('PRAGMA integrity_check')
        .all()
        .map((r) => r.integrity_check),
      ['ok']
    );
    assert.deepEqual(ledger.db.prepare('PRAGMA foreign_key_check').all(), []);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
      assert.deepEqual(snapshot(backup), expected);
    } finally {
      backup.close();
    }
  } finally {
    ledger.close();
  }

  const reopened = new UsageLedger(original.path);
  try {
    assert.deepEqual(snapshot(reopened.db), expected);
    // An old textual ID must still prevent duplicates after conversion.
    const duplicate = makeUsageRecord({
      id: '57def0d3-669e-4fdb-9f3d-781faec65adf',
      ts: 1789200000000,
      provider: 'mixdog-local',
      model: 'local',
      inputTokens: 9,
    });
    assert.equal(reopened.record([duplicate]), 0);
    assert.deepEqual(snapshot(reopened.db), expected);
    assert.equal(reopened.record([{ ...duplicate, id: 'new/요청' }]), 1);
    assert.equal(reopened.db.prepare('SELECT input FROM events WHERE id=?').get('new/요청').input, 9);
    assert.equal(createHash('sha256').update(readFileSync(backupPath)).digest('hex'), backupHash);
  } finally {
    reopened.close();
  }
});

test('compaction reduces the actual database size without deleting any record', () => {
  const original = fixture(5000);
  original.db.close();
  const before = statSync(original.path).size;
  const ledger = new UsageLedger(original.path);
  try {
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5000);
    assert.ok(statSync(original.path).size < before, 'physical database must shrink');
  } finally {
    ledger.close();
  }
});

test('a rejected conversion rolls back to v1 and retains an untouched original backup', () => {
  const original = fixture(4);
  original.db.prepare('UPDATE events SET day=? WHERE id=?').run('not-a-day', '요청/完整/é');
  const expected = snapshot(original.db);
  original.db.close();
  let failure;
  assert.throws(
    () => new UsageLedger(original.path),
    (error) => {
      failure = error;
      return /calendar day/.test(error.message);
    }
  );
  assert.ok(failure.backupPath);
  for (const path of [original.path, failure.backupPath]) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.deepEqual(snapshot(db), expected);
    } finally {
      db.close();
    }
  }
});

test('concurrent upgrade and capture preserve all original and new records', async () => {
  const original = fixture(250);
  original.db.close();
  const url = new URL('./usage-ledger.mjs', import.meta.url).href;
  const run = (label) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        `
            (async () => {
                const {UsageLedger,makeUsageRecord}=await import(${JSON.stringify(url)});
                const ledger=new UsageLedger(${JSON.stringify(original.path)});
                for(let i=0;i<10;i++)ledger.record([makeUsageRecord({
                    id:${JSON.stringify(label)}+i,ts:1789200000000,provider:'mixdog-local',
                    model:'local',inputTokens:10,outputTokens:2
                })]);
                ledger.close();
            })().catch(error=>{console.error(error);process.exitCode=1;});
        `,
        { eval: true }
      );
      worker.on('error', reject);
      worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    });
  await Promise.all([run('a'), run('b')]);
  const ledger = new UsageLedger(original.path);
  try {
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 270);
    assert.equal(
      ledger.db.prepare("SELECT SUM(input+output) AS tokens FROM events WHERE provider='mixdog-local'").get().tokens,
      240
    );
  } finally {
    ledger.close();
  }
});
