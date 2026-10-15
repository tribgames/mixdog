import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root: the supervisor only ever reads/writes this run's advert.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-owned-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
delete process.env.MIXDOG_PG_ATTACH_ONLY;
delete process.env.MIXDOG_MEMORY_SECONDARY;

const dataDir = join(directory, 'data');
const pgdata = join(dataDir, 'pgdata');
const runtimeDir = join(directory, 'pg-runtime');
mkdirSync(dataDir, { recursive: true });

// A fake process layer standing in for pg_ctl: one postmaster at a time.
const calls = { start: [], stop: [], stopSync: [] };
let livePort = null;
mock.module('./process.mjs', {
  namedExports: {
    startPg: async ({ pgdataDir, port }) => {
      calls.start.push({ pgdataDir, port });
      livePort = port;
      return { pid: process.pid, port };
    },
    stopPg: async (args) => {
      calls.stop.push(args);
      livePort = null;
    },
    stopPgSync: (args) => {
      calls.stopSync.push(args);
      livePort = null;
    },
    healthcheckPg: async ({ port }) => port === livePort,
    reconcileConfV2: async () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: async () => 0,
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir }) },
});

const advertFile = join(directory, 'runtime', 'discovery', 'pg.json');
const readAdvert = () => JSON.parse(readFileSync(advertFile, 'utf8'));

const { ensurePgInstance, stopOwnedPgForShutdown, stopOwnedPgForShutdownSync } = await import('./supervisor.mjs');

test.after(() => rmSync(directory, { recursive: true, force: true }));

test('the process that started a cluster stops it, on exit and on shutdown, and then refuses to restart it', async () => {
  // Never ensured: the exit hook has nothing of ours to stop.
  stopOwnedPgForShutdownSync();
  assert.equal(calls.stopSync.length, 0);

  const first = await ensurePgInstance(dataDir);
  assert.equal(calls.start.length, 1, 'this process started the cluster');
  assert.equal(readAdvert().pg_owner_pid, process.pid);

  // Last-chance exit hook: a synchronous pg_ctl stop of the started cluster.
  stopOwnedPgForShutdownSync();
  assert.deepEqual(calls.stopSync, [{ runtimeDir, pgdataDir: pgdata }]);
  assert.equal(existsSync(advertFile), false, 'the stopped cluster no longer advertises');

  // A later ensure starts it again (the next boot of the same data dir).
  const second = await ensurePgInstance(dataDir);
  assert.equal(calls.start.length, 2);
  assert.equal(second.pgdataDir, first.pgdataDir);

  // Graceful daemon shutdown: bounded pg_ctl stop -m fast of the started cluster.
  assert.equal(await stopOwnedPgForShutdown({ timeoutMs: 3_000 }), true);
  assert.deepEqual(calls.stop, [{ runtimeDir, pgdataDir: pgdata, timeoutMs: 3_000 }]);
  assert.equal(existsSync(advertFile), false);

  // Shutting down: a late connection-loss recovery must not bring it back.
  await assert.rejects(ensurePgInstance(dataDir), /shutting down/);
  assert.equal(calls.start.length, 2);

  // The exit hook after a completed graceful stop is a no-op.
  stopOwnedPgForShutdownSync();
  assert.equal(calls.stopSync.length, 1);
});
