#!/usr/bin/env node
// Golden twin of the `model` status domain's live-route facts (setup-tool/executor.mjs
// `SETUP_STATUS_READERS.model`): the Lead preset's fallback chain (`rt.listPresets()`), and where the
// calling conversation and the other Lead conversations are on their chains (`routePositionsStatus`
// with `keep: kind === 'lead'`). Node's real setup executor answers `{ action: 'status', domain:
// 'model' }` over sessions held in the live-state map; the whole answer is recorded, and the
// `agents` domain's `sessions` beside it. Rust `SessionLiveRoute` under `ModelStatus` must answer
// the same object.
//
//   node benchmarks/rust-core/recorders/record-live-route.mjs [--tree <dir>]
//
// Output: native/core/fixtures/live-route/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'live-route-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'live-route');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-live-route.mjs';
const orch = 'src/runtime/agent/orchestrator/session/';
const live = await importFrom(tree, `${orch}store/live-state.mjs`);
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
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
const EMPTY_CHAIN_CONFIG = { ...CONFIG, presets: [{ ...CONFIG.presets[0], fallbacks: [] }] };
const NO_LEAD_CONFIG = { default: 'main', presets: [{ id: 'main', name: 'Main', provider: 'openai', model: 'gpt' }] };

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
const worker = (id, extra = {}) => ({ id, owner: 'agent', agent: 'worker', provider: 'openai', model: 'gpt', routeFallbacks: CHAIN, ...extra });

const SESSIONS = [
  hopped('sess_lead_a', 'lead'),
  hopped(agentHomeSessionId('helper'), 'helper'),
  fresh('sess_lead_b', 'lead'),
  worker('sess_worker_chain'),
  { ...hopped('sess_lead_closed', 'lead'), closed: true },
  fresh('sess_lead_plain', 'lead', 'other'),
  { id: 'sess_noagent', owner: 'user', provider: 'openai', model: 'gpt' },
];

// The facade properties a conversation carries (`rt.provider`, ...), as `mainRoute(rt)` and the model reader read them.
const FACTS = {
  provider: 'openai', model: 'gpt', effort: 'high', fast: true, fastCapable: true, autoEffort: false,
  modelParameters: { tier: 'x' }, contextPercent: 34, contextTokens: 1200, effortOptions: ['low', 'high'],
};

const cases = [];
async function record(name, { config = CONFIG, held = SESSIONS, caller = null, facts = FACTS }) {
  const records = Object.fromEntries(held.map((s) => [s.id, s]));
  for (const s of held) live.setLiveSession(s);
  try {
    const rt = { ...facts, listPresets: () => config.presets, getOrchestrationMode: () => 'none' };
    const executor = createSetupToolExecutor({
      getApi: () => rt,
      getConfig: () => config,
      getSessionId: () => caller,
      getCallerSession: (id) => records[id] || null,
    });
    const answers = {};
    for (const domain of ['model', 'agents']) {
      const out = JSON.parse(await executor.execute({ action: 'status', domain }, { callerSessionId: caller ?? undefined }));
      answers[domain] = out;
    }
    cases.push({
      name,
      config: plain(config),
      caller,
      facts: plain(facts),
      sessions: plain(held),
      model: plain({ route: answers.model.route, effortOptions: answers.model.effortOptions, session: answers.model.session, sessions: answers.model.sessions }),
      modelKeys: Object.keys(answers.model),
      agentsSessions: plain(answers.agents.sessions),
    });
  } finally {
    for (const s of held) live._clearLiveSession(s.id);
  }
}

await record('a Lead caller with the Lead chain', { caller: 'sess_lead_a' });
await record('a fresh Lead caller', { caller: 'sess_lead_b' });
await record('a bot caller', { caller: agentHomeSessionId('helper') });
await record('a worker caller', { caller: 'sess_worker_chain' });
await record('a caller without an agent', { caller: 'sess_noagent' });
await record('a caller that is not held', { caller: 'sess_other' });
await record('no caller', {});
await record('nothing held', { held: [], caller: 'sess_lead_a' });
await record('a Lead preset without a chain', { config: BARE_CONFIG, caller: 'sess_lead_a' });
await record('a Lead preset with an empty chain', { config: EMPTY_CHAIN_CONFIG, caller: 'sess_lead_a' });
await record('no Lead preset', { config: NO_LEAD_CONFIG, caller: 'sess_lead_a' });
await record('a facade with nothing set', { facts: {}, caller: 'sess_lead_a' });
await record('held in another order', { held: [...SESSIONS].reverse(), caller: 'sess_lead_b' });

writeJson(join(stage, 'golden.json'), { domain: 'live-route', recorder, cases });
writeSetManifest(stage, {
  set: 'live-route',
  recorder,
  command: 'node benchmarks/rust-core/recorders/record-live-route.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} live-route cases`);