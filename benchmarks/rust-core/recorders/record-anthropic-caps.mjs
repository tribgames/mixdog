#!/usr/bin/env node
// Golden twin of the Anthropic effort capabilities (shared/llm/anthropic-effort.mjs): what Node
// answers for a model id with no catalog (the release-generation floor) and with live catalog
// rows that advertise an effort ladder (`setModelEffortCapabilities`). Rust
// `run_host::builder_env::CatalogCaps` must give the same answers.
//
//   node benchmarks/rust-core/recorders/record-anthropic-caps.mjs [--tree <dir>]
//
// Output: native/core/fixtures/anthropic-caps/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// An empty data dir: no cached catalog can describe an id behind the recording's back.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'anthropic-caps-'));
delete process.env.MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT;

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'anthropic-caps');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-anthropic-caps.mjs';
const effort = await importFrom(tree, 'src/runtime/shared/llm/anthropic-effort.mjs');

const IDS = [
  'claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5',
  'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4.8-20260101', 'claude-opus-5',
  'claude-fable-5-1', 'claude-nova', 'anthropic/claude-opus-4.8', 'gpt-5', 'deepseek-v3',
];
const LIVE = [
  { id: 'claude-sonnet-4-6', reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }] },
  { id: 'claude-opus-4-8', reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
  { id: 'claude-opus-5-20260101', reasoningOptions: [{ type: 'effort', values: ['high', 'xhigh', 'low', 'medium'] }] },
  { id: 'deepseek-v3', reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
];

// Rows that declare more than a ladder: an empty stated ladder (a model that takes no effort),
// `thinkingTypes` flags, a bare alias that keeps the richer sibling, and a row stating no ladder
// at all (unknown, so skipped).
const DECLARED = [
  { id: 'claude-opus-4-8', reasoningOptions: [] },
  { id: 'claude-sonnet-4-5', reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }], thinkingTypes: { adaptive: true, enabled: false } },
  { id: 'claude-opus-5', reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }], thinkingTypes: { adaptive: false } },
  { id: 'claude-sonnet-4-6-20260101', reasoningOptions: [{ type: 'effort', values: ['low', 'medium'] }] },
  { id: 'claude-sonnet-4-6', reasoningOptions: [] },
  { id: 'claude-fable-5-1', thinkingTypes: { enabled: true } },
  { id: 'claude-opus-4-7', reasoningOptions: [], thinkingTypes: { enabled: true } },
];

function answers() {
  return IDS.map((model) => ({
    model,
    supportsEffort: effort.modelSupportsEffort(model),
    xhigh: effort.modelSupportsXhighEffort(model),
    max: effort.modelSupportsMaxEffort(model),
    adaptiveOnly: effort.isAnthropicAdaptiveOnlyModel(model),
    betaHeader: effort.shouldIncludeEffortBeta(model),
    levels: effort.anthropicEffortLevelsFor(model),
  }));
}

effort.setModelEffortCapabilities([]);
const floor = answers();
effort.setModelEffortCapabilities(LIVE);
const live = answers();
effort.setModelEffortCapabilities(DECLARED);
const declared = answers();

writeJson(join(stage, 'golden.json'), { ids: IDS, live: LIVE, floor, withLive: live, declaredRows: DECLARED, declared });
writeSetManifest(stage, { set: 'anthropic-caps', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
