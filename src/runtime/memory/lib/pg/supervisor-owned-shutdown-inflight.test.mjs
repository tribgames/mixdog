import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root: the supervisor only ever reads/writes this run's advert.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-inflight-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
delete process.env.MIXDOG_PG_ATTACH_ONLY;
delete process.env.MIXDOG_MEMORY_SECONDARY;

const dataDir = join(directory, 'data');
const runtimeDir = join(directory, 'pg-runtime');
mkdirSync(dataDir, { recursive: true });

// pg_ctl start already spawned, readiness still pending when shutdown begins.
let releaseStart;
const startGate = new Promise((resolve) => {
  releaseStart = resolve;
});
let startReached;
const startCalled = new Promise((resolve) => {
  startReached = resolve;
});
const stops = [];
let livePort = null;
mock.module('./process.mjs', {
  namedExports: {
    startPg: async ({ port }) => {
      startReached();
      await startGate;
      livePort = port;
      return { pid: process.pid, port };
    },
    stopPg: async (args) => {
      stops.push(args);
      livePort = null;
    },
    stopPgSync: () => {},
    healthcheckPg: async ({ port }) => port === livePort,
    reconcileConfV2: async () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: async () => 0,
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir }) },
});

const { ensurePgInstance, stopOwnedPgForShutdown } = await import('./supervisor.mjs');

test.after(() => rmSync(directory, { recursive: true, force: true }));

test('a shutdown during a start in flight waits for it and stops the cluster it brought up', async () => {
  const starting = ensurePgInstance(dataDir);
  await startCalled;
  const stopping = stopOwnedPgForShutdown({ timeoutMs: 5_000 });
  releaseStart();
  await starting;
  assert.equal(await stopping, true);
  assert.equal(stops.length, 1, 'the just-started cluster was stopped');
});
