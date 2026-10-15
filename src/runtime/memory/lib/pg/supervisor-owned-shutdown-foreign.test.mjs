import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root: the supervisor only ever reads/writes this run's advert.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-foreign-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
delete process.env.MIXDOG_PG_ATTACH_ONLY;
delete process.env.MIXDOG_MEMORY_SECONDARY;

const dataDir = join(directory, 'data');
const pgdata = join(dataDir, 'pgdata');
const runtimeDir = join(directory, 'pg-runtime');
const RUNNING_PORT = 55499;
mkdirSync(dataDir, { recursive: true });

const calls = { start: 0, stop: 0, stopSync: 0 };
mock.module('./process.mjs', {
  namedExports: {
    startPg: async () => {
      calls.start += 1;
      throw new Error('a running cluster must be re-attached, not started');
    },
    stopPg: async () => {
      calls.stop += 1;
    },
    stopPgSync: () => {
      calls.stopSync += 1;
    },
    healthcheckPg: async ({ port }) => port === RUNNING_PORT,
    reconcileConfV2: async () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: async () => 0,
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir }) },
});

// The cluster is already up, advertised by another live process (the parent
// test runner stands in for the memory runtime that started it).
const advertFile = join(directory, 'runtime', 'discovery', 'pg.json');
mkdirSync(join(directory, 'runtime', 'discovery'), { recursive: true });
writeFileSync(
  advertFile,
  JSON.stringify({
    pg_port: RUNNING_PORT,
    pg_pgdata: pgdata,
    pg_runtime_dir: runtimeDir,
    pg_owner_pid: process.ppid,
    updatedAt: 1,
  })
);

const { ensurePgInstance, stopOwnedPgForShutdown, stopOwnedPgForShutdownSync } = await import('./supervisor.mjs');

test.after(() => rmSync(directory, { recursive: true, force: true }));

test("a re-attached cluster another live process owns is left running by this process's shutdown", async () => {
  const attached = await ensurePgInstance(dataDir);
  assert.equal(attached.port, RUNNING_PORT, 're-attached to the running cluster');
  assert.equal(calls.start, 0);
  assert.equal(JSON.parse(readFileSync(advertFile, 'utf8')).pg_owner_pid, process.ppid, 'ownership unchanged');

  assert.equal(await stopOwnedPgForShutdown({ timeoutMs: 3_000 }), false);
  stopOwnedPgForShutdownSync();
  assert.deepEqual(calls, { start: 0, stop: 0, stopSync: 0 });
  assert.equal(existsSync(advertFile), true, 'the owner keeps its advert');
});
