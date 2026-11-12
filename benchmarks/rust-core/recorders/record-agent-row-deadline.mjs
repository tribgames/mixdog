#!/usr/bin/env node
// What a Lead's clients are told when the agent maintenance pass removes a worker row at its deadline (agent-tool.mjs,
// maintenance-pass.mjs), on real Node with its timers and clock mocked (node:test `mock.timers`, setTimeout/setInterval/Date;
// setImmediate stays real, as the status re-read uses it):
//   - one Lead's agent tool (`createStandaloneAgent`) over a worker index holding four running rows whose sessions are gone:
//     `overdue` (its reap deadline passed before the process started), `early` and `late` (due 10 s and 60 s in), and
//     `active` (due 20 s in, written again 5 s in, which moves its deadline a whole reap window past that write);
//   - the Lead's status (`createRoutedAgentTool(...).agentStatusState`, what the session runtime publishes to its clients
//     as `agentWorkers`) and the agent tool's `onStatusChange` announcements (each one the runtime re-reading and
//     publishing that status).
// Recorded at each step: the workers the status lists (`tag:status`), how many announcements came since the last step,
// and the tags whose rows left the index as tombstones.
//
//   node benchmarks/rust-core/recorders/record-agent-row-deadline.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/agent-row-deadline/golden.json
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-agent-row-deadline.mjs';
const T0 = 1_793_923_200_000;
const LEAD = 'sess_rows_lead';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-row-deadline-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
delete process.env.NODE_TEST_CONTEXT;
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });

const mgr = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager.mjs');
const { createStandaloneAgent } = await importFrom(tree, 'src/session-runtime/services/agent-tool.mjs');
const { createRoutedAgentTool } = await importFrom(tree, 'src/session-runtime/agent-tool-routing.mjs');
const { createWorkerIndex } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-index.mjs');
const { flushAllIndexWrites } = await importFrom(tree, 'src/session-runtime/services/agent-tool/index-write-queue.mjs');
const { agentMaintenanceSettled } = await importFrom(tree, 'src/session-runtime/services/agent-tool/maintenance-pass.mjs');
const { resolveAgentTerminalReapMs } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');

const { SETTLED_ROW_RETENTION_MS } = await importFrom(tree, 'src/session-runtime/services/agent-tool/terminal-reaper/row-helpers.mjs');
// A settled row leaves the index at the later of its retention floor and its continuation window, after its finish.
const WINDOW = Math.max(SETTLED_ROW_RETENTION_MS, resolveAgentTerminalReapMs({}, 'p'));
const iso = (ms) => new Date(ms).toISOString();
// A settled (idle) row whose session is gone, stamped so that its retention deadline (its finish plus WINDOW) is `dueIn`
// ms from T0. (A running row with no live turn counts as settled two minutes after its stamp.)
const row = (tag, dueIn) => {
  const stamp = iso(T0 - WINDOW + dueIn);
  return {
    tag,
    sessionId: `sess_rows_${tag}`,
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    agent: 'worker',
    provider: 'p',
    model: 'm',
    status: 'idle',
    stage: 'idle',
    clientHostPid: process.pid,
    createdAt: stamp,
    updatedAt: stamp,
    finishedAt: stamp,
  };
};
const rows = [row('overdue', -60_000), row('early', 10_000), row('active', 20_000), row('late', 60_000)];
const dataDir = join(root, 'agent');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'agent-workers.json'), JSON.stringify({ version: 2, workers: Object.fromEntries(rows.map((r) => [r.sessionId, r])), tombstones: {} }));

const cfgMod = { loadConfig: () => ({ providers: {}, presets: [] }) };
// The keychain prewarm has finished, as the daemon's own agent tool takes it (daemon-agent-control.mjs).
const agent = createStandaloneAgent({ cfgMod, reg: {}, mgr, dataDir, cwd: dataDir, awaitKeychainPrewarm: async () => {}, isKeychainPrewarmReady: () => true });
const status = createRoutedAgentTool({ rt: { session: { id: LEAD, clientHostPid: process.pid } }, agentTool: agent }).agentStatusState;
let announced = 0;
agent.onStatusChange(() => {
  announced += 1;
});
// Another writer of the same index (the daemon's canonical agent tool), for the `active` row's second write.
const writer = createWorkerIndex({ dataDir, cfgMod, mgr, tags: new Map(), tagAgents: new Map(), tagCwds: new Map() });

const turn = () => new Promise((resolve) => setImmediate(resolve));
// Everything due at the current mocked instant: the pass it started, its index writes, and the status re-read and
// announcements they caused (each a macrotask of its own).
async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await agentMaintenanceSettled();
    await flushAllIndexWrites();
    await turn();
  }
}

// The index as written to disk: the tags of its rows and of its tombstones.
function indexFile() {
  const doc = JSON.parse(readFileSync(join(dataDir, 'agent-workers.json'), 'utf8'));
  return {
    indexed: Object.values(doc.workers || {}).map((w) => w.tag).sort(),
    tombstones: Object.values(doc.tombstones || {}).map((t) => t.tag).sort(),
  };
}

let now = 0;
const steps = [];
function snapshot(at, what) {
  const state = status();
  steps.push({
    at,
    what,
    workers: state.agentWorkers.map((w) => `${w.tag}:${w.status}`),
    announced,
    ...indexFile(),
  });
  announced = 0;
}
async function tickTo(at) {
  mock.timers.tick(at - now);
  now = at;
  await settle();
}

// The Lead's first status read (its runtime loading) registers its scope and asks for a pass.
await settle();
snapshot(0, 'the first status read');
for (const [at, what] of [
  [999, 'before the first pass'],
  [1000, 'the first pass, one event delay after the first read'],
]) {
  await tickTo(at);
  snapshot(at, what);
}
await tickTo(5000);
// The `active` row worked again and settled: its stamps move to now.
writer.writeWorkerRows((byKey) => {
  const active = byKey.get('sess_rows_active');
  byKey.set('sess_rows_active', { ...active, updatedAt: iso(T0 + 5000), finishedAt: iso(T0 + 5000) });
});
await settle();
snapshot(5000, 'the active row written again');
for (const [at, what] of [
  [9999, 'before the early deadline'],
  [10_000, 'the early deadline'],
  [20_000, 'the active row\'s old deadline'],
  [59_999, 'before the late deadline'],
  [60_000, 'the late deadline'],
  [5000 + WINDOW - 1, 'before the active row\'s new deadline'],
  [5000 + WINDOW, 'the active row\'s new deadline'],
]) {
  await tickTo(at);
  snapshot(at, what);
}

agent.dispose();
writer.dispose();
await flushAllIndexWrites();
mock.timers.reset();
rmSync(root, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'agent-row-deadline');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what a Lead\'s status lists and announces as the agent maintenance pass removes worker rows at their deadlines',
  t0: T0,
  window: WINDOW,
  lead: LEAD,
  rows: rows.map(({ tag, sessionId, updatedAt }) => ({ tag, sessionId, stampedAt: updatedAt })),
  steps,
});
writeSetManifest(out, {
  set: 'agent-row-deadline',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    syntheticInputs: [
      `node:test mock.timers on setTimeout, setInterval and Date from ${T0}; setImmediate real`,
      'a worker index of four running worker rows of one Lead whose sessions do not exist, stamped relative to the reap window of provider p under an empty config',
      'the active row rewritten 5 s in with its updatedAt at that moment, through a second worker index over the same folder',
    ],
    keptWhole: 'per step: the listed workers (tag:status), the number of onStatusChange announcements since the previous step, and the tags tombstoned in the index',
  },
});
commitStage(out, finalOut);
console.log(JSON.stringify(steps));
process.exit(0);
