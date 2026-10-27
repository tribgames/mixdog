// Side-effect import for tests that touch Mixdog user data. Import it FIRST (ESM
// evaluates imports in order) so the data/home dirs resolve to a scratch dir
// before any module under test reads them, even under plain `node --test` from a
// shell that exports the signed-in profile's MIXDOG_DATA_DIR.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleTempDirs, removeTempDirSync } from './stale-temp.mjs';

// The exit handler below never runs for a killed process, so each start sweeps
// what earlier killed processes left.
const PREFIX = 'mixdog-test-profile-';
pruneStaleTempDirs([PREFIX]);
const root = mkdtempSync(join(tmpdir(), PREFIX));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
process.on('exit', () => {
  removeTempDirSync(root);
});
