import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeFeatureGates } from './runtime-feature-gates.mjs';

// MIXDOG_FEATURE_* overrides win over every stored toggle, so a developer
// environment that sets one must not decide what these gates report.
const OVERRIDES = [
  'MIXDOG_FEATURE_WEB_SEARCH',
  'MIXDOG_FEATURE_MEMORY',
  'MIXDOG_FEATURE_GIT',
  'MIXDOG_FEATURE_OFFICE',
  'MIXDOG_FEATURE_MEDIA',
];

function withoutFeatureOverrides(t) {
  const saved = OVERRIDES.map((name) => [name, process.env[name]]);
  for (const name of OVERRIDES) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const installed = {
  builtins: { git: { installed: true }, memory: { installed: true }, office: { installed: true } },
};

test('gates read the live config, so a toggle takes effect without rebuilding them', (t) => {
  withoutFeatureOverrides(t);
  let config = { ...installed };
  const gates = createRuntimeFeatureGates({
    getConfig: () => config,
    getToolProfile: () => 'interactive',
  });

  assert.equal(gates.officeToolsEnabledFn(), true);
  assert.equal(gates.featureDisallowedTools().includes('office'), false);

  config = { ...config, modules: { office: { enabled: false } } };

  assert.equal(gates.officeToolsEnabledFn(), false);
  assert.equal(gates.featureDisallowedTools().includes('office'), true);
});

test('the git gate follows the live tool profile', (t) => {
  withoutFeatureOverrides(t);
  let toolProfile = 'interactive';
  const gates = createRuntimeFeatureGates({
    getConfig: () => ({ builtins: {} }),
    getToolProfile: () => toolProfile,
  });

  // Not installed: interactive denies the git tool, headless needs no install.
  assert.equal(gates.gitToolsEnabledFn(), false);
  assert.equal(gates.featureDisallowedTools().includes('git'), true);

  toolProfile = 'headless';

  assert.equal(gates.gitToolsEnabledFn(), true);
  assert.equal(gates.featureDisallowedTools().includes('git'), false);
});

test('an uninstalled built-in stays inactive and is denied at the session surface', (t) => {
  withoutFeatureOverrides(t);
  const gates = createRuntimeFeatureGates({
    getConfig: () => ({ builtins: {} }),
    getToolProfile: () => 'interactive',
  });

  assert.equal(gates.memoryToolsEnabledFn(), false);
  assert.equal(gates.localProviderEnabledFn(), false);
  for (const denied of ['memory', 'recall', 'git_stage', 'github']) {
    assert.equal(gates.featureDisallowedTools().includes(denied), true);
  }
  // Module-level features keep their enabled-by-default answer.
  assert.equal(gates.channelsEnabled(), true);
  assert.equal(gates.recapEnabledFn(), true);
  assert.equal(gates.webSearchEnabled(), true);
});
