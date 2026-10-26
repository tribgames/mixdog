// A session's search writes run in the order they were issued, so a value a
// sensitive fill marked never comes back into the index through a plaintext
// write that was still in flight (session-search-ingest.mjs). The fake db keeps
// the stored rows, and one insert can be held to stand for a slow PG.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';

const SECRET = '682419';
/** source_ref → stored row */
const table = new Map();
const stamps = new Map();
/** Every content any insert was called with, in call order. */
const inserted = [];
const deletedSessions = [];
let transactions = 0;
let held = null;
let failNextInsert = null;

const db = {
  exec: async () => {},
  transaction: async (fn) => {
    transactions += 1;
    return fn({ query: (sql, params) => db.query(sql, params) });
  },
  query: async (sql, params) => {
    if (/INSERT INTO session_search\.messages/.test(sql)) {
      const [refs, sessionIds, ordinals, roles, ts, contents] = params;
      inserted.push(...contents);
      if (failNextInsert) {
        const error = failNextInsert;
        failNextInsert = null;
        throw error;
      }
      const hold = held;
      held = null;
      if (hold) {
        hold.started();
        await hold.gate;
      }
      refs.forEach((ref, index) => {
        if (table.has(ref)) return; // ON CONFLICT (source_ref) DO NOTHING
        table.set(ref, {
          source_ref: ref,
          session_id: sessionIds[index],
          ordinal: ordinals[index],
          role: roles[index],
          ts: ts[index],
          content: contents[index],
        });
      });
      return { rows: [], rowCount: refs.length };
    }
    if (/SELECT source_ref, ordinal, role, ts, content/.test(sql)) {
      const rows = [...table.values()].filter((row) => row.session_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (/DELETE FROM session_search\.messages WHERE source_ref/.test(sql)) {
      for (const ref of params[0]) table.delete(ref);
    }
    if (/DELETE FROM session_search\.messages WHERE session_id/.test(sql)) {
      deletedSessions.push(params[0]);
      for (const [ref, row] of table) if (row.session_id === params[0]) table.delete(ref);
    }
    if (/INSERT INTO session_search\.backfill/.test(sql)) stamps.set(params[0], params[1]);
    if (/SELECT session_id, stamp/.test(sql)) {
      return { rows: [...stamps].map(([session_id, stamp]) => ({ session_id, stamp })), rowCount: stamps.size };
    }
    if (/SELECT DISTINCT session_id/.test(sql)) {
      const ids = new Set([...[...table.values()].map((row) => row.session_id), ...stamps.keys()]);
      return { rows: [...ids].map((session_id) => ({ session_id })), rowCount: ids.size };
    }
    return { rows: [], rowCount: 0 };
  },
};
mock.module('../memory/lib/pg/adapter.mjs', {
  namedExports: {
    ensurePgInstance: async () => ({ db, pool: {} }),
    withSchemaBootstrapLock: async (_pool, fn) => fn(),
  },
});
mock.module('../shared/plugin-paths.mjs', {
  namedExports: { resolvePluginData: () => '/resolved-plugin-data' },
});

const { ingestSessionTurn, forgetSessionSearch, backfillSessionSearch } = await import('./session-search-ingest.mjs');
const { rememberSensitiveValues } = await import('../agent/orchestrator/session/sensitive-values.mjs');

function reset() {
  table.clear();
  stamps.clear();
  inserted.length = 0;
  deletedSessions.length = 0;
  transactions = 0;
  held = null;
  failNextInsert = null;
}

/** The next insert reaches the db (`started`) and lands only at `release()`. */
function holdNextInsert() {
  const hold = {};
  const started = new Promise((resolve) => (hold.started = resolve));
  const gate = new Promise((resolve) => (hold.release = resolve));
  hold.gate = gate;
  held = hold;
  return { started, release: hold.release };
}

/** Every write here waits only on the fake db, which settles on microtasks, so
 *  one macrotask turn lets all the writes that can run finish. */
const settled = () => nextMacrotask();

const mark = (id) =>
  rememberSensitiveValues(id, [
    { name: 'browser', arguments: { action: 'fill', input: { ref: 'p1-s1-e3', text: SECRET, sensitive: true } } },
  ]);
const contentsOf = (id) =>
  [...table.values()]
    .filter((row) => row.session_id === id)
    .map((row) => row.content)
    .sort();
const sessionOf = (id, ...texts) => ({
  id,
  agent: 'lead',
  messages: texts.map((content, index) => ({ role: index % 2 ? 'assistant' : 'user', content })),
});
const CODE = `The code is ${SECRET}.`;
const REDACTED = 'The code is [redacted].';

test('a plaintext append delayed past a redaction still ends redacted', async () => {
  reset();
  const id = 'sess_order_race';
  const session = sessionOf(id, 'Finish the sign-up.', CODE);
  const hold = holdNextInsert();
  ingestSessionTurn(session);
  await hold.started;

  mark(id);
  ingestSessionTurn(session);
  await settled();
  assert.equal(transactions, 0, 'the redaction waits for the append in flight');
  assert.deepEqual(contentsOf(id), []);

  hold.release();
  await settled();
  assert.equal(transactions, 1);
  assert.deepEqual(contentsOf(id), ['Finish the sign-up.', REDACTED]);
});

test('a write issued after a redaction is redacted', async () => {
  reset();
  const id = 'sess_order_after';
  mark(id);
  ingestSessionTurn(sessionOf(id, 'Finish the sign-up.', CODE));
  await settled();
  ingestSessionTurn(sessionOf(id, 'Finish the sign-up.', CODE, `Enter ${SECRET} now.`));
  await settled();
  assert.deepEqual(contentsOf(id), ['Enter [redacted] now.', 'Finish the sign-up.', REDACTED]);
  assert.ok(!inserted.some((content) => content.includes(SECRET)), 'no write ever carried it');
});

test('a write queued before a redaction is redacted with the values known when it runs', async () => {
  reset();
  const id = 'sess_order_queued';
  const hold = holdNextInsert();
  ingestSessionTurn(sessionOf(id, 'Finish the sign-up.'));
  await hold.started;

  ingestSessionTurn(sessionOf(id, 'Finish the sign-up.', CODE));
  mark(id);
  hold.release();
  await settled();
  assert.deepEqual(contentsOf(id), ['Finish the sign-up.', REDACTED]);
  assert.ok(!inserted.some((content) => content.includes(SECRET)), 'no write ever carried it');
});

test('a backfill of a session and a redaction of it run in the order issued', async () => {
  reset();
  const id = 'sess_order_backfill';
  const session = sessionOf(id, 'Finish the sign-up.', CODE);
  const dir = mkdtempSync(join(tmpdir(), 'ss-order-'));
  try {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(session));
    const deps = { dir, readSession: (d, file) => JSON.parse(readFileSync(join(d, file), 'utf-8')) };
    const hold = holdNextInsert();
    const backfill = backfillSessionSearch({ deps });
    await hold.started;

    mark(id);
    ingestSessionTurn(session);
    await settled();
    assert.equal(transactions, 0, 'the redaction waits for the backfill write');

    hold.release();
    assert.equal(await backfill, 1);
    await settled();
    assert.equal(transactions, 1);
    assert.deepEqual(contentsOf(id), ['Finish the sign-up.', REDACTED]);
    assert.equal(stamps.has(id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed write is reported and does not block the next write of the session', async () => {
  reset();
  const id = 'sess_order_failed';
  failNextInsert = new Error('pg down');
  const reported = [];
  const stderr = mock.method(process.stderr, 'write', (chunk) => {
    reported.push(String(chunk));
    return true;
  });
  try {
    ingestSessionTurn(sessionOf(id, 'first question'));
    ingestSessionTurn(sessionOf(id, 'first question', 'its answer'));
    await settled();
  } finally {
    stderr.mock.restore();
  }
  assert.deepEqual(reported, [`[session-search] ingest ${id} failed: pg down\n`]);
  assert.deepEqual(contentsOf(id), ['first question', 'its answer']);
});

test("one session's slow write does not hold up another session", async () => {
  reset();
  const hold = holdNextInsert();
  ingestSessionTurn(sessionOf('sess_order_slow', 'slow one'));
  await hold.started;

  ingestSessionTurn(sessionOf('sess_order_other', 'other one'));
  await settled();
  assert.deepEqual(contentsOf('sess_order_other'), ['other one']);
  assert.deepEqual(contentsOf('sess_order_slow'), []);

  hold.release();
  await settled();
  assert.deepEqual(contentsOf('sess_order_slow'), ['slow one']);
});

test('a delete runs after the session writes issued before it', async () => {
  reset();
  const id = 'sess_order_delete';
  const hold = holdNextInsert();
  ingestSessionTurn(sessionOf(id, 'to be forgotten'));
  await hold.started;

  const forgotten = forgetSessionSearch(id);
  await settled();
  assert.deepEqual(deletedSessions, [], 'the delete waits for the write in flight');

  hold.release();
  await forgotten;
  assert.deepEqual(deletedSessions, [id]);
  assert.deepEqual(contentsOf(id), []);
});
