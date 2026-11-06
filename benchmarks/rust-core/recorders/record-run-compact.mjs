#!/usr/bin/env node
// Golden twin of the config-backed part of a turn's compaction settings: what Node's
// resolveWorkerCompactPolicy (session/loop/compact-policy.mjs) resolves for a session whose
// compaction was synced from the saved config (syncSessionCompaction), over random session
// headers, saved `compaction` sections and the MIXDOG_*COMPACT* environment. Only the resolved
// policy is recorded; the Rust side builds CompactSettings from the same inputs and resolves it.
//
//   node benchmarks/rust-core/recorders/record-run-compact.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { resolveWorkerCompactPolicy } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/loop/compact-policy.mjs'
);
const { syncSessionCompaction } = await importFrom(tree, 'src/session-runtime/session-compaction-sync.mjs');

let state = 20260517;
const rnd = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const maybe = (p, make) => (rnd() < p ? make() : undefined);

const tokens = [undefined, null, 0, -5, 'abc', '', 1000, 3000, 8000, '12000', 50000, 128000, 200000, 272000, 1000000.7, true];
const percents = [undefined, null, 0, 5, 10, '15', 25, 50, 0.1, 0.3, 100, 150, -1, 'x', ''];
const ratios = [undefined, null, 0, 0.05, 0.1, 0.2, 0.9, 1, 1.5, 30, -2, 'y'];
const providers = ['anthropic', 'anthropic-oauth', 'openai', 'gemini', 'google-x', 'cursor-api', 'Gemini', undefined, ''];

const ENV_NAMES = [
  ['MIXDOG_AGENT_COMPACT_AUTO', ['off', '0', 'on', 'maybe', '']],
  ['MIXDOG_AGENT_COMPACT_BUFFER_TOKENS', ['2000', '0', 'z']],
  ['MIXDOG_AGENT_COMPACT_BUFFER_PERCENT', ['5', '12.5', '', '0']],
  ['MIXDOG_AGENT_COMPACT_BUFFER_RATIO', ['0.2', '40']],
  ['MIXDOG_MAIN_COMPACT_BUFFER_TOKENS', ['4000']],
  ['MIXDOG_MAIN_COMPACT_BUFFER_PERCENT', ['8']],
  ['MIXDOG_MAIN_COMPACT_BUFFER_RATIO', ['0.15']],
  ['MIXDOG_AGENT_COMPACT_RESERVED_TOKENS', ['1500']],
  ['MIXDOG_AGENT_COMPACT_TARGET_TOKENS', ['9000']],
  ['MIXDOG_COMPACT_TARGET_TOKENS', ['7000']],
  ['MIXDOG_AGENT_COMPACT_TARGET_MIN_TOKENS', ['6000']],
  ['MIXDOG_COMPACT_TARGET_MIN_TOKENS', ['2500']],
  ['MIXDOG_AGENT_COMPACT_TARGET_PERCENT', ['40', '0.4', '0']],
  ['MIXDOG_COMPACT_TARGET_PERCENT', ['10']],
  ['MIXDOG_TOKEN_CALIBRATION_ANTHROPIC', ['1.2', '9', '0.01', 'q']],
  ['MIXDOG_TOKEN_CALIBRATION_GEMINI', ['1.5']],
  ['MIXDOG_TOKEN_CALIBRATION_DEFAULT', ['1.1']],
];

const COMPACT_KEYS = [
  ['auto', [true, false, undefined, null, 0]],
  ['enabled', [false, true]],
  ['contextWindow', tokens],
  ['boundaryTokens', tokens],
  ['autoCompactTokenLimit', tokens],
  ['bufferTokens', tokens],
  ['buffer', tokens],
  ['bufferPercent', percents],
  ['bufferPct', percents],
  ['bufferRatio', ratios],
  ['bufferFraction', ratios],
  ['mainBufferTokens', tokens],
  ['mainBuffer', tokens],
  ['mainBufferPercent', percents],
  ['mainBufferPct', percents],
  ['mainBufferRatio', ratios],
  ['mainBufferFraction', ratios],
  ['reservedTokens', tokens],
  ['targetTokens', tokens],
  ['target', tokens],
  ['targetPercent', percents],
  ['targetPct', percents],
  ['targetRatio', ratios],
  ['targetFraction', ratios],
  ['targetMinTokens', tokens],
  ['minTargetTokens', tokens],
  ['triggerTokens', tokens],
  ['bufferTokens', [0, 20000, 27200]],
  ['bufferRatio', [0.1, 0]],
];

function object(keys, p) {
  const out = {};
  for (const [key, values] of keys) {
    if (rnd() < p) {
      const value = pick(values);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

const entries = [];
for (let i = 0; i < 900; i += 1) {
  const sparse = rnd() < 0.4 ? 0.12 : 0.35;
  const savedCompaction = rnd() < 0.85 ? object(COMPACT_KEYS, sparse) : undefined;
  const session = {
    ...maybe(0.7, () => ({ owner: pick(['agent', ' Agent ', 'user', '', 7]) })),
    ...maybe(0.5, () => ({ sessionMode: pick(['agent', 'coding', 'weird']) })),
    ...maybe(0.2, () => ({ id: pick(['sess_home_lead', 'sess_home_a_b', 'sess_rmem_r1_x', 'sess_plain']) })),
    ...maybe(0.15, () => ({ ownerAgentId: pick(['bot', 'a.b', ' ', 9]) })),
    ...maybe(0.1, () => ({ visibility: 'agent-only' })),
    provider: pick(providers),
    ...maybe(0.6, () => ({ contextWindow: pick(tokens) })),
    ...maybe(0.35, () => ({ compactBoundaryTokens: pick(tokens) })),
    ...maybe(0.3, () => ({ autoCompactTokenLimit: pick(tokens) })),
    compaction: object(COMPACT_KEYS, 0.2),
  };
  if (session.provider === undefined) delete session.provider;
  const env = {};
  if (rnd() < 0.5) {
    for (const [name, values] of ENV_NAMES) if (rnd() < 0.12) env[name] = pick(values);
  }
  for (const [name] of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, env);
  const config = savedCompaction === undefined ? {} : { compaction: savedCompaction };
  const live = JSON.parse(JSON.stringify(session));
  syncSessionCompaction(live, config);
  const policy = resolveWorkerCompactPolicy(live, []);
  entries.push({
    session,
    config,
    env,
    policy:
      policy === null
        ? null
        : policy.auto === false
          ? { auto: false }
          : {
              auto: true,
              boundaryTokens: policy.boundaryTokens,
              triggerTokens: policy.triggerTokens,
              compactTargetTokens: policy.compactTargetTokens,
              singleShot: policy.singleShot,
              contextWindow: policy.contextWindow,
              reserveTokens: policy.reserveTokens,
              configuredReserveTokens: policy.configuredReserveTokens,
              tokenCalibration: policy.tokenCalibration,
            },
  });
}
for (const [name] of ENV_NAMES) delete process.env[name];

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'run-compact-twin.json'), {
  domain: 'run-compact-twin',
  recorder: 'benchmarks/rust-core/recorders/record-run-compact.mjs',
  entries,
});
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${entries.length} compaction cases`);
