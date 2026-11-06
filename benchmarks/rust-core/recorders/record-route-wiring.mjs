#!/usr/bin/env node
// Golden twin of `prepareTurnEffortConfiguration` (effort-configuration.mjs): what a route's
// effort configuration is at turn start, for each route kind, effort spelling and history.
// Each case holds the session, the provider facts Node read (`config`, `customConfig.protocol`,
// `getCachedModelInfo`), the turn's effort override, the xhigh/max answers of the Anthropic
// effort gates (Rust reads them from the model's catalog caps), and what Node answered.
// Rust `mixdog-core` `run_host::route_wiring` must equal it.
//
//   node benchmarks/rust-core/recorders/record-route-wiring.mjs --tree <dir>
import { join } from 'node:path';
import { REPO_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const orch = 'src/runtime/agent/orchestrator/providers/';
const configuration = await importFrom(tree, `${orch}effort-configuration.mjs`);
const anthropic = await importFrom(tree, 'src/runtime/shared/llm/anthropic-effort.mjs');

const LEVELS_ROW = { reasoningLevels: ['low', 'medium', 'high'] };
const NONE_ROW = { reasoningOptions: [{ type: 'effort', values: ['none', 'low'] }] };
const snap = (provider, model, mode, initialEffort, effort) => ({
  version: 1,
  provider,
  model,
  mode,
  initialEffort,
  effort,
});
const routes = [
  { provider: 'openai', model: 'gpt-6' },
  { provider: 'openai', model: 'gpt-6.1-2026-01-01' },
  { provider: 'openai', model: 'gpt-5' },
  { provider: 'openai-oauth', model: 'gpt-6-1' },
  { provider: 'openai-oauth', model: 'gpt-5.5' },
  { provider: 'openai', model: 'gpt-6', config: { thinkingBudgetTokens: 1000 } },
  { provider: 'openai', model: 'gpt-6', config: { effortConfigurationEnabled: false } },
  { provider: 'openai', model: 'gpt-6', modelParameters: { reasoning_mode: 'pro' } },
  { provider: 'openai', model: 'gpt-6', modelParameters: { multi_agent: true } },
  { provider: 'anthropic', model: 'claude-opus-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  { provider: 'anthropic', model: 'claude-opus-5', config: { baseURL: 'https://proxy.example/v1' } },
  { provider: 'anthropic', model: 'claude-opus-5', config: { baseURL: 'https://api.anthropic.com/v1' } },
  { provider: 'anthropic', model: 'claude-opus-5', config: { disableBetaHeaders: true } },
  { provider: 'anthropic-oauth', model: 'claude-haiku-5-5' },
  { provider: 'anthropic-oauth', model: 'claude-newfamily-6' },
  { provider: 'gemini', model: 'gemini-3-pro' },
  // Ids no catalog describes: the generation floor answers.
  { provider: 'anthropic', model: 'claude-opus-4-5' },
  { provider: 'anthropic', model: 'claude-opus-4.6' },
  { provider: 'anthropic', model: 'claude-opus-4-7-20260101' },
  { provider: 'anthropic', model: 'claude-opus-4-20250514' },
  { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' },
  { provider: 'anthropic', model: 'claude-3-5-sonnet' },
  { provider: 'anthropic', model: 'claude-nova' },
  { provider: 'anthropic', model: 'claude-nova-9-1-20270101' },
  { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-8' },
  { provider: 'anthropic', model: 'us.anthropic.claude-opus-5-v1:0' },
  { provider: 'anthropic', model: 'claude-sonnet-4@20250514' },
  { provider: 'anthropic', model: 'claude-opus-4-8x' },
  { provider: 'anthropic', model: 'not-claude-7' },
  { provider: 'anthropic-oauth', model: 'CLAUDE-OPUS-4-7' },
  { provider: 'custom-x', model: 'gpt-6', protocol: 'openai-responses', row: LEVELS_ROW },
  { provider: 'custom-x', model: 'org/gpt-6.1-sol', protocol: 'openai-responses', row: LEVELS_ROW },
  { provider: 'custom-x', model: 'llama', protocol: 'openai-chat', row: LEVELS_ROW },
  { provider: 'custom-x', model: 'llama', protocol: 'openai-chat', row: NONE_ROW },
  { provider: 'custom-x', model: 'llama', protocol: 'openai-chat', row: { reasoningLevels: [] } },
  { provider: 'custom-x', model: 'llama', protocol: 'openai-chat' },
  { provider: 'custom-x', model: 'claude-opus-5', protocol: 'anthropic', row: LEVELS_ROW },
];
const efforts = [undefined, 'high', 'ultra', 'xhigh', 'EXTRA-HIGH', 'max', 'none', '', 'bogus', 'minimal'];
const turnEfforts = [undefined, 'low', 'Max'];

const cases = [];
for (const route of routes) {
  const histories = [
    [],
    [{ role: 'user', meta: { effortConfiguration: snap(route.provider, String(route.model).toLowerCase().replace(/\./g, '-').replace(/-\d{4}-\d{2}-\d{2}$/, ''), 'responses', 'low', 'high') } }],
    [{ role: 'user', meta: { effortConfiguration: snap('other', route.model, 'responses', 'low', 'high') } }],
  ];
  for (const [index, messages] of histories.entries()) {
    for (const effort of index === 0 ? efforts : ['medium']) {
      for (const turnEffort of index === 0 && efforts.indexOf(effort) > 3 ? [undefined] : turnEfforts) {
        const session = {
          provider: route.provider,
          model: route.model,
          effort,
          modelParameters: route.modelParameters,
          messages: structuredClone(messages),
        };
        const provider = {
          config: route.config ?? {},
          customConfig: route.protocol ? { protocol: route.protocol } : undefined,
          getCachedModelInfo: () => route.row ?? null,
        };
        const result = configuration.prepareTurnEffortConfiguration(session, provider, turnEffort);
        const caps = { xhigh: anthropic.modelSupportsXhighEffort(route.model), max: anthropic.modelSupportsMaxEffort(route.model) };
        cases.push({
          session: { provider: route.provider, model: route.model, effort: effort ?? null, modelParameters: route.modelParameters ?? null, messages },
          provider: { config: route.config ?? {}, protocol: route.protocol ?? null, row: route.row ?? null },
          turnEffort: turnEffort ?? null,
          caps,
          snapshot: result ?? null,
        });
      }
    }
  }
}
const gateIds = [...new Set(routes.map((r) => r.model))];
const gates = gateIds.map((model) => ({
  model,
  xhigh: anthropic.modelSupportsXhighEffort(model),
  max: anthropic.modelSupportsMaxEffort(model),
}));
writeJson(join(REPO_ROOT, 'native/core/crates/mixdog-core/src/run_host/golden/route_wiring.json'), { cases, gates });
console.log(`route wiring cases: ${cases.length}`);
