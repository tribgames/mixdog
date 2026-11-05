// Records the Node golden for mixdog_ai::effort: normalizeEffortInput,
// effortOptionsFor, coerceEffortFor, effortItemsFor (runtime-core/effort.mjs),
// nearestAcceptedEffort and clampEffortOpts (effort-rejection.mjs). Run from
// the repository root:
//   node native/core/crates/mixdog-ai/fixtures/effort/record.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || process.cwd());

const rejections = {
  version: 1,
  models: {
    'openai:rej1': { rejected: ['high'] },
    'openai:rej2': { rejected: ['none'], allowed: ['low', 'medium', 'xhigh'] },
    'xai:rej1': { rejected: ['low', 'medium', 'high', 'xhigh'] },
  },
};
const data = mkdtempSync(join(tmpdir(), 'effort-golden-'));
mkdirSync(data, { recursive: true });
process.env.MIXDOG_DATA_DIR = data;
writeFileSync(join(data, 'effort-rejections.json'), JSON.stringify(rejections));

const mod = (path) => import(pathToFileURL(join(root, path)).href);
const effort = await mod('src/runtime/agent/orchestrator/runtime-core/effort.mjs');
const rejection = await mod('src/runtime/agent/orchestrator/providers/effort-rejection.mjs');

const providers = ['openai', 'xai', 'mimo-oauth', 'command-code-oauth', 'anthropic', 'gemini', '', 'custom-x'];
const opt = (type, values) => ({ type, ...(values === undefined ? {} : { values }) });
const rows = [
  {},
  { id: 'a1', family: 'opus' },
  { id: 'a2', family: 'Sonnet ' },
  { id: 'a3', family: 'haiku' },
  { id: 'a4', family: 'GPT-5.5' },
  { id: 'a5', family: 'gpt-nano' },
  { id: 'a6', family: 'grok' },
  { id: 'a7', family: 'unknown-family' },
  { id: 'b1', family: 'opus', reasoningOptions: [opt('effort', ['Low', 'HIGH', 'bogus', 'low', ' ', 'ultra'])] },
  { id: 'b2', reasoningOptions: [opt('EFFORT ', [])], reasoningLevels: ['medium'] },
  { id: 'b3', reasoningOptions: [opt('effort')], reasoningLevels: ['minimal', 'High', 'none'] },
  { id: 'b4', reasoningOptions: [opt('thinking', ['low'])], reasoningLevels: ['low', 'xhigh'], family: 'opus' },
  { id: 'b5', reasoningLevels: [], family: 'sonnet' },
  { id: 'b6', reasoningLevels: ['none', 'ultra', 'xhigh', 'max'] },
  { id: 'b7', reasoningOptions: 'nope', reasoningLevels: 'nope', family: 'opus' },
  { id: 'c1', customReasoning: { wireFormat: 'standard' }, reasoningOptions: [opt('effort', ['low', 'ultra', 'high', 'none'])] },
  { id: 'c2', customReasoning: true },
  { id: 'c3', customReasoning: {}, reasoningLevels: [] },
  { id: 'c4', customReasoning: {}, reasoningOptions: [opt('effort', 'low')], reasoningLevels: ['medium', 'HIGH', 'bogus'] },
  { id: 'c5', customReasoning: { replay: true }, reasoningLevels: ['none', 'minimal', 'xhigh'], family: 'opus' },
  { id: 'c6', customReasoning: false, reasoningLevels: ['low'] },
  { id: 'c7', customReasoning: 0, family: 'opus' },
  { id: 'c8', customReasoning: '', family: 'sonnet' },
  { id: 'rej1', family: 'opus' },
  { id: 'REJ1 ', reasoningLevels: ['none', 'low', 'high', 'xhigh'] },
  { id: 'rej2', reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'rej2', customReasoning: {}, reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'] },
];
const efforts = ['', 'auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'HIGH', 'bogus'];
const inputs = [undefined, null, '', ' Auto ', 'HIGH', 'low', 'ultra', 'bogus', 7, true, {}, ['low']];
const attempt = (run) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: error.message };
  }
};

const golden = { rejections, normalize: [], options: [], coerce: [], items: [], nearest: [], clamp: [] };

for (const input of inputs) {
  golden.normalize.push({
    input: input === undefined ? { absent: true } : { value: input },
    input_result: attempt(() => effort.normalizeEffortInput(input)),
    saved: effort.normalizeSavedEffort(input),
  });
}
for (const provider of providers) {
  for (const model of rows) {
    const options = effort.effortOptionsFor(provider, model);
    golden.options.push({ provider, model, options });
    golden.items.push({ provider, model, active: 'high', items: effort.effortItemsFor(provider, model, 'high') });
    for (const wanted of efforts) {
      golden.coerce.push({ provider, model, effort: wanted, result: effort.coerceEffortFor(provider, model, wanted) });
    }
  }
}
golden.coerce.push({ provider: 'openai', model: null, effort: 'high', result: effort.coerceEffortFor('openai', null, 'high') });
golden.coerce.push({ provider: 'openai', model: {}, effort: null, result: effort.coerceEffortFor('openai', {}, null) });

const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const subsets = [[], ['high'], ['low', 'minimal'], ['none', 'minimal', 'low'], ['xhigh', 'max', 'ultra'], order.slice(0, 7), order];
for (const requested of [...order, 'bogus', '']) {
  for (const set of subsets) {
    for (const allowHigher of [false, true]) {
      golden.nearest.push({
        requested,
        rejected: set,
        allowHigher,
        result: rejection.nearestAcceptedEffort(requested, new Set(set), { allowHigher }),
      });
    }
  }
}

const optVariants = [
  { effort: 'high' },
  { effort: 'ultra', xaiReasoningEffort: 'ultra', openRouterReasoningEffort: 'ultra', other: 1 },
  {},
  { effort: null },
  { effort: ' LOW ' },
  { effort: 'none', deepseekReasoningEffort: 'none' },
  { effort: 'bogus' },
];
const targets = [['openai', 'rej1'], ['openai', 'rej2'], ['xai', 'rej1'], ['openai', 'plain'], ['', '']];
const levelSets = [null, ['low', 'medium', 'high'], ['low'], []];
for (const [provider, model] of targets) {
  for (const opts of optVariants) {
    for (const config of [undefined, 'high', 'none', 'ultra']) {
      for (const levels of levelSets) {
        golden.clamp.push({
          provider,
          model,
          opts,
          config,
          levels,
          result: rejection.clampEffortOpts(provider, model, opts, config, levels),
        });
      }
    }
  }
}

writeFileSync(join(here, 'golden.json'), `${JSON.stringify(golden)}\n`);
console.log(
  `normalize ${golden.normalize.length}, options ${golden.options.length}, coerce ${golden.coerce.length}, items ${golden.items.length}, nearest ${golden.nearest.length}, clamp ${golden.clamp.length}`
);
