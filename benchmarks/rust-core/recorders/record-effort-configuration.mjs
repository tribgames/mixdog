#!/usr/bin/env node
// Golden twin of the two effort-configuration answers a model row's hydration reads
// (providers/effort-configuration.mjs): `effortConfigurationMode` (does the route take a
// mid-conversation effort update, and on which wire) and `customAutoEffortCapable`. Node's real
// functions run over deterministic provider/model/option grids; a case may first mark a model
// as having rejected the update (process state, cumulative in case order). Rust
// `mixdog_ai::service::effort_configuration` must equal it.
//
//   node benchmarks/rust-core/recorders/record-effort-configuration.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const ec = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/effort-configuration.mjs');

let seed = 0x0ef0c0f1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const PROVIDERS = ['openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'custom-a', 'custom-b', 'gemini', 'xai', ''];
const MODELS = [
  'gpt-5', 'gpt-5.4', 'gpt-6', 'gpt-6.1-sol', 'GPT-7-2025-01-01', ' gpt-6-20260101 ', 'gpt-60', 'gpt-6x', 'openai/gpt-6.1-sol', 'gpt6',
  'claude-opus-5', 'claude-opus-4-9', 'claude-opus-4.9', 'claude-sonnet-5-5', 'claude-sonnet-5-4', 'claude-sonnet-5.5', 'claude-haiku-5-5',
  'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1', 'claude-newfam-6', 'claude-newfam-4', 'claude-opus-5-20251201', 'Claude-Opus-5.5',
  'claude-opus-5-2026-01-01', 'claude-opus-10', 'claude-opus-5-100', 'claude-3-7-sonnet', 'o3', '', undefined, null, 7,
];
const BASES = [undefined, '', 'https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://api.anthropic.company', 'http://api.anthropic.com', 'https://proxy.example/v1'];
const PROTOCOLS = [undefined, 'openai-responses', 'openai-chat', 'anthropic', ''];

function randomOptions() {
  const opts = {};
  if (chance(0.15)) opts.effortConfigurationEnabled = pick([false, true, 0, null]);
  if (chance(0.15)) opts.thinkingBudgetTokens = pick([0, -1, 1024, '5', 'x', null, true, '0']);
  if (chance(0.15)) opts.protocol = pick(PROTOCOLS);
  if (chance(0.2)) opts.baseURL = pick(BASES);
  if (chance(0.15)) opts.disableBetaHeaders = pick([true, false, 1]);
  if (chance(0.15)) opts.multiAgent = pick([true, false, 1]);
  if (chance(0.2)) opts.reasoning = pick([{ mode: 'standard' }, { mode: 'max' }, {}, null, { mode: '' }]);
  if (chance(0.3)) {
    const p = {};
    if (chance(0.4)) p.reasoning_mode = pick(['standard', 'deep', '']);
    if (chance(0.3)) p.mode = pick(['standard', 'fast']);
    if (chance(0.2)) p.multi_agent = pick([true, false]);
    opts.modelParameters = p;
  }
  return opts;
}

const rows = [
  undefined, null, {}, { reasoningLevels: ['low', 'high'] }, { reasoningLevels: [] }, { reasoningLevels: 'x' },
  { reasoningOptions: [{ type: 'effort', values: ['low', 'ultra', 'bogus'] }] }, { reasoningOptions: [{ type: ' Effort ', values: [] }] },
  { reasoningOptions: [{ type: 'other', values: ['low'] }], reasoningLevels: ['medium'] }, { reasoningOptions: [], reasoningLevels: ['max', 'none'] },
  { reasoningOptions: [{ type: 'effort' }], reasoningLevels: ['high'] }, { reasoningOptions: 'x' },
];

const cases = [];
const marks = [];
for (let i = 0; i < 700; i += 1) {
  const mark = chance(0.04) ? [pick(PROVIDERS), pick(MODELS)] : null;
  if (mark) {
    ec.markEffortConfigurationUnsupported(mark[0], mark[1]);
    marks.push(mark);
  }
  const provider = pick(PROVIDERS);
  // Mostly the family's own ids, so the version rules and the option gates both get exercised.
  const own = provider.startsWith('openai') || provider.startsWith('custom-') ? MODELS.slice(0, 10) : provider.startsWith('anthropic') ? MODELS.slice(10, 27) : MODELS;
  const model = chance(0.75) ? pick(own) : pick(MODELS);
  const opts = chance(0.4) ? {} : randomOptions();
  cases.push({ kind: 'mode', mark: plain(mark), provider, model: plain(model), opts: plain(opts), value: ec.effortConfigurationMode(provider, model, opts) });
}
// A marked model stops taking updates; the mark folds the id the way the mode does.
for (const [provider, model] of marks.slice(0, 20)) {
  cases.push({ kind: 'mode', mark: null, provider, model: plain(model), opts: {}, value: ec.effortConfigurationMode(provider, model, {}) });
}
for (let i = 0; i < 300; i += 1) {
  const provider = pick(PROVIDERS);
  const protocol = pick(PROTOCOLS);
  const row = pick(rows);
  cases.push({ kind: 'custom', provider, protocol: plain(protocol), row: plain(row), value: ec.customAutoEffortCapable(provider, protocol, row) });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'effort-configuration-twin.json'), {
  domain: 'effort-configuration-twin',
  recorder: 'benchmarks/rust-core/recorders/record-effort-configuration.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-effort-configuration.mjs',
  command: 'node benchmarks/rust-core/recorders/record-effort-configuration.mjs --tree <tree>',
  identityTree: tree,
});
const by = (value) => cases.filter((c) => c.kind === 'mode' && c.value === value).length;
console.log(`recorded ${cases.length} cases (mode: responses ${by('responses')}, anthropic ${by('anthropic')}, null ${by(null)})`);
