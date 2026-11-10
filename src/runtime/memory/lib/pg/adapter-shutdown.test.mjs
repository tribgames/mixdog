import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// The daemon's PostgreSQL stop must not wait on its pools: a pool holding a
// checked-out client (pool.end() pending) never delays `pg_ctl stop -m fast`.
const events = [];
let poolEndRelease;
const poolEndPending = new Promise((resolve) => {
  poolEndRelease = resolve;
});

mock.module('./supervisor.mjs', {
  namedExports: {
    ensurePgInstance: async () => ({ host: '127.0.0.1', port: 55432, runtimeDir: 'rt', pgdataDir: 'pgdata' }),
    stopOwnedPgForShutdown: async ({ timeoutMs }) => {
      events.push(`stop:${timeoutMs}`);
      return true;
    },
    installOwnedPgExitStop: () => {},
    pgClusterExists: () => true,
  },
});

class FakePool {
  constructor(options) {
    this.admin = options.max === 1;
  }
  on() {}
  async connect() {
    return { query: async () => ({ rows: [{}] }), release() {} };
  }
  end() {
    if (this.admin) return Promise.resolve();
    events.push('pool:end');
    return poolEndPending; // a checked-out client keeps the pool open
  }
}
mock.module('pg', { defaultExport: { Pool: FakePool } });

const { ensurePgInstance, shutdownOwnedPg, POOL_CLOSE_BOUND_MS } = await import('./adapter.mjs');

test('the owned PostgreSQL stop proceeds while pools close slowly, and their close is bounded', async () => {
  await ensurePgInstance('C:/mixdog-test-data', { schema: 'scheduler' });
  assert.ok(POOL_CLOSE_BOUND_MS > 0);
  // Resolves while the pool's close can never finish on its own: its wait is
  // bounded (POOL_CLOSE_BOUND_MS).
  assert.equal(await shutdownOwnedPg({ timeoutMs: 6_000 }), true);
  assert.deepEqual(events, ['stop:6000', 'pool:end'], 'the stop is issued before the pools end');
  poolEndRelease();
});
