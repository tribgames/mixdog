#!/usr/bin/env node
// Which worker rows the agent tool's stale-row pass takes out of the index and which sessions its scan refuses, on real Node
// (`createStaleRowTransition` in terminal-reaper/stale-rows.mjs, `createTerminalReaper(...).tombstoneBlocksScan`), over the rows the
// Node tests of that pass seed (terminal-reaper/stale-rows.test.mjs): a worker index file written on disk, the real worker index
// reading it, a session manager that answers what the scenario says is live. Per scenario: the rows and sessions it was given
// (whole), the config, and the outcome: the index file's workers and tombstones maps as Node wrote them (whole, in Node's order),
// and the scan's verdict for each session.
//
// The clock is the deterministic world's; every stamp is written as an ISO text at an offset from it.
//
//   node benchmarks/rust-core/recorders/record-agent-stale-rows.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/agent-stale-rows/golden.json
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { installDeterministicWorld } from './lib/deterministic-world.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-agent-stale-rows.mjs';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_793_923_200_000;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const world = installDeterministicWorld({ start: NOW, pid: 4242 });
const load = (rel) => importFrom(tree, rel);
const agentTool = 'src/session-runtime/services/agent-tool';
const { flushAllIndexWritesSync } = await load(`${agentTool}/index-write-queue.mjs`);
const { createWorkerIndex } = await load(`${agentTool}/worker-index.mjs`);
const { createStaleRowTransition } = await load(`${agentTool}/terminal-reaper/stale-rows.mjs`);
const { createTerminalReaper } = await load(`${agentTool}/terminal-reaper.mjs`);

const iso = (offset) => new Date(NOW + offset).toISOString();
const row = (sessionId, tag, extra = {}) => ({
  tag, sessionId, parentSessionId: 'lead-a', ownerSessionId: 'lead-a', agent: 'worker', provider: 'anthropic', clientHostPid: 4242, status: 'idle', ...extra,
});
const settled = (offset) => ({ updatedAt: iso(offset), finishedAt: iso(offset) });
const scanSession = (id, extra = {}) => ({ id, agentTag: id, agent: 'worker', provider: 'anthropic', status: 'idle', ...extra });
const scanned = (offset) => ({ createdAt: iso(offset), finishedAt: iso(offset), updatedAt: iso(offset) });

const scenarios = [
  {
    name: 'live rows and a settled row under a day stay',
    rows: [
      row('s-run', 'run', { status: 'running', stage: 'running', updatedAt: iso(0) }),
      row('s-live-old', 'live-old', { status: 'running', stage: 'running', updatedAt: iso(-2 * DAY) }),
      row('s-recent', 'recent', settled(-2 * HOUR)),
    ],
    live: ['s-run', 's-live-old'],
    scan: [scanSession('running', { status: 'running', createdAt: iso(-2 * DAY), updatedAt: iso(0) }), scanSession('recent', scanned(-2 * HOUR))],
  },
  {
    name: 'expired settled and orphan rows follow the configured retention',
    config: { autoClear: { providerIdleMs: { anthropic: 36 * HOUR } } },
    rows: [
      row('s-old', 'old', settled(-2 * DAY)),
      row('s-within', 'within', settled(-30 * HOUR)),
      row('s-orphan-old', 'orphan-old', { status: 'waiting', stage: 'waiting', updatedAt: iso(-2 * DAY) }),
      row('s-orphan-within', 'orphan-within', { status: 'waiting', stage: 'waiting', updatedAt: iso(-30 * HOUR) }),
    ],
    scan: [scanSession('old', scanned(-2 * DAY)), scanSession('within', scanned(-30 * HOUR))],
  },
  {
    name: 'settled rows past a day and their reap window leave a tombstone',
    rows: [
      row('s-old', 'old', settled(-2 * DAY)),
      row('s-recent', 'recent', settled(-2 * HOUR)),
      row('s-lead', 'lead', { agent: 'lead', ...settled(-2 * DAY) }),
      row('s-owed', 'owed', { status: 'failed', stage: 'failed', failureReason: 'process-restart', ...settled(-2 * DAY) }),
      row('s-running', 'running', { status: 'running', stage: 'running', updatedAt: iso(0) }),
      row('s-stamped', 'stamped', { ...settled(-2 * DAY), reapAt: iso(DAY) }),
    ],
  },
  {
    name: 'a configured reap window longer than the age keeps the row',
    config: { autoClear: { providerIdleMs: { anthropic: 3 * DAY } } },
    rows: [row('s-long', 'long', settled(-2 * DAY))],
  },
  {
    name: 'a settled row whose session is live in this process stays',
    rows: [
      row('s-running', 'a', settled(-2 * DAY)),
      row('s-queued', 'b', settled(-2 * DAY)),
      row('s-active', 'c', settled(-2 * DAY)),
      row('s-gone', 'd', settled(-2 * DAY)),
    ],
    mgr: { turnInFlight: ['s-running'], pending: ['s-queued'], stages: { 's-active': 'streaming' } },
  },
  {
    name: 'pruning and scan admission share one age rule over the latest stamp',
    rows: [
      row('s-touched', 'touched', { finishedAt: iso(-2 * DAY), updatedAt: iso(-HOUR) }),
      row('s-aged', 'aged', settled(-2 * DAY)),
    ],
    scan: [
      { id: 's-touched', agentTag: 'touched', agent: 'worker', status: 'idle', createdAt: iso(-2 * DAY), finishedAt: iso(-2 * DAY), updatedAt: iso(-HOUR) },
      { id: 's-aged', agentTag: 'aged', agent: 'worker', status: 'idle', createdAt: iso(-2 * DAY), finishedAt: iso(-2 * DAY), updatedAt: iso(-2 * DAY) },
    ],
  },
];

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-stale-rows-'));
const out = [];
for (const [n, scenario] of scenarios.entries()) {
  const config = scenario.config ?? {};
  const flags = scenario.mgr ?? {};
  const mgr = {
    getSession: () => null,
    listSessions: () => scenario.scan ?? [],
    getSessionRuntime: (id) => (flags.stages?.[id] ? { stage: flags.stages[id] } : null),
    isSessionTurnInFlight: (id) => (flags.turnInFlight ?? []).includes(id),
    hasPendingMessages: (id) => (flags.pending ?? []).includes(id),
  };
  const make = (dir) => createWorkerIndex({ dataDir: dir, cfgMod: { loadConfig: () => config }, mgr, tags: new Map(), tagAgents: new Map(), tagCwds: new Map() });
  const dir = join(sandbox, `s${n}`);
  mkdirSync(dir);
  const file = join(dir, 'agent-workers.json');
  writeFileSync(file, JSON.stringify({ version: 2, workers: Object.fromEntries(scenario.rows.map((r) => [r.sessionId, r])) }));
  const index = make(dir);
  // The rows as the index handed them to the pass: Node's index load already settles a row stored as running whose session the
  // manager does not run, and fills each row's absent fields.
  const loaded = JSON.parse(JSON.stringify(index.readWorkerRows({})));
  const live = new Set(scenario.live ?? []);
  const common = { cfgMod: { loadConfig: () => config }, mgr, tagMaps: { unbindIfOwned() {} }, index };
  const { transitionStaleNonterminalRows } = createStaleRowTransition({ ...common, getLiveSession: (id) => (live.has(id) ? { id } : null) });
  transitionStaleNonterminalRows();
  flushAllIndexWritesSync();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  // The rows the index holds after the pass, as its reader returns them (the file keeps the rows it was given until a change
  // rewrites it), and the tombstones the pass wrote, whole and in the order Node holds them.
  const result = {
    workers: Object.fromEntries(index.readWorkerRows({}).filter((r) => r.agent !== 'lead').map((r) => [r.sessionId, r])),
    tombstones: doc.tombstones ?? {},
  };
  if (scenario.scan) {
    // The scan runs over an index that holds no tombstone: the verdict is the sessions' own stamps'.
    const scanDir = join(sandbox, `scan${n}`);
    mkdirSync(scanDir);
    const reaper = createTerminalReaper({ ...common, index: make(scanDir), getLiveSession: () => null });
    result.blocked = scenario.scan.map((session) => reaper.tombstoneBlocksScan(session, session.agentTag, new Map()));
  }
  out.push({ ...scenario, loaded, result });
}

const finalOut = join(FIXTURES_ROOT, 'agent-stale-rows');
const stage = stageSet(finalOut);
writeJson(join(stage, 'golden.json'), { note: 'the stale-row pass and the scan guard of real Node over the rows its tests seed', now: NOW, scenarios: out });
writeSetManifest(stage, {
  set: 'agent-stale-rows',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: out.length,
    syntheticInputs: [
      'the worker rows and the scan sessions: the rows and sessions of terminal-reaper/stale-rows.test.mjs, every stamp an offset from the fixed clock',
      'the session manager: answers only the in-flight, pending-message and runtime-stage facts a scenario names, no session record',
    ],
    keptWhole: 'per scenario: its rows, config, manager facts and scan sessions, the rows the index holds after the pass and the tombstones the pass wrote (every row and tombstone whole, recorded in Node\'s order), the scan verdicts',
    exclusions: {
      'the rows as stored in the index file':'a replay starts from `loaded`, the rows as Node\'s index handed them to the pass: its load settles a row stored as running whose session the manager does not run (restart-settlement.mjs:21, row-liveness) and fills absent fields, and the core settles such rows at its boot (agent_registry/restart.rs), not at a refresh. `rows`, the scenario\'s own input, is recorded beside it',
      'null members of rows and tombstones':'Node writes `null` for a tombstone field it has no value for (cwd, parent and owner ids); the core builds the tombstone without such a field, so a replay leaves null members out of both sides. Every non-null member of every row and tombstone is compared',
      'order of the rows and tombstones': 'recorded in the order Node\'s index lists them, but the core keeps each row in its own session\'s header (agent_registry/mod.rs:6-13), so it has no file order to compare; the rows and tombstones are compared as maps',
      'rows of the Lead pool (agent "lead")': 'Node leaves them out of the index file whenever the file is written again (its worker rows are projected without them), so no recorded list holds one; the core keeps the Lead\'s own row in its session header (agent_registry/lead_row.rs), which no pass removes, so a replay leaves them out of the list it compares',
      'the count of config loads': 'Node counts how often its reaper loads the config; the core reads its config from memory and has no load to count',
    },
  },
});
commitStage(stage, finalOut);
rmSync(sandbox, { recursive: true, force: true });
console.log(`scenarios=${out.length}`);
process.exit(0);
