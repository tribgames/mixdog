import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Shutdown ordering: durable writes in flight commit before `pg_ctl stop`
// (bounded); derived writes (session search) are never waited on.
const events = [];
const logs = [];
const gates = new Map(); // sql tag → release()

mock.module('./supervisor.mjs', {
  namedExports: {
    ensurePgInstance: async () => ({ host: '127.0.0.1', port: 55432, runtimeDir: 'rt', pgdataDir: 'pgdata' }),
    stopOwnedPgForShutdown: async () => {
      events.push('stop');
      return true;
    },
    installOwnedPgExitStop: () => {},
    pgClusterExists: () => true,
  },
});
mock.module('../memory-log.mjs', {
  namedExports: { __mixdogMemoryLog: (line) => logs.push(String(line)) },
});

class FakePool {
  on() {}
  async connect() {
    return {
      query: async (sql) => {
        const tag = /\/\*(\w+)\*\//.exec(String(sql))?.[1];
        if (tag) {
          await new Promise((resolve) => gates.set(tag, resolve));
          events.push(`commit:${tag}`);
        }
        return { rows: [{}], rowCount: 1 };
      },
      release() {},
    };
  }
  end() {
    return Promise.resolve();
  }
}
mock.module('pg', { defaultExport: { Pool: FakePool } });

const { ensurePgInstance, shutdownOwnedPg, pendingDurablePgOps } = await import('./adapter.mjs');
const DATA = 'C:/mixdog-drain-test-data';
const turn = () => new Promise((resolve) => setImmediate(resolve));
/** The write tagged `tag` reached the server (its query is executing). */
async function untilExecuting(tag) {
  while (!gates.has(tag)) await turn();
}
/** Event-loop turns: a stop that did not wait (no I/O in these fakes) has run by then. */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await turn();
}

test('a durable write still in flight commits before PostgreSQL is stopped', async () => {
  events.length = 0;
  const { db } = await ensurePgInstance(DATA, { schema: 'scheduler' });
  const write = db.query('/*markDone*/ UPDATE scheduler.schedules SET status = $1', ['done']);
  await untilExecuting('markDone');
  assert.equal(pendingDurablePgOps(), 1);
  const stopping = shutdownOwnedPg({ timeoutMs: 6_000, drainMs: 2_000 });
  await settle(); // slow teardown write: the stop waits for it
  assert.deepEqual(events, []);
  gates.get('markDone')();
  await write;
  assert.equal(await stopping, true);
  assert.deepEqual(events, ['commit:markDone', 'stop']);
  assert.equal(pendingDurablePgOps(), 0);
});

test('a derived write (session search) is not waited on', async () => {
  events.length = 0;
  const { db } = await ensurePgInstance(DATA, { schema: 'session_search' });
  const write = db.query('/*ingest*/ INSERT INTO session_search.messages VALUES ($1)', ['x']);
  await untilExecuting('ingest');
  assert.equal(pendingDurablePgOps(), 0);
  assert.equal(await shutdownOwnedPg({ timeoutMs: 6_000, drainMs: 2_000 }), true);
  assert.deepEqual(events, ['stop']);
  gates.get('ingest')();
  await write;
});

test('a durable write outliving the drain bound: PG still stops, logged once', async () => {
  events.length = 0;
  logs.length = 0;
  const { db } = await ensurePgInstance(DATA, { schema: 'webhooks' });
  const write = db.query('/*delivery*/ UPDATE webhooks.deliveries SET status = $1', ['done']);
  await untilExecuting('delivery');
  // Resolves while the write can never finish on its own: the drain is bounded.
  assert.equal(await shutdownOwnedPg({ timeoutMs: 6_000, drainMs: 200 }), true);
  assert.equal(pendingDurablePgOps(), 1, 'the write is still in flight');
  assert.deepEqual(events, ['stop']);
  const stuck = logs.filter((line) => /durable operation\(s\) still in flight/.test(line));
  assert.equal(stuck.length, 1);
  gates.get('delivery')();
  await write;
});
