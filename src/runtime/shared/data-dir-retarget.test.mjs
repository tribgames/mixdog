import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { configPath, readSection, updateSection } from './config.mjs';
import { _setTurnSnapshotStoreRootForTest, saveTurnSnapshotRecord } from './turn-snapshot-store.mjs';

// The pristine-execution boundary retargets MIXDOG_DATA_DIR after import; the
// data-dir consumers must follow it instead of the import-time value.
test('config and turn snapshot records follow a runtime MIXDOG_DATA_DIR retarget', async () => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const first = mkdtempSync(join(tmpdir(), 'mixdog-retarget-a-'));
  const second = mkdtempSync(join(tmpdir(), 'mixdog-retarget-b-'));
  try {
    _setTurnSnapshotStoreRootForTest('');
    process.env.MIXDOG_DATA_DIR = first;
    assert.equal(configPath(), join(first, 'mixdog-config.json'));
    process.env.MIXDOG_DATA_DIR = second;
    assert.equal(configPath(), join(second, 'mixdog-config.json'));

    updateSection('retarget-probe', () => ({ ok: true }));
    assert.equal(existsSync(join(second, 'mixdog-config.json')), true);
    assert.equal(existsSync(join(first, 'mixdog-config.json')), false);
    assert.deepEqual(readSection('retarget-probe'), { ok: true });

    const saved = await saveTurnSnapshotRecord('retarget-session', { baselineTree: 'abc', root: second });
    assert.equal(saved, true);
    assert.equal(existsSync(join(second, 'turn-snapshots')), true);
    assert.equal(existsSync(join(first, 'turn-snapshots')), false);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
