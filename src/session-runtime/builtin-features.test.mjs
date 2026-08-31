import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALLABLE_BUILTIN_IDS,
  builtinInstalled,
  featureDisallowedToolsFor,
  setBuiltinInstalledInConfig,
  withGrandfatheredBuiltins,
} from './builtin-features.mjs';

test('a fresh profile is stamped empty: every feature starts not installed', () => {
  const config = withGrandfatheredBuiltins({});
  assert.deepEqual(config.builtins, {});
  for (const id of INSTALLABLE_BUILTIN_IDS) {
    assert.equal(builtinInstalled(config, id), false);
  }
});

test('a profile that predates the marker is grandfathered as installed', () => {
  const config = withGrandfatheredBuiltins({
    presets: [{ id: 'main', provider: 'openai-oauth', model: 'gpt-5.6-sol' }],
    default: 'main',
  });
  for (const id of INSTALLABLE_BUILTIN_IDS) {
    assert.equal(builtinInstalled(config, id), true);
  }
  // The pre-existing config keys stay untouched.
  assert.equal(config.default, 'main');
});

test('an already-stamped config passes through by identity', () => {
  const config = { builtins: {}, presets: [] };
  assert.equal(withGrandfatheredBuiltins(config), config);
  const installed = { builtins: { git: { installed: true } } };
  assert.equal(withGrandfatheredBuiltins(installed), installed);
});

test('structural keys alone never grandfather a profile', () => {
  // A default in-memory config may carry harmless keys before onboarding
  // writes; only user marks (presets/providers/modules/...) count.
  const config = withGrandfatheredBuiltins({ shell: { command: 'pwsh' }, theme: 'basic' });
  assert.deepEqual(config.builtins, {});
});

test('a fresh profile keeps every gated tool family off the session surface', () => {
  const config = withGrandfatheredBuiltins({});
  assert.deepEqual(featureDisallowedToolsFor(config), [
    'memory', 'recall', 'git', 'git_stage', 'browser', 'computer', 'office',
  ]);
});

test('installed features with live bridges expose the full tool surface', () => {
  const config = withGrandfatheredBuiltins({ presets: [] });
  assert.deepEqual(
    featureDisallowedToolsFor(config, { browserAvailable: true, computerAvailable: true }),
    [],
  );
  // A missing bridge keeps browser/computer out even on an installed profile.
  assert.deepEqual(featureDisallowedToolsFor(config), ['browser', 'computer']);
});

test('a disabled toggle removes tools even while the feature stays installed', () => {
  const config = {
    ...withGrandfatheredBuiltins({ presets: [] }),
    modules: { office: { enabled: false } },
    memoryTools: { enabled: false },
  };
  assert.deepEqual(
    featureDisallowedToolsFor(config, { browserAvailable: true, computerAvailable: true }),
    ['memory', 'recall', 'office'],
  );
});

test('MIXDOG_FEATURE_* env overrides win over stored markers in both directions', () => {
  process.env.MIXDOG_FEATURE_OFFICE = '1';
  process.env.MIXDOG_FEATURE_GIT = 'off';
  try {
    // A headless run surfaces office without any install marker…
    const fresh = featureDisallowedToolsFor(withGrandfatheredBuiltins({}));
    assert.equal(fresh.includes('office'), false);
    // …and forces git out of an installed, enabled profile.
    assert.deepEqual(
      featureDisallowedToolsFor(withGrandfatheredBuiltins({ presets: [] }), {
        browserAvailable: true,
        computerAvailable: true,
      }),
      ['git', 'git_stage'],
    );
  } finally {
    delete process.env.MIXDOG_FEATURE_OFFICE;
    delete process.env.MIXDOG_FEATURE_GIT;
  }
});

test('install markers set and clear without disturbing sibling entries', () => {
  let config = setBuiltinInstalledInConfig({}, 'office', true);
  config = setBuiltinInstalledInConfig(config, 'memory', true);
  assert.equal(builtinInstalled(config, 'office'), true);
  assert.equal(builtinInstalled(config, 'memory'), true);
  config = setBuiltinInstalledInConfig(config, 'office', false);
  assert.equal(builtinInstalled(config, 'office'), false);
  assert.equal(builtinInstalled(config, 'memory'), true);
});
