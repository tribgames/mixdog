#!/usr/bin/env node
// Golden twin of the ladder a step-effort judgment resolves (session/loop/step-auto-effort.mjs
// `stepResult`, lines 160-191): `effortOptionsFor(provider, autoEffortModel(provider,
// providerClient, model))`. Each case holds the provider's cached model row (what
// `getCachedModelInfo` answers), the Anthropic effort-gate levels Node read, and the options
// Node computed. Rust `run_host::step_judge::ladder_facts` must equal it.
//
//   node benchmarks/rust-core/recorders/record-step-ladder.mjs [--tree <dir>]
//
// Output: native/core/fixtures/step-ladder/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'step-ladder');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-step-ladder.mjs';
const { autoEffortModel } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/effort-configuration.mjs');
const { effortOptionsFor } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/effort.mjs');
const { anthropicEffortLevelsFor } = await importFrom(tree, 'src/runtime/shared/llm/anthropic-effort.mjs');

const CASES = [
  ['openai', 'gpt-5', null],
  ['openai', 'gpt-5', {}],
  ['openai', 'gpt-5', { family: 'gpt-5' }],
  ['openai', 'o3', { reasoningLevels: ['low', 'medium', 'high'] }],
  ['openai', 'gpt-5', { reasoningOptions: [{ type: 'effort', values: ['minimal', 'low', 'high', 'bogus'] }] }],
  ['openai-oauth', 'gpt-5.5', { reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }] }],
  ['gemini', 'gemini-2.5-pro', { reasoningLevels: ['low', 'high'] }],
  ['gemini', 'gemini-2.5-pro', {}],
  ['xai', 'grok-4', { family: 'grok' }],
  ['deepseek', 'deepseek-v4-pro', {}],
  ['custom-acme', 'm1', { customReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
  ['custom-acme', 'm1', { customReasoning: true, reasoningLevels: [] }],
  ['custom-acme', 'm1', { customReasoning: true }],
  ['custom-acme', 'm1', { customReasoning: true, reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high'] }] }],
  ['anthropic', 'claude-opus-4-8', { reasoningLevels: ['low'] }],
  ['anthropic', 'claude-sonnet-4-5', null],
  ['anthropic-oauth', 'claude-3-5-haiku', null],
  ['anthropic', 'claude-opus-5', null],
];
const cases = CASES.map(([provider, model, row]) => {
  const impl = { getCachedModelInfo: () => (row === null ? undefined : { ...row }) };
  const options = effortOptionsFor(provider, autoEffortModel(provider, impl, model));
  const anthropicLevels = provider.startsWith('anthropic') ? anthropicEffortLevelsFor(model) : null;
  return { provider, model, row, anthropicLevels, options };
});

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'step-ladder', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
