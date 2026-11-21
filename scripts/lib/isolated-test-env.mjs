// Side-effect import: must come first so the data/home dirs resolve to a scratch dir before any module under test reads them.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOwnedTempDir } from './scoped-temp.mjs';
import { pruneStaleTempDirs, removeTempDirSync } from './stale-temp.mjs';

// The exit handler below never runs for a killed process, so each start sweeps
// what earlier killed processes left.
const PREFIX = 'mixdog-test-profile-';
pruneStaleTempDirs([PREFIX]);
const root = mkdtempSync(join(tmpdir(), PREFIX));
registerOwnedTempDir(root);
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
process.on('exit', () => {
  removeTempDirSync(root);
});
