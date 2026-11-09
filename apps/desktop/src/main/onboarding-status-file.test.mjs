import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readOnboardingStatusFromDisk } from './onboarding-status-file.ts';

test('missing config answers onboarding status without starting the engine', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(tmpdir(), `mixdog-missing-onboarding-${process.pid}-${Date.now()}`);
  try {
    assert.deepEqual(await readOnboardingStatusFromDisk(), {
      completed: false,
      version: 0,
      default: null,
      workflowRoutes: [],
      starterGuide: null,
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
  }
});

// The config Node b6f10295a left on disk after `skipOnboarding()` and two `saveStarterGuideState` calls (recorded by running
// settings-profile-api.mjs over an empty data directory); the guide merges `visited` across saves and keeps the first `closed`/`welcomed`.
const NODE_SAVED_CONFIG = {
  agent: {
    onboarding: {
      completed: true,
      version: 1,
      completedAt: '2026-11-09T03:22:37.763Z',
      skipped: true,
      starterGuide: { closed: true, welcomed: true, visited: ['provider', 'remote'] },
    },
  },
  defaultsVersion: 2,
};

test('a guide state saved through the runtime config is what the engine-free probe reads back', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-starter-guide-roundtrip-'));
  process.env.MIXDOG_DATA_DIR = dir;
  try {
    await writeFile(join(dir, 'mixdog-config.json'), JSON.stringify(NODE_SAVED_CONFIG));
    const probe = await readOnboardingStatusFromDisk();
    assert.equal(probe.completed, true);
    assert.deepEqual(probe.starterGuide, { closed: true, welcomed: true, visited: ['provider', 'remote'] });
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});
test('the starter guide state is read from agent.onboarding.starterGuide, null when absent', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-starter-guide-'));
  process.env.MIXDOG_DATA_DIR = dir;
  try {
    const guide = { closed: true, welcomed: true, visited: ['provider'] };
    await writeFile(
      join(dir, 'mixdog-config.json'),
      JSON.stringify({ agent: { onboarding: { completed: true, starterGuide: guide } } })
    );
    assert.deepEqual((await readOnboardingStatusFromDisk()).starterGuide, guide);
    await writeFile(join(dir, 'mixdog-config.json'), JSON.stringify({ agent: { onboarding: { completed: true } } }));
    assert.equal((await readOnboardingStatusFromDisk()).starterGuide, null);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});