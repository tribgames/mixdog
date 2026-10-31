import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root + data dirs: nothing here touches a real PG instance
// or the user's data directory. startPg is mocked, so "spawning" is a counter.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-spawn-lock-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
delete process.env.MIXDOG_PG_ATTACH_ONLY;
delete process.env.MIXDOG_MEMORY_SECONDARY;

const startCalls = [];
mock.module('./process.mjs', {
  namedExports: {
    startPg: async (args) => {
      startCalls.push(args);
      return { port: args.port };
    },
    stopPg: async () => {},
    stopPgSync: () => {},
    healthcheckPg: async () => false,
    reconcileConfV2: () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: async () => 0,
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir: join(directory, 'pg-runtime') }) },
});

function newDataDir(name) {
  const dataDir = join(directory, name);
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

test('an empty pg-spawn.lock left by a crash does not block the spawn path', async (t) => {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { ensurePgInstance } = await import('./supervisor.mjs');
  const dataDir = newDataDir('empty-lock');
  const lockPath = join(dataDir, 'pg-spawn.lock');
  writeFileSync(lockPath, '');
  // Age the 0-byte lock past the stale window, as a crash from a previous run would.
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);

  const result = await ensurePgInstance(dataDir);
  assert.equal(startCalls.length, 1, 'startPg ran despite the stale empty lock');
  assert.equal(result.pgdataDir, join(dataDir, 'pgdata'));
  assert.equal(existsSync(lockPath), false, 'the lock is released after the spawn');
});

test('a pg-spawn.lock held by a live owner still excludes the spawn', async () => {
  const { ensurePgInstance } = await import('./supervisor.mjs');
  const dataDir = newDataDir('live-lock');
  const lockPath = join(dataDir, 'pg-spawn.lock');
  // This test process is a live owner (pid + foreign token), so it is never reclaimed.
  writeFileSync(lockPath, `${process.pid} ${Date.now()} foreign-owner-token\n`);
  const before = startCalls.length;

  const pending = ensurePgInstance(dataDir);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(startCalls.length, before, 'startPg must wait for the live owner');

  rmSync(lockPath);
  await pending;
  assert.equal(startCalls.length, before + 1, 'the spawn proceeds once the owner releases');
});

test('an aged legacy JSON pg-spawn.lock naming a live owner excludes the lock', async () => {
  const { withFileLock } = await import('../../../shared/file-lock.mjs');
  const dataDir = newDataDir('legacy-json-lock');
  const lockPath = join(dataDir, 'pg-spawn.lock');
  // v1.4.2 writer format, aged past the 30s stale window, owner still alive.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 120_000 }));
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);

  let entered = false;
  await assert.rejects(
    withFileLock(
      lockPath,
      () => {
        entered = true;
      },
      { timeoutMs: 400 }
    ),
    { code: 'ELOCKTIMEOUT' }
  );
  assert.equal(entered, false, 'a second owner must not enter while the legacy owner is alive');
  assert.equal(existsSync(lockPath), true, 'the live legacy lock is left in place');
});
