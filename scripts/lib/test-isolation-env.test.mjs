import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { effectiveInstructionFilesMode } from '../../src/runtime/agent/orchestrator/context/instruction-files.mjs';
import { testIsolationEnv } from './run-node-tests.mjs';

test('test processes get a private data dir and the instruction-files switch forced off', () => {
  const env = testIsolationEnv(join('scratch', 'run'));
  assert.equal(env.MIXDOG_DATA_DIR, join('scratch', 'run', 'data'));
  assert.equal(env.TMPDIR, join('scratch', 'run'));
  const prior = process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
  process.env.MIXDOG_BOOT_INSTRUCTION_FILES = env.MIXDOG_BOOT_INSTRUCTION_FILES;
  try {
    // Whatever the stored setting says, no composed session reads the real home.
    assert.equal(effectiveInstructionFilesMode('all'), 'off');
  } finally {
    if (prior === undefined) delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
    else process.env.MIXDOG_BOOT_INSTRUCTION_FILES = prior;
  }
});
