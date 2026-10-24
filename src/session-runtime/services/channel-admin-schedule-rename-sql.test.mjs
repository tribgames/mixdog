import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A rename through the production store (schedules-db.mjs renameSchedule): its
// UPDATE runs against an in-memory scheduler.schedules table that evaluates
// the statement's own SET clause, so the cursor and run state a rename keeps
// are the ones the shipped SQL keeps.
const table = new Map();

/** A CASE condition: `$n::boolean` or `<value> IS NOT NULL`. */
function condition(text, row, params) {
  const notNull = /^(.+) IS NOT NULL$/.exec(text);
  if (notNull) return evaluate(notNull[1], row, params) != null;
  return evaluate(text, row, params) === true;
}

/** One SET expression of the statement: a parameter, a literal, the row's
 *  own column, or `CASE WHEN c THEN a [WHEN c THEN b ...] ELSE z END`. */
function evaluate(expr, row, params) {
  let match = /^CASE (.+) ELSE (.+) END$/.exec(expr);
  if (match) {
    for (const branch of match[1].split(/(?=WHEN )/)) {
      const [, when, then] = /^WHEN (.+?) THEN (.+?)\s*$/.exec(branch);
      if (condition(when, row, params)) return evaluate(then, row, params);
    }
    return evaluate(match[2], row, params);
  }
  match = /^\$(\d+)(::\w+)?$/.exec(expr);
  if (match) return params[match[1] - 1];
  if (expr === 'NULL') return null;
  if (expr === 'now()') return new Date();
  match = /^'(.*)'$/.exec(expr);
  if (match) return match[1];
  if (/^\w+$/.test(expr) && Object.hasOwn(row, expr)) return row[expr];
  throw new Error(`unsupported SQL expression: ${expr}`);
}

const db = {
  exec: async () => {},
  query: async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM scheduler\.schedules WHERE name = \$1$/.test(text)) {
      const row = table.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    const update = /^UPDATE scheduler\.schedules SET (.*) WHERE name = \$1 RETURNING /.exec(text);
    if (update) {
      const row = table.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      const next = { ...row };
      for (const assignment of update[1].split(',')) {
        const [, column, expr] = /^\s*(\w+) = (.+?)\s*$/.exec(assignment);
        next[column] = evaluate(expr, row, params);
      }
      if (next.name !== row.name && table.has(next.name)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      table.delete(row.name);
      table.set(next.name, next);
      return { rows: [{ ...next }], rowCount: 1 };
    }
    throw new Error(`unexpected statement: ${text}`);
  },
};
const pgAdapter = await import('../../runtime/memory/lib/pg/adapter.mjs');
mock.module('../../runtime/memory/lib/pg/adapter.mjs', {
  namedExports: {
    ...pgAdapter,
    ensurePgInstance: async () => ({ db, pool: {} }),
    withSchemaBootstrapLock: async (_pool, fn) => fn(),
    pgClusterExists: () => true,
  },
});
const owner = await import('../routine-owner.mjs');
const probe = { mixyExists: () => true, presence: () => 'present' };
mock.module('../routine-owner.mjs', {
  namedExports: {
    ...owner,
    routineOwnerProblem: (id) => owner.routineOwnerProblem(id, probe),
    assertRoutineOwner: (id) => owner.assertRoutineOwner(id, probe),
  },
});
const { saveSchedule } = await import('./channel-admin.mjs');

const AT = new Date('2030-01-02T03:04:05.678Z');
const FIRED = new Date('2030-01-02T03:04:06.000Z');
const LATER = new Date('2030-01-02T04:00:00.000Z');

function seed(row) {
  table.clear();
  table.set(row.name, {
    description: '',
    when_at: null,
    when_cron: null,
    timezone: null,
    target: 'session',
    channel_id: null,
    cwd: null,
    attachments: null,
    delivery: 'app',
    prompt: 'Report',
    enabled: true,
    status: 'active',
    last_fired_at: null,
    last_scheduled_at: null,
    last_started_at: null,
    last_success_at: null,
    last_failed_at: null,
    last_skipped_at: null,
    owner_agent_id: 'lead',
    consecutive_failures: 0,
    result_delivery: null,
    next_fire_at: null,
    deferred_until: null,
    skipped_until: null,
    ...row,
  });
}

const rename = (name, newName, timing) =>
  saveSchedule({ name, newName, instructions: 'Report', overwrite: true, ...timing });

test('renaming a finished one-shot with its time untouched leaves it finished: no cursor, no re-run', async () => {
  seed({ name: 'once', when_at: AT, status: 'done', last_fired_at: FIRED, last_success_at: FIRED });
  const saved = await rename('once', 'renamed', { at: AT.toISOString() });
  assert.deepEqual([...table.keys()], ['renamed']);
  const row = table.get('renamed');
  assert.equal(row.status, 'done');
  assert.equal(row.next_fire_at, null, 'no next fire for a finished one-shot');
  assert.equal(row.last_fired_at, FIRED);
  assert.equal(row.last_success_at, FIRED);
  assert.equal(saved.nextFireAt, undefined);
});

test('renaming a deferred one-shot with its time untouched keeps the deferral', async () => {
  seed({ name: 'once', when_at: AT, next_fire_at: LATER, deferred_until: LATER });
  await rename('once', 'renamed', { at: AT.toISOString() });
  const row = table.get('renamed');
  assert.equal(row.next_fire_at, LATER, 'the cursor stays on the deferral');
  assert.equal(row.deferred_until, LATER);
  assert.equal(row.status, 'active');
});

test('renaming a one-shot to a new time re-arms it at that time', async () => {
  seed({ name: 'once', when_at: AT, status: 'done', last_fired_at: FIRED });
  await rename('once', 'renamed', { at: LATER.toISOString() });
  const row = table.get('renamed');
  assert.equal(row.status, 'active');
  assert.equal(row.next_fire_at.getTime(), LATER.getTime());
  assert.equal(row.last_fired_at, null);
});

test('a recurring schedule moved to another zone is re-armed; the same cron in the same zone is not', async () => {
  seed({ name: 'daily', when_cron: '0 9 * * *', timezone: 'Asia/Seoul', next_fire_at: LATER, last_scheduled_at: AT });
  await rename('daily', 'morning', { time: '0 9 * * *', timezone: 'Asia/Seoul' });
  let row = table.get('morning');
  assert.equal(row.next_fire_at, LATER, 'unchanged timing keeps the cursor');
  assert.equal(row.last_scheduled_at, AT);

  await rename('morning', 'early', { time: '0 9 * * *', timezone: 'UTC' });
  row = table.get('early');
  assert.equal(row.next_fire_at, null, 'the scheduler computes the next fire in the new zone');
  assert.equal(row.last_scheduled_at, null);
});

test('a stored recurring schedule without a zone runs in the default one, so a rename keeps its cursor', async () => {
  seed({ name: 'legacy', when_cron: '30 8 * * 1-5', next_fire_at: LATER, last_scheduled_at: AT });
  await rename('legacy', 'weekday', { time: '30 8 * * 1-5' });
  const row = table.get('weekday');
  assert.equal(row.next_fire_at, LATER);
  assert.equal(row.last_scheduled_at, AT);
});
