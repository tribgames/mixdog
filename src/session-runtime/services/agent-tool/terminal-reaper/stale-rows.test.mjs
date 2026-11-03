import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { flushAllIndexWritesSync } = await import('../index-write-queue.mjs');
const { createWorkerIndex } = await import('../worker-index.mjs');
const { createStaleRowTransition } = await import('./stale-rows.mjs');
const { createTerminalReaper } = await import('../terminal-reaper.mjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function row(sessionId, tag, extra = {}) {
  return {
    tag,
    sessionId,
    parentSessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    agent: 'worker',
    provider: 'anthropic',
    clientHostPid: 4242,
    status: 'idle',
    ...extra,
  };
}

// The reaper's config loads are counted; the index gets its own config source
// so only the reaper's calls are measured.
function countingConfig(config) {
  const cfgMod = {
    loads: 0,
    loadConfig: () => {
      cfgMod.loads += 1;
      return config;
    },
  };
  return cfgMod;
}

function runTransition(rows, { config = {}, mgrExtra = {}, live = new Set() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-'));
  const file = join(root, 'agent-workers.json');
  writeFileSync(file, JSON.stringify({ version: 2, workers: Object.fromEntries(rows.map((r) => [r.sessionId, r])) }));
  const cfgMod = countingConfig(config);
  const mgr = { getSession: () => null, listSessions: () => [], getSessionRuntime: () => null, ...mgrExtra };
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => config },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const { transitionStaleNonterminalRows } = createStaleRowTransition({
    cfgMod,
    mgr,
    tagMaps: { unbindIfOwned() {} },
    index,
    getLiveSession: (id) => (live.has(id) ? { id } : null),
  });
  transitionStaleNonterminalRows();
  flushAllIndexWritesSync();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(root, { recursive: true, force: true });
  return { doc, loads: cfgMod.loads };
}

function setup(rows, config = {}, mgrExtra = {}) {
  return runTransition(rows, { config, mgrExtra }).doc;
}

function scanBlocks(sessions, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-'));
  const cfgMod = countingConfig(config);
  const mgr = { getSession: () => null, listSessions: () => sessions, getSessionRuntime: () => null };
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => config },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const reaper = createTerminalReaper({
    cfgMod,
    mgr,
    tagMaps: { unbindIfOwned() {} },
    index,
    getLiveSession: () => null,
  });
  const blocked = sessions.map((session) => reaper.tombstoneBlocksScan(session, session.agentTag, new Map()));
  rmSync(root, { recursive: true, force: true });
  return { blocked, loads: cfgMod.loads };
}

function scanSession(id, extra = {}) {
  return { id, agentTag: id, agent: 'worker', provider: 'anthropic', status: 'idle', ...extra };
}

test('an empty index, live rows and settled rows under a day never load config', () => {
  const now = Date.now();
  const recent = iso(now - 2 * HOUR);
  assert.equal(runTransition([]).loads, 0);
  const live = runTransition(
    [
      row('s-run', 'run', { status: 'running', stage: 'running', updatedAt: iso(now) }),
      row('s-live-old', 'live-old', { status: 'running', stage: 'running', updatedAt: iso(now - 2 * DAY) }),
    ],
    { live: new Set(['s-run', 's-live-old']) }
  );
  assert.equal(live.loads, 0);
  assert.deepEqual(Object.keys(live.doc.workers).sort(), ['s-live-old', 's-run']);
  const settled = runTransition([row('s-recent', 'recent', { updatedAt: recent, finishedAt: recent })]);
  assert.equal(settled.loads, 0);
  assert.deepEqual(Object.keys(settled.doc.workers), ['s-recent']);
});

test('scan admission of running and recently settled sessions never loads config', () => {
  const now = Date.now();
  const recent = iso(now - 2 * HOUR);
  const scan = scanBlocks([
    scanSession('running', { status: 'running', createdAt: iso(now - 2 * DAY), updatedAt: iso(now) }),
    scanSession('recent', { createdAt: recent, finishedAt: recent, updatedAt: recent }),
  ]);
  assert.deepEqual(scan, { blocked: [false, false], loads: 0 });
});

test('expired settled and orphan rows still follow the configured retention, loading config once', () => {
  const now = Date.now();
  const config = { autoClear: { providerIdleMs: { anthropic: 36 * HOUR } } };
  const old = iso(now - 2 * DAY);
  const within = iso(now - 30 * HOUR);
  const { doc, loads } = runTransition(
    [
      row('s-old', 'old', { updatedAt: old, finishedAt: old }),
      row('s-within', 'within', { updatedAt: within, finishedAt: within }),
      // Neither terminal nor active (index construction settles stale active
      // rows), so these take the no-live-session branch.
      row('s-orphan-old', 'orphan-old', { status: 'waiting', stage: 'waiting', updatedAt: old }),
      row('s-orphan-within', 'orphan-within', { status: 'waiting', stage: 'waiting', updatedAt: within }),
    ],
    { config }
  );
  assert.equal(loads, 1);
  assert.deepEqual(Object.keys(doc.workers).sort(), ['s-orphan-within', 's-within']);
  const tombstoned = Object.values(doc.tombstones)
    .map((t) => `${t.tag}:${t.sessionId}`)
    .sort();
  assert.deepEqual(tombstoned, ['old:s-old', 'orphan-old:s-orphan-old']);

  const scan = scanBlocks(
    [
      scanSession('old', { createdAt: old, finishedAt: old, updatedAt: old }),
      scanSession('within', { createdAt: within, finishedAt: within, updatedAt: within }),
    ],
    config
  );
  assert.deepEqual(scan.blocked, [true, false]);
});

test('settled rows past 1 day and their reap window leave the index, leaving a tombstone', () => {
  const now = Date.now();
  const old = iso(now - 2 * DAY);
  const doc = setup([
    row('s-old', 'old', { updatedAt: old, finishedAt: old }),
    row('s-recent', 'recent', { updatedAt: iso(now - 2 * HOUR), finishedAt: iso(now - 2 * HOUR) }),
    row('s-lead', 'lead', { agent: 'lead', updatedAt: old, finishedAt: old }),
    row('s-owed', 'owed', {
      status: 'failed',
      stage: 'failed',
      failureReason: 'process-restart',
      updatedAt: old,
      finishedAt: old,
    }),
    row('s-running', 'running', { status: 'running', stage: 'running', updatedAt: iso(now) }),
    row('s-stamped', 'stamped', { updatedAt: old, finishedAt: old, reapAt: iso(now + DAY) }),
  ]);
  assert.deepEqual(Object.keys(doc.workers).sort(), ['s-owed', 's-recent', 's-running', 's-stamped']);
  assert.ok(Object.values(doc.tombstones).some((t) => t.tag === 'old' && t.sessionId === 's-old'));
});

test('a row whose configured reap window is longer than its age is kept', () => {
  const now = Date.now();
  const old = iso(now - 2 * DAY);
  const doc = setup([row('s-long', 'long', { updatedAt: old, finishedAt: old })], {
    autoClear: { providerIdleMs: { anthropic: 3 * DAY } },
  });
  assert.deepEqual(Object.keys(doc.workers), ['s-long']);
});

test('a settled row whose session is live in this process is kept', () => {
  const now = Date.now();
  const old = iso(now - 2 * DAY);
  const doc = setup(
    [
      row('s-running', 'a', { updatedAt: old, finishedAt: old }),
      row('s-queued', 'b', { updatedAt: old, finishedAt: old }),
      row('s-active', 'c', { updatedAt: old, finishedAt: old }),
      row('s-gone', 'd', { updatedAt: old, finishedAt: old }),
    ],
    {},
    {
      isSessionTurnInFlight: (id) => id === 's-running',
      hasPendingMessages: (id) => id === 's-queued',
      getSessionRuntime: (id) => (id === 's-active' ? { stage: 'streaming' } : null),
    }
  );
  assert.deepEqual(Object.keys(doc.workers).sort(), ['s-active', 's-queued', 's-running']);
});

test('pruning and scan admission share one age rule over the latest activity stamp', () => {
  const now = Date.now();
  const old = iso(now - 2 * DAY);
  // Finished 2 days ago but touched an hour ago: not aged for either side.
  const touched = row('s-touched', 'touched', { finishedAt: old, updatedAt: iso(now - HOUR) });
  const doc = setup([touched, row('s-aged', 'aged', { updatedAt: old, finishedAt: old })]);
  assert.deepEqual(Object.keys(doc.workers), ['s-touched']);

  // Tombstones capped out: the scan alone must keep aged sessions out and let
  // the touched one in, matching what the prune keeps.
  const sessions = [
    {
      id: 's-touched',
      agentTag: 'touched',
      agent: 'worker',
      status: 'idle',
      createdAt: old,
      finishedAt: old,
      updatedAt: iso(now - HOUR),
    },
    {
      id: 's-aged',
      agentTag: 'aged',
      agent: 'worker',
      status: 'idle',
      createdAt: old,
      finishedAt: old,
      updatedAt: old,
    },
  ];
  const root = mkdtempSync(join(tmpdir(), 'mixdog-stale-rows-'));
  const cfgMod = { loadConfig: () => ({}) };
  const mgr = { getSession: () => null, listSessions: () => sessions, getSessionRuntime: () => null };
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod,
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const reaper = createTerminalReaper({
    cfgMod,
    mgr,
    tagMaps: { unbindIfOwned() {} },
    index,
    getLiveSession: () => null,
  });
  const none = new Map();
  assert.equal(reaper.tombstoneBlocksScan(sessions[1], 'aged', none), true);
  assert.equal(reaper.tombstoneBlocksScan(sessions[0], 'touched', none), false);
  rmSync(root, { recursive: true, force: true });
});
