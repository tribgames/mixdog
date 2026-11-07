#!/usr/bin/env node
// What Rust `run_host::agent_world` (the production `DispatchWorld` of the hidden-role dispatch)
// must answer as Node does, recorded from Node's own code:
//
//  - hiddenAgents: `getHiddenAgent(name)` (defaults/agents.json merged with the frontmatter of its
//    systemFile) for every internal agent and for names that are none.
//  - runtimeSpec: `resolveRuntimeSpec(preset, { lane: 'agent', agentId })`.
//  - contextSelection: `contextSelectionFromState(resolveRouteContextState(route, null, lookup), route)`
//    for routes with and without a known model window (`lookup` is the injected window source).
//
//   node benchmarks/rust-core/recorders/record-agent-world.mjs [--tree <dir>]
//
// Output: native/core/fixtures/agent-world/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// Nothing Mixdog imports may reach the user's real directories (import-time sweeps delete data).
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = mkdtempSync(join(tmpdir(), `agent-world-${name.toLowerCase()}-`));
}

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'agent-world');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-world.mjs';
const at = (path) => importFrom(tree, path);

const orchestrator = 'src/runtime/agent/orchestrator/';
const internal = await at(`${orchestrator}internal-agents.mjs`);
const presets = await at(`${orchestrator}config-presets.mjs`);
const contextState = await at(`${orchestrator}runtime-core/route-context-state.mjs`);

const hiddenAgents = ['explore-agent', 'cycle1-agent', 'title-agent', 'worker', 'maintainer', '', 'Cycle1-Agent'].map((name) => ({
  name,
  agent: internal.getHiddenAgent(name),
}));

const specCases = [
  { preset: { provider: 'anthropic-oauth', model: 'claude-sonnet' }, agentId: 'cycle1-agent' },
  { preset: { provider: ' openai ', model: ' gpt-5 ' }, agentId: 'w1' },
  { preset: {}, agentId: 'a' },
  { preset: { provider: 'p' }, agentId: 'a' },
  { preset: { model: 'm', effort: 'high', fast: true }, agentId: 'a' },
  { preset: null, agentId: 'a' },
];
const runtimeSpec = specCases.map(({ preset, agentId }) => ({
  preset,
  agentId,
  spec: presets.resolveRuntimeSpec(preset, { lane: 'agent', agentId }),
}));
let missingAgent;
try {
  presets.resolveRuntimeSpec({ provider: 'p', model: 'm' }, { lane: 'agent' });
} catch (error) {
  missingAgent = error.message;
}

const windows = {
  'p/known': { contextWindow: 400000, maxContextWindow: 1000000 },
  'p/plain': { contextWindow: 200000, maxContextWindow: 200000 },
  'p/only-max': { maxContextWindow: 500000 },
};
const lookup = (provider, model) => windows[`${provider}/${model}`] || null;
const selectionRoutes = [
  { provider: 'p', model: 'known' },
  { provider: 'p', model: 'known', contextPercent: 50 },
  { provider: 'p', model: 'known', contextPercent: 100 },
  { provider: 'p', model: 'known', contextPercent: 37 },
  { provider: 'p', model: 'known', contextTokens: 600000 },
  { provider: 'p', model: 'known', contextTokens: 400000 },
  { provider: 'p', model: 'known', contextTokens: 10 },
  { provider: 'p', model: 'plain', contextPercent: 60 },
  { provider: 'p', model: 'only-max', contextPercent: 20 },
  { provider: 'p', model: 'unknown', contextPercent: 40 },
  { provider: 'p', model: 'unknown', contextTokens: 123456 },
  { provider: 'p', model: 'unknown' },
  { provider: ' p ', model: ' known ', contextPercent: '70' },
];
const contextSelection = selectionRoutes.map((route) => {
  const state = contextState.resolveRouteContextState(route, null, lookup);
  return { route, window: lookup(String(route.provider).trim(), String(route.model).trim()), selection: contextState.contextSelectionFromState(state, route) };
});

writeJson(join(stage, 'golden.json'), { hiddenAgents, runtimeSpec, missingAgent, contextSelection });
writeSetManifest(stage, { set: 'agent-world', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
