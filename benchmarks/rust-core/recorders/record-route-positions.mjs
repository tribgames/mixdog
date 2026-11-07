#!/usr/bin/env node
// Golden twin of the held-session fallback positions the `agents` status prints
// (`session-route-actions.mjs` `routePositionsStatus` -> `route-fallback-chain.mjs`
// `liveRouteFallbackPositions`): Node's real functions run over sessions held in the live-state map
// (`setLiveSession`), in the order they were held, and the rows they answer are recorded whole.
// Rust `SessionRoutePositions::others` must answer the same rows for the same held threads.
//
//   node benchmarks/rust-core/recorders/record-route-positions.mjs [--tree <dir>]
//
// Output: native/core/fixtures/route-positions/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'route-positions-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'route-positions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-route-positions.mjs';
const orch = 'src/runtime/agent/orchestrator/session/';
const live = await importFrom(tree, `${orch}store/live-state.mjs`);
const { routePositionsStatus } = await importFrom(tree, 'src/session-runtime/setup-tool/session-route-actions.mjs');
const { agentHomeSessionId } = await importFrom(tree, `${orch}agent-home.mjs`);

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const CHAIN = [
  { provider: 'anthropic', model: 'opus' },
  { provider: 'google', model: 'gemini' },
];
const CONFIG = {
  default: 'workflow-lead',
  presets: [{ id: 'workflow-lead', name: 'WORKFLOW LEAD', provider: 'openai', model: 'gpt', effort: 'high', fallbacks: CHAIN }],
  agents: { helper: { provider: 'openai', model: 'gpt', fallbacks: CHAIN } },
};
const BARE_CONFIG = { default: 'workflow-lead', presets: [{ ...CONFIG.presets[0], fallbacks: undefined }] };

const hopped = (id, agent) => ({
  id,
  owner: 'user',
  agent,
  provider: 'anthropic',
  model: 'opus',
  routeFallbackIndex: 1,
  routeFallbackPrimary: { provider: 'openai', model: 'gpt', effort: 'high' },
  routeFallbackFailures: [{ provider: 'openai', model: 'gpt', kind: 'quota_exhausted', error: 'limit' }],
});
const fresh = (id, agent, model = 'gpt') => ({ id, owner: 'user', agent, provider: 'openai', model });
const worker = (id, extra = {}) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  provider: 'openai',
  model: 'gpt',
  routeFallbacks: CHAIN,
  ...extra,
});

// What is held, in the order it was held.
const SESSIONS = [
  hopped('sess_lead_a', 'lead'),
  hopped(agentHomeSessionId('helper'), 'helper'),
  worker('sess_worker_chain'),
  worker('sess_worker_bare', { routeFallbacks: [] }),
  worker('sess_worker_hopped', { routeFallbacks: [], routeFallbackIndex: 1, routeFallbackFailures: [{ provider: 'openai', model: 'gpt', kind: 'rate_limit', error: 'slow' }] }),
  { ...hopped('sess_helper_closed', 'helper'), closed: true },
  { ...hopped('sess_noagent', ''), agent: undefined },
  fresh('sess_lead_fresh', 'lead'),
  fresh(agentHomeSessionId('scout'), 'scout', 'other'),
  hopped('sess_room_seat', 'helper'),
];

const cases = [];
function record(name, { config = CONFIG, held = SESSIONS, caller = null }) {
  for (const s of held) live.setLiveSession(s);
  try {
    const callerSession = held.find((s) => s.id === caller) ?? (caller ? { id: caller } : undefined);
    const rows = routePositionsStatus({ caller: callerSession, config, keep: (row) => row.kind !== 'lead' }).sessions;
    cases.push({ name, config: plain(config), caller, sessions: plain(held), rows: plain(rows) });
  } finally {
    for (const s of held) live._clearLiveSession(s.id);
  }
}

record('nothing held', { held: [] });
record('a caller outside the held sessions', { caller: 'sess_other' });
record('the caller is a held bot', { caller: agentHomeSessionId('helper') });
record('the caller is a held lead', { caller: 'sess_lead_a' });
record('the caller is a worker', { caller: 'sess_worker_chain' });
record('a config whose chains are gone', { config: BARE_CONFIG });
record('only leads and sessions that follow nothing', { held: [SESSIONS[0], SESSIONS[7], SESSIONS[3]] });
record('held in another order', { held: [...SESSIONS].reverse() });

writeJson(join(stage, 'golden.json'), { domain: 'route-positions', recorder, cases });
writeSetManifest(stage, {
  set: 'route-positions',
  recorder,
  command: 'node benchmarks/rust-core/recorders/record-route-positions.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} route-position cases (${cases.reduce((n, c) => n + c.rows.length, 0)} rows)`);