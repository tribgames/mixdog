#!/usr/bin/env node
// Golden twin of the config-backed `status` readers (autoclear, compaction, developer, shell,
// update, worktree, network-proxy, output-style, local-provider, memory, profile): the real
// `createSetupToolExecutor` answering `status` over a recording facade whose getters return the
// values of each case. A case keeps the facade calls made and the status Node printed, so Rust
// must call the same getters in the same order and shape them the same way.
//
//   node benchmarks/rust-core/recorders/record-setup-status-config.mjs --tree <dir>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The bridge discovery files of the desktop live in the user's directories: point them at an empty sandbox.
const sandbox = mkdtempSync(join(tmpdir(), 'setup-status-config-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
  process.env[name] = join(sandbox, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');

async function run(domain, values, config = {}, env = {}) {
  for (const name of ['MIXDOG_FEATURE_BROWSER', 'MIXDOG_FEATURE_COMPUTER', 'MIXDOG_FEATURE_TERMINAL']) delete process.env[name];
  Object.assign(process.env, env);
  const calls = [];
  const facade = {};
  for (const [method, value] of Object.entries(values)) {
    if (method === 'props') continue;
    facade[method] = (...args) => {
      calls.push({ method, args: JSON.parse(JSON.stringify(args)) });
      return JSON.parse(JSON.stringify(value));
    };
  }
  Object.assign(facade, values.props || {});
  const executor = createSetupToolExecutor({ getApi: () => facade, getConfig: () => config, getSessionId: () => 'sess_a' });
  const args = { action: 'status', domain };
  try {
    return { domain, values, config, env, calls, result: JSON.parse(await executor.execute(args, {})) };
  } catch (error) {
    return { domain, values, config, env, calls, error: String(error?.message ?? error) };
  }
}

const cases = [];
const add = async (domain, values, config, env) => cases.push(await run(domain, values, config, env));

for (const value of [{ enabled: true, duration: '45m', providers: { groq: '45m' } }, {}, null, 0]) await add('autoclear', { getAutoClear: value });
for (const value of [{ enabled: true, home: 'pwsh' }, {}, null]) await add('shell', { getSystemShell: value });
for (const value of [{ allowAllActions: false, cursorOAuth: true }, { z: 1, a: 2 }]) await add('developer', { getDeveloperSettings: value });
for (const value of [{ autoUpdate: true, currentVersion: '1.0.0', latestVersion: null }, {}, null]) await add('update', { getUpdateSettings: value });
for (const value of [{ newTaskDefaults: { mode: 'worktree' }, root: 'r' }, {}]) await add('worktree', { getWorktreeSettings: value });
for (const value of [{ mode: 'system', url: '' }, { mode: 'manual', url: 'http://h:1', source: 'config' }]) await add('network-proxy', { getNetworkProxy: value });
for (const value of [{ configured: 'concise', available: ['concise', 'plain'] }, {}, null]) await add('output-style', { getOutputStyle: value });
for (const value of [{ localProvider: { enabled: true, installed: false, models: [] }, memory: { enabled: true } }, {}, { localProvider: null }]) {
  await add('local-provider', { getToolModuleSettings: value });
}
for (const [tool, recap] of [
  [{ memory: { enabled: true, installed: true } }, { enabled: false }],
  [{ memory: { enabled: false } }, null],
  [{}, { enabled: true }],
  [{ other: 1 }, {}],
]) await add('memory', { getToolModuleSettings: tool, getRecapSettings: recap });
for (const [compaction, titles, warming] of [
  [{ auto: true, summaryMode: 'self' }, { aiSessionTitles: true }, { enabled: false }],
  [{ auto: false }, {}, {}],
  [{}, { aiSessionTitles: false }, { enabled: true }],
  [null, null, { enabled: true }],
  [{ z: 1, a: 2 }, { a: 3 }, { enabled: false, other: 1 }],
]) await add('compaction', { getCompactionSettings: compaction, getSessionTitleSettings: titles, getCacheWarmingSettings: warming });
for (const profile of [
  { title: 'Kim', language: 'ko', experienceLevel: 'expert', languages: [{ id: 'ko' }, 'en', { id: 'ja', label: 'x' }], experienceLevels: [{ id: 'vibe' }, 'expert'] },
  {},
  null,
  { title: '', language: '', experienceLevel: '', languages: [], experienceLevels: [] },
  { title: 'T', languages: [{ label: 'no id' }], experienceLevels: ['a'] },
]) await add('profile', { getProfile: profile });

for (const [route, tools] of [
  [{ provider: 'openai', model: 'gpt-5' }, { webSearch: { enabled: true } }],
  [{}, { webSearch: { enabled: false } }],
  [null, {}],
  [{ provider: '' }, { webSearch: {} }],
  [{ provider: 'xai', model: 'grok', fallbacks: [] }, null],
]) await add('websearch', { getWebSearchRoute: route, getToolModuleSettings: tools });
for (const status of [{ completed: true, version: 2, routes: [] }, {}, null, { z: 1, a: { b: 2 } }]) await add('onboarding', { getOnboardingStatus: status });

for (const rows of [
  [{ id: 'default', name: 'Default', description: 'd', source: 'built-in', active: true }, { id: 'review', name: 'Review', description: '', source: 'user', overridesBuiltIn: true, active: false }],
  [],
  null,
]) await add('workflow', { listWorkflows: rows });

const MODULES = {
  git: { enabled: true, installed: true, extra: 1 },
  autoEffort: { enabled: true, installed: false, supported: true, ready: false, installing: true, other: 2 },
  instructionFiles: 'off',
  webSearch: { enabled: false },
  localProvider: null,
};
for (const [tools, voice, config, env] of [
  [MODULES, { enabled: true, installed: true, components: { whisper: true }, busy: false }, {}, {}],
  [MODULES, { enabled: false, installed: false, busy: true }, { heartbeat: true, heartbeatIntervalMinutes: 120, reactions: false }, { MIXDOG_FEATURE_BROWSER: '1' }],
  [{}, {}, { heartbeat: 'yes', heartbeatIntervalMinutes: 45 }, { MIXDOG_FEATURE_COMPUTER: 'off', MIXDOG_FEATURE_TERMINAL: '1' }],
  [null, { enabled: 'true', installed: 1 }, { reactions: null }, {}],
  [{ voice: 'x', browser: 'y', zeta: { enabled: true } }, { enabled: true, installed: true }, { heartbeatIntervalMinutes: '30' }, {}],
]) await add('features', { getToolModuleSettings: tools, getVoiceStatus: voice }, config, env);

const FULL_ROUTE = { provider: 'openai', model: 'gpt-5', effort: 'high', fast: true, fastCapable: true, modelParameters: { temperature: 0.2 }, contextPercent: 40, contextTokens: 0 };
for (const [props, workflows, style, profile, onboarding] of [
  [FULL_ROUTE, [{ id: 'default', name: 'Default', source: 'built-in', active: false }, { id: 'review', name: 'Review', source: 'user', active: true }], { configured: 'concise' }, { title: 'Kim', language: 'ko', experienceLevel: 'expert', languages: ['ko'] }, { completed: true }],
  [{}, [], {}, {}, null],
  [{ provider: '', model: null, effort: '', fast: 'yes', fastCapable: 1, modelParameters: null, contextPercent: null }, [{ id: 'a', active: false }], null, null, {}],
  [{ provider: 'xai', model: 'grok', fast: false, contextPercent: 0 }, [{ id: 'a', active: true }, { id: 'b', active: true }], { configured: '' }, { title: '' }, null],
]) await add('summary', { props, listWorkflows: workflows, getOutputStyle: style, getProfile: profile, getOnboardingStatus: onboarding, getToolModuleSettings: { git: { enabled: true, installed: false, x: 1 } }, getVoiceStatus: { enabled: false, installed: true } });

for (const [props, presets] of [
  [{ ...FULL_ROUTE, autoEffort: true, effortOptions: [{ value: 'low' }, { value: 'high', label: 'High' }] }, [{ id: 'workflow-lead', fallbacks: [{ provider: 'xai', model: 'grok' }] }, { id: 'other', fallbacks: [{ provider: 'a' }] }]],
  [{ autoEffort: false }, []],
  [{}, [{ id: 'workflow-lead' }]],
  [{ provider: 'openai', autoEffort: null, effortOptions: null }, [null, { id: 'workflow-lead', fallbacks: null }]],
]) await add('model', { props, listPresets: presets });

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-status-config-twin.json'), {
  domain: 'setup-status-config-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-status-config.mjs',
  cases,
});
console.log(`recorded ${cases.length} cases (${cases.filter((c) => c.error).length} errors)`);