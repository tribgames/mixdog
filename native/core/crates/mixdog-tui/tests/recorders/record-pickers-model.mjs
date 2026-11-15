// Records what the Node model, effort, Fast, web search, workflow, output style, agents and theme pickers do, so the Rust port
// (`mixdog_tui::pickers::model`) is checked against it (tests/pickers_model.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-pickers-model.mjs --tree C:/Project/mixdog [--catalog <model-list-twin.json>] --write tests/goldens/pickers-model.json
//   node record-pickers-model.mjs --tree C:/Project/mixdog [--catalog <model-list-twin.json>] --check tests/goldens/pickers-model.json
//
// Recorded:
//  * options   - model-options.mjs over catalogs (hand-written ones, and the catalog rows of ai-admin/model-list-twin.json when
//                --catalog names it, grouped by provider): normalizeModelOptions, the provider and model rows, route labels,
//                version / recency / family / context helpers, and the setup-name and catalog-failure loaders;
//  * scenarios - the pickers driven by scripted operations (open, select, left/right/tab/key, highlight, cancel, confirm, a
//                newer panel taking the surface, a clock step) against a scripted store: after every operation the store calls,
//                notices and other events it caused and the panel that is on screen (rows, footers of every row, help, keys).
//
// The store's answers are promises in Node and plain results in Rust; every operation is followed by a short wait, so what
// settles in Node has settled before the next operation. The store calls of one operation are compared as a sorted list (Node
// issues the full catalog load before the quick one and starts a save before it paints the next panel; the Rust store calls are
// blocking and run in the order that paints first).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-pickers-model.mjs --tree <mixdog checkout> [--catalog <file>] (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const STUBS = {
  react:
    'export const useState=()=>[],useEffect=()=>{},useRef=()=>({}),useCallback=f=>f,useMemo=f=>f(),useLayoutEffect=()=>{},useContext=()=>({}),createContext=()=>({}),createElement=()=>null,memo=f=>f,forwardRef=f=>f,Fragment=null;export default {};',
  'string-width': 'export default s=>[...String(s)].length;',
  'strip-ansi': 'export default s=>String(s);',
  marked: 'export const marked={lexer:()=>[],setOptions(){},use(){}};',
  chalk:
    'const p=()=>new Proxy(function(s){return String(s)},{get:(t,k)=>k==="level"?0:p(),apply:(t,th,a)=>String(a[0])});export class Chalk{constructor(){return p()}};export default p();',
  'wrap-ansi': 'export default s=>String(s);',
};
const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && STUBS[spec]) return { url: 'stub:' + spec, shortCircuit: true };
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const sources = [];
const load = async (path) => {
  const file = join(tree, 'src/tui', path);
  sources.push({ path: `src/tui/${path}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

const opts = await load('app/model-options.mjs');
const { createModelPicker } = await load('app/model-picker.mjs');
const { createRoutePickers } = await load('app/route-pickers.mjs');
const { createThemeEffortPickers } = await load('app/theme-effort-pickers.mjs');
const { createPanelSurface } = await load('app/panel-surface.mjs');
const panelEpoch = await load('app/panel-epoch.mjs');
const appFormat = await load('app/app-format.mjs');

// The quick load failing leaves the full load it raced with unobserved: Node reports it as unhandled, and the app's own
// handler drops it.
process.on('unhandledRejection', () => {});

const wait = (ms = 12) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value) => (Number.isFinite(value) ? value : String(value));

// ---------------------------------------------------------------------------------------------------------------- options

const model = (provider, id, extra = {}) => ({ provider, id, ...extra });
const EFFORTS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];
const SPEED = {
  id: 'serviceTier',
  label: 'Speed',
  kind: 'enum',
  options: [
    { value: 'priority', label: 'Fast' },
    { value: 'ultrafast', label: 'Ultrafast' },
  ],
};
const ROUTING = {
  id: 'providerSort',
  label: 'Routing',
  kind: 'enum',
  options: [
    { value: 'auto', label: 'Auto' },
    { value: 'price', label: 'Price first' },
    { value: 'throughput', label: 'Speed first' },
    { value: 'latency', label: 'Latency first' },
  ],
};
const THINKING = {
  id: 'thinking',
  label: 'Thinking',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ],
};
const DAYBREAK = {
  id: 'daybreak',
  label: 'Daybreak Blue',
  kind: 'boolean',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ],
};
const CUSTOM_ID = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';

const CLAUDE_X = model('anthropic', 'claude-x-1', {
  display: 'Claude X',
  effortOptions: EFFORTS,
  fastCapable: true,
  fastEfforts: ['low', 'medium'],
  contextWindow: 200_000,
  maxContextWindow: 1_000_000,
  modelParameterOptions: [THINKING],
  defaultModelParameters: { thinking: 'off' },
});
const CLAUDE_PLAIN = model('anthropic', 'claude-plain', { display: 'Claude Plain', contextWindow: 100_000 });

const handCatalogs = {
  claude: [
    ...['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5'].map((id) =>
      model('anthropic-oauth', id)
    ),
    model('anthropic-oauth', 'claude-sonnet-4-6', { latest: true, created: 1_760_000_000 }),
    model('anthropic-oauth', 'claude-haiku-4-5-20251001'),
    model('anthropic', 'claude-3-7-sonnet-20250219', { releaseDate: '2025-02-19' }),
  ],
  openai: [
    model('openai-oauth', 'gpt-5.2', { display: 'GPT 5.2', contextWindow: 400_000, fastCapable: true, description: 'Flagship' }),
    model('openai-oauth', 'gpt-5.1', { created: 1_730_000_000 }),
    model('openai-oauth', 'gpt-5', { releaseDate: '2025-08-07' }),
    model('openai-oauth', 'o3-mini'),
    model('openai-oauth', 'gpt-5.2-codex', { description: '  Coding  ', fastCapable: true }),
    model('openai', 'gpt-4.1', { contextWindow: 1_047_576 }),
  ],
  gemini: [
    model('gemini', 'gemini-2.5-pro', { contextWindow: 1_048_576 }),
    model('gemini', 'gemini-2.5-flash', { contextWindow: 131_072 }),
    model('gemini', 'gemini-3-pro', { contextWindow: 2_000_000 }),
    model('gemini', 'gemini-1.5-pro', { contextWindow: 1_062_500 }),
    model('gemini', 'gemini-2.0-flash', { contextWindow: 128_000 }),
  ],
  openrouter: [
    ...Array.from({ length: 12 }, (_, i) => model('openrouter', `vendor/model-${i}`, { created: 1000 + i })),
    model('openrouter', '~anthropic/claude-opus-latest', { created: 1 }),
    model('openrouter', '~openai/gpt-sol-latest', { created: 2 }),
    model('openrouter', 'qwen3.8-max'),
    model('openrouter', 'z-ai/glm-5.3-flash'),
  ],
  mixed: [
    model('xai', 'grok-4.1', { family: 'Grok' }),
    model('deepseek', 'deepseek-v4-flash', { name: 'DeepSeek V4 Flash' }),
    model('mixdog-local', 'local-7b'),
    model('opencode-go-oauth', 'kimi-k2.7-code'),
    model(CUSTOM_ID, 'my-model', { display: 'My Model', providerName: 'Gateway' }),
    model('openai', 'gpt-x', { display: 'GPT X', providerName: 'Spoof' }),
    model('unknown-provider', 'thing-1'),
    model('default', 'default'),
  ],
};

const fixtureCatalogs = {};
if (!option('--catalog') && option('--check')) {
  // A check without the catalog file reads the corpus the golden was recorded with.
  const recordedGolden = JSON.parse(readFileSync(option('--check'), 'utf8'));
  for (const [name, entry] of Object.entries(recordedGolden.options.catalogs)) {
    if (name.startsWith('fixture-')) fixtureCatalogs[name] = entry.models;
  }
}
if (option('--catalog')) {
  const twin = JSON.parse(readFileSync(option('--catalog'), 'utf8'));
  const rows = (twin.rowCases || []).map((c) => c.row).filter((row) => row && row.id);
  for (let i = 0; i < rows.length && i < 120; i += 1) {
    const provider = ['anthropic-oauth', 'openai-oauth', 'openrouter', 'gemini', 'xai'][i % 5];
    const key = `fixture-${provider}`;
    (fixtureCatalogs[key] ||= []).push({ ...rows[i], provider });
  }
}

const itemSummary = (item) => [item.value, item.label, item.marker || '', item.meta || '', item.description || '', item._action || '', item._provider || '', item._modelId || ''];

const NAMES = { [CUSTOM_ID]: '내 AI' };
const ROUTES = [
  null,
  { provider: 'anthropic', model: 'claude-x-1' },
  { provider: 'openai-oauth', model: 'gpt-5.2', effort: 'xhigh', fast: true },
  { provider: 'openai-oauth', model: 'gpt-5.2', effort: 'high', fast: true, modelParameters: { serviceTier: 'ultrafast', daybreak: 'on' } },
  { provider: 'openai-oauth', model: 'gpt-5.2', modelDisplay: 'GPT Five', modelParameters: { daybreak: 'ON' } },
  { provider: CUSTOM_ID, model: 'my-model', effort: 'low' },
  { provider: 'openrouter', model: 'vendor/model-3', effort: 'auto_x' },
  { provider: '', model: 'x' },
  {},
];

const IDS = [
  'CLAUDE-OPUS-5', 'claude-sonnet-4-6', 'claude-sonnet-4.6', 'gpt5.2.123', 'prefix-1-gpt5.2', 'gpt-5', 'vendor-v3.4',
  'vendor-v2.3.4567', 'unversioned', undefined, 'o3-mini', 'glm-5.3-flash', 'claude-opus', 'llama3.1', 'x-1.2.3.4', '',
];
const optionsOut = { routes: ROUTES, names: NAMES, ids: IDS, catalogs: {}, helpers: {} };
const allCatalogs = { ...handCatalogs, ...fixtureCatalogs };
for (const [name, models] of Object.entries(allCatalogs)) {
  const normalized = opts.normalizeModelOptions(models);
  const providers = [...new Set(normalized.map((m) => m.provider))];
  const matrix = [];
  const sample = models.slice(0, 14);
  for (const a of sample) for (const b of sample) matrix.push([opts.compareModelRecency(a, b), opts.compareModelVersion(a, b)]);
  optionsOut.catalogs[name] = {
    models,
    normalized: normalized.map((m) => [m.provider, m.id]),
    providerItems: ROUTES.map((route) => opts.buildModelProviderItems(normalized, route, NAMES).map(itemSummary)),
    providerItemsNoNames: opts.buildModelProviderItems(normalized, null, null).map(itemSummary),
    modelItems: providers.map((p) => [p, opts.buildProviderModelItems(normalized, p, ROUTES[1]).map(itemSummary)]),
    names: opts.catalogProviderDisplayNames(models, {}),
    namesWithSetup: opts.catalogProviderDisplayNames(models, NAMES),
    perModel: models.map((m) => ({
      version: opts.modelVersion(m),
      release: num(opts.releaseTime(m)),
      family: opts.modelFamily(m),
      claude: opts.isClaudeModel(m),
      context: opts.modelContextWindow(m),
      contextLabel: opts.formatContextWindow(opts.modelContextWindow(m)),
      description: opts.modelDescription(m),
      limit: opts.modelFamilyLimit(m.provider, opts.modelFamily(m)),
    })),
    matrix,
  };
}

optionsOut.helpers.parsedModelVersion = IDS.map((id) => [id ?? null, opts.parsedModelVersion(id)]);
optionsOut.helpers.formatContextWindow = [
  0, -1, NaN, 500, 999, 1000, 1024, 1500, 8192, 100_000, 128_000, 131_072, 200_000, 262_144, 1_000_000, 1_048_576, 1_062_500,
  1_500_000, 2_000_000, 2_097_152, 4_194_304, 10_000_000, 1_234_567, 4_294_967_296, 8_589_934_592, 1_073_741_824, 1e12,
].map((n) => [num(n), opts.formatContextWindow(n)]);
optionsOut.helpers.providerRank = [
  'default', 'OpenAI-OAuth', 'anthropic-oauth', 'grok-oauth', 'muse-code-oauth', 'command-code-oauth', 'mimo-oauth',
  'antigravity-oauth', 'cursor-oauth', 'devin-oauth', 'opencode-go-oauth', 'openai', 'anthropic-api', 'gemini', 'xai-api',
  'deepseek', 'mixdog-local', 'openrouter', 'zzz', '', undefined,
].map((p) => [p ?? null, opts.providerDisplayRank(p), opts.providerDisplayName(p)]);
optionsOut.helpers.routeLabels = ROUTES.map((route) => [
  opts.routeLabel(route, null),
  opts.routeLabel(route, NAMES),
  opts.routeModelLabel(route),
  opts.agentModelProfile(route),
  JSON.stringify(opts.agentModelParts(route || {})),
]);
optionsOut.helpers.routeFromModel = [
  [CLAUDE_X, null],
  [CLAUDE_X, 'auto'],
  [CLAUDE_X, 'high'],
].map(([m, effort]) => opts.routeFromModel(m, effort));
optionsOut.helpers.resolveProviderDisplayName = [
  [CUSTOM_ID, NAMES],
  [CUSTOM_ID, null],
  ['openai', {}],
  ['openai', { openai: 'Mine' }],
  [`  ${CUSTOM_ID}  `, NAMES],
  ['custom-x', { 'custom-x': '' }],
].map(([p, n]) => opts.resolveProviderDisplayName(p, n));

const setupRows = {
  api: [
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      catalogError: { message: 'opencode-go models 401: This API key has expired.', errorKind: { kind: 'auth', code: 'api_key_expired', status: 401 } },
    },
    { id: 'openai', catalogError: { message: 'openai models 500', errorKind: { kind: 'transient', status: 500 } } },
    { id: 'xai' },
    { provider: 'p-only', label: ' Label Only ' },
    { id: '  spaced ', name: '  Spaced  ' },
    null,
    { id: CUSTOM_ID, name: '내 AI', catalogError: { message: 'fetch failed' } },
  ],
  oauth: [{ id: 'anthropic-oauth', catalogError: { message: 'Request failed with status code 429' } }],
  local: 'not-an-array',
};
const setupStore = (setup) => ({ getProviderSetup: async () => setup });
const names1 = await opts.loadProviderDisplayNames(setupStore(setupRows));
const failures1 = await opts.loadProviderCatalogFailures(setupStore(setupRows));
optionsOut.setup = {
  rows: setupRows,
  names: names1,
  failures: failures1,
  failureItems: opts.buildCatalogFailureItems(failures1, handCatalogs.mixed, names1).map(itemSummary),
  failureItemsOther: opts.buildCatalogFailureItems(failures1, [], null).map((i) => [i.value, i.label, i.marker, i.description, i._failure]),
  missing: await opts.loadProviderDisplayNames({}),
  missingFailures: await opts.loadProviderCatalogFailures({}),
  throwing: await opts.loadProviderDisplayNames({ getProviderSetup: async () => { throw new Error('down'); } }),
};

// ---------------------------------------------------------------------------------------------------------------- scenarios

const MODELS = [CLAUDE_X, CLAUDE_PLAIN];
const ULTRA = [model('anthropic', 'ultra-1', { display: 'Ultra', fastCapable: true, modelParameterOptions: [SPEED] })];
const PLAIN_FAST = [model('anthropic', 'plain-fast', { display: 'PF', fastCapable: true })];
const ROUTING_MODELS = [model('anthropic', 'or-1', { display: 'OR', modelParameterOptions: [ROUTING] }), model('anthropic', 'plain-1', { display: 'Plain' })];
const MULTI = [
  CLAUDE_X,
  CLAUDE_PLAIN,
  model('openai-oauth', 'gpt-5.2', {
    display: 'GPT 5.2',
    effortOptions: [...EFFORTS, { value: 'xhigh', label: 'xhigh' }],
    fastCapable: true,
    modelParameterOptions: [DAYBREAK, SPEED],
    parameterVariants: [
      { fast: 'true', effort: 'low' },
      { fast: 'true', effort: 'xhigh', daybreak: 'off' },
    ],
    savedEffort: 'medium',
    savedFast: true,
    savedContextPercent: 45,
    savedModelParameters: { daybreak: 'on' },
    contextWindow: 400_000,
    maxContextWindow: 1_000_000,
    defaultEffort: 'low',
  }),
  model(CUSTOM_ID, 'my-model', { display: 'My Model' }),
];
const AGENTS = [
  { id: 'worker', label: 'Worker', description: 'Does the work', route: { provider: 'anthropic', model: 'claude-x-1', effort: 'high', fast: true } },
  { id: 'reviewer', label: 'Reviewer', disabled: true, definition: { description: 'Reviews' } },
  { id: 'scout', label: 'Scout', route: { provider: 'openai-oauth', model: 'gpt-5.2', effort: 'xhigh', modelParameters: { serviceTier: 'ultrafast' }, fast: true } },
];
const WORKFLOWS = [
  { id: 'solo', name: 'Solo', active: true, description: 'One agent' },
  { id: 'team', name: 'Team', source: 'user' },
  { id: 'plain', name: 'Plain' },
];
const STYLES = {
  styles: [
    { id: 'default', label: 'Default', description: 'Standard' },
    { id: 'terse', source: 'user pack' },
    { id: 'verbose' },
  ],
  current: { id: 'terse' },
};
const THEMES = [
  { id: 'default', label: 'Default', description: 'Basic', current: true },
  { id: 'dark', label: 'Dark' },
  { id: 'light-ansi' },
];
const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low', description: 'Fast, cheap' },
  { value: 'medium', label: 'Medium', description: 'current' },
  { value: 'high', label: 'High', description: 'Current' },
];
const T0 = 1_000_000_000;
const FRESH = (models) => ({ models, at: T0 });

const scenarios = [];
const scenario = (name, spec) => scenarios.push({ name, spec });

scenario('model: footers, effort wrap, Fast, context, thinking, Enter saves, Esc back', {
  caches: { provider: FRESH(MODELS) },
  store: { setRoute: true },
  ops: [
    { open: 'model', options: { onAfterSelect: true } },
    { select: 0 },
    { right: 'claude-x-1' },
    { left: 'claude-x-1' },
    { left: 'claude-x-1' },
    { tab: 'claude-x-1' },
    { right: 'claude-x-1' },
    { key: 'c', row: 'claude-x-1' },
    { key: 'c', row: 'claude-x-1' },
    { key: 'C', row: 'claude-x-1' },
    { key: 't', row: 'claude-x-1' },
    { key: 'T', row: 'claude-plain' },
    { key: 'x', row: 'claude-x-1' },
    { cancel: true },
    { select: 0 },
    { select: 'claude-x-1' },
    { open: 'model' },
    { select: 0 },
    { select: 'claude-plain' },
  ],
});
scenario('model: Ultrafast cycle and plain Fast toggle', {
  caches: { provider: FRESH([...ULTRA, ...PLAIN_FAST]) },
  state: { model: 'other' },
  store: { setRoute: true },
  ops: [
    { open: 'model' },
    { select: 0 },
    { tab: 'ultra-1' },
    { tab: 'ultra-1' },
    { select: 'ultra-1' },
    { open: 'model' },
    { select: 0 },
    { tab: 'ultra-1' },
    { tab: 'ultra-1' },
    { tab: 'ultra-1' },
    { select: 'ultra-1' },
    { open: 'model' },
    { select: 0 },
    { tab: 'plain-fast' },
    { tab: 'plain-fast' },
    { tab: 'plain-fast' },
    { select: 'plain-fast' },
  ],
});
scenario('model: OpenRouter routing cycle', {
  caches: { provider: FRESH(ROUTING_MODELS) },
  state: { model: 'other' },
  store: { setRoute: true },
  ops: [
    { open: 'model' },
    { select: 0 },
    { key: 'r', row: 'or-1' },
    { key: 'r', row: 'or-1' },
    { key: 'r', row: 'or-1' },
    { key: 'r', row: 'or-1' },
    { key: 'R', row: 'or-1' },
    { key: 'r', row: 'plain-1' },
    { select: 'or-1' },
  ],
});
scenario('model: several providers, saved values, parameter variants, current route and state seeds', {
  caches: { provider: FRESH(MULTI) },
  state: { provider: 'anthropic', model: 'claude-x-1', effort: 'medium', fast: true, contextPercent: 30, modelParameters: { thinking: 'on' } },
  store: { setRoute: true, getProviderSetup: { api: [{ id: CUSTOM_ID, name: '내 AI' }], oauth: [], local: [] } },
  ops: [
    { open: 'model' },
    { select: 1 },
    { tab: 'gpt-5.2' },
    { key: 't', row: 'gpt-5.2' },
    { key: 'c', row: 'gpt-5.2' },
    { right: 'gpt-5.2' },
    { right: 'gpt-5.2' },
    { right: 'gpt-5.2' },
    { tab: 'gpt-5.2' },
    { key: 'r', row: 'gpt-5.2' },
    { select: 'gpt-5.2' },
    { open: 'model', options: { currentRoute: { provider: 'openai-oauth', model: 'gpt-5.2', effort: 'xhigh', fast: false, contextPercent: 70, modelParameters: { daybreak: 'off' } } } },
    { select: 'openai-oauth' },
    { cancel: true },
    { cancel: true },
    { open: 'model', options: { title: 'Custom Title', providerDescription: 'Pick one.', modelDescription: 'Pick a model.' } },
    { select: CUSTOM_ID },
    { select: 'my-model' },
  ],
});
scenario('model: quick load then full load adopted for the next open', {
  caches: {},
  clock: T0,
  store: {
    listProviderModels: { $args: { '[{"quick":true}]': MODELS.slice(0, 1), '[{"force":false}]': MODELS, '[{"force":true}]': MODELS, '*': MODELS } },
    setRoute: true,
  },
  ops: [{ open: 'model' }, { select: 0 }, { cancel: true }, { cancel: true }, { open: 'model' }, { select: 0 }, { cancel: true }],
});
scenario('model: quick load empty falls back to the full load; refresh forces it', {
  caches: {},
  store: { listProviderModels: { $args: { '[{"quick":true}]': [], '[{"force":false}]': MODELS, '[{"force":true}]': MODELS.slice(1), '*': [] } } },
  ops: [{ open: 'model' }, { cancel: true }, { open: 'model', options: { refreshModels: true } }, { select: 0 }],
});
scenario('model: stale cache renders at once and refreshes in the background, one refresh at a time', {
  caches: { provider: { models: MODELS.slice(0, 1), at: T0 - 10 * 60 * 1000 } },
  clock: T0,
  store: { listProviderModels: { $args: { '[{"force":true}]': MODELS, '*': MODELS } } },
  ops: [{ open: 'model' }, { cancel: true }, { open: 'model' }, { select: 0 }],
});
scenario('model: failed and empty catalogs', {
  caches: {},
  store: { listProviderModels: { $error: 'boom' } },
  ops: [{ open: 'model' }, { open: 'model', options: { emptyNotice: 'nothing here' } }],
});
scenario('model: empty catalog opens provider setup and its continue reopens', {
  caches: {},
  store: { listProviderModels: [] },
  ops: [{ open: 'model' }, { continue: true }, { open: 'model', options: { emptyNotice: 'nothing here' } }],
});
scenario('model: provider whose list failed says why; custom names; row providerName', {
  caches: { provider: FRESH([CLAUDE_X, model(CUSTOM_ID, 'my-model', { providerName: 'Gateway' })]) },
  store: { getProviderSetup: setupRows },
  ops: [{ open: 'model' }, { select: 0 }, { select: 1 }, { select: 2 }, { select: 3 }],
});
scenario('model: nested picker with a caller-owned save, return and failure', {
  caches: { provider: FRESH(MODELS) },
  store: { setRoute: true },
  ops: [
    { open: 'model', options: { returnTo: true, returnOnNestedCancel: true, returnLabel: 'Agents', onSelectRoute: 'ok', onAfterSelect: true, currentRoute: { provider: 'anthropic', model: 'claude-x-1', effort: 'medium', fast: true } } },
    { select: 0 },
    { select: 'claude-x-1' },
    { open: 'model', options: { returnTo: true, onSelectRoute: 'fail', onImmediateSelect: true, handoffPanel: true } },
    { select: 0 },
    { cancel: true },
    { select: 0 },
    { select: 'claude-plain' },
    { open: 'model', options: { returnTo: true, handoffPanel: true } },
    { cancel: true },
    { open: 'model', options: { handoffPanel: true } },
    { select: 0 },
    { select: 'claude-plain' },
  ],
});
scenario('model: setRoute answers false and rejects', {
  caches: { provider: FRESH(MODELS) },
  store: { setRoute: false },
  ops: [{ open: 'model' }, { select: 0 }, { select: 'claude-plain' }],
});
scenario('model: setRoute rejects', {
  caches: { provider: FRESH(MODELS) },
  store: { setRoute: { $error: 'disk full' } },
  ops: [{ open: 'model' }, { select: 0 }, { select: 'claude-plain' }],
});
scenario('model: a newer panel takes the surface while the load is open', {
  caches: {},
  store: { listProviderModels: MODELS },
  ops: [{ open: 'model', supersedeDuring: true }, { open: 'model' }, { supersede: true }, { select: 0 }],
});
scenario('web search: route, save, failures', {
  caches: { webSearch: FRESH([model('openai-oauth', 'gpt-5.2', { effortOptions: EFFORTS }), model('gemini', 'gemini-2.5-pro')]) },
  store: { getWebSearchRoute: { provider: 'gemini', model: 'gemini-2.5-pro' }, setWebSearchRoute: { provider: 'openai-oauth', model: 'gpt-5.2', effort: 'low' }, getProviderSetup: setupRows },
  ops: [{ open: 'websearch' }, { select: 0 }, { select: 'gpt-5.2' }, { open: 'websearch', options: { returnTo: true, returnLabel: 'Menu', returnOnNestedCancel: true } }, { select: 0 }, { cancel: true }, { select: 1 }, { select: 'gemini-2.5-pro' }],
});
scenario('web search: override route, save refused, nothing to list', {
  caches: { webSearch: FRESH([model('gemini', 'gemini-2.5-pro')]) },
  store: { getWebSearchRoute: null, setWebSearchRoute: null },
  ops: [{ open: 'websearch', options: { routeOverride: { provider: 'gemini', model: 'gemini-2.5-pro' } } }, { select: 0 }, { select: 'gemini-2.5-pro' }],
});
scenario('web search: empty catalog and failed save', {
  caches: {},
  store: { listWebSearchModels: [], setWebSearchRoute: { $error: 'nope' } },
  ops: [{ open: 'websearch' }],
});
scenario('agents: roster, per-agent panel, pinned model, turn off', {
  caches: { provider: FRESH(MODELS) },
  store: { listAgents: AGENTS, setAgentRoute: { provider: 'anthropic', model: 'claude-plain', effort: 'low', fast: true }, setRoute: true },
  ops: [
    { open: 'agents' },
    { select: 'worker' },
    { cancel: true },
    { select: 'reviewer' },
    { select: 'model' },
    { select: 0 },
    { cancel: true },
    { cancel: true },
    { select: 'worker' },
    { select: 'model' },
    { select: 0 },
    { select: 'claude-plain' },
    { select: 'reviewer' },
    { select: 'off' },
    { cancel: true },
  ],
});
scenario('agents: refresh option, overrides, failures', {
  caches: { provider: FRESH(MODELS) },
  store: { listAgents: AGENTS, setAgentRoute: null },
  ops: [
    { open: 'agents', options: { refreshModels: true, routeOverrides: { reviewer: { provider: 'anthropic', model: 'claude-x-1', effort: 'low' } }, initialAgentId: ' scout ' } },
    { select: 'scout' },
    { select: 'off' },
    { select: 'scout' },
    { select: 'model' },
    { select: 0 },
    { select: 'claude-x-1' },
  ],
});
scenario('agents: list fails, empty roster, turn off fails', {
  caches: {},
  store: { listAgents: { $error: 'daemon down' }, setAgentRoute: { $error: 'locked' } },
  ops: [{ open: 'agents' }],
});
scenario('agents: turn off rejected', {
  caches: {},
  store: { listAgents: AGENTS, setAgentRoute: { $error: 'locked' } },
  ops: [{ open: 'agents' }, { select: 'worker' }, { select: 'off' }],
});
scenario('agents: an Esc during the write drops the hop back to the roster', {
  caches: {},
  store: { listAgents: AGENTS, setAgentRoute: { provider: 'x' } },
  ops: [{ open: 'agents' }, { select: 'worker' }, { select: 'off', supersedeDuring: true }],
});
scenario('workflow: help, switch, hop back, failures', {
  store: { listWorkflows: WORKFLOWS, setWorkflow: { id: 'team' } },
  ops: [
    { open: 'workflow' },
    { cancel: true },
    { open: 'workflow', options: { returnTo: true } },
    { select: 'team' },
    { open: 'workflow', options: { returnTo: true, handoffPanel: true } },
    { select: 'plain' },
    { open: 'workflow', options: { returnTo: true, handoffPanel: true } },
    { cancel: true },
  ],
});
scenario('workflow: refused and rejected switches, empty and failing lists', {
  store: { listWorkflows: WORKFLOWS, setWorkflow: null },
  ops: [{ open: 'workflow', options: { returnTo: true, handoffPanel: true } }, { select: 'team' }],
});
scenario('workflow: rejected switch', {
  store: { listWorkflows: WORKFLOWS, setWorkflow: { $error: 'bad' } },
  ops: [{ open: 'workflow', options: { returnTo: true, handoffPanel: true } }, { select: 'team' }, { open: 'workflow', options: { returnTo: true } }, { select: 'team' }],
});
scenario('workflow: no workflows', { store: { listWorkflows: [] }, ops: [{ open: 'workflow' }] });
scenario('workflow: list fails', { store: { listWorkflows: { $error: 'down' } }, ops: [{ open: 'workflow' }] });
scenario('workflow: an Esc before the switch acks cancels the hop', {
  store: { listWorkflows: WORKFLOWS, setWorkflow: { id: 'team' } },
  ops: [{ open: 'workflow', options: { returnTo: true } }, { select: 'team', supersedeDuring: true }],
});
scenario('output style: settings form', {
  store: { listOutputStyles: STYLES, setOutputStyle: { current: { id: 'verbose', label: 'Verbose' }, appliedToCurrentSession: false } },
  ops: [{ open: 'outputstyle', options: { returnTo: true, handoffPanel: true } }, { highlight: 'verbose' }, { select: 'verbose' }, { open: 'outputstyle' }, { select: 'default' }, { open: 'outputstyle' }, { cancel: true }],
});
scenario('output style: onboarding form', {
  store: { listOutputStyles: STYLES, setOutputStyle: { configured: 'terse' } },
  ops: [
    { open: 'outputstyle', options: { onboarding: true } },
    { highlight: 'verbose' },
    { confirm: 'next' },
    { open: 'outputstyle', options: { onboarding: true } },
    { select: 'default' },
    { open: 'outputstyle', options: { onboarding: true } },
    { confirm: 'back' },
    { open: 'outputstyle', options: { onboarding: true } },
    { cancel: true },
  ],
});
scenario('output style: refused and rejected', {
  store: { listOutputStyles: STYLES, setOutputStyle: null },
  ops: [{ open: 'outputstyle', options: { returnTo: true } }, { select: 'default' }, { open: 'outputstyle', options: { handoffPanel: true, returnTo: true } }, { select: 'default' }],
});
scenario('output style: rejected', {
  store: { listOutputStyles: STYLES, setOutputStyle: { $error: 'bad' } },
  ops: [{ open: 'outputstyle', options: { handoffPanel: true, returnTo: true } }, { select: 'default' }, { open: 'outputstyle' }, { select: 'default' }],
});
scenario('output style: none and failing', { store: { listOutputStyles: { styles: [] } }, ops: [{ open: 'outputstyle' }] });
scenario('output style: list fails', { store: { listOutputStyles: { $error: 'down' } }, ops: [{ open: 'outputstyle' }] });
scenario('theme: preview while moving, Enter persists, Esc restores', {
  store: { listThemes: THEMES, getTheme: 'default', setTheme: { id: 'dark', label: 'Dark' } },
  ops: [
    { open: 'theme', options: { returnTo: true } },
    { highlight: 'dark' },
    { highlight: 'light-ansi' },
    { select: 'dark' },
    { open: 'theme' },
    { highlight: 'dark' },
    { cancel: true },
    { open: 'theme', options: { handoffPanel: true, returnTo: true } },
    { cancel: true },
  ],
});
scenario('theme: onboarding', {
  store: { listThemes: THEMES, getTheme: 'dark', setTheme: { id: 'light-ansi' } },
  ops: [
    { open: 'theme', options: { onboarding: true } },
    { highlight: 'light-ansi' },
    { confirm: 'next' },
    { open: 'theme', options: { onboarding: true } },
    { highlight: 'default' },
    { confirm: 'back' },
    { open: 'theme', options: { onboarding: true } },
    { select: 'default' },
    { open: 'theme', options: { onboarding: true } },
    { cancel: true },
  ],
});
scenario('theme: current from the list, setTheme rejects, none and failing', {
  store: { listThemes: THEMES, getTheme: null, setTheme: { $error: 'locked' } },
  ops: [{ open: 'theme' }, { select: 'dark' }],
});
scenario('theme: no themes', { store: { listThemes: [] }, ops: [{ open: 'theme' }] });
scenario('theme: list fails', { store: { listThemes: { $error: 'down' } }, ops: [{ open: 'theme' }] });
scenario('theme: setTheme answers nothing', { store: { listThemes: THEMES, getTheme: 'default', setTheme: null }, ops: [{ open: 'theme' }, { select: 'dark' }] });
scenario('effort: pick, busy, cancel, none', {
  state: { effort: 'low', effortOptions: EFFORT_OPTIONS },
  store: { setEffort: 'medium' },
  ops: [{ open: 'effort' }, { select: 'medium' }, { open: 'effort' }, { cancel: true }],
});
scenario('effort: busy turn, refused, rejected, no options', {
  state: { effort: null, effortOptions: EFFORT_OPTIONS, busy: true },
  store: { setEffort: null },
  ops: [{ open: 'effort' }, { select: 'high' }],
});
scenario('effort: rejected', {
  state: { effortOptions: EFFORT_OPTIONS },
  store: { setEffort: { $error: 'bad' } },
  ops: [{ open: 'effort' }, { select: 'high' }],
});
scenario('effort: no levels', { state: { effortOptions: [] }, store: {}, ops: [{ open: 'effort' }] });

// ---- the harness

const resolveScript = (script, method, callArgs) => {
  const entry = script[method];
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && '$args' in entry) {
    const key = JSON.stringify(callArgs);
    return key in entry.$args ? entry.$args[key] : entry.$args['*'];
  }
  return entry;
};

async function runScenario(spec) {
  panelEpoch.supersedePanelEpoch();
  let live = null;
  let clock = spec.clock ?? T0;
  Date.now = () => clock;
  let calls = [];
  let notices = [];
  let events = [];
  let supersedeNext = false;
  const script = { listProviderModels: [], listWebSearchModels: [], ...(spec.store || {}) };
  const answer = (method, callArgs) => {
    calls.push([method, callArgs]);
    if (supersedeNext) {
      supersedeNext = false;
      panelEpoch.supersedePanelEpoch();
    }
    const value = resolveScript(script, method, callArgs);
    if (value && typeof value === 'object' && '$error' in value) throw new Error(value.$error);
    return value;
  };
  const asyncMethod = (method) => (...callArgs) => {
    try {
      return Promise.resolve(answer(method, callArgs));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const syncMethod = (method) => (...callArgs) => answer(method, callArgs);
  const store = {
    pushNotice: (text, tone) => notices.push([text, tone]),
  };
  for (const method of Object.keys(script)) {
    store[method] = ['listThemes', 'getTheme', 'setTheme'].includes(method) ? syncMethod(method) : asyncMethod(method);
  }
  // Methods the Node code calls without `?.`: a scenario that does not script them is not used with them.
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (panelEpoch.shouldSupersedePanelEpoch(previous, live)) panelEpoch.supersedePanelEpoch();
    },
    setContextPanel: (panel) => events.push(['context', panel == null ? null : 'panel']),
    setUsagePanel: () => {},
  });
  const providerModelsCacheRef = { current: { models: spec.caches?.provider?.models ?? null, at: spec.caches?.provider?.at ?? 0 } };
  const webSearchModelsCacheRef = { current: { models: spec.caches?.webSearch?.models ?? null, at: spec.caches?.webSearch?.at ?? 0 } };
  const stateOf = () => ({ provider: 'anthropic', model: 'claude-x-1', effort: null, fast: false, busy: false, ...(spec.state || {}) });
  const setProviderPrompt = () => events.push(['clearProviderPrompt']);
  const setSettingsPrompt = () => events.push(['clearSettingsPrompt']);
  const closeUsagePanel = () => events.push(['closeUsage']);
  const cache = { providerModelsCacheRef, webSearchModelsCacheRef };
  const openProviderSetupPicker = (request) => {
    events.push(['providerSetup', request.title, request.continueLabel, request.continueDescription]);
    pendingContinue = request.onContinue;
  };
  let pendingContinue = null;
  const { openModelPicker } = createModelPicker({
    store,
    getState: stateOf,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    ...cache,
    modelPickerRequestRef: { current: 0 },
    modelSwitchNotice: appFormat.modelSwitchNotice,
    openProviderSetupPicker,
  });
  const routePickers = createRoutePickers({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    clean: appFormat.clean,
    routeLabel: opts.routeLabel,
    agentModelParts: opts.agentModelParts,
    agentModelProfile: opts.agentModelProfile,
    workflowSwitchNotice: appFormat.workflowSwitchNotice,
    openModelPicker,
  });
  const { openThemePicker, openEffortPicker } = createThemeEffortPickers({
    state: stateOf(),
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    clean: appFormat.clean,
  });

  const callbackOptions = (raw = {}) => {
    const out = { ...raw };
    if (raw.returnTo) out.returnTo = () => events.push(['returnTo']);
    if (raw.onAfterSelect) out.onAfterSelect = () => events.push(['afterSelect']);
    if (raw.onImmediateSelect) out.onImmediateSelect = (route) => events.push(['immediate', route.model ?? null]);
    if (raw.handoffPanel) out.handoffPanel = { title: 'Handoff', items: [] };
    if (raw.onSelectRoute) {
      out.onSelectRoute = async (route, picked, effort) => {
        // The write settles after the keypress has painted its destination and handed the surface back.
        await null;
        events.push(['onSelectRoute', route.model, picked.id, effort ?? null]);
        if (raw.onSelectRoute === 'fail') throw new Error('disk full');
      };
    }
    if (raw.onboarding) {
      out.onboarding = {
        onAdvance: () => events.push(['onboarding', 'advance']),
        onBack: () => events.push(['onboarding', 'back']),
        onCancel: () => events.push(['onboarding', 'cancel']),
      };
    }
    return out;
  };

  const summary = (panel) => {
    if (!panel) return null;
    const items = Array.isArray(panel.items) ? panel.items : [];
    return {
      title: panel.title ?? '',
      description: panel.description ?? '',
      help: panel.help ?? null,
      pickerKey: panel.pickerKey ?? null,
      initialIndex: panel.initialIndex ?? null,
      indexMode: panel.indexMode ?? null,
      labelWidth: panel.labelWidth ?? null,
      metaWidth: panel.metaWidth ?? null,
      loading: panel.loading === true,
      confirm: panel.confirmBar ? panel.confirmBar.buttons.map((b) => [b.value, b.label]) : null,
      adjustable: Boolean(panel.onLeft || panel.onRight || panel.onTab),
      highlights: typeof panel.onHighlight === 'function',
      items: items.map((item) => ({
        value: item.value,
        label: item.label ?? '',
        marker: item.marker ?? '',
        meta: item.meta ?? '',
        description: item.description ?? '',
        metaParts: item.metaParts ? item.metaParts.map((p) => [p.text, p.width]) : null,
        action: item._action ?? null,
        provider: item._provider ?? null,
        modelId: item._modelId ?? null,
        failure: item._failure ?? null,
      })),
      footers: typeof panel.footer === 'function' ? items.map((item) => panel.footer(item).map((l) => [l.glyph, l.text])) : null,
    };
  };

  const rowOf = (panel, ref) => {
    const items = panel?.items || [];
    return typeof ref === 'number'
      ? items[ref]
      : items.find((item) => item.value === ref || item._modelId === ref || item._provider === ref);
  };

  const guard = (promise) => promise.catch((e) => events.push(['unhandled', String(e?.message || e)]));
  const steps = [];
  for (const op of spec.ops) {
    calls = [];
    notices = [];
    events = [];
    const panel = live;
    if (op.supersedeDuring) supersedeNext = true;
    const options = callbackOptions(op.options);
    if (op.open) {
      if (op.open === 'model') {
        guard(openModelPicker(options));
      } else if (op.open === 'websearch') guard(routePickers.openWebSearchPicker(options));
      else if (op.open === 'agents') guard(routePickers.openAgentsPicker(options));
      else if (op.open === 'workflow') guard(routePickers.openWorkflowPicker(options));
      else if (op.open === 'outputstyle') guard(routePickers.openOutputStylePicker(options));
      else if (op.open === 'theme') openThemePicker(options);
      else if (op.open === 'effort') openEffortPicker();
    } else if (op.continue) {
      const run = pendingContinue;
      pendingContinue = null;
      run?.();
    } else if ('select' in op) {
      const item = rowOf(panel, op.select);
      panel?.onSelect?.(item?.value, item);
    } else if (op.left || op.right || op.tab) {
      const ref = op.left || op.right || op.tab;
      const item = rowOf(panel, ref);
      (op.left ? panel?.onLeft : op.right ? panel?.onRight : panel?.onTab)?.(item);
    } else if (op.key) {
      panel?.onKey?.(op.key, {}, rowOf(panel, op.row));
    } else if (op.highlight !== undefined) {
      const item = rowOf(panel, op.highlight);
      panel?.onHighlight?.(item?.value, item, (panel.items || []).indexOf(item));
    } else if (op.cancel) {
      panel?.onCancel?.();
    } else if (op.confirm) {
      const button = panel?.confirmBar?.buttons.find((b) => b.value === op.confirm);
      panel?.confirmBar?.onConfirm?.(button);
    } else if (op.supersede) {
      panelEpoch.supersedePanelEpoch();
    } else if (op.advance) {
      clock += op.advance;
    }
    await wait();
    await wait();
    steps.push({
      op,
      calls: calls.map((c) => JSON.stringify(c)).sort().map((c) => JSON.parse(c)),
      notices,
      events,
      panel: summary(live),
      caches: [
        providerModelsCacheRef.current.models ? providerModelsCacheRef.current.models.length : null,
        providerModelsCacheRef.current.at,
        webSearchModelsCacheRef.current.models ? webSearchModelsCacheRef.current.models.length : null,
        webSearchModelsCacheRef.current.at,
      ],
    });
  }
  return { steps };
}

const out = { options: optionsOut, scenarios: [] };
for (const { name, spec } of scenarios) {
  const result = await runScenario(spec);
  out.scenarios.push({ name, spec, ...result });
}
out.sources = sources;

const text = `{\n${Object.entries(out)
  .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(',\n')}\n}\n`;
const target = option('--write') ?? option('--check');
if (option('--write')) {
  writeFileSync(target, text);
  console.log(`wrote ${target} (${text.length} bytes, ${out.scenarios.length} scenarios)`);
} else {
  const recorded = readFileSync(target, 'utf8');
  if (recorded.replace(/\r\n/g, '\n') !== text) {
    console.error(`${target} differs from what the Node code does now: re-record it with --write`);
    process.exit(1);
  }
  console.log(`${target} matches (${out.scenarios.length} scenarios)`);
}
