import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root: the supervisor must never read or write the real
// discovery files, and attach-only mode stops ensure before any PG spawn.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-sweep-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
process.env.MIXDOG_PG_ATTACH_ONLY = '1';

const sweepCalls = [];
mock.module('./process.mjs', {
  namedExports: {
    startPg: async () => {
      throw new Error('startPg must not run in this test');
    },
    stopPg: async () => {},
    stopPgSync: () => {},
    healthcheckPg: async () => false,
    reconcileConfV2: () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: (...args) => {
      sweepCalls.push(args);
      return 0;
    },
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir: join(directory, 'pg-runtime') }) },
});

test('ensurePgInstance schedules an orphan sweep that reaches the process-layer sweeper', async (t) => {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const { ensurePgInstance } = await import('./supervisor.mjs');

  await assert.rejects(ensurePgInstance(join(directory, 'data')), /requires an existing PG instance/);
  assert.equal(sweepCalls.length, 0, 'the sweep is deferred off the ensure path');

  mock.timers.tick(30_000);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweepCalls.length, 1, 'the first sweep runs after its delay');

  mock.timers.tick(30 * 60_000);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweepCalls.length, 2, 'the sweep repeats on its interval');
});
