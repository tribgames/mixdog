#!/usr/bin/env node
// Golden twin of mixdog_ai::providers::google::traits: the family test (gemini-family.mjs) and
// the thinking contract (gemini-thinking.mjs: the mandatory budget-only spec of the 2.5 models
// and the effort translation).
//
//   node benchmarks/rust-core/recorders/record-google-traits.mjs [--tree <dir>]
//
// Output: native/core/fixtures/google-traits/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'google-traits');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-google-traits.mjs';
const family = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/gemini-family.mjs');
const thinking = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/gemini-thinking.mjs');
const ids = [
  'gemini-2.5-pro',
  'models/gemini-3.1-pro',
  'GEMINI-4-argon',
  'Models/Gemini-Pro-Agent',
  'gemini-pro-agent',
  'publishers/google/models/gemini-x',
  'claude-sonnet-4-5',
  'gpt-oss-120b-medium',
  'xgemini-1',
  'gemini',
  'gemini2',
  '',
];
const families = ids.map((model) => ({ model, isGemini: family.isGeminiFamilyModel(model) }));

const models = [
  'gemini-2.5-pro',
  'models/gemini-2.5-pro',
  'Gemini-2.5-Pro-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5',
  'gemini-2.5x',
  'gemini-3-pro',
  'claude-sonnet-4-5',
];
const options = [
  { effort: 'low' },
  { effort: 'High' },
  { effort: 'minimal' },
  { effort: 'medium' },
  { effort: 'xhigh' },
  { thinkingLevel: 'low' },
  { thinkingBudget: 0 },
  { thinkingBudget: 100 },
  { thinkingBudget: 2000 },
  { thinkingBudget: -1 },
  { thinkingBudget: 99999 },
  {},
];
const configs = [];
for (const model of models) {
  for (const opts of options) {
    const out = { model, options: opts };
    try {
      out.config = thinking.geminiThinkingConfig(model, opts, { includeThoughts: true }) ?? null;
    } catch (error) {
      out.error = error.message;
    }
    configs.push(out);
  }
}
writeJson(join(stage, 'golden.json'), { families, configs });
writeSetManifest(stage, { set: 'google-traits', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);

