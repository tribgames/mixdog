#!/usr/bin/env node
// Golden twin of `buildSessionProviderCacheOpts` (session-lifecycle.mjs, a module-private function,
// rebuilt here from the exports it calls) and `resolveSessionContextMeta` (context-meta.mjs). Each
// cache case holds the inputs and what Node answered; each meta case also holds the cached provider
// row and the catalog row Node read, since Rust reads them from its own catalog.
// Rust `mixdog-core` `run_host::session_cache_opts` and `run_host::session_context_meta` must equal it.
//
//   node benchmarks/rust-core/recorders/record-session-cache-meta.mjs --tree <dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'session-cache-meta-'));
delete process.env.MIXDOG_CACHE_MESSAGES_TTL;
const cli = parseArgs();
const tree = resolveTree(cli);
const orch = 'src/runtime/agent/orchestrator/';
const cache = await importFrom(tree, `${orch}agent-runtime/cache-strategy.mjs`);
const helpers = await importFrom(tree, `${orch}runtime-core/config-helpers.mjs`);
const meta = await importFrom(tree, `${orch}session/manager/context-meta.mjs`);
const catalog = await importFrom(tree, `${orch}providers/model-catalog.mjs`);

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function buildSessionProviderCacheOpts(provider, sessionId, agent, config, session) {
  if (cache.cacheCapabilityForProvider(provider) !== 'explicit-breakpoint') {
    return cache.roleProviderCacheOpts(provider, agent, { session });
  }
  let autoClear = null;
  if (cache.isLeadCacheClass(agent, session)) {
    autoClear = {
      ...helpers.normalizeAutoClearConfig(config?.autoClear),
      idleMs: helpers.resolveAutoClearIdleMs(config, provider),
    };
  }
  return cache.buildProviderCacheOpts(provider, sessionId, agent, { autoClear, session });
}

const AGENTS = [null, 'lead', 'worker', 'title-agent', 'cycle1-agent', 'explore-agent', 'ann'];
const HEADERS = [
  {},
  { owner: 'agent' },
  { owner: ' Agent ' },
  { sessionMode: 'agent' },
  { sessionMode: 'coding' },
  { id: 'sess_home_ann' },
  { id: 'sess_rmem_abcdef_ann' },
  { ownerAgentId: 'ann' },
  { visibility: 'agent-only', id: 'sess_home_ann' },
];
const AUTO_CLEARS = [
  undefined,
  { enabled: false },
  { idleMs: 300000 },
  { idleMs: 7200000 },
  { idleMs: 10 },
  { providerIdleMs: { anthropic: 600000 } },
  { providerIdleMs: { anthropic: 'unlimited' } },
  { providerIdleMs: { default: 120000 } },
];
const cacheCases = [];
const addCache = (provider, agent, header, autoClear) => {
  const config = autoClear === undefined ? {} : { autoClear };
  const session = { id: 'sess_x', ...header };
  cacheCases.push({
    provider,
    sessionId: 'sess_x',
    agent,
    header: session,
    autoClear: autoClear === undefined ? null : autoClear,
    opts: plain(buildSessionProviderCacheOpts(provider, 'sess_x', agent, config, session)),
  });
};
for (const provider of ['anthropic', 'anthropic-oauth'])
  for (const agent of AGENTS) for (const header of HEADERS) for (const ac of AUTO_CLEARS) addCache(provider, agent, header, ac);
for (const provider of ['openai', 'openai-oauth', 'xai', 'grok-oauth', 'gemini', 'deepseek', 'cursor-oauth', 'custom-x', ''])
  for (const agent of AGENTS) addCache(provider, agent, {}, undefined);

const PROVIDERS = ['anthropic', 'openai', 'openai-oauth', 'xai', 'gemini', 'cursor-oauth', 'cursor-api', 'mixdog-local', 'local', '', 'custom-x'];
const MODELS = [
  'claude-opus-5-5', 'claude-sonnet-4', 'claude-haiku-4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-4o', 'grok-build-1',
  'grok-4.5', 'grok-3', 'gemini-3.8-flash', 'gemini-2.5-pro', 'deepseek-v4', 'llama-3-8b', 'qwen-7b', 'phi-3', 'unknown-model', 'GPT-5-Mini',
];
const INFOS = [null, { contextWindow: 272000 }, { contextWindow: 1000000, maxContextWindow: 1000000 }, { context_window: 2000000 }, { maxContextWindow: 300000 }, { contextWindow: 64000, effectiveContextWindowPercent: 90 }, { runtimeContextWindow: 8192, contextWindow: 32768 }, { autoCompactTokenLimit: 100000, contextWindow: 200000 }];
const SEEDS = [
  {}, { contextPercent: 50 }, { contextPercent: 0 }, { selectedContextWindow: 123000 }, { contextTokens: 50000 }, { contextTokens: 9999999 },
  { rawContextWindow: 400000 }, { contextWindow: 333000 }, { effectiveContextWindowPercent: 80 }, { effective_context_window_percent: 150 },
  { autoCompactTokenLimit: 90000 }, { autoCompactTokenLimit: 1e9 }, { contextWindow: '250000' }, { selectedContextWindow: 60000, contextPercent: 60 },
];
let state = 0x1badb002;
const rnd = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const metaCases = [];
const addMeta = (provider, model, info, seed, wholeWindow) => {
  const impl = { name: provider, getCachedModelInfo: () => info };
  metaCases.push({
    provider,
    model,
    info,
    seed,
    wholeWindow,
    catalogInfo: plain(catalog.getModelMetadataSync(model, provider.toLowerCase())),
    meta: plain(meta.resolveSessionContextMeta(impl, model, seed, { wholeWindow })),
  });
};
for (const provider of PROVIDERS) for (const model of MODELS) addMeta(provider, model, null, {}, false);
for (const model of MODELS) addMeta('openai', model, null, {}, true);
// A managed local runtime: its allocated capacity bounds a restored or selected window.
const LOCAL_ROW = { contextWindow: 16384, maxContextWindow: 262144, runtimeContextWindow: 16384 };
for (const seed of [{}, { selectedContextWindow: 262144 }, { selectedContextWindow: 8192 }, { contextTokens: 100000 }, { contextPercent: 50 }, { contextWindow: 65536 }])
  for (const wholeWindow of [false, true]) {
    addMeta('mixdog-local', 'qwen-7b', LOCAL_ROW, seed, wholeWindow);
    addMeta('mixdog-local', 'qwen-7b', { ...LOCAL_ROW, runtimeContextWindow: undefined }, seed, wholeWindow);
  }
for (let i = 0; i < 600; i += 1) addMeta(pick(PROVIDERS), pick(MODELS), pick(INFOS), pick(SEEDS), rnd() < 0.3);

writeJson(join(tree, 'native/core/crates/mixdog-core/src/run_host/golden/session_cache_opts.json'), { cases: cacheCases });
writeJson(join(tree, 'native/core/crates/mixdog-core/src/run_host/golden/session_context_meta.json'), { cases: metaCases });
console.log(`cache cases: ${cacheCases.length}, meta cases: ${metaCases.length}`);
