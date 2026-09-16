import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { applyDeferredToolSurface } from './tool-catalog.mjs';
import { HEADLESS_MODEL_TOOL_NAMES, filterModelToolsForProfile, modelToolSchemaAllowlist } from './tool-profile.mjs';

import {
  INSTALLABLE_BUILTIN_IDS,
  builtinFeatureActive,
  builtinInstalled,
  featureDisallowedToolsFor,
  setBuiltinInstalledInConfig,
  withGrandfatheredBuiltins,
} from './builtin-features.mjs';
import { filterSkillsExcludingDisabled } from '../runtime/agent/orchestrator/context/collect.mjs';

const { buildSharedToolContent } = createRequire(import.meta.url)('../lib/rules-builder.cjs');

test('headless basic tools omit the loader and its guidance without removing optional or interactive loading', () => {
  const envKeys = ['MIXDOG_FEATURE_WEB_SEARCH', 'MIXDOG_FEATURE_OFFICE', 'MIXDOG_FEATURE_GIT', 'MIXDOG_FEATURE_TIDY'];
  const previous = envKeys.map((key) => [key, process.env[key]]);
  for (const key of envKeys) delete process.env[key];
  try {
    const basic = { builtins: {}, modules: { webSearch: { enabled: false } } };
    const surface = (config, profile) => {
      const denied = featureDisallowedToolsFor(config, { toolProfile: profile });
      const session = {
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        messages: [],
        disallowedTools: denied,
        tools: filterModelToolsForProfile(
          [...HEADLESS_MODEL_TOOL_NAMES, 'Skill'].map((name) => ({
            name,
            inputSchema: { type: 'object', properties: {} },
          })),
          profile
        ),
      };
      applyDeferredToolSurface(session, 'lead');
      return {
        session,
        rules: buildSharedToolContent({
          PLUGIN_ROOT: join(process.cwd(), 'src'),
          allowTools: modelToolSchemaAllowlist(profile),
          omitTools: [...denied, 'edit'],
        }),
      };
    };
    const headless = surface(basic, 'headless');
    assert.equal(
      headless.session.tools.some((tool) => tool.name === 'load_tool'),
      false
    );
    assert.equal(
      headless.session.deferredToolCatalog.some((tool) => tool.name === 'load_tool'),
      false
    );
    assert.ok(headless.session.tools.some((tool) => tool.name === 'shell'));
    assert.ok(headless.session.tools.some((tool) => tool.name === 'git'));
    assert.doesNotMatch(headless.rules, /load_tool|# Skills|# Goals/);
    assert.match(headless.rules, /Tools own their work; shell never substitutes/);

    const interactive = surface(basic, 'interactive');
    assert.ok(interactive.session.tools.some((tool) => tool.name === 'load_tool'));
    assert.ok(interactive.session.tools.some((tool) => tool.name === 'Skill'));
    assert.match(interactive.rules, /`load_tool`/);

    for (const [name, config] of [
      ['web_search', { ...basic, modules: { webSearch: { enabled: true } } }],
      ['office', { ...basic, builtins: { office: { installed: true } } }],
      ['github', { ...basic, builtins: { git: { installed: true } } }],
    ]) {
      const optional = surface(config, 'headless');
      assert.ok(
        optional.session.tools.some((tool) => tool.name === 'load_tool'),
        name
      );
      assert.ok(
        optional.session.deferredToolCatalog.some((tool) => tool.name === name),
        name
      );
      assert.match(optional.rules, /`load_tool`/);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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
  for (const id of ['git', 'memory', 'office']) {
    assert.equal(builtinInstalled(config, id), true);
  }
  assert.equal(builtinInstalled(config, 'localProvider'), false);
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
    'memory',
    'recall',
    'git',
    'git_stage',
    'github',
    'browser',
    'browser_devtools',
    'computer',
    'office',
    'tidy',
  ]);
});

test('installed features with live bridges expose the full tool surface', () => {
  // tidy ships after the grandfathering cut, so an upgraded profile still has
  // to install it; everything grandfathered stays available.
  const config = setBuiltinInstalledInConfig(withGrandfatheredBuiltins({ presets: [] }), 'tidy', true);
  assert.deepEqual(featureDisallowedToolsFor(config, { browserAvailable: true, computerAvailable: true }), []);
  // A missing bridge keeps browser/computer out even on an installed profile.
  assert.deepEqual(featureDisallowedToolsFor(config), ['browser', 'browser_devtools', 'computer']);
});

test('headless Git needs no install marker but respects OFF and does not enable extension tools', () => {
  const config = { builtins: {} };
  const blocked = featureDisallowedToolsFor(config, { toolProfile: 'headless' });
  assert.equal(blocked.includes('git'), false);
  assert.equal(blocked.includes('git_stage'), true);
  assert.equal(blocked.includes('github'), true);
  assert.deepEqual(config, { builtins: {} });
  const off = featureDisallowedToolsFor(
    {
      ...config,
      modules: { git: { enabled: false } },
    },
    { toolProfile: 'headless' }
  );
  for (const name of ['git', 'git_stage', 'github']) assert.ok(off.includes(name));
  const previous = process.env.MIXDOG_FEATURE_GIT;
  process.env.MIXDOG_FEATURE_GIT = '0';
  try {
    const denied = featureDisallowedToolsFor(config, { toolProfile: 'headless' });
    assert.ok(denied.includes('git'));
    assert.ok(denied.includes('git_stage'));
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_GIT;
    else process.env.MIXDOG_FEATURE_GIT = previous;
  }
});

test('a disabled toggle removes tools even while the feature stays installed', () => {
  const config = {
    ...withGrandfatheredBuiltins({ presets: [] }),
    modules: { office: { enabled: false } },
    memoryTools: { enabled: false },
  };
  assert.deepEqual(featureDisallowedToolsFor(config, { browserAvailable: true, computerAvailable: true }), [
    'memory',
    'recall',
    'office',
    'tidy',
  ]);
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
      featureDisallowedToolsFor(setBuiltinInstalledInConfig(withGrandfatheredBuiltins({ presets: [] }), 'tidy', true), {
        browserAvailable: true,
        computerAvailable: true,
      }),
      ['git', 'git_stage', 'github']
    );
  } finally {
    delete process.env.MIXDOG_FEATURE_OFFICE;
    delete process.env.MIXDOG_FEATURE_GIT;
  }
});

test('code tidy installs like office and is not grandfathered', () => {
  const previous = process.env.MIXDOG_FEATURE_TIDY;
  delete process.env.MIXDOG_FEATURE_TIDY;
  try {
    assert.ok(INSTALLABLE_BUILTIN_IDS.includes('tidy'));
    // An upgraded profile keeps its grandfathered features but must install tidy.
    const upgraded = withGrandfatheredBuiltins({ presets: [{ id: 'main' }] });
    assert.equal(builtinInstalled(upgraded, 'office'), true);
    assert.equal(builtinInstalled(upgraded, 'tidy'), false);
    assert.equal(builtinFeatureActive(upgraded, 'tidy'), false);
    assert.ok(featureDisallowedToolsFor(upgraded).includes('tidy'));

    const installed = setBuiltinInstalledInConfig(upgraded, 'tidy', true);
    assert.equal(builtinFeatureActive(installed, 'tidy'), true);
    assert.equal(featureDisallowedToolsFor(installed).includes('tidy'), false);

    // Installed but switched off is inactive, exactly like office.
    const off = { ...installed, modules: { tidy: { enabled: false } } };
    assert.equal(builtinFeatureActive(off, 'tidy'), false);
    assert.ok(featureDisallowedToolsFor(off).includes('tidy'));

    // Headless runs may surface tidy through the env override alone.
    process.env.MIXDOG_FEATURE_TIDY = '1';
    assert.equal(builtinFeatureActive({ builtins: {} }, 'tidy'), true);
    assert.equal(featureDisallowedToolsFor({ builtins: {} }).includes('tidy'), false);
    assert.ok(HEADLESS_MODEL_TOOL_NAMES.includes('tidy'));
    assert.ok(modelToolSchemaAllowlist('headless').includes('tidy'));

    process.env.MIXDOG_FEATURE_TIDY = '0';
    assert.equal(builtinFeatureActive(installed, 'tidy'), false);
    assert.ok(featureDisallowedToolsFor(installed).includes('tidy'));
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_TIDY;
    else process.env.MIXDOG_FEATURE_TIDY = previous;
  }
});

test('the tidy schema defers like office instead of loading eagerly', () => {
  const previous = process.env.MIXDOG_FEATURE_TIDY;
  process.env.MIXDOG_FEATURE_TIDY = '1';
  try {
    const session = {
      provider: 'openai-oauth',
      model: 'gpt-5.6-sol',
      messages: [],
      disallowedTools: featureDisallowedToolsFor({ builtins: {} }),
      tools: [...HEADLESS_MODEL_TOOL_NAMES, 'media'].map((name) => ({
        name,
        inputSchema: { type: 'object', properties: {} },
      })),
    };
    applyDeferredToolSurface(session, 'lead');
    const deferred = session.deferredToolCatalog.map((tool) => tool.name);
    assert.ok(deferred.includes('tidy'), 'tidy must stay loadable on demand');
    assert.equal(
      session.tools.some((tool) => tool.name === 'tidy'),
      false,
      'and must not load eagerly'
    );
    // Same treatment as the other feature tools it ships beside.
    assert.equal(
      session.tools.some((tool) => tool.name === 'office'),
      false
    );
    assert.equal(
      session.tools.some((tool) => tool.name === 'media'),
      false
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_TIDY;
    else process.env.MIXDOG_FEATURE_TIDY = previous;
  }
});

test('the code-tidy skill is offered only while the tidy feature is active', () => {
  const previous = process.env.MIXDOG_FEATURE_TIDY;
  delete process.env.MIXDOG_FEATURE_TIDY;
  try {
    // Mirrors the shipped SKILL.md frontmatter: metadata.requires: tidy.
    const skills = [
      { name: 'code-tidy', source: 'builtin', requires: ['tidy'] },
      { name: 'pptx', source: 'builtin', requires: ['office'] },
    ];
    const names = (config) => filterSkillsExcludingDisabled(skills, config).map((skill) => skill.name);
    const installed = setBuiltinInstalledInConfig({ builtins: { office: { installed: true } } }, 'tidy', true);

    assert.deepEqual(names({ builtins: { office: { installed: true } } }), ['pptx']);
    assert.deepEqual(names(installed), ['code-tidy', 'pptx']);
    assert.deepEqual(names({ ...installed, modules: { tidy: { enabled: false } } }), ['pptx']);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_TIDY;
    else process.env.MIXDOG_FEATURE_TIDY = previous;
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
