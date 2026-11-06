#!/usr/bin/env node
// What Node's OpenAI Responses request builder asks the model catalog and its documented-id rules
// about a model (openai-model-capabilities.mjs, openai-direct-request.mjs): reasoning, verbosity,
// native tool search, the prompt-cache form and the Fast / Ultrafast tiers. Rust
// `run_host::builder_env::CatalogOpenAiFacts` must give the same answers on a cold catalog.
//
//   node benchmarks/rust-core/recorders/record-openai-facts.mjs [--tree <dir>]
//
// Output: native/core/fixtures/openai-facts/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// An empty data dir: no cached catalog can describe an id behind the recording's back.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'openai-facts-'));

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'openai-facts');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-openai-facts.mjs';
const caps = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-model-capabilities.mjs');
const direct = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-direct-request.mjs');

const IDS = [
  'gpt-4.1', 'gpt-4o', 'o1', 'o3-mini', 'gpt-5', 'gpt-5-chat-latest', 'gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex-max',
  'gpt-5.2', 'gpt-5.2-2026-01-01', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6-sol', 'gpt-5.6-sol-2026-02-03',
  'gpt-5.6', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna-2026-05-06', 'gpt-60', 'text-embedding-3-small', 'claude-opus-5', '',
];

const cases = IDS.map((model) => {
  const body = direct.applyOpenAIDirectCachePolicy({}, model, true);
  return {
    model,
    reasoning: caps.openAiPublicSupportsReasoning(model),
    verbosity: caps.openAiPublicSupportsVerbosity(model),
    toolSearch: caps.openAiPublicSupportsToolSearch(model),
    cacheOptions: body.prompt_cache_options ?? null,
    cacheRetention: body.prompt_cache_retention ?? null,
    fast: direct.openAiDirectSupportsFast(model),
    ultrafast: direct.openAiDirectSupportsUltrafast(model),
  };
});

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'openai-facts', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
