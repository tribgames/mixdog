#!/usr/bin/env node
// Golden twin of `getToolModuleSettings()` and its setters (`settings-builtin-tools-api.mjs`).
// 100 deterministic configs (fake data only), each read under a few `MIXDOG_FEATURE_*` env
// variants and run through every setter. An entry holds the config, the runtime state Node
// read from outside the config (embedder, judge, local-provider status, git on PATH), the value
// Node answered, and per setter the saved config, the host calls and the value it returned.
// The Rust `ToolModules` must reproduce all of it from the same config and external state.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-tool-modules.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createBuiltinToolSettings } = await importFrom(tree, 'src/session-runtime/settings-builtin-tools-api.mjs');
const { createRuntimeFeatureGates } = await importFrom(tree, 'src/session-runtime/runtime-feature-gates.mjs');
const helpers = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
const { gitExecutablePresent } = await importFrom(tree, 'src/runtime/shared/path-executable.mjs');

let seed = 0x7001c0de;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const MODULES = ['webSearch', 'git', 'office', 'tidy', 'localProvider', 'autoEffort', 'visualize', 'media'];
const INSTALLABLE = ['git', 'memory', 'office', 'tidy', 'localProvider', 'autoEffort'];
const TOGGLEABLE = ['git', 'office', 'tidy', 'localProvider', 'autoEffort', 'visualize', 'media'];
const LOCAL_STATUSES = [
  undefined,
  {},
  { runtime: { installed: true }, models: [], installations: [] },
  { runtime: { installed: false }, available: true, models: [{ id: 'm1' }], installations: [{ phase: 'runtime', state: 'paused' }] },
  { runtime: { installed: 'yes' }, enabled: 'stale', installed: 'stale' },
];
const ENVS = [{}, { MIXDOG_FEATURE_GIT: '0' }, { MIXDOG_FEATURE_MEMORY: '1', MIXDOG_FEATURE_WEB_SEARCH: 'off' }, { MIXDOG_FEATURE_AUTO_EFFORT: 'false', MIXDOG_FEATURE_MEDIA: '  ' }, { MIXDOG_FEATURE_TIDY: 'yes', MIXDOG_FEATURE_VISUALIZE: '0' }];

function randomConfig() {
  const config = { providers: { openai: { apiKey: 'sk-fake' } }, other: { keep: true } };
  if (chance(0.8)) {
    config.builtins = {};
    for (const id of INSTALLABLE) if (chance(0.5)) config.builtins[id] = chance(0.9) ? { installed: chance(0.8), note: 1 } : {};
  }
  if (chance(0.6)) {
    config.modules = {};
    for (const id of [...MODULES, 'memory']) {
      if (chance(0.35)) config.modules[id] = pick([{ enabled: false }, { enabled: true }, {}, { enabled: 'no' }, false]);
    }
  }
  if (chance(0.3)) config.memoryTools = pick([{ enabled: false }, { enabled: true }, {}]);
  if (chance(0.3)) config.recap = pick([{ enabled: false }, { enabled: true, interval: 3 }]);
  if (chance(0.5)) config.instructionFiles = pick(['all', 'agents', 'claude', 'off', 'bogus', 3, null]);
  if (chance(0.5)) config.autoEffortBase = pick(['low', 'medium', 'high', ' HIGH ', 'Low', 'x', 7, null, '']);
  if (chance(0.3)) config.providers['mixdog-local'] = pick([{ enabled: false }, { enabled: true, idleTtlSeconds: 60 }, {}]);
  return config;
}

const entries = [];
for (let i = 0; i < 100; i += 1) {
  const config = randomConfig();
  const env = ENVS[i % ENVS.length];
  const status = pick(LOCAL_STATUSES);
  const commandError = chance(0.3) ? 'install failed' : null;
  const run = async (call) => {
    let current = structuredClone(config);
    let saved = null;
    const calls = [];
    const gates = createRuntimeFeatureGates({ getConfig: () => current, getToolProfile: () => 'interactive' });
    const api = createBuiltinToolSettings(
      {
        getConfig: () => current,
        saveConfigAndAdopt: (next) => { current = structuredClone(next); saved = structuredClone(next); },
        setRecapEnabledInConfig: helpers.setRecapEnabledInConfig,
        setMemoryToolsEnabledInConfig: helpers.setMemoryToolsEnabledInConfig,
        setModuleEnabledInConfig: helpers.setModuleEnabledInConfig,
        prepareBuiltinFeature: async (name, options) => { calls.push(options ? ['prepare', name, options] : ['prepare', name]); },
        getLocalProviderStatus: status === undefined ? undefined : () => structuredClone(status),
        stopLocalProviderServer: async () => { calls.push(['stopServer']); },
        syncLocalProviderRegistry: async (enabled) => { calls.push(['syncRegistry', enabled]); },
        invalidateContextStatusCache: () => calls.push(['invalidateContext']),
        invalidatePreSessionToolSurface: () => calls.push(['invalidateSurface']),
        ...gates,
      },
      { status: () => ({ installationCommandError: commandError }) }
    );
    const result = await Promise.resolve().then(() => call(api)).then((value) => ({ value }), (error) => ({ error: String(error?.message ?? error) }));
    return { saved, calls, ...result };
  };

  const saved = {};
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
  for (const key of Object.keys(process.env)) if (key.startsWith('MIXDOG_FEATURE_') && !(key in env)) { saved[key] = process.env[key]; delete process.env[key]; }
  try {
    const read = await run((api) => Promise.resolve(api.getToolModuleSettings()));
    const external = {
      embeddingInfo: read.value.memory.info,
      onnxSupported: read.value.memory.semanticSearchSupported,
      gitAvailable: gitExecutablePresent(),
      localProvider: status === undefined ? {} : status,
      installationCommandError: commandError,
      effortJudge: {
        available: read.value.autoEffort.installed,
        installing: read.value.autoEffort.installing,
        ready: read.value.autoEffort.ready,
        lastError: read.value.autoEffort.lastError,
        info: read.value.autoEffort.info,
      },
    };
    const setters = [
      ['setWebSearchEnabled', [chance(0.5)], (api, a) => api.setWebSearchEnabled(a[0])],
      ['setInstructionFiles', [pick(['all', 'claude', 'bogus'])], (api, a) => api.setInstructionFiles(a[0])],
      ['setAutoEffortBase', [pick(['low', 'high', 'extreme'])], (api, a) => api.setAutoEffortBase(a[0])],
      ['setRecapEnabled', [chance(0.5)], (api, a) => Promise.resolve(api.setRecapEnabled(a[0]))],
      ['setMemoryToolsEnabled', [chance(0.5)], (api, a) => api.setMemoryToolsEnabled(a[0])],
      ['setBuiltinToolEnabled', [pick([...TOGGLEABLE, 'nope']), chance(0.5)], (api, a) => api.setBuiltinToolEnabled(a[0], a[1])],
      ['installBuiltinFeature', [pick([...INSTALLABLE, 'nope'])], (api, a) => api.installBuiltinFeature(a[0])],
      ['installBuiltinFeature', ['tidy', { engines: ['rust'] }], (api, a) => api.installBuiltinFeature(a[0], a[1])],
    ];
    const results = [];
    for (const [method, args, call] of setters) {
      results.push({ method, args, ...(await run((api) => call(api, args))) });
    }
    entries.push({ config, env, external, value: read.value, setters: results });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'tool-modules-twin.json'), {
  domain: 'tool-modules-twin',
  recorder: 'benchmarks/rust-core/recorders/record-tool-modules.mjs',
  entries,
});
console.log(`recorded ${entries.length} tool-module configs`);
