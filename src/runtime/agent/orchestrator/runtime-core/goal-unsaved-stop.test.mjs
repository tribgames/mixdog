import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';
import { writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';

const SESSION = 'sess_goal_unsaved_stop';

test('a failed turn whose stop cannot be saved holds automatic continuation until a write succeeds', async (t) => {
  let diskFull = false;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-unsaved-'));
  const runtime = createGoalRuntime({
    dataDir,
    deadlineWarningMs: [],
    generateTitle: null,
    writeGoalRecord: async (path, record, options) => {
      if (diskFull) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      await writeJsonAtomicAsync(path, record, options);
    },
  });
  t.after(async () => {
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await runtime.control(SESSION, { action: 'create', objective: 'Ship the parser' });
  await runtime.startTurn(SESSION);

  diskFull = true;
  await assert.rejects(
    runtime.settleTurn(SESSION, { status: 'failed', error: 'ENOSPC: no space left on device, write' }),
    /ENOSPC/
  );
  // The record still reads active, yet the failure must not start another
  // automatic turn into the same error.
  assert.equal(runtime.snapshot(SESSION).status, 'active');
  const held = runtime.continuation(SESSION);
  assert.equal(held.run, false);
  assert.equal(held.reason, 'unsaved-stop');

  // The user's next turn writes again: the hold lifts.
  diskFull = false;
  await runtime.startTurn(SESSION);
  await runtime.settleTurn(SESSION, { status: 'completed' });
  assert.equal(runtime.continuation(SESSION).run, true);
});
