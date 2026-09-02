import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readOnboardingStatusFromDisk } from './onboarding-status-file.ts';

test('missing config answers onboarding status without starting the engine', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(
    tmpdir(),
    `mixdog-missing-onboarding-${process.pid}-${Date.now()}`,
  );
  try {
    assert.deepEqual(await readOnboardingStatusFromDisk(), {
      completed: false,
      version: 0,
      default: null,
      workflowRoutes: [],
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
  }
});
