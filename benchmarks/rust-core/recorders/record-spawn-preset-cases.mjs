#!/usr/bin/env node
// Records Node's agent spawn preset for the k1 UNTESTED spawn-preset.test.mjs (gaps-rest.md section 3, mixdog-agent
// `agent_tool/` flow/preset.rs): each test's config and args through Node's real `resolveAgentSpawnPreset`, with the
// route candidates Node's `configuredAgentRouteCandidates` reads for the agent (what the Rust host's `route_candidates`
// hands the resolver), and the whole `{presetName, preset}` it returns.
//
//   node benchmarks/rust-core/recorders/record-spawn-preset-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/spawn-preset-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-spawn-preset-cases.mjs';
const TEST = 'src/session-runtime/services/agent-tool/spawn-preset.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);

const { resolveAgentSpawnPreset } = await importFrom(tree, 'src/session-runtime/services/agent-tool/spawn-preset.mjs');
const { configuredAgentRouteCandidates } = await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');

const scenarios = [
  {
    case: 'agent route preset carries modelParameters and contextPercent',
    config: {
      agents: {
        reviewer: { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5', effort: 'low', modelParameters: { context: '1m' }, contextPercent: 40 },
      },
    },
    args: { agent: 'reviewer' },
  },
  {
    case: 'agent route preset omits unset modelParameters and contextPercent',
    config: { agents: { reviewer: { provider: 'p', model: 'm' } } },
    args: { agent: 'reviewer' },
  },
];

const cases = scenarios.map((s) => ({
  ...s,
  candidates: configuredAgentRouteCandidates(structuredClone(s.config), s.args.agent),
  recorded: resolveAgentSpawnPreset(structuredClone(s.config), structuredClone(s.args)),
}));

const finalDir = join(FIXTURES_ROOT, 'spawn-preset-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's resolveAgentSpawnPreset at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'spawn-preset-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: { ...recorderProvenance(import.meta.url), compared: 'the whole {presetName, preset} the resolver returns', excluded: {} },
});
commitStage(stage, finalDir);
console.log(`spawn-preset-cases: ${cases.length} case(s)`);
process.exit(0);
