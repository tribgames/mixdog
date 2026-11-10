import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SESSION_SUMMARY_INDEX_VERSION, summaryIndexPath } from '../store-summary-index.mjs';
import { listStoredSessionSummaries } from './listing.mjs';
import { _summaryRowsCache } from './summary-cache.mjs';

test('a summary index that cannot be probed is never treated as absent', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-listing-index-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    fs.mkdirSync(join(root, 'sessions'), { recursive: true });
    const indexPath = summaryIndexPath();
    fs.writeFileSync(indexPath, JSON.stringify({ version: SESSION_SUMMARY_INDEX_VERSION, rows: [] }));
    const statSync = fs.statSync;
    t.mock.method(fs, 'statSync', (target, ...rest) => {
      if (String(target) === indexPath) {
        const error = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return statSync(target, ...rest);
    });
    syncBuiltinESMExports();

    const rows = listStoredSessionSummaries();

    assert.deepEqual(rows, []);
    // A cold cache must stay cold. Anything else is the rebuild that would
    // overwrite the present-but-unreadable sidecar.
    assert.equal(_summaryRowsCache, null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
