#!/usr/bin/env node
// Golden twin of `collectWebSearchProviderModels` (session-runtime/provider-models/web-search-catalog.mjs)
// with the quick rows it falls back to (quick-model-rows/web-search-rows.mjs), the revision index
// (provider-models/model-meta.mjs) and `quickWebSearchModels` (quick-web-search-models.mjs). Node's own
// factories run over a scripted registry; the collaborators the factories take as arguments (the row
// builder, the hydrating read, the sort, the capability check) are scripted too, so the golden fixes
// the orchestration: which tier answers, which rows are asked for, in what order, and what is cached.
// The route / provider-id / route-config helpers, `isSelectableLlmModel`, the main-model meta and the
// roster reader are Node's own.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-web-search-models.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'web-search-models');
const base = mkdtempSync(join(tmpdir(), 'web-search-models-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
delete process.env.NODE_TEST_CONTEXT;

const sr = 'src/session-runtime';
const { createWebSearchCatalog } = await importFrom(tree, `${sr}/provider-models/web-search-catalog.mjs`);
const { createQuickWebSearchRows } = await importFrom(tree, `${sr}/quick-model-rows/web-search-rows.mjs`);
const { createModelMetaIndex } = await importFrom(tree, `${sr}/provider-models/model-meta.mjs`);
const { quickWebSearchModels } = await importFrom(tree, `${sr}/quick-web-search-models.mjs`);
const { createWebSearchRouteCandidates } = await importFrom(tree, `${sr}/native-web-search/routes.mjs`);
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const cache = await importFrom(tree, 'src/runtime/shared/llm/provider-catalog-cache.mjs');
const registry = await importFrom(tree, 'src/runtime/shared/llm/provider-catalog-registry.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const byKey = (a, b) => {
  const x = `${a.provider}\n${a.id}`;
  const y = `${b.provider}\n${b.id}`;
  return x < y ? -1 : x > y ? 1 : 0;
};

// -- the scripted world -------------------------------------------------------------------------
const model = (id, extra = {}) => ({ id, ...extra });
const search = (id, extra = {}) => ({ id, supportsWebSearch: true, ...extra });
const PROVIDERS_ALL = {
  'openai-oauth': { enabled: true },
  gemini: { enabled: true },
  'anthropic-oauth': { enabled: true },
};

const scenarios = [];
const add = (name, world, steps) => scenarios.push({ name, world, steps });
const collect = (force) => ({ op: 'collect', force });

// Tier 4: nothing cached anywhere, so quick rows answer and are adopted.
add('cold: no provider enabled, no main row', { route: { provider: 'openai', model: 'gpt-x' }, config: { providers: {} } }, [collect(false), collect(false)]);
add('cold: the default row follows a capable main model', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: {} },
  capable: { 'openai:main-model': true },
}, [collect(false)]);
add('cold: default row not added for an incapable main model', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: {} },
}, [collect(false)]);
add('cold: rosters of enabled capable providers', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: PROVIDERS_ALL },
  rosters: { 'openai-oauth': [search('o-one'), search('o-two', { name: 'Two' }), model('o-plain')], gemini: [search('g-one', { display: 'G One' })], 'anthropic-oauth': [] },
  capable: { 'openai:main-model': true },
}, [collect(false), collect(false)]);
add('cold: a disabled provider and an incapable provider name are skipped', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: false }, 'grok-oauth': { enabled: true }, deepseek: { enabled: true }, 'not-a-provider': { enabled: true } } },
  rosters: { 'openai-oauth': [search('hidden')], 'grok-oauth': [search('grok-s')], deepseek: [search('ds')] },
}, [collect(false)]);
add('cold: provider ids are normalized and deduplicated', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { ' gemini ': { enabled: true }, 'gemini-api': { enabled: true } } },
  rosters: { gemini: [search('shared'), search('shared'), search('only-one')] },
}, [collect(false)]);
add('cold: roster rows carry catalog declarations', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [
    { id: 'tools', supportedTools: ['web_search'], tools: ['t'], capabilities: { search: true }, supportsWebSearch: true },
    { id: 'explicit-false', supportsWebSearch: false },
    { id: 'string-flag', supportsWebSearch: 'yes' },
    { id: 'reasoning', supportsWebSearch: true, supportsReasoning: true, reasoningOptions: ['low'], reasoningLevels: ['low', 'high'], reasoningContentField: 'rc', contextWindow: 1000, outputTokens: 10, latest: true },
    { id: 'kind', supportsWebSearch: true, mode: 'embedding' },
  ] },
}, [collect(false)]);
add('cold: the capability table decides, not the roster flag', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [model('capable-by-table'), search('declared-but-not-capable')] },
  rowCapable: { 'openai-oauth:capable-by-table': true, 'openai-oauth:declared-but-not-capable': false },
}, [collect(false)]);
add('cold: a configured web-search route is added', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: {}, webSearchRoute: { provider: 'gemini', model: 'configured-model' } },
  rowCapable: { 'gemini:configured-model': true },
}, [collect(false)]);
add('cold: the route state is the fallback of the configured route', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: {} },
  webSearchRoute: { provider: 'anthropic', model: 'state-model' },
  rowCapable: { 'anthropic:state-model': true },
}, [collect(false)]);
add('cold: an unusable configured route falls back to the state', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: {}, webSearchRoute: { provider: '', model: '' } },
  webSearchRoute: { provider: 'gemini', model: 'state-model' },
  rowCapable: { 'gemini:state-model': true },
}, [collect(false)]);
add('cold: the main model is added when it can search', {
  route: { provider: 'anthropic', model: 'claude-main' },
  config: { providers: {} },
  capable: { 'anthropic:claude-main': true },
}, [collect(false)]);
add('cold: the main model meta merges the provider catalog row', {
  route: { provider: 'anthropic', model: 'claude-main' },
  config: { providers: {} },
  providers: { anthropic: { cachedInfo: { 'claude-main': { supportsWebSearch: true, contextWindow: 77, supportedTools: ['web_search'] } } } },
  capable: { 'anthropic:claude-main': true },
}, [collect(false)]);
add('cold: roster rows are not duplicated by the main model', {
  route: { provider: 'openai-oauth', model: 'o-one' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('o-one')] },
  capable: { 'openai-oauth:o-one': true },
}, [collect(false)]);
add('cold: the default id from a roster is not a row of its own', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('default'), search('Default'), search('real')] },
  capable: { 'openai:x': true },
}, [collect(false)]);

// Tier 3: the provider models cache, when a catalog read has filled it.
add('derived: from the provider models cache', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: PROVIDERS_ALL },
  capable: { 'openai:main-model': true },
  modelsCache: [
    { provider: 'openai', id: 'a-search', supportsWebSearch: true },
    { provider: 'openai', id: 'a-plain', supportsWebSearch: false },
    { provider: 'gemini', id: 'g-search', supportsWebSearch: true, webSearchToolType: 'google_search' },
    { provider: 'openai-oauth', id: 'o-search', supportsWebSearch: true },
    { provider: 'openai', id: 'a-search', supportsWebSearch: true },
  ],
}, [collect(false), collect(false)]);
add('derived: the cache is adopted, a later models cache is ignored', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: {} },
  modelsCache: [{ provider: 'openai', id: 'first', supportsWebSearch: true }],
}, [collect(false), { op: 'modelsCache', rows: [{ provider: 'openai', id: 'second', supportsWebSearch: true }] }, collect(false)]);
add('derived: an empty models cache is a cache', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('ignored')] },
  modelsCache: [],
}, [collect(false)]);
add('derived: the default row leads and is not repeated', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: {} },
  capable: { 'openai:x': true },
  modelsCache: [{ provider: 'default', id: 'default', supportsWebSearch: true }, { provider: 'openai', id: 'a', supportsWebSearch: true }],
}, [collect(false)]);

// Tier 1: a forced scan of the enabled providers.
add('force: scans every enabled capable provider', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: PROVIDERS_ALL },
  capable: { 'openai:main-model': true },
  providers: {
    'openai-oauth': { list: [search('o-one'), model('o-plain'), search('o-two')] },
    gemini: { list: [search('g-one')] },
    'anthropic-oauth': { list: [] },
  },
}, [collect(true), collect(false)]);
add('force: nothing enabled answers an empty list, with no default row', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: {} },
  capable: { 'openai:main-model': true },
}, [collect(true), collect(false)]);
add('force: the provider refreshes its cache first', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true }, gemini: { enabled: true } } },
  providers: { openai: { refresh: [search('fresh')], list: [search('stale')] }, gemini: { list: [search('g')] } },
}, [collect(true)]);
add('force: a refresh that throws falls back to the listing', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { refresh: 'throw', list: [search('listed')] } },
}, [collect(true)]);
add('force: a refresh that is not a list falls back to the listing', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { refresh: 'notArray', list: [search('listed')] } },
}, [collect(true)]);
add('force: a listing that throws is an empty provider', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true }, gemini: { enabled: true } } },
  providers: { openai: { list: 'throw' }, gemini: { list: [search('g')] } },
}, [collect(true)]);
add('force: a listing that is not a list is an empty provider', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { list: 'notArray' } },
}, [collect(true)]);
add('force: a provider with no listing is skipped', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true }, gemini: { enabled: true } } },
  providers: { openai: { list: 'absent' }, gemini: { list: [search('g')] } },
}, [collect(true)]);
add('force: an unregistered provider is skipped', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true }, gemini: { enabled: true } } },
  providers: { gemini: { list: [search('g')] } },
}, [collect(true)]);
add('force: models without an id or not selectable are dropped', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { list: [
    search(''), { supportsWebSearch: true }, null, search('embed-search', { mode: 'embedding' }), search('image-gen'),
    search('text-embedding-3'), search('ok', { display: 'OK' }), search('speech-x', { name: 'Speech' }), search('chat-one', { mode: 'chat' }),
  ] } },
}, [collect(true)]);
add('force: rows are remembered under their provider', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { list: [search('a'), search('b')] } },
}, [collect(true)]);
add('force: duplicate rows across providers keep the first', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true }, openai: { enabled: true } } },
  providers: { 'openai-oauth': { list: [search('same'), search('same')] }, openai: { list: [search('same'), search('other')] } },
}, [collect(true)]);
add('force: the default row leads, a listed default is not repeated', {
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: { openai: { enabled: true } } },
  capable: { 'openai:main-model': true },
  providers: { openai: { list: [search('default'), search('real')] } },
}, [collect(true)]);
add('force: the cache is replaced by a forced read', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { list: [search('v1')] } },
}, [collect(true), { op: 'list', provider: 'openai', rows: [search('v2')] }, collect(false), collect(true), collect(false)]);

// The revision: a catalog that moved on drops the cache.
add('revision: a moved catalog drops the adopted cache', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('quick-one')] },
}, [collect(false), { op: 'roster', provider: 'openai-oauth', rows: [search('quick-two')] }, collect(false), { op: 'revision', value: 2 }, collect(false), collect(false)]);
add('revision: an unchanged revision keeps the cache', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('quick-one')] },
}, [collect(false), { op: 'revision', value: 0 }, { op: 'roster', provider: 'openai-oauth', rows: [search('quick-two')] }, collect(false)]);
add('revision: a forced read after a move', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { openai: { enabled: true } } },
  providers: { openai: { list: [search('a')] } },
}, [collect(true), { op: 'revision', value: 5 }, collect(false), collect(true), collect(false)]);
add('revision: a non-numeric revision reads as zero', {
  route: { provider: 'openai', model: 'x' },
  config: { providers: { 'openai-oauth': { enabled: true } } },
  rosters: { 'openai-oauth': [search('a')] },
}, [{ op: 'revision', value: 'x' }, collect(false)]);

// Client mode: the main catalog owns caching.
add('client: forced and plain reads go through the shared catalog', {
  client: true,
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: { openai: { enabled: true } } },
  capable: { 'openai:main-model': true },
  collected: [
    { provider: 'openai', id: 'a', supportsWebSearch: true },
    { provider: 'openai', id: 'b', supportsWebSearch: false },
    { provider: 'gemini', id: 'g', supportsWebSearch: true, webSearchToolType: 'google_search' },
  ],
}, [collect(false), collect(true), collect(false)]);
add('client: nothing is cached between reads', {
  client: true,
  route: { provider: 'openai', model: 'x' },
  config: { providers: {} },
  collected: [{ provider: 'openai', id: 'one', supportsWebSearch: true }],
}, [collect(false), { op: 'collected', rows: [{ provider: 'openai', id: 'two', supportsWebSearch: true }] }, collect(false)]);
add('client: an empty shared catalog', { client: true, route: { provider: 'openai', model: 'x' }, config: { providers: {} }, collected: [] }, [collect(false)]);
add('client: the default row and provider normalization', {
  client: true,
  route: { provider: 'openai', model: 'main-model' },
  config: { providers: {} },
  capable: { 'openai:main-model': true },
  collected: [
    { provider: 'openai-oauth', id: 'o', supportsWebSearch: true },
    { provider: 'default', id: 'default', supportsWebSearch: true },
    { provider: 'openai', id: 'o', supportsWebSearch: true },
    { provider: '', id: 'no-provider', supportsWebSearch: true },
    { provider: 'openai', model: 'by-model-key', supportsWebSearch: true },
  ],
}, [collect(false)]);

// -- running the scenarios -------------------------------------------------------------------------
function run(scenario) {
  const world = {
    route: { provider: 'openai', model: 'x' },
    config: { providers: {} },
    webSearchRoute: null,
    providers: {},
    rosters: {},
    capable: {},
    rowCapable: {},
    modelsCache: null,
    collected: [],
    client: false,
    ...scenario.world,
  };
  const trace = [];
  const remembered = [];
  let revision = 0;
  const providers = new Map();
  const setProvider = (name, spec = {}) => {
    const provider = {};
    if (spec.list !== 'absent') {
      provider.listModels = async () => {
        trace.push(['listModels', name]);
        if (spec.list === 'throw') throw new Error('listing failed');
        if (spec.list === 'notArray') return { not: 'a list' };
        return spec.list ?? [];
      };
    }
    if (spec.refresh !== undefined) {
      provider._refreshModelCache = async () => {
        trace.push(['refreshModels', name]);
        if (spec.refresh === 'throw') throw new Error('refresh failed');
        if (spec.refresh === 'notArray') return { not: 'a list' };
        return spec.refresh;
      };
    }
    provider.getCachedModelInfo = (id) => spec.cachedInfo?.[id] ?? null;
    providers.set(name, { spec, provider });
  };
  for (const [name, spec] of Object.entries(world.providers)) setProvider(name, spec);
  const reg = {
    providerCatalogRevision: () => revision,
    getProvider: (name) => providers.get(name)?.provider,
  };
  const caches = {
    providerModelsCache: { models: world.modelsCache, at: 0, revision: 0 },
    providerModelsPromise: null,
    providerModelsLoadSeq: 0,
    webSearchProviderModelsCache: { models: null, at: 0, revision: 0 },
  };
  const meta = createModelMetaIndex({ caches, modelMetaByRoute: new Map(), reg: () => reg, scheduleProviderModelWarmup: () => {} });
  const cacheKeyCapable = (provider, id) => {
    const key = `${provider}:${id}`;
    return Object.hasOwn(world.rowCapable, key) ? world.rowCapable[key] : null;
  };
  const providerModelCacheRow = (name, arg) => {
    const key = cacheKeyCapable(name, arg.id);
    const supportsWebSearch = key === null ? arg.supportsWebSearch === true : key;
    trace.push(['cacheRow', name, plain(arg)]);
    return { ...arg, provider: name, supportsWebSearch };
  };
  const webSearchCapableFor = (provider, modelMeta) => Boolean(world.capable[`${provider}:${modelMeta?.id}`]);
  const getRoute = () => world.route;
  const candidates = createWebSearchRouteCandidates({
    getRoute,
    getReg: () => reg,
    getWebSearchRoute: () => world.webSearchRoute,
    setWebSearchRoute() {},
    ensureFullConfig() {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (cfg) => cfg,
    normalizeWebSearchProviderId: workflow.normalizeWebSearchProviderId,
    isDefaultWebSearchRouteConfig: workflow.isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider: workflow.isWebSearchCapableProvider,
    webSearchCapableFor,
  });
  const quick = createQuickWebSearchRows({
    getRoute,
    getWebSearchRoute: () => world.webSearchRoute,
    displayConfig: () => world.config,
    providerModelCacheRow,
    sortProviderModels: (rows) => [...rows].sort(byKey),
    normalizeWebSearchProviderId: workflow.normalizeWebSearchProviderId,
    normalizeWebSearchRouteConfig: workflow.normalizeWebSearchRouteConfig,
    isWebSearchCapableProvider: workflow.isWebSearchCapableProvider,
    webSearchCapableFor,
    currentMainWebSearchModelMeta: candidates.currentMainWebSearchModelMeta,
  });
  const rowsApi = {
    providerModelCacheRow,
    providerModelsFromCacheRows: (rows) =>
      (rows || []).filter((row) => row.provider !== 'hidden-provider').map((row) => ({ ...row, hydrated: true })).sort(byKey),
  };
  const catalog = createWebSearchCatalog({
    caches,
    config: () => world.config,
    reg: () => reg,
    meta: {
      syncCatalogRevision: () => {
        const before = caches.webSearchProviderModelsCache.models;
        const value = meta.syncCatalogRevision();
        if (before && !caches.webSearchProviderModelsCache.models) trace.push(['dropped', value]);
        return value;
      },
      remember: (provider, id, row) => remembered.push([provider, id, plain(row)]),
    },
    rows: rowsApi,
    quickHelpers: quick,
    normalizeWebSearchProviderId: workflow.normalizeWebSearchProviderId,
    isWebSearchCapableProvider: workflow.isWebSearchCapableProvider,
    collectProviderModels: async ({ force }) => {
      trace.push(['collectProviderModels', force]);
      return world.collected;
    },
    ensureFullConfig: () => trace.push(['ensureFullConfig']),
    awaitKeychainPrewarm: async () => trace.push(['awaitKeychainPrewarm']),
    ensureProvidersReady: async (providersConfig) => trace.push(['ensureProvidersReady', Object.keys(providersConfig).sort()]),
  });

  const rosterMap = () => {
    const map = new Map();
    for (const [provider, rows] of Object.entries(world.rosters)) {
      for (const file of registry.providerRosterFiles(provider)) map.set(file, rows);
    }
    return map;
  };
  const cachedModels = () => {
    const out = {};
    const snapshot = rosterMap();
    cache.withRosterSnapshot(snapshot, () => {
      for (const provider of Object.keys(world.config.providers || {})) out[workflow.normalizeWebSearchProviderId(provider)] = plain(cache.providerCachedModelsSync(workflow.normalizeWebSearchProviderId(provider)));
    });
    return out;
  };
  return { world, trace, remembered, catalog, caches, setProvider, rosterMap, cachedModels, setRevision: (v) => { revision = v; }, cache };
}

const results = [];
for (const scenario of scenarios) {
  const ctx = run(scenario);
  if (ctx.world.client) process.env.MIXDOG_MODEL_PROXY = 'client';
  else delete process.env.MIXDOG_MODEL_PROXY;
  const outputs = [];
  for (const step of scenario.steps) {
    ctx.trace.length = 0;
    ctx.remembered.length = 0;
    if (step.op === 'collect') {
      // The cached tiers read the roster synchronously, before the first await.
      const cachedModels = ctx.cachedModels();
      const answer = await ctx.cache.withRosterSnapshot(ctx.rosterMap(), () => ctx.catalog.collectWebSearchProviderModels({ force: step.force }));
      outputs.push({ op: 'collect', force: step.force, cachedModels, rows: plain(answer), trace: plain(ctx.trace), remembered: plain(ctx.remembered), cached: plain(ctx.caches.webSearchProviderModelsCache.models) });
    } else if (step.op === 'revision') {
      ctx.setRevision(step.value);
      outputs.push({ op: 'revision', value: step.value });
    } else if (step.op === 'modelsCache') {
      ctx.caches.providerModelsCache = { models: step.rows, at: 0, revision: 0 };
      outputs.push({ op: 'modelsCache', rows: step.rows });
    } else if (step.op === 'roster') {
      ctx.world.rosters[step.provider] = step.rows;
      outputs.push({ op: 'roster', provider: step.provider, rows: step.rows });
    } else if (step.op === 'list') {
      ctx.setProvider(step.provider, { ...ctx.world.providers[step.provider], list: step.rows });
      outputs.push({ op: 'list', provider: step.provider, rows: step.rows });
    } else if (step.op === 'collected') {
      ctx.world.collected = step.rows;
      outputs.push({ op: 'collected', rows: step.rows });
    }
  }
  delete process.env.MIXDOG_MODEL_PROXY;
  results.push({ name: scenario.name, world: plain({ ...scenario.world }), steps: outputs });
}

// quickWebSearchModels is pure over its models argument.
const NEWEST = [
  ['empty', {}],
  ['null', null],
  ['six rows, dated and undated', {
    a: { name: 'A', release_date: '2025-01-01' },
    b: { name: 'B', release_date: '2026-03-01' },
    c: { release_date: '2024-12-31' },
    d: { name: 'D' },
    e: { name: 'E', release_date: '2026-03-01' },
    f: { name: 'F', release_date: '2026-04' },
    g: { name: 'G', release_date: 'garbage' },
  }],
  ['ties keep their order', { x: { release_date: '2026-01-01' }, y: { release_date: '2026-01-01' }, z: { release_date: '2026-01-01' } }],
  ['a row that is not an object', { x: null, y: 'text', z: { name: 'Z', release_date: '2026-02-02' } }],
];
const quickCases = NEWEST.map(([name, models]) => ({ name, models, rows: plain(quickWebSearchModels('openai', models)) }));

writeJson(join(outDir, 'golden.json'), { domain: 'web-search-models', recorder: 'benchmarks/rust-core/recorders/record-web-search-models.mjs', scenarios: results, quick: quickCases });
writeSetManifest(outDir, {
  set: 'web-search-models',
  recorder: 'benchmarks/rust-core/recorders/record-web-search-models.mjs',
  command: 'node benchmarks/rust-core/recorders/record-web-search-models.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(70), r.steps.filter((s) => s.op === 'collect').map((s) => s.rows.length).join(','));
process.exit(0);
