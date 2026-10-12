import assert from 'node:assert/strict';
import test from 'node:test';

import { createProfileSettings } from './settings-profile-api.mjs';

function harness(onboarding) {
  let config = { onboarding };
  const profile = createProfileSettings({
    getConfig: () => config,
    adoptConfig: (next) => {
      config = next;
    },
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    scheduleSkillsSave() {},
    cfgMod: {},
    hasOwn: Object.hasOwn,
    summarizeWorkflowRoutes: () => [],
    ONBOARDING_VERSION: 3,
  });
  return { profile, config: () => config };
}

test('onboarding status reports the stored starter guide, null when absent', () => {
  assert.equal(harness({ completed: true }).profile.getOnboardingStatus().starterGuide, null);
  const { profile } = harness({
    completed: true,
    starterGuide: { closed: true, welcomed: 1, visited: ['remote', 'remote', 'bogus', 'provider'] },
  });
  assert.deepEqual(profile.getOnboardingStatus().starterGuide, {
    closed: true,
    welcomed: false,
    visited: ['provider', 'remote'],
  });
});

test('saveStarterGuideState stores the state and preserves the other onboarding fields', () => {
  const { profile, config } = harness({ completed: true, version: 3, completedAt: 'then' });
  const status = profile.saveStarterGuideState({
    closed: true,
    welcomed: true,
    visited: ['workflow', 'project', 'project'],
  });
  assert.deepEqual(config().onboarding, {
    completed: true,
    version: 3,
    completedAt: 'then',
    starterGuide: { closed: true, welcomed: true, visited: ['project', 'workflow'] },
  });
  assert.equal(status.completed, true);
  assert.deepEqual(status.starterGuide, config().onboarding.starterGuide);
});

test('saveStarterGuideState rejects malformed payloads and leaves the stored state alone', () => {
  const stored = { closed: true, welcomed: true, visited: ['remote'] };
  const { profile, config } = harness({ completed: true, starterGuide: stored });
  for (const bad of [
    'junk',
    null,
    [],
    {},
    { closed: 'yes', welcomed: true, visited: [] },
    { closed: false, welcomed: false },
    { closed: false, welcomed: false, visited: ['nope'] },
    { closed: false, welcomed: false, visited: [7] },
    { closed: false, welcomed: false, visited: [], extra: 1 },
  ]) {
    assert.throws(() => profile.saveStarterGuideState(bad), TypeError, JSON.stringify(bad));
  }
  assert.deepEqual(config().onboarding.starterGuide, stored);
});

test('a stale save never reopens a closed guide or forgets a visited step', () => {
  const { profile, config } = harness({
    completed: true,
    starterGuide: { closed: false, welcomed: false, visited: [] },
  });
  // Two renderer writes race: the close lands first, the older visit second.
  profile.saveStarterGuideState({ closed: true, welcomed: true, visited: ['provider'] });
  profile.saveStarterGuideState({ closed: false, welcomed: false, visited: ['workflow'] });
  assert.deepEqual(config().onboarding.starterGuide, {
    closed: true,
    welcomed: true,
    visited: ['provider', 'workflow'],
  });
});

test('a first onboarding completion starts the guide fresh; an earlier completion is left alone', () => {
  const fresh = harness({});
  fresh.profile.skipOnboarding();
  assert.deepEqual(fresh.config().onboarding.starterGuide, { closed: false, welcomed: false, visited: [] });
  const legacy = harness({ completed: true, version: 1 });
  legacy.profile.skipOnboarding();
  assert.equal(legacy.config().onboarding.starterGuide, undefined, 'absence keeps meaning "onboarded before"');
  const kept = harness({ starterGuide: { closed: true, welcomed: true, visited: [] } });
  kept.profile.skipOnboarding();
  assert.equal(kept.config().onboarding.starterGuide.closed, true);
});
