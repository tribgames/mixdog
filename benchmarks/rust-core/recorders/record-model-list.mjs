#!/usr/bin/env node
// Golden twin of the pure parts behind `model/list`: model-recency (sort, selectable, cache
// row), model-select `providerRows`, and row hydration. Deterministic cases; each holds the
// inputs and what Node answered. Rust `mixdog_ai::service::admin_models` must equal all of it.
//
//   node benchmarks/rust-core/recorders/record-model-list.mjs --tree <dir> [--out <dir>]
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const sr = 'src/session-runtime/';
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const recency = await importFrom(tree, `${sr}model-recency.mjs`);
const select = await importFrom(tree, `${sr}services/agent-tool/model-select.mjs`);
const hydration = await importFrom(tree, `${sr}provider-models/row-hydration.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const effort = await importFrom(tree, `${rc}effort.mjs`);
const effortCfg = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/effort-configuration.mjs');
const registry = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');
const daybreak = await importFrom(tree, 'src/runtime/shared/llm/openai-daybreak.mjs');
const openrouter = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openrouter-provider-routing.mjs');

let seed = 0x3a91c0de;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const PROVIDERS = ['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth', 'openrouter', 'gemini', 'xai', 'custom-a', 'custom-b', 'Zed', 'zed', 'Éclair', 'eclair', 'p10', 'p9'];
const IDS = [
  'claude-opus-4-1-20250805', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-haiku-3.5', 'claude-opus-5', 'claude-3-7-sonnet',
  'gpt-5', 'gpt-5.1', 'gpt-5.1.2', 'gpt-4o', 'gpt-4.1-mini', 'o3', 'o4-mini', 'o1-preview', 'gpt5.2', 'grok-4', 'grok4.1', 'qwen3', 'llama3.1',
  'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro-002', 'text-embedding-3-small', 'gpt-image-1', 'dall-e-3', 'whisper-1', 'tts-1', 'sora-2',
  'model-v2', 'model_v10', 'm-3.4.567', 'mistral7', 'phi4', 'glm-4.5', 'Ünï-1', 'plain', '20250101-x', 'abc-20240315-def', 'x-20251345-y', 'x-20250230-y', ' padded-2 ', 'moderation-latest', 'gpt-realtime',
  'imagen-4', 'dall-e', 'dall e 3', 'dalle3', 'rerank-v3', 'a--image', 'my_images_x', 'speech-to-text', 'imagine-1',
];
const DATES = [undefined, null, '', '2025-03-01', '2024-12-31', '2025-03', '2025', '2025-03-01T10:00:00Z', '2025-03-01T10:00:00+09:00', '2025-03-01T10:00:00.123-05:30', 'garbage', '2025-13-01', '2025-02-30', '0000-01-01', 1700000000000, '2023-01-15'];
const CREATED = [undefined, null, 0, -4, 1700000000, 1700000000000, '1700000000', 'x', 1.5, 99999999999];

function randomModel(provider) {
  const m = { id: pick(IDS) };
  if (chance(0.5)) m.display = pick([pick(IDS), 'Nice Model', 'éclair model', 'Éclair model', 'model 10', 'model 9', 'Model 9', '', null]);
  if (chance(0.2)) m.name = pick(['n', 'Name X', '']);
  if (chance(0.5)) m.releaseDate = pick(DATES);
  if (chance(0.4)) m.created = pick(CREATED);
  if (chance(0.3)) m.latest = pick([true, false, 'yes']);
  if (chance(0.3)) m.mode = pick(['chat', 'completion', 'responses', 'messages', 'Chat', 'embedding', 'image_generation', '']);
  if (chance(0.5)) m.contextWindow = pick([0, 8000, 128000, 200000, 400000, 1000000, '200000', null]);
  if (chance(0.4)) m.maxContextWindow = pick([0, 200000, 1000000, 2000000, null, 'x']);
  if (chance(0.3)) m.outputTokens = pick([0, 4096, 64000]);
  for (const flag of ['supportsVision', 'supportsFunctionCalling', 'supportsPromptCaching', 'supportsReasoning', 'defaultFast', 'supportsMaxMode', 'fastCapable', 'webSearch']) {
    if (chance(0.25)) m[flag] = pick([true, false, 'true', 1]);
  }
  if (chance(0.3)) m.family = pick(['gpt', 'claude', '']);
  if (chance(0.2)) m.tier = pick(['pro', null]);
  if (chance(0.2)) m.description = 'about it';
  if (chance(0.3)) m.reasoningLevels = pick([['low', 'high'], [], 'x']);
  if (chance(0.3)) m.reasoningOptions = pick([[{ value: 'low' }], [], null]);
  if (chance(0.2)) m.reasoningContentField = pick(['reasoning', '']);
  if (chance(0.2)) m.serviceTiers = pick([['priority'], 'x']);
  if (chance(0.2)) m.additionalSpeedTiers = pick([['fast'], null]);
  if (chance(0.2)) m.defaultServiceTier = pick(['priority', '']);
  if (chance(0.25)) m.accessPrograms = pick([['standard'], ['daybreak_blue'], ['standard', 'daybreak_blue'], [], 'x']);
  if (chance(0.2)) m.hidden = pick([true, false, 'yes']);
  if (chance(0.2)) m.fastEfforts = pick([['low'], 'x']);
  if (chance(0.3)) m.modelParameterOptions = pick([[{ id: 'serviceTier', label: 'old' }], [{ id: 'other' }, null], [], 'x']);
  if (chance(0.2)) m.parameterVariants = pick([[{ id: 'v' }], 'x']);
  if (chance(0.2)) m.defaultModelParameters = pick([{ a: 1 }, null, [1], 'x']);
  if (chance(0.2)) m.defaultEffort = pick(['high', '']);
  if (chance(0.3)) m.providerName = pick(['Old Name', '']);
  if (chance(0.2)) m.manual = pick([true, false, 'x']);
  if (chance(0.2)) m.customReasoning = pick([{ levels: ['low'] }, null, [], 'x']);
  return m;
}

const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const webSearchCapableFor = (name, m) => name === 'openai' || m.webSearch === true;

const sortCases = [];
for (let i = 0; i < 300; i += 1) {
  const rows = [];
  for (let j = 0, n = 2 + Math.floor(rnd() * 9); j < n; j += 1) {
    const provider = pick(PROVIDERS);
    rows.push(recency.providerModelCacheRow(provider, randomModel(provider), webSearchCapableFor));
  }
  const primary = chance(0.7) ? pick(PROVIDERS) : '';
  const input = plain(rows);
  const sorted = recency.sortProviderModels(rows.slice(), primary);
  sortCases.push({ rows: input, primary, order: sorted.map((row) => input.findIndex((candidate) => candidate === rows.find((r) => r === row) && false)) , sorted: plain(sorted) });
}
// Order as indices into the input (rows are distinct objects).
for (const c of sortCases) {
  const keyOf = (row) => JSON.stringify(row);
  const seen = new Map();
  c.order = c.sorted.map((row) => {
    const key = keyOf(row);
    const start = seen.get(key) ?? 0;
    let at = c.rows.findIndex((r, idx) => idx >= start && keyOf(r) === key);
    seen.set(key, at + 1);
    return at;
  });
  delete c.sorted;
}

const selectableCases = [];
for (let i = 0; i < 400; i += 1) {
  const m = {};
  if (chance(0.9)) m.id = pick([...IDS, '', '  ', 'IMAGE-GEN', 'text Embedding', 'a_audio_b', 'video', 'x.image', 'DALL-E 3', 'dall--e']);
  if (chance(0.5)) m.display = pick(['Nice', 'Image Maker', 'speech\tmodel', 'dall_e', 'Dall E', 'Sora', 'embed', '', null, 'tts\u00a0x']);
  if (chance(0.3)) m.name = pick(['n', 'Rerank Pro']);
  if (chance(0.4)) m.mode = pick(['chat', 'Completion', 'RESPONSES', 'messages', 'embedding', 'image_generation', '', null, ' chat ']);
  selectableCases.push({ model: m, value: recency.isSelectableLlmModel(m) });
}

const rowCases = [];
for (let i = 0; i < 400; i += 1) {
  const provider = pick(PROVIDERS);
  const m = randomModel(provider);
  rowCases.push({ provider, model: m, row: plain(recency.providerModelCacheRow(provider, m, webSearchCapableFor)) });
}

const providerRowCases = [];
for (let i = 0; i < 200; i += 1) {
  const rows = [];
  for (let j = 0, n = Math.floor(rnd() * 8); j < n; j += 1) rows.push({ provider: pick(PROVIDERS), id: pick(IDS) });
  const provider = pick([undefined, '', 'open', 'openai', 'OPENAI', 'open-ai', 'anth', '???', 'custom', 'z', 'Éclair', 'p1']);
  providerRowCases.push({ rows, provider: provider ?? null, value: select.providerRows(rows, provider) });
}

const CONFIGS = [
  {},
  { providers: { 'custom-a': { name: ' Alpha ', protocol: 'chat' }, 'custom-b': { name: '', protocol: 'responses' }, openai: {} } },
  { modelSettings: { 'openai/gpt-5': { alias: ' Five ', effort: 'high', fast: true, autoEffort: false, modelParameters: { a: 1 }, contextPercent: 30, contextTokens: 100000, hidden: true, favorite: true } } },
  { modelSettings: { 'openrouter/gpt-5': { fast: false, alias: 7, contextPercent: 'x', hidden: 'no', favorite: 'yes' } } },
];
const hydrateCases = [];
for (let i = 0; i < 400; i += 1) {
  const provider = pick(['openai', 'openai-oauth', 'openrouter', 'anthropic', 'custom-a', 'custom-b', 'gemini']);
  const model = randomModel(provider);
  if (chance(0.4)) model.id = 'gpt-5';
  const row = plain(recency.providerModelCacheRow(provider, model, webSearchCapableFor));
  if (chance(0.3)) row.accessPrograms = pick([['daybreak_blue'], ['standard']]);
  if (chance(0.2)) delete row.modelParameterOptions;
  const config = pick(CONFIGS);
  const saved = config.modelSettings?.[`${provider}/${row.id}`] ?? {};
  const providerConfig = registry.getProvider(provider)?.config ?? {};
  const modeOpts = { ...providerConfig, modelParameters: saved.modelParameters || {} };
  const oracle = {
    fastCapable: caps.fastCapableFor(provider, row),
    ultrafastCapable: caps.ultrafastCapableFor(provider, row),
    effortItems: plain(effort.effortItemsFor(provider, row, null)),
    modeTruthy: Boolean(effortCfg.effortConfigurationMode(provider, row.id, modeOpts)),
    customAuto: effortCfg.customAutoEffortCapable(provider, config.providers?.[provider]?.protocol, row),
    providerConfig: plain(providerConfig),
  };
  hydrateCases.push({ config, row, oracle, value: plain(hydration.hydrateProviderModelRow(config, row)) });
}

// provider-availability: client mode from the environment, the developer gate per provider.
const proxyMode = await importFrom(tree, 'src/runtime/shared/model-proxy-mode.mjs');
const devOptions = await importFrom(tree, 'src/runtime/shared/developer-options.mjs');
const ENVS = [{}, { MIXDOG_MODEL_PROXY: 'client' }, { MIXDOG_MODEL_PROXY: 'Client' }, { MIXDOG_MODEL_PROXY: ' client' }, { MIXDOG_MODEL_PROXY: '' }, { MIXDOG_MODEL_PROXY: 'server' }, { OTHER: 'client' }];
const NAMES = ['antigravity-oauth', 'cursor-oauth', 'devin-oauth', 'mimo-oauth', 'openai-oauth', 'anthropic-oauth', 'grok-oauth', 'custom-a', '', 'Cursor-oauth', ' devin-oauth'];
// (An absent `stored` reads the machine's own config file, so it is not recorded.)
const STORED = [null, {}, [], 'x', { cursorOAuth: true }, { cursorOAuth: 'true' }, { devinOAuth: true, mimoOAuth: false, antigravityOAuth: true }, { mimoOAuth: true, junk: 1 }, { allowAllActions: true }, { cursorOAuth: 1 }];
const availabilityCases = {
  env: ENVS.map((env) => ({ env, clientMode: proxyMode.modelProxyClientMode(env) })),
  gate: NAMES.map((name) => ({ name, option: devOptions.developerOptionForProvider(name)?.id ?? null })),
  enabled: STORED.flatMap((stored) =>
    ['antigravityOAuth', 'cursorOAuth', 'devinOAuth', 'mimoOAuth', 'allowAllActions', 'nope'].map((id) => ({
      stored: { value: stored },
      id,
      value: devOptions.developerOptionEnabled(id, stored),
    }))
  ),
};

const options = {
  daybreakOption: plain(daybreak.DAYBREAK_PARAMETER_OPTION),
  openrouterOption: plain(openrouter.OPENROUTER_SORT_OPTION),
};

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'model-list-twin.json'), {
  domain: 'model-list-twin',
  recorder: 'benchmarks/rust-core/recorders/record-model-list.mjs',
  options,
  availabilityCases,
  sortCases,
  selectableCases,
  rowCases,
  providerRowCases,
  hydrateCases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-model-list.mjs',
  command: 'node benchmarks/rust-core/recorders/record-model-list.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${sortCases.length} sort, ${selectableCases.length} selectable, ${rowCases.length} row, ${providerRowCases.length} providerRows, ${hydrateCases.length} hydrate cases`);
