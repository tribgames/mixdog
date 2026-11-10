import './usage-test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import {
  buildSessionDaysStep,
  prepareSessionDays,
  readSessionUsage,
  readUsageToken,
  sessionDaysComplete,
} from './usage-ledger-rollup.mjs';
import { warmCatalogForTest } from './catalog-warm.fixture.mjs';
import * as modelCatalog from './model-catalog.mjs';
await warmCatalogForTest(modelCatalog);

const now = new Date(2026, 8, 12, 12).getTime();
let serial = 0;
const record = (extra = {}) =>
  makeUsageRecord({
    ts: now,
    provider: 'anthropic-oauth',
    model: 'claude-opus-4-8',
    sessionId: 'lead',
    sourceType: 'lead',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    durationMs: 2000,
    responseId: `r-${serial++}`,
    ...extra,
  });
const SONNET = { model: 'claude-sonnet-4-6' };

/** The per-session sums rebuilt from the records alone: what the table must equal. */
const REBUILT = `SELECT e.session AS session,e.day AS day,e.route AS route,COUNT(*) AS turns,SUM(e.input) AS input,
    SUM(e.output) AS output,SUM(e.cache_read) AS cache_read,SUM(e.cache_write) AS cache_write,
    SUM(COALESCE(e.cost_usd,0)) AS cost_usd,SUM(e.duration_ms) AS duration_ms,
    SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END) AS speed_output,
    SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END) AS speed_ms,
    json_extract(r.signature,'$[0]') AS provider,json_extract(r.signature,'$[1]') AS model
  FROM usage_events e JOIN usage_routes r ON r.id=e.route GROUP BY e.session,e.day,e.route ORDER BY session,day,route`;
const TABLE = `SELECT * FROM usage_session_days WHERE turns<>0 ORDER BY session,day,route`;
const close = (left, right, label) => {
  assert.equal(left.length, right.length, `${label}: rows`);
  left.forEach((row, index) => {
    for (const [key, value] of Object.entries(row)) {
      if (key === 'cost_usd') assert.ok(Math.abs(value - right[index][key]) < 1e-9, `${label} ${key}`);
      else assert.equal(value, right[index][key], `${label} ${key}`);
    }
  });
};

function assertSumsMatchRecords(ledger, label) {
  close(ledger.db.prepare(TABLE).all(), ledger.db.prepare(REBUILT).all(), label);
}

/** The read run on sums rebuilt from the records, for the same ids. */
function fullRead(ledger, ids, owners) {
  const db = ledger.db;
  db.exec('BEGIN');
  try {
    db.exec(
      `DELETE FROM usage_session_days; INSERT INTO usage_session_days ${REBUILT.replace(' ORDER BY session,day,route', '')}`
    );
    return readSessionUsage(db, ids, owners);
  } finally {
    db.exec('ROLLBACK');
  }
}

function assertSameRead(ledger, ids, owners, label) {
  const incremental = readSessionUsage(ledger.db, ids, owners);
  const full = fullRead(ledger, ids, owners);
  for (const [key, value] of Object.entries(incremental)) {
    if (key.startsWith('cost')) assert.ok(Math.abs(value - full[key]) < 1e-9, `${label} ${key}`);
    else assert.equal(value, full[key], `${label} ${key}`);
  }
  return incremental;
}

const READS = [
  [['lead'], []],
  [['lead'], ['lead']],
  [['agent-1', 'agent-2'], ['lead']],
  [['agent-1'], []],
  [['nested'], []],
  [['agent-3'], []],
  [['agent-3'], ['other-lead']],
  [[], ['other-lead']],
];
const assertAllReads = (ledger, label) =>
  READS.forEach(([ids, owners], index) => assertSameRead(ledger, ids, owners, `${label} #${index}`));

test('per-session sums equal the records through supersession, nesting, ownership changes, edits and deletes', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record([
    record(),
    record({ responseId: 'lead-2' }),
    // A gateway summary of a model nothing else covers that day counts...
    record({ ...SONNET, sessionId: 'agent-1', ownerSessionId: 'lead', origin: 'gateway', sourceType: 'agent' }),
    // ...a nested agent, linked only through its parent...
    record({ sessionId: 'nested', ownerSessionId: 'agent-1', sourceType: 'agent' }),
    // ...a session first recorded for one Lead keeps that Lead when another claims it later...
    record({ sessionId: 'agent-3', ownerSessionId: 'other-lead', sourceType: 'agent' }),
    record({ sessionId: 'agent-3', ownerSessionId: 'lead', sourceType: 'agent' }),
    // ...and calls without provider usage or without a price stay unmeasured / unpriced.
    record({
      sessionId: 'agent-1',
      ownerSessionId: 'lead',
      inputTokens: null,
      inputTokensKnown: false,
      outputTokens: 7,
    }),
  ]);
  assertSumsMatchRecords(ledger, 'after inserts');
  assertAllReads(ledger, 'phase 1');
  const before = readSessionUsage(ledger.db, ['agent-1'], ['lead']);
  assert.equal(before.unmeasuredTurns >= 1, true);

  // The agent total of the Lead: agent-1's gateway summary, its unmeasured call and the nested agent; not agent-3.
  const leadAgents = (ids = []) => readSessionUsage(ledger.db, ids, ['lead']);
  const withSummary = leadAgents();
  assert.equal(withSummary.turns, 3);

  // A detail record of the same model and day supersedes the summary for everyone.
  ledger.record([
    record({ ...SONNET, sessionId: 'agent-2', ownerSessionId: 'lead', sourceType: 'agent', inputTokens: 2000 }),
  ]);
  assertSumsMatchRecords(ledger, 'after supersession');
  assertAllReads(ledger, 'phase 2');
  const superseded = leadAgents();
  assert.equal(superseded.turns, 3, 'nested + unmeasured call + agent-2 detail; the summary is gone');
  assert.equal(superseded.input, withSummary.input + 1000, 'the summarised 1000 input is replaced by the detail 2000');
  assert.equal(readSessionUsage(ledger.db, ['agent-1'], []).turns, 1, 'agent-1 keeps only its own measured-route call');

  // A repair rewrites a record's route and cost; a delete removes one.
  const target = ledger.db
    .prepare("SELECT e.id FROM usage_events e JOIN usage_sessions s ON s.id=e.session WHERE s.value='nested'")
    .get();
  const otherRoute = ledger.db.prepare('SELECT id FROM usage_routes ORDER BY id DESC LIMIT 1').get();
  ledger.db.prepare('UPDATE usage_events SET route=?,cost_usd=? WHERE id=?').run(otherRoute.id, 0.5, target.id);
  assertSumsMatchRecords(ledger, 'after repair');
  assertAllReads(ledger, 'phase 3');
  const gone = ledger.db
    .prepare("SELECT e.id FROM usage_events e JOIN usage_sessions s ON s.id=e.session WHERE s.value='lead' LIMIT 1")
    .get();
  ledger.db.prepare('DELETE FROM usage_events WHERE id=?').run(gone.id);
  assertSumsMatchRecords(ledger, 'after delete');
  assertAllReads(ledger, 'phase 4');
  assert.equal(readSessionUsage(ledger.db, ['lead'], []).turns, 1);
});

/** A ledger as an older build left it: records, but none of the session sums or the revision. */
function makeLegacy(db) {
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'session_days_%' OR name LIKE 'key_revision_%' OR name LIKE 'membership_%')"
    )
    .all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  db.exec(`DROP TABLE usage_session_days; DROP TABLE usage_session_days_state; DROP TABLE usage_session_revisions;
    DROP TABLE usage_key_revisions; DROP TABLE usage_membership_revision`);
}

const legacyRows = () => [
  record(),
  record({ sessionId: 'agent-1', ownerSessionId: 'lead', ...SONNET, origin: 'gateway' }),
  record({ sessionId: 'agent-2', ownerSessionId: 'lead', ...SONNET }),
  record({ sessionId: 'nested', ownerSessionId: 'agent-1' }),
  record({ sessionId: 'agent-3', ownerSessionId: 'lead' }),
];

test('a ledger written before the sums existed is prepared without building, then built in short steps while writes continue', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record(legacyRows());
  const expected = ledger.db.prepare(TABLE).all();
  const read = readSessionUsage(ledger.db, ['lead'], ['lead']);
  makeLegacy(ledger.db);

  prepareSessionDays(ledger.db);
  assert.equal(sessionDaysComplete(ledger.db), false, 'preparing never builds');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_session_days').get().n, 0);
  assert.throws(() => readSessionUsage(ledger.db, ['lead'], []), /still building/);

  // One session per step; a write lands between every two steps: to a session already built, one not yet, a new one.
  const writes = [
    record({ sessionId: 'lead' }),
    record({ sessionId: 'nested', ownerSessionId: 'agent-1' }),
    record({ sessionId: 'late', ownerSessionId: 'lead' }),
    record({ sessionId: 'agent-3', ownerSessionId: 'lead' }),
  ];
  let steps = 0;
  while (!buildSessionDaysStep(ledger.db, 1)) {
    steps += 1;
    if (writes.length) ledger.record([writes.shift()]);
  }
  assert.ok(steps >= 4, 'the build took several transactions');
  while (writes.length) ledger.record([writes.shift()]);
  assertSumsMatchRecords(ledger, 'built under writes');
  assert.equal(sessionDaysComplete(ledger.db), true);
  assert.ok(readSessionUsage(ledger.db, ['lead'], ['lead']).turns > read.turns);
  // Building again, or a step after completion, changes nothing.
  assert.equal(buildSessionDaysStep(ledger.db), true);
  assertSumsMatchRecords(ledger, 'built twice');
  assert.ok(expected.length > 0);
});

test('a ledger opened on the main thread is never built there; the ledger worker builds it before the first read answers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-days-'));
  const path = join(dir, 'ledger.sqlite');
  const seeded = new UsageLedger(path);
  seeded.record(legacyRows());
  const read = readSessionUsage(seeded.db, ['lead'], ['lead']);
  makeLegacy(seeded.db);
  seeded.close();

  const ledger = new UsageLedger(path);
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.equal(sessionDaysComplete(ledger.db), false, 'opening the ledger did not build the sums');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_session_days').get().n, 0);
  // A write and a read arrive while it is unbuilt: both are served, the read after the build.
  const written = ledger.recordQueued(record({ sessionId: 'agent-3', ownerSessionId: 'lead' }));
  const answered = await ledger.sessionUsageAsync(['lead'], ['lead']);
  await written;
  assert.equal(sessionDaysComplete(ledger.db), true);
  assert.equal(answered.turns, read.turns + 1, 'the read holds the write that arrived beside it');
  assertSumsMatchRecords(ledger, 'built by the worker');
});

test('the sums stay exact under any statement form, whatever a connection sets', (t) => {
  for (const recursive of ['OFF', 'ON']) {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-days-forms-'));
    const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
    t.after(() => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const events = record({ inputTokens: 20 });
    ledger.record([events]);
    // Another connection, as another process or an older build would write.
    const other = new DatabaseSync(join(dir, 'ledger.sqlite'));
    other.exec(`PRAGMA recursive_triggers=${recursive}; PRAGMA foreign_keys=ON`);
    const stored = other.prepare('SELECT * FROM usage_events').get();
    const again = (verb, input) =>
      other
        .prepare(`${verb} INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(stored.id, stored.ts, stored.day, stored.route, stored.session, input, 0, 0, 0, 0, 0);
    again('INSERT OR REPLACE', 10);
    again('INSERT OR IGNORE', 30);
    again('REPLACE', 40);
    again('INSERT OR REPLACE', stored.input);
    assert.throws(
      () => other.prepare('UPDATE usage_events SET id=?').run(Buffer.from('another')),
      /id does not change/
    );
    other.prepare('UPDATE OR REPLACE usage_events SET input=input').run();
    const { turns, input } = other.prepare('SELECT turns,input FROM usage_session_days').get();
    assert.deepEqual([turns, input], [1, stored.input], `recursive_triggers=${recursive}`);
    assert.equal(
      other.prepare('SELECT input FROM usage_events').get().input,
      stored.input,
      'the stored record is the first'
    );
    other.close();
    assertSumsMatchRecords(ledger, `forms ${recursive}`);
  }
});

test('deleting the last record of a session the build has not reached leaves its sums at zero, not below', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record([
    record({ sessionId: 's1' }),
    record({ sessionId: 's2', inputTokens: 20 }),
    record({ sessionId: 's3' }),
  ]);
  makeLegacy(ledger.db);
  prepareSessionDays(ledger.db);
  // Session 1 is built; 2 and 3 are not.
  assert.equal(buildSessionDaysStep(ledger.db, 1), false);
  const second = ledger.db
    .prepare("SELECT e.id FROM usage_events e JOIN usage_sessions s ON s.id=e.session WHERE s.value='s2'")
    .get();
  ledger.db.prepare('DELETE FROM usage_events WHERE id=?').run(second.id);
  // A new record for the unbuilt session 3 lands between steps too.
  ledger.record([record({ sessionId: 's3' })]);
  while (!buildSessionDaysStep(ledger.db, 1));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_session_days WHERE turns<=0 OR input<0').get().n, 0);
  assertSumsMatchRecords(ledger, 'after the delete');
  assert.equal(readSessionUsage(ledger.db, ['s2'], []).turns, 0);
  assert.equal(readSessionUsage(ledger.db, ['s3'], []).turns, 2);
});

/** A lead with an agent and a nested agent, another Lead with its own, on the same day and model. */
function groupsLedger(t, extra = []) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record([
    record(),
    record({ sessionId: 'agent-1', ownerSessionId: 'lead' }),
    record({ sessionId: 'nested', ownerSessionId: 'agent-1' }),
    record({ sessionId: 'other', ownerSessionId: 'other-lead' }),
    ...extra,
  ]);
  return ledger;
}
const token = (ledger) => readUsageToken(ledger.db, ['lead', 'agent-1'], ['lead']);

test('a group token moves with its Lead, its agents at any depth and its ownership, not with other sessions on the same day and model', (t) => {
  const ledger = groupsLedger(t);
  const quiet = token(ledger);
  // Unrelated sessions commit to the very same day, provider and model.
  ledger.record([
    record({ sessionId: 'other' }),
    record({ sessionId: 'busy-1', ownerSessionId: 'other-lead' }),
    record({ sessionId: 'busy-2' }),
  ]);
  assert.equal(token(ledger), quiet, 'unrelated commits leave it alone');
  assert.equal(readUsageToken(ledger.db, ['lead'], ['lead']), readUsageToken(ledger.db, ['lead'], ['lead']));

  const moves = (change, label) => {
    const before = token(ledger);
    change();
    assert.notEqual(token(ledger), before, label);
  };
  moves(() => ledger.record([record({ sessionId: 'lead' })]), 'the Lead records');
  moves(() => ledger.record([record({ sessionId: 'agent-1', ownerSessionId: 'lead' })]), 'a listed agent records');
  moves(() => ledger.record([record({ sessionId: 'nested', ownerSessionId: 'agent-1' })]), 'a nested agent records');
  moves(
    () => ledger.record([record({ sessionId: 'agent-1', inputTokens: null, inputTokensKnown: false })]),
    'an unmeasured response'
  );
  moves(() => ledger.record([record({ sessionId: 'new-agent', ownerSessionId: 'agent-1' })]), 'a new agent joins');
  moves(
    () => ledger.db.prepare("UPDATE usage_sessions SET value='renamed' WHERE value='nested'").run(),
    'a session is renamed'
  );
  const afterRename = token(ledger);
  assert.equal(token(ledger), afterRename);
});

test("another Lead's detail that supersedes this group's gateway summary moves its token, a lower-priority record does not", (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record([record({ ...SONNET, sessionId: 'agent-1', ownerSessionId: 'lead', origin: 'gateway' })]);
  const mine = () => readUsageToken(ledger.db, ['lead', 'agent-1'], ['lead']);
  const before = mine();
  assert.equal(readSessionUsage(ledger.db, ['agent-1'], []).turns, 1);
  // A summary of the same rank from elsewhere changes nothing for this group.
  ledger.record([record({ ...SONNET, sessionId: 'x', ownerSessionId: 'lead-b', origin: 'gateway' })]);
  assert.equal(mine(), before);
  // A detail from another Lead supersedes it.
  ledger.record([record({ ...SONNET, sessionId: 'elsewhere', ownerSessionId: 'lead-b' })]);
  assert.equal(readSessionUsage(ledger.db, ['agent-1'], []).turns, 0);
  const superseded = mine();
  assert.notEqual(superseded, before, 'the numbers fell and the token moved');
  // More details of the same rank leave the selection, and the token, as it is.
  ledger.record([record({ ...SONNET, sessionId: 'elsewhere', ownerSessionId: 'lead-b' })]);
  assert.equal(mine(), superseded);
  // The selection falling back when the superseding rows go is a change as well.
  ledger.db.exec("DELETE FROM daily WHERE rank=0 AND model='claude-sonnet-4-6'");
  assert.notEqual(mine(), superseded);
});

test('a record rewritten to another route moves the tokens of groups sitting on both route keys', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  ledger.record([
    record({ ...SONNET, sessionId: 'agent-1', ownerSessionId: 'lead', origin: 'gateway' }),
    record({ ...SONNET, sessionId: 'elsewhere', ownerSessionId: 'lead-b' }),
    record({ sessionId: 'agent-2', ownerSessionId: 'lead-c' }),
  ]);
  const group = (...ids) => readUsageToken(ledger.db, ids, [ids[0]]);
  const sonnetGroup = group('agent-1');
  const opusGroup = group('agent-2');
  const target = ledger.db
    .prepare("SELECT e.id FROM usage_events e JOIN usage_sessions s ON s.id=e.session WHERE s.value='elsewhere'")
    .get();
  const opusRoute = ledger.db
    .prepare("SELECT route FROM usage_events e JOIN usage_sessions s ON s.id=e.session WHERE s.value='agent-2'")
    .get();
  ledger.db.prepare('UPDATE usage_events SET route=? WHERE id=?').run(opusRoute.route, target.id);
  assert.notEqual(group('agent-1'), sonnetGroup, 'the old key');
  assert.notEqual(group('agent-2'), opusGroup, 'the new key');
  assertSumsMatchRecords(ledger, 'after the move');
  // A route definition rewritten in place to another model carries its sums with it.
  const before = group('agent-2');
  ledger.db.exec(
    "UPDATE usage_routes SET signature=json_set(signature,'$[1]','rewritten-model') WHERE id=" + opusRoute.route
  );
  assertSumsMatchRecords(ledger, 'after the rewrite');
  assert.notEqual(group('agent-2'), before, 'a rewritten route definition moves every group');
});
