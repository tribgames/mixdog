// Test helper: a separate process that holds the staged-originals lock for
// argv[2] ms (a contending holder on this data dir), announcing "held" first.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { withFileLockSync } from '../shared/atomic-file.mjs';
import { stagedOriginalsLockPath } from './staged-originals.mjs';

mkdirSync(dirname(stagedOriginalsLockPath()), { recursive: true });
withFileLockSync(stagedOriginalsLockPath(), () => {
  process.stdout.write('held\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]) || 1000);
});
