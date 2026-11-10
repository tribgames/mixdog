import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Isolated runtime root: the exit hook must only ever touch this run's advert.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-exit-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');

const stops = [];
mock.module('./process.mjs', {
  namedExports: {
    startPg: async () => {},
    stopPg: async () => {},
    stopPgSync: (args) => stops.push(args),
    healthcheckPg: async () => false,
    reconcileConfV2: () => ({ applied: false, reloaded: false }),
    sweepOrphanTempPostmasters: () => 0,
  },
});
mock.module('../runtime-fetcher.mjs', {
  namedExports: { ensureRuntime: async () => ({ runtimeDir: join(directory, 'pg-runtime') }) },
});

const advertFile = join(directory, 'runtime', 'discovery', 'pg.json');
function writeAdvert(ownerPid) {
  mkdirSync(join(directory, 'runtime', 'discovery'), { recursive: true });
  writeFileSync(
    advertFile,
    JSON.stringify({
      pg_port: 55432,
      pg_pgdata: join(directory, 'data'),
      pg_runtime_dir: join(directory, 'rt'),
      pg_owner_pid: ownerPid,
      updatedAt: 1,
    })
  );
}

test("exit-hook sync stop removes this run's pg.json along with the postmaster", async (t) => {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { stopPgForShutdown, stopPgForShutdownSync } = await import('./supervisor.mjs');
  writeAdvert(process.pid);
  await stopPgForShutdown(); // loads the process layer, as a real shutdown has
  stops.length = 0;

  writeAdvert(process.pid);
  stopPgForShutdownSync();
  assert.equal(stops.length, 1, 'the postmaster is stopped');
  assert.equal(existsSync(advertFile), false, 'the advert of the stopped postmaster is removed');

  // A dead owner's advert (a previous run) is a corpse and goes too.
  stops.length = 0;
  writeAdvert(2 ** 22 + 12345);
  stopPgForShutdownSync();
  assert.equal(existsSync(advertFile), false);

  // A different live owner's advert is neither stopped nor removed.
  stops.length = 0;
  writeAdvert(process.ppid);
  stopPgForShutdownSync();
  assert.equal(stops.length, 0);
  assert.equal(existsSync(advertFile), true, 'another live owner keeps its advert');
});
