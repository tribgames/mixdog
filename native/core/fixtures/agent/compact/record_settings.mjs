// Records Node's `config/*` compaction methods (getCompactionSettings, setCompactionSettings,
// getAutoClear, setAutoClear) through `createCompactionSettings` with the real helpers.
//
//   node native/core/fixtures/agent/compact/record_settings.mjs [--tree <node checkout with node_modules>]
//
// `golden/settings.json`: per case an initial agent config, the route provider, the session's
// compaction record, and a call list; each call records its result or error message, the
// config after it, the adopted session compaction and the context-status invalidation count.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-settings-golden-'));
// The `agent` set is shared with the agent-loop recorders: stage a copy, overwrite only this recorder's goldens,
// re-list the shared manifest, then swap the finished copy in.
const agentDir = resolve(here, '..');
const stage = stageSet(agentDir, []);
const outDir = join(stage, 'compact');
mkdirSync(join(outDir, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);

const helpers = await load('src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
const { createCompactionSettings } = await load('src/session-runtime/settings-compaction-api.mjs');
const keys = await load('src/runtime/agent/orchestrator/runtime-core/compaction-config-keys.mjs');

const { _liveSessions } = await load('src/runtime/agent/orchestrator/session/store/live-state.mjs');

const clone = (value) => JSON.parse(JSON.stringify(value));
// A case that depends on the order its keys are written in gives `configText`: JSON text, parsed
// here so Node enumerates it as it would a stored file, and handed to Rust as the same text (a
// parsed JS object lists integer-like keys first, so the recorded `config` could not carry it).
const run = (spec) => {
  const initial = spec.configText === undefined ? spec.config : JSON.parse(spec.configText);
  let config = clone(initial);
  const session = spec.session ? { compaction: clone(spec.session) } : null;
  let invalidated = 0;
  // `refreshLeadCacheOpts` re-derives the cache options of every live Lead session: a Lead
  // session on a cache-explicit provider, registered live, counts each refresh Node makes.
  let refreshes = 0;
  const live = {
    id: 'live',
    agent: 'lead',
    provider: 'anthropic',
    get providerCacheOpts() {
      return null;
    },
    set providerCacheOpts(_next) {
      refreshes += 1;
    },
  };
  _liveSessions.clear();
  _liveSessions.set(live.id, live);
  const api = createCompactionSettings({
    getConfig: () => config,
    getRoute: () => (spec.provider ? { provider: spec.provider } : null),
    getSession: () => session,
    saveConfigAndAdopt: (next) => {
      config = clone(next);
    },
    hasOwn: Object.hasOwn,
    normalizeAutoClearConfig: helpers.normalizeAutoClearConfig,
    autoClearIdleMsForProvider: helpers.autoClearIdleMsForProvider,
    resolveAutoClearIdleMs: helpers.resolveAutoClearIdleMs,
    normalizeCompactionConfig: helpers.normalizeCompactionConfig,
    autoClearProviderDefaults: helpers.autoClearProviderDefaults,
    parseDurationMs: helpers.parseDurationMs,
    formatDurationMs: helpers.formatDurationMs,
    invalidateContextStatusCache: () => {
      invalidated += 1;
    },
  });
  const steps = spec.calls.map(({ method, input }) => {
    const step = { method, input };
    try {
      step.result = clone(input === undefined ? api[method]() : api[method](input));
    } catch (error) {
      step.error = String(error?.message ?? error);
    }
    step.config = clone(config);
    step.session = session ? clone(session.compaction) : null;
    step.invalidated = invalidated;
    step.refreshes = refreshes;
    return step;
  });
  _liveSessions.clear();
  return { name: spec.name, config: initial, configText: spec.configText ?? null, provider: spec.provider ?? null, session: spec.session ?? null, steps };
};

const providers = { anthropic: { enabled: true }, openai: { enabled: false }, 'openai-oauth': {}, Custom: { enabled: true }, off: null };
const cases = [
  {
    name: 'defaults',
    config: {},
    calls: [{ method: 'getCompactionSettings' }, { method: 'getAutoClear' }],
  },
  {
    name: 'legacy-compaction',
    config: {
      compaction: { enabled: false, semanticModel: 'm-old', recallMemoryTimeoutMs: 9000, type: 'x', prune: true, tailTurns: 3, useMaintainer: false, mainBufferPercent: 20, extra: { a: 1 } },
    },
    calls: [{ method: 'getCompactionSettings' }],
  },
  {
    name: 'set-compaction',
    config: { compaction: { auto: true, mainBufferTokens: 5000, summaryModel: 'sm' } },
    session: { auto: true, mainBufferTokens: 5000, bufferTokens: 42, thresholds: { a: 1 }, model: 'x', useMaintainer: false },
    calls: [
      { method: 'setCompactionSettings', input: { mainBufferPercent: 30 } },
      { method: 'setCompactionSettings', input: { enabled: false, onModelChange: false } },
      { method: 'setCompactionSettings', input: { summaryMode: 'maintainer', auto: true } },
      { method: 'setCompactionSettings', input: { summaryMode: 'bogus' } },
      { method: 'setCompactionSettings', input: { mainBufferTokens: 8000, mainBuffer: 1 } },
      { method: 'setCompactionSettings', input: {} },
      { method: 'setCompactionSettings' },
      { method: 'setCompactionSettings', input: { type: 'smart', auto: 0 } },
    ],
  },
  {
    name: 'auto-clear-routes',
    config: { providers, autoClear: { enabled: true, providerIdleMs: { Groq: 7200000, mistral: 0, 'x-new': '90m', bad: -1, empty: '' } } },
    provider: 'anthropic',
    calls: [{ method: 'getAutoClear' }],
  },
  {
    name: 'auto-clear-integer-like-keys',
    configText: '{"providers":{"b":{"enabled":true}},"autoClear":{"providerIdleMs":{"zeta":120000,"20":300000,"alpha":180000,"3":"15m","007":240000}}}',
    provider: 'b',
    calls: [
      { method: 'getAutoClear' },
      { method: 'setAutoClear', input: { provider: '9', duration: '20m' } },
      { method: 'setAutoClear', input: { provider: 'alpha', resetProvider: true } },
    ],
  },
  {
    name: 'auto-clear-integer-like-provider-rows',
    configText: '{"providers":{"b":{},"20":{},"3":{}}}',
    calls: [{ method: 'getAutoClear' }],
  },
  {
    name: 'auto-clear-oauth-unlimited',
    config: { providers: { 'openai-oauth': { enabled: true } } },
    provider: 'openai-oauth',
    calls: [{ method: 'getAutoClear' }],
  },
  {
    name: 'auto-clear-unknown-provider',
    config: { autoClear: { idleMs: 90000, minContextPercent: 250.6 } },
    provider: 'Weird',
    calls: [{ method: 'getAutoClear' }],
  },
  {
    name: 'set-auto-clear-global',
    config: { providers, autoClear: { idleMs: 120000 } },
    provider: 'anthropic',
    calls: [
      { method: 'setAutoClear', input: { enabled: false } },
      { method: 'setAutoClear', input: { minContextPercent: 33.4 } },
      { method: 'setAutoClear', input: { minContextPercent: 'abc' } },
      { method: 'setAutoClear', input: { idleMs: 30000 } },
      { method: 'setAutoClear', input: { idleMs: -5 } },
      { method: 'setAutoClear', input: { idleMs: null } },
      { method: 'setAutoClear', input: { reset: true } },
      { method: 'setAutoClear', input: { duration: '2h' } },
      { method: 'setAutoClear', input: { duration: 'zzz' } },
      { method: 'setAutoClear', input: { enabled: false, duration: '90m' } },
      { method: 'setAutoClear', input: {} },
    ],
  },
  {
    name: 'set-auto-clear-provider',
    config: { providers, autoClear: { providerIdleMs: { anthropic: 7200000 } } },
    provider: 'openai',
    calls: [
      { method: 'setAutoClear', input: { provider: 'Anthropic', duration: '45m' } },
      { method: 'setAutoClear', input: { provider: 'groq', idleMs: 10000 } },
      { method: 'setAutoClear', input: { provider: 'groq', unlimited: true } },
      { method: 'setAutoClear', input: { provider: 'xai', idleMs: 0 } },
      { method: 'setAutoClear', input: { provider: 'xai', duration: 'never' } },
      { method: 'setAutoClear', input: { provider: 'xai', resetProvider: true } },
      { method: 'setAutoClear', input: { provider: 'groq', idleMs: null } },
      { method: 'setAutoClear', input: { provider: 'groq', duration: 'bogus' } },
      { method: 'setAutoClear', input: { provider: 'groq', idleMs: 'x' } },
      { method: 'setAutoClear', input: { provider: ' DeepSeek ', duration: '1.5h' } },
      { method: 'setAutoClear', input: { duration: 'unlimited' } },
      { method: 'setAutoClear', input: { duration: 'UNLIMITED', enabled: true } },
    ],
  },
  {
    name: 'set-auto-clear-no-route',
    config: {},
    calls: [
      { method: 'setAutoClear', input: { duration: 'unlimited' } },
      { method: 'setAutoClear', input: { duration: '10m' } },
      { method: 'setAutoClear', input: { provider: 'mistral', duration: '3600s' } },
    ],
  },
].map(run);

// `resolveAgentTerminalReapMs`: per autoClear section, each provider's retention. openai-oauth is
// unlimited as an idle window (0) yet reaps after an hour; unlimited overrides never disable reaping.
const reapSections = [
  { name: 'none', autoClear: undefined },
  { name: 'empty', autoClear: {} },
  { name: 'overrides', autoClear: { providerIdleMs: { Groq: 7200000, anthropic: 0, 'openai-oauth': 600000, mistral: '90m', default: 900000, bad: -1, '20': 300000 } } },
  { name: 'unlimited-default', autoClear: { providerIdleMs: { default: 0, xai: 'never' } } },
  { name: 'not-an-object', autoClear: 'x' },
];
const reapProviders = ['openai-oauth', 'OpenAI', ' anthropic ', 'groq', 'xai', 'mistral', 'deepseek', 'unknown', 'Default', '', '20', undefined, null];
const reap = reapSections.flatMap(({ name, autoClear }) =>
  reapProviders.map((provider) => ({
    section: name,
    autoClear: autoClear ?? null,
    provider: provider ?? null,
    ms: helpers.resolveAgentTerminalReapMs(autoClear === undefined ? {} : { autoClear }, provider),
  }))
);

writeFileSync(
  join(outDir, 'golden', 'settings.json'),
  `${JSON.stringify({ configKeys: keys.COMPACTION_CONFIG_KEYS, cases, reap }, null, 2)}\n`
);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, agentDir);
