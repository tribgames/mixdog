#!/usr/bin/env node
// Records Node's stale worker-row transition for the k1 UNTESTED stale-rows.test.mjs (gaps-rest.md section 3,
// mixdog-core-session `agent_registry`). Each case writes the test's rows as `agent-workers.json`, runs Node's real
// `createWorkerIndex` and `createStaleRowTransition` (`transitionStaleNonterminalRows`), and records the rows kept and
// the tombstones left; the scan cases run Node's real `createTerminalReaper` `tombstoneBlocksScan` with no tombstones.
// The clock is fixed at 2026-11-06T00:00:00.000Z.
//
//   node benchmarks/rust-core/recorders/record-stale-rows-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/stale-rows-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-stale-rows-cases.mjs';
const TEST = 'src/session-runtime/services/agent-tool/terminal-reaper/stale-rows.test.mjs';
const NOW = Date.parse('2026-11-06T00:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-cases-'));
Date.now = () => NOW;

const { flushAllIndexWritesSync } = await importFrom(tree, 'src/session-runtime/services/agent-tool/index-write-queue.mjs');
const { createWorkerIndex } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-index.mjs');
const { createStaleRowTransition } = await importFrom(tree, 'src/session-runtime/services/agent-tool/terminal-reaper/stale-rows.mjs');
const { createTerminalReaper } = await importFrom(tree, 'src/session-runtime/services/agent-tool/terminal-reaper.mjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const row = (sessionId, tag, extra = {}) => ({
  tag,
  sessionId,
  parentSessionId: 'lead-a',
  ownerSessionId: 'lead-a',
  agent: 'worker',
  provider: 'anthropic',
  clientHostPid: 4242,
  status: 'idle',
  ...extra,
});
const scanSession = (id, extra = {}) => ({ id, agentTag: id, agent: 'worker', provider: 'anthropic', status: 'idle', ...extra });

// The test's `runTransition`; `live` lists what each session is doing in this process.
function transition(rows, { config = {}, live = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-'));
  const file = join(root, 'agent-workers.json');
  writeFileSync(file, JSON.stringify({ version: 2, workers: Object.fromEntries(rows.map((r) => [r.sessionId, r])) }));
  const mgr = {
    getSession: () => null,
    listSessions: () => [],
    getSessionRuntime: (id) => (live[id] === 'streaming' ? { stage: 'streaming' } : null),
    isSessionTurnInFlight: (id) => live[id] === 'turn',
    hasPendingMessages: (id) => live[id] === 'queued',
  };
  const index = createWorkerIndex({ dataDir: root, cfgMod: { loadConfig: () => config }, mgr, tags: new Map(), tagAgents: new Map(), tagCwds: new Map() });
  const { transitionStaleNonterminalRows } = createStaleRowTransition({
    cfgMod: { loadConfig: () => config },
    mgr,
    tagMaps: { unbindIfOwned() {} },
    index,
    getLiveSession: () => null,
  });
  transitionStaleNonterminalRows();
  flushAllIndexWritesSync();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(root, { recursive: true, force: true });
  return {
    workers: Object.keys(doc.workers).sort(),
    tombstoned: Object.values(doc.tombstones || {}).map((t) => `${t.tag}:${t.sessionId}`).sort(),
  };
}

// The test's `scanBlocks`: each session against no tombstones.
function scan(sessions, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-'));
  const mgr = { getSession: () => null, listSessions: () => sessions, getSessionRuntime: () => null };
  const index = createWorkerIndex({ dataDir: root, cfgMod: { loadConfig: () => config }, mgr, tags: new Map(), tagAgents: new Map(), tagCwds: new Map() });
  const reaper = createTerminalReaper({ cfgMod: { loadConfig: () => config }, mgr, tagMaps: { unbindIfOwned() {} }, index, getLiveSession: () => null });
  const blocked = sessions.map((session) => reaper.tombstoneBlocksScan(session, session.agentTag, new Map()));
  rmSync(root, { recursive: true, force: true });
  return blocked;
}

const cases = [];
const old = iso(NOW - 2 * DAY);
{
  const config = { autoClear: { providerIdleMs: { anthropic: 36 * HOUR } } };
  const within = iso(NOW - 30 * HOUR);
  const rows = [
    row('s-old', 'old', { updatedAt: old, finishedAt: old }),
    row('s-within', 'within', { updatedAt: within, finishedAt: within }),
    row('s-orphan-old', 'orphan-old', { status: 'waiting', stage: 'waiting', updatedAt: old }),
    row('s-orphan-within', 'orphan-within', { status: 'waiting', stage: 'waiting', updatedAt: within }),
  ];
  const sessions = [
    scanSession('old', { createdAt: old, finishedAt: old, updatedAt: old }),
    scanSession('within', { createdAt: within, finishedAt: within, updatedAt: within }),
  ];
  cases.push({
    case: 'expired settled and orphan rows still follow the configured retention, loading config once',
    config,
    rows,
    sessions,
    recorded: { ...transition(rows, { config }), blocked: scan(sessions, config) },
  });
}
{
  const recent = iso(NOW - 2 * HOUR);
  const rows = [
    row('s-old', 'old', { updatedAt: old, finishedAt: old }),
    row('s-recent', 'recent', { updatedAt: recent, finishedAt: recent }),
    row('s-lead', 'lead', { agent: 'lead', updatedAt: old, finishedAt: old }),
    row('s-owed', 'owed', { status: 'failed', stage: 'failed', failureReason: 'process-restart', updatedAt: old, finishedAt: old }),
    row('s-running', 'running', { status: 'running', stage: 'running', updatedAt: iso(NOW) }),
    row('s-stamped', 'stamped', { updatedAt: old, finishedAt: old, reapAt: iso(NOW + DAY) }),
  ];
  cases.push({ case: 'settled rows past 1 day and their reap window leave the index, leaving a tombstone', config: {}, rows, recorded: transition(rows) });
}
{
  const config = { autoClear: { providerIdleMs: { anthropic: 3 * DAY } } };
  const rows = [row('s-long', 'long', { updatedAt: old, finishedAt: old })];
  cases.push({ case: 'a row whose configured reap window is longer than its age is kept', config, rows, recorded: transition(rows, { config }) });
}
{
  const rows = ['s-running', 's-queued', 's-active', 's-gone'].map((id, n) => row(id, 'abcd'[n], { updatedAt: old, finishedAt: old }));
  const live = { 's-running': 'turn', 's-queued': 'queued', 's-active': 'streaming' };
  cases.push({ case: 'a settled row whose session is live in this process is kept', config: {}, rows, live, recorded: transition(rows, { live }) });
}
{
  const touched = iso(NOW - HOUR);
  const rows = [row('s-touched', 'touched', { finishedAt: old, updatedAt: touched }), row('s-aged', 'aged', { updatedAt: old, finishedAt: old })];
  const sessions = [
    { id: 's-touched', agentTag: 'touched', agent: 'worker', status: 'idle', createdAt: old, finishedAt: old, updatedAt: touched },
    { id: 's-aged', agentTag: 'aged', agent: 'worker', status: 'idle', createdAt: old, finishedAt: old, updatedAt: old },
  ];
  cases.push({
    case: 'pruning and scan admission share one age rule over the latest activity stamp',
    config: {},
    rows,
    sessions,
    recorded: { ...transition(rows), blocked: scan(sessions) },
  });
}

const excluded = {
  'an empty index, live rows and settled rows under a day never load config':
    'GONE (gaps-rest.md): the reap window is an injected trait (agent_registry/mod.rs `ReapWindow`), not a config load to count',
  'scan admission of running and recently settled sessions never loads config':
    'GONE (gaps-rest.md): the reap window is an injected trait, not a config load to count',
};

const finalDir = join(FIXTURES_ROOT, 'stale-rows-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's stale-row transition at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, now: NOW, cases });
writeSetManifest(stage, {
  set: 'stale-rows-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'the sessions whose rows stay, the tombstones left (tag:session), and each scan decision',
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`stale-rows-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
