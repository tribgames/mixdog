// Side-effect import for tests that touch Mixdog user data. Import it FIRST (ESM
// evaluates imports in order) so the data/home dirs resolve to a scratch dir
// before any module under test reads them, even under plain `node --test` from a
// shell that exports the signed-in profile's MIXDOG_DATA_DIR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mixdog-test-profile-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});
