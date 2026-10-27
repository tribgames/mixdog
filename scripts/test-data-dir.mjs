// Side-effect module: import FIRST in tests that touch the read-snapshot store.
// Points the Mixdog data dir at a per-run temp dir before snapshot-store.mjs
// resolves SNAPSHOT_DIR at module load, so tests never write to the real one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleTempDirs, removeTempDirSync } from './lib/stale-temp.mjs';

if (!process.env.MIXDOG_TEST_DATA_DIR_OWNED) {
  // The exit handler never runs for a killed process, so each start sweeps
  // what earlier killed processes left.
  const prefix = 'mixdog-test-data-';
  pruneStaleTempDirs([prefix]);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.MIXDOG_TEST_DATA_DIR_OWNED = '1';
  process.on('exit', () => {
    removeTempDirSync(dir);
  });
}
