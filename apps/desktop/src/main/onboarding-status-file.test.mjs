import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('a guide state saved through the runtime config is what the engine-free probe reads back', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousBackupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-starter-guide-roundtrip-'));
  process.env.MIXDOG_DATA_DIR = join(dir, 'data');
  // Config writes snapshot the profile; keep those out of the real home.
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');
  try {
    await mkdir(process.env.MIXDOG_DATA_DIR, { recursive: true });
    const cfgMod = await import('../../../../src/runtime/agent/orchestrator/config.mjs');
    const { createProfileSettings } = await import('../../../../src/session-runtime/settings-profile-api.mjs');
    let config = cfgMod.loadConfig({ secrets: false });
    const profile = createProfileSettings({
      getConfig: () => config,
      adoptConfig: (next) => {
        config = next;
      },
      saveConfigAndAdopt: (next) => {
        cfgMod.saveConfig(next, { baseConfig: config });
        config = next;
      },
      scheduleSkillsSave() {},
      cfgMod,
      hasOwn: Object.hasOwn,
      summarizeWorkflowRoutes: () => [],
      ONBOARDING_VERSION: 1,
    });
    profile.skipOnboarding();
    profile.saveStarterGuideState({ closed: true, welcomed: true, visited: ['remote'] });
    profile.saveStarterGuideState({ closed: false, welcomed: false, visited: ['provider'] });
    const expected = { closed: true, welcomed: true, visited: ['provider', 'remote'] };
    const probe = await readOnboardingStatusFromDisk();
    assert.equal(probe.completed, true);
    assert.deepEqual(probe.starterGuide, expected);
    assert.deepEqual(cfgMod.loadConfig({ secrets: false }).onboarding.starterGuide, expected);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousBackupRoot === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = previousBackupRoot;
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
