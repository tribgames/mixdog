#!/usr/bin/env node
// Golden twin of the read the desktop renderer used to poll and now takes from a pushed section
// (`native/core/fixtures/section-producers/`), from the real Node code at the commit the manifest names:
// - `agent-pool.json`: `agentPool`. Per step the worker files Node read (`agent-workers.json`,
//   `lead-workers.json`, the session records) and the rows its `listStoredAgentWorkersAsync` + progress chain
//   answered, exactly as `daemon-desktop-runtime.mjs` chains them (`listAgentPool`). Same step shape as
//   `agent-pool/pool-twin.json`, so the Rust pool rig replays it.
//
//   node benchmarks/rust-core/recorders/record-section-producers.mjs --tree <git clone at IDENTITY_REF with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

// The Node commit these twins are recorded from; the manifest must show the loaded tree equals it.
const IDENTITY_REF = 'b6f10295a2f698afc85332467192de28500bd146';

const tree = resolveTree(parseArgs());
const BASE = 1_800_000_000_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

// ---- agent pool ----------------------------------------------------------------------------------

const SRC = 'src/runtime/agent/orchestrator/session';
const rowsMod = await importFrom(tree, `${SRC}/store-agent-worker-rows.mjs`);
const progress = await importFrom(tree, `${SRC}/agent-pool-progress.mjs`);
const runtimeState = await importFrom(tree, `${SRC}/manager/runtime-state.mjs`);
const stall = await importFrom(tree, 'src/runtime/agent/orchestrator/stall-policy.mjs');

const worker = (sessionId, tag, status, extra = {}) => ({
  sessionId,
  tag,
  agent: 'worker',
  status,
  ownerSessionId: 'lead_1',
  parentSessionId: 'lead_1',
  title: `Task ${tag}`,
  provider: 'openai',
  model: 'gpt',
  startedAt: iso(BASE - 600_000),
  createdAt: iso(BASE - 700_000),
  updatedAt: iso(BASE - 1_000),
  ...extra,
});
const leadRow = { sessionId: 'lead_1', status: 'running', provider: 'openai', model: 'gpt', startedAt: iso(BASE - HOUR), createdAt: iso(BASE - HOUR), updatedAt: iso(BASE - 5_000) };
const header = (id, extra = {}) => ({ id, owner: 'agent', agent: 'worker', sourceType: 'agent', ownerSessionId: 'lead_1', messages: [], ...extra });
const world = (workers, headers) => ({
  agentIndex: JSON.stringify({ version: 2, workers, tombstones: {} }),
  leadIndex: JSON.stringify({ version: 2, workers: [leadRow] }),
  headers: Object.fromEntries([['lead_1', JSON.stringify({ id: 'lead_1', owner: 'lead', agent: 'lead', sourceType: 'lead', title: 'Lead', messages: [] })], ...headers.map(([id, h]) => [id, JSON.stringify(h)])]),
});
const todo = { phases: [{ name: 'Plan', tasks: [{ content: 'write it', status: 'completed' }, { content: 'test it', status: 'in_progress' }] }] };
const heard = (stage, at) => ({ stage, lastProgressAt: BASE - at, lastStreamDeltaAt: BASE - at, requestSentAt: BASE - at, lastTransportAt: BASE - at, taskWaits: 0 });

// Each step is one daemon state; the section's push for it is what Node's chain answered.
const POOL_CASES = [
  {
    name: 'two workers, one finishes, one is withdrawn',
    steps: [
      { at: 0, running: ['w1', 'w2'], files: world([worker('w1', 'alpha', 'running'), worker('w2', 'beta', 'running')], [['w1', header('w1', { title: 'Task alpha' })], ['w2', header('w2', { title: 'Task beta' })]]), entries: { w1: heard('streaming', 2_000), w2: heard('tool_running', 4_000) }, live: { w1: { totalInputTokens: 10, totalOutputTokens: 5, totalToolCalls: 2, todo } } },
      { at: 1_000, running: ['w1'], files: world([worker('w1', 'alpha', 'running'), worker('w2', 'beta', 'running')], [['w1', header('w1')], ['w2', header('w2')]]), entries: { w1: heard('streaming', 500) }, live: { w1: { totalInputTokens: 30, totalOutputTokens: 9, totalToolCalls: 3, todo } } },
      // Nothing changed since the step before but the clock.
      { at: 2_000, running: ['w1'], files: world([worker('w1', 'alpha', 'running'), worker('w2', 'beta', 'running')], [['w1', header('w1')], ['w2', header('w2')]]), entries: { w1: heard('streaming', 500) }, live: { w1: { totalInputTokens: 30, totalOutputTokens: 9, totalToolCalls: 3, todo } } },
      { at: 3_000, running: ['w1'], files: world([worker('w1', 'alpha', 'running'), worker('w2', 'beta', 'completed', { finishedAt: iso(BASE + 2_500) })], [['w1', header('w1')], ['w2', header('w2')]]), entries: { w1: heard('streaming', 400) }, live: {} },
      { at: 4_000, running: [], files: world([worker('w2', 'beta', 'completed', { finishedAt: iso(BASE + 2_500) })], [['w2', header('w2')]]), entries: {}, live: {} },
    ],
  },
  {
    name: 'a worker is cancelled, then comes back working',
    steps: [
      { at: 0, running: ['w1'], files: world([worker('w1', 'alpha', 'running')], [['w1', header('w1')]]), entries: { w1: heard('requesting', 100) }, live: {} },
      { at: 1_000, running: [], files: world([worker('w1', 'alpha', 'cancelled', { cancelledAt: iso(BASE + 900) })], [['w1', header('w1')]]), entries: {}, live: {} },
      { at: 2_000, running: ['w1'], files: world([worker('w1', 'alpha', 'running', { turnStartedAt: iso(BASE + 1_900) })], [['w1', header('w1')]]), entries: { w1: heard('connecting', 50) }, live: {} },
    ],
  },
];

const root = mkdtempSync(join(tmpdir(), 'section-producers-'));
const poolCases = [];
for (const [n, scenario] of POOL_CASES.entries()) {
  const dir = join(root, `case${n}`);
  process.env.MIXDOG_DATA_DIR = dir;
  const steps = [];
  for (const step of scenario.steps) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'agent-workers.json'), step.files.agentIndex);
    writeFileSync(join(dir, 'lead-workers.json'), step.files.leadIndex);
    for (const [id, text] of Object.entries(step.files.headers)) writeFileSync(join(dir, 'sessions', `${id}.json`), text);
    const at = BASE + step.at;
    Date.now = () => at;
    const listed = await rowsMod.listStoredAgentWorkersAsync({ runningSessionIds: () => new Set(step.running) });
    const rows = progress.withTurnProgress(
      progress.withLedgerToken(
        progress.withLiveUsage(
          progress.withLiveTodo(listed, (id) => step.live[id] ?? null),
          (id) => step.live[id] ?? null
        ),
        () => new Map()
      ),
      (id) => step.entries[id],
      runtimeState.isTurnInFlight,
      () => false
    );
    steps.push({ now: at, running: step.running, files: step.files, entries: step.entries, live: step.live, awaiting: [], ledger: {}, listed, rows: JSON.parse(JSON.stringify(rows)) });
  }
  poolCases.push({ name: scenario.name, steps });
}
rmSync(root, { recursive: true, force: true });

const setDir = join(FIXTURES_ROOT, 'section-producers');
mkdirSync(setDir, { recursive: true });
const recorder = 'benchmarks/rust-core/recorders/record-section-producers.mjs';
writeJson(join(setDir, 'agent-pool.json'), {
  domain: 'agent-pool-section-twin',
  recorder,
  base: BASE,
  stallWarnMs: Object.fromEntries([...new Set(poolCases.flatMap((c) => c.steps.flatMap((s) => s.listed.map((row) => row.agent))))].map((agent) => [String(agent), stall.resolveAgentStallThresholds(agent).warn * 1000])),
  cases: poolCases,
});
writeSetManifest(setDir, {
  set: 'section-producers',
  recorder,
  command: `node ${recorder} --tree <git clone of the Node repo at ${IDENTITY_REF}, with node_modules>`,
  identityTree: tree,
  identityRef: IDENTITY_REF,
});
console.log(`section producers: ${poolCases.reduce((s, c) => s + c.steps.length, 0)} pool steps`);
process.exit(0);
