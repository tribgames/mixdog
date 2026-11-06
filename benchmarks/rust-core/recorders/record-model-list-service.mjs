#!/usr/bin/env node
// Golden twin of `model/list` (Node's `listProviderModels` = `collectProviderModels`,
// session-runtime/provider-models.mjs): Node's real provider-models, catalog loader, row mapping,
// hydration and sort run over fake providers whose `listModels` answer (or fail) as scripted. A
// case holds the providers' listings, the saved configuration, the live route's provider and the
// read (cold, warm, quick, forced), and what Node answered. Each model is also given as the
// catalog record the Rust service reads (`snapshot`), built from the listing by `recordOf`, so a
// listing key the record cannot carry never appears. Rust
// `domains::ai_admin::model_list::ModelListService` must answer the same rows.
//
//   node benchmarks/rust-core/recorders/record-model-list-service.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
await importFrom(tree, 'scripts/lib/isolated-test-env.mjs');
const sr = 'src/session-runtime/';
const { createProviderModels } = await importFrom(tree, `${sr}provider-models.mjs`);
const recency = await importFrom(tree, `${sr}model-recency.mjs`);
const { webSearchCapableFor } = await importFrom(tree, `${sr}boot/shared.mjs`);
const { invalidateSharedProviderCatalog } = await importFrom(tree, `${sr}provider-catalog-cache.mjs`);

const NOW = 1_700_000_000_000;
Date.now = () => NOW;

let seed = 0x6d0de11d;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const PROVIDERS = ['anthropic', 'anthropic-oauth', 'custom-a', 'custom-b', 'gemini', 'openai', 'openai-oauth', 'openrouter', 'xai', 'antigravity-oauth', 'cursor-oauth'];
const IDS = [
  'zz-alpha-1', 'zz-alpha-2', 'zz-beta-10', 'zz-beta-9', 'zz-gamma-3', 'zz-delta', 'zz-dated-20250301', 'zz-dated-20250401', 'zz-latest',
  'zz-image-1', 'zz-embed-3', 'zz-tts-1', 'zz-rerank', 'zz-realtime', 'zz-moderation-latest', 'zz-Ünï-1', 'zz mixed id', 'zz-hidden-1',
];
const DATES = [undefined, '2025-03-01', '2024-12-31', '2025-11-20', '2023-01-15'];
const EFFORT_LEVELS = [['low', 'high'], ['low', 'medium', 'high'], ['minimal', 'low', 'medium', 'high', 'xhigh'], ['none', 'low', 'max']];

function randomListing(provider, id) {
  const m = { id };
  if (chance(0.5)) m.display = pick(['Alpha', 'beta model', 'Éclair', 'Model 10', 'Model 9', 'z last']);
  if (chance(0.5)) m.releaseDate = pick(DATES.filter(Boolean));
  if (chance(0.4)) m.created = pick([1700000000, 1710000000, 1650000000, 0]);
  if (chance(0.6)) m.contextWindow = pick([8000, 128000, 200000, 400000, 1000000]);
  if (chance(0.4)) m.maxContextWindow = pick([200000, 1000000, 2000000]);
  if (chance(0.4)) m.outputTokens = pick([4096, 32000, 64000]);
  if (chance(0.3)) m.family = pick(['gpt', 'claude', 'gemini']);
  if (chance(0.3)) m.mode = pick(['chat', 'responses', 'messages', 'completion', 'embedding']);
  if (chance(0.15)) m.hidden = true;
  for (const flag of ['supportsVision', 'supportsFunctionCalling', 'supportsReasoning', 'fastCapable']) {
    if (chance(0.4)) m[flag] = true;
  }
  if (chance(0.4)) m.reasoningLevels = pick(EFFORT_LEVELS);
  if (chance(0.3)) m.reasoningOptions = [{ type: 'effort', values: pick(EFFORT_LEVELS) }];
  if (chance(0.2)) m.serviceTiers = [{ id: 'priority', name: 'Priority', description: 'Faster' }];
  if (chance(0.2)) m.additionalSpeedTiers = ['fast'];
  if (chance(0.25)) m.accessPrograms = pick([['standard'], ['daybreak_blue'], ['standard', 'daybreak_blue'], []]);
  if (chance(0.2)) m.fastEfforts = ['low'];
  if (chance(0.2)) {
    m.modelParameterOptions = [{ id: 'verbosity', label: 'Verbosity', kind: 'enum', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High', contextWindow: 200000 }] }];
  }
  if (chance(0.15)) m.parameterVariants = [{ verbosity: 'low' }, { verbosity: 'high' }];
  if (chance(0.2)) m.defaultEffort = pick(['low', 'high']);
  if (provider.startsWith('custom-') && chance(0.5)) m.customReasoning = { wireFormat: 'standard', wireValues: { low: 'l', high: 'h' }, replay: false };
  return m;
}

// The catalog record the listing becomes (`ModelRecord` of catalog/record.rs, camelCase).
function recordOf(provider, m) {
  const cap = (on) => (on ? 'yes' : 'unknown');
  const picker = {};
  if (m.releaseDate !== undefined) picker.releaseDate = m.releaseDate;
  if (m.accessPrograms !== undefined) picker.accessPrograms = m.accessPrograms;
  if (m.modelParameterOptions) picker.modelParameterOptions = m.modelParameterOptions;
  if (m.parameterVariants) picker.parameterVariants = m.parameterVariants;
  if (m.fastEfforts) picker.fastEfforts = m.fastEfforts;
  if (m.serviceTiers) picker.serviceTiers = m.serviceTiers;
  if (m.additionalSpeedTiers) picker.additionalSpeedTiers = m.additionalSpeedTiers;
  if (m.reasoningOptions) picker.reasoningOptions = m.reasoningOptions;
  if (m.customReasoning) picker.customReasoning = m.customReasoning;
  const record = {
    picker,
    hidden: m.hidden === true,
    id: m.id,
    provider,
    rates: {},
    vision: cap(m.supportsVision),
    functionCalling: cap(m.supportsFunctionCalling),
    reasoning: cap(m.supportsReasoning),
    fastMode: cap(m.fastCapable),
    reasoningEfforts: m.reasoningLevels ?? [],
    source: 'native',
  };
  for (const [from, to] of [['display', 'displayName'], ['created', 'created'], ['contextWindow', 'contextWindow'], ['maxContextWindow', 'maxContextWindow'], ['outputTokens', 'outputTokens'], ['family', 'family'], ['mode', 'mode'], ['defaultEffort', 'defaultEffort']]) {
    if (m[from] !== undefined) record[to] = m[from];
  }
  return record;
}

function randomCase() {
  const names = PROVIDERS.filter(() => chance(0.4)).sort();
  if (!names.length) names.push(pick(PROVIDERS));
  const providers = names.map((name) => {
    const failed = chance(0.15);
    const models = failed ? [] : Array.from({ length: pick([0, 1, 2, 3, 5, 8]) }, () => randomListing(name, pick(IDS)));
    return { name, failed, models };
  });
  const modelSettings = {};
  for (const p of providers) {
    for (const m of p.models) {
      if (!chance(0.25)) continue;
      const s = {};
      if (chance(0.4)) s.alias = pick(['My Model', ' padded ', '']);
      if (chance(0.4)) s.effort = pick(['low', 'high']);
      if (chance(0.4)) s.fast = chance(0.5);
      if (chance(0.2)) s.autoEffort = chance(0.5);
      if (chance(0.2)) s.modelParameters = { serviceTier: 'priority' };
      if (chance(0.2)) s.contextPercent = pick([30, 50]);
      if (chance(0.2)) s.contextTokens = pick([100000, 0]);
      if (chance(0.2)) s.hidden = chance(0.5);
      if (chance(0.2)) s.favorite = true;
      modelSettings[`${p.name}/${m.id}`] = s;
    }
  }
  const config = { modelSettings, providers: {} };
  for (const name of names) {
    if (name.startsWith('custom-')) config.providers[name] = { name: pick(['My A', ' Padded ', '']), protocol: pick(['openai-chat', 'openai-responses', 'anthropic']) };
  }
  const read = pick(['cold', 'cold', 'warm', 'warm-quick', 'force']);
  return { providers, config, route: pick([...PROVIDERS, '']), read };
}

async function run(c) {
  const rev = (run.rev = (run.rev || 0) + 1);
  invalidateSharedProviderCatalog();
  const listings = new Map(c.providers.map((p) => [p.name, p]));
  const registry = {
    providerCatalogRevision: () => rev,
    getProvider: (name) => listings.get(name) && { listModels: async () => [] },
    getAllProviders: () =>
      new Map(
        c.providers.map((p) => [
          p.name,
          {
            listModels: async () => {
              if (p.failed) throw new Error(`${p.name} is down`);
              return structuredClone(p.models);
            },
          },
        ])
      ),
    refreshProviderCatalogsOnStartup: async () => {},
    refreshCatalogs: async () => {},
  };
  const caches = {
    providerModelsCache: { models: null, at: 0, revision: 0 },
    providerModelsPromise: null,
    webSearchProviderModelsCache: { models: null, at: 0, revision: 0 },
    providerModelsLoadSeq: 0,
  };
  const api = createProviderModels({
    caches,
    modelMetaByRoute: new Map(),
    getRoute: () => ({ provider: c.route }),
    getConfig: () => c.config,
    getReg: () => registry,
    webSearchCapableFor,
    sortProviderModelsRaw: recency.sortProviderModels,
    providerModelCacheRowRaw: recency.providerModelCacheRow,
    normalizeWebSearchProviderId: (v) => v,
    isWebSearchCapableProvider: () => false,
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    bootProfile: () => {},
    scheduleProviderModelWarmup: () => {},
    quickHelpers: { quickProviderModelRows: () => [] },
  });
  if (c.read === 'warm' || c.read === 'warm-quick') await api.collectProviderModels();
  const options = c.read === 'force' ? { force: true } : c.read === 'warm-quick' ? { quick: true } : {};
  return api.collectProviderModels(options);
}

const cases = [];
for (let i = 0; i < 400; i += 1) {
  const c = randomCase();
  let result;
  try {
    result = { value: plain(await run(c)) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  const models = {};
  const status = {};
  for (const p of c.providers) {
    models[p.name] = p.models.map((m) => recordOf(p.name, m));
    status[p.name] = p.failed ? { state: 'missing', retryAt: NOW + 30_000, message: `${p.name} is down` } : { state: 'ok' };
  }
  cases.push({
    read: c.read,
    route: c.route,
    config: c.config,
    snapshot: { generation: 1, models, status },
    ...result,
  });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'model-list-service-twin.json'), {
  domain: 'model-list-service-twin',
  recorder: 'benchmarks/rust-core/recorders/record-model-list-service.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-model-list-service.mjs',
  command: 'node benchmarks/rust-core/recorders/record-model-list-service.mjs --tree <tree>',
  identityTree: tree,
});
const rows = cases.reduce((n, c) => n + (c.value?.length ?? 0), 0);
console.log(`recorded ${cases.length} cases, ${rows} rows (${cases.filter((c) => c.error).length} errors)`);
