#!/usr/bin/env node
// Golden twin of the ladder's cached provider rows (run_host/ladder_sources.rs): the effort options
// Node's real `autoEffortModel` + `effortOptionsFor` give for the row a provider's
// `getCachedModelInfo` answers (OpenAI OAuth catalog via `_normalizeCodexModel`, a compat
// provider), and `effectiveCustomModelRows` layering a custom override onto a discovered row.
//
//   node benchmarks/rust-core/recorders/record-ladder-rows.mjs [--tree <dir>]
//
// Output: native/core/fixtures/ladder-rows/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'ladder-rows-'));

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'ladder-rows');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-ladder-rows.mjs';
const base = 'src/runtime/agent/orchestrator';
const effort = await importFrom(tree, `${base}/runtime-core/effort.mjs`);
const configuration = await importFrom(tree, `${base}/providers/effort-configuration.mjs`);
const codex = await importFrom(tree, `${base}/providers/openai-codex-model.mjs`);
const custom = await importFrom(tree, `${base}/providers/custom-provider-config.mjs`);

const options = (provider, cached, model) =>
  effort.effortOptionsFor(provider, configuration.autoEffortModel(provider, { getCachedModelInfo: () => cached }, model));

const codexRow = codex._normalizeCodexModel({
  slug: 'gpt-5.5',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
});
const compatRow = {
  id: 'grok-x',
  provider: 'xai',
  reasoningLevels: ['low', 'high'],
  reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
};
const routes = [
  { provider: 'openai-oauth', model: 'gpt-5.5', cached: codexRow },
  { provider: 'openai-oauth', model: 'gpt-5.5', cached: null },
  { provider: 'xai', model: 'grok-x', cached: compatRow },
  { provider: 'xai', model: 'grok-x', cached: null },
].map((r) => ({
  provider: r.provider,
  model: r.model,
  levels: r.cached?.reasoningLevels ?? null,
  options: options(r.provider, r.cached, r.model),
}));

const discovered = {
  id: 'm1',
  name: 'm1',
  provider: 'custom-acme',
  contextWindow: 8000,
  outputTokens: null,
  reasoningLevels: ['low', 'high'],
  reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
};
const layer = (overrides, rows) =>
  custom.effectiveCustomModelRows({ modelOverrides: overrides }, rows, { providerId: 'custom-acme' }).find((r) => r.id === 'm1');
const rows = {
  discovered,
  manualOnly: layer({ m1: { manual: true } }, [discovered]),
  manualWithLevels: layer({ m1: { manual: true, reasoning: { levels: ['medium'] } } }, [discovered]),
  notDiscovered: layer({ m1: { manual: true } }, []),
};

writeJson(join(stage, 'golden.json'), { routes, rows });
writeSetManifest(stage, { set: 'ladder-rows', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
