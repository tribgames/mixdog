#!/usr/bin/env node
// Golden twin of `agent/pool/list`: Node's own pool listing (store-agent-worker-rows.mjs
// listStoredAgentWorkersAsync over a real data directory of worker indexes and session records)
// followed by the progress sweep of agent-pool-progress.mjs, exactly as daemon-desktop-runtime.mjs
// chains them. Every case holds the files it was read from, then per step the clock, the daemon's
// running set, the scripted live inputs (runtime entries, live sessions, awaited tasks, the ledger
// token table) and the rows Node answered. The clock is injected: Date.now is fixed per step.
//
//   node benchmarks/rust-core/recorders/record-agent-pool.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const SRC = 'src/runtime/agent/orchestrator/session';
const rowsMod = await importFrom(tree, `${SRC}/store-agent-worker-rows.mjs`);
const progress = await importFrom(tree, `${SRC}/agent-pool-progress.mjs`);
const runtimeState = await importFrom(tree, `${SRC}/manager/runtime-state.mjs`);
const stall = await importFrom(tree, 'src/runtime/agent/orchestrator/stall-policy.mjs');

const BASE = 1_800_000_000_000;
const HOUR = 3_600_000;
let seed = 0x51ed270b;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];
const iso = (ms) => new Date(ms).toISOString();

const STATUSES = ['running', 'queued', 'streaming', 'tool-running', 'idle', 'done', 'completed', 'failed', 'error', 'timeout', 'cancelled', 'killed', 'cancel-unconfirmed', 'cancel_pending', 'cancelling', 'weird', '', undefined];
const AGENTS = ['ada', 'worker', 'reviewer', 'heavy-worker', 'maintainer', 'Lead', 'lead', undefined];
const TAGS = ['b-worker', 'B-worker', 'a-worker', 'ä-worker', 'z-worker', 'worker 10', 'worker 9', ' padded ', ''];
const STAMPS = (ago) => pick([iso(BASE - ago), BASE - ago, String(BASE - ago), 'not a date', '', null, undefined, iso(BASE - ago).slice(0, 10)]);

function leadHeader(id) {
  return { id, owner: 'lead', agent: 'lead', sourceType: 'lead', title: `Lead ${id}`, messages: [] };
}

function todoOf() {
  const status = () => pick(['pending', 'in_progress', 'completed', 'abandoned', 'blocked', 'x']);
  return pick([
    { phases: [{ name: 'Plan', tasks: [{ content: ' a  b ', status: status() }, { content: 'c', status: status() }] }, { name: ' ', tasks: [{ content: 'd', status: status() }] }] },
    { phases: [] },
    { phases: [{ name: 'Empty', tasks: [] }] },
    { phases: [{ tasks: [{ content: 'only', status: 'completed' }, { content: '', status: 'pending' }, null, 7] }] },
    null,
    'junk',
  ]);
}

function sessionHeader(id, row, owner) {
  const header = { id, messages: [] };
  if (chance(0.7)) header.owner = pick(['agent', 'lead', 'Agent']);
  if (chance(0.7)) header.agent = pick(AGENTS);
  if (chance(0.4)) header.sourceType = pick(['lead', 'agent']);
  if (chance(0.5)) header.ownerSessionId = owner;
  if (chance(0.3)) header.parentSessionId = owner;
  for (const key of ['title', 'provider', 'model', 'effort', 'cwd']) if (chance(0.5)) header[key] = `${key}-${id}`;
  if (chance(0.3)) header.fast = true;
  if (chance(0.2)) header.autoEffort = false;
  if (chance(0.4)) header.createdAt = STAMPS(5 * HOUR);
  if (chance(0.4)) header.updatedAt = STAMPS(2 * HOUR);
  if (chance(0.3)) header.clientHostPid = pick([0, 17, -3, '42', 'x']);
  if (chance(0.3)) header.turnStartedAt = STAMPS(HOUR);
  if (chance(0.2)) header.startedAt = STAMPS(HOUR);
  if (chance(0.15)) header.cancelledAt = STAMPS(HOUR / 2);
  if (chance(0.15)) header.finishedAt = STAMPS(HOUR / 2);
  for (const key of ['cancelStatus', 'status', 'state', 'lastStatus', 'stage', 'outcome', 'terminationReason']) {
    if (chance(0.12)) header[key] = pick(STATUSES.filter(Boolean));
  }
  if (chance(0.5)) header.totalInputTokens = pick([0, 10, 1500, -1, 'x', null, 2.5]);
  if (chance(0.5)) header.totalOutputTokens = pick([0, 7, 900, -1, null]);
  if (chance(0.5)) header.totalToolCalls = pick([0, 3, 40, -2, null]);
  if (chance(0.5)) header.todo = todoOf();
  return header;
}

function childRow(id, owner, parent) {
  const row = { sessionId: id, tag: pick(TAGS), agent: pick(AGENTS) };
  const set = (key, value) => {
    if (value !== undefined) row[key] = value;
  };
  set('status', pick(STATUSES));
  if (chance(0.4)) set('stage', pick(STATUSES));
  if (chance(0.7)) row.ownerSessionId = owner;
  if (chance(0.5)) row.parentSessionId = parent;
  for (const key of ['title', 'provider', 'model', 'effort', 'cwd']) if (chance(0.5)) row[key] = ` ${key} ${id} `;
  if (chance(0.3)) row.fast = true;
  if (chance(0.2)) row.autoEffort = false;
  set('startedAt', chance(0.6) ? STAMPS(3 * HOUR) : undefined);
  set('createdAt', chance(0.6) ? STAMPS(4 * HOUR) : undefined);
  set('updatedAt', chance(0.8) ? STAMPS(pick([HOUR / 4, HOUR / 2, 2 * HOUR, 30 * HOUR])) : undefined);
  if (chance(0.3)) set('finishedAt', STAMPS(pick([HOUR / 4, 2 * HOUR])));
  if (chance(0.15)) set('cancelledAt', STAMPS(pick([HOUR / 4, 2 * HOUR])));
  if (chance(0.3)) set('turnStartedAt', STAMPS(HOUR / 3));
  if (chance(0.15)) row.awaitingUser = pick(['approval', 'other']);
  if (chance(0.15)) row.released = pick([true, false, 'yes']);
  if (chance(0.2)) row.failureReason = pick(['boom', ' spaced ', '', 7]);
  if (chance(0.15)) row.reapAt = STAMPS(0);
  if (chance(0.3)) row.clientHostPid = pick([0, 17, '42', -1, 'x']);
  if (chance(0.2)) row[pick(['task_id', 'taskId'])] = pick(['t1', ' t2 ', '']);
  return row;
}

function leadRow(id) {
  const row = { sessionId: id };
  const status = pick(STATUSES);
  if (status !== undefined) row.status = status;
  for (const key of ['provider', 'model', 'effort', 'cwd']) if (chance(0.6)) row[key] = ` ${key} ${id}`;
  if (chance(0.3)) row.fast = true;
  if (chance(0.2)) row.autoEffort = false;
  if (chance(0.6)) row.startedAt = STAMPS(3 * HOUR);
  if (chance(0.5)) row.createdAt = STAMPS(4 * HOUR);
  if (chance(0.7)) row.updatedAt = STAMPS(pick([HOUR / 4, 2 * HOUR, 30 * HOUR]));
  if (chance(0.3)) row.finishedAt = STAMPS(pick([HOUR / 4, 2 * HOUR]));
  if (chance(0.3)) row.cancelledAt = STAMPS(HOUR / 2);
  if (chance(0.3)) row.turnStartedAt = STAMPS(HOUR / 3);
  if (chance(0.2)) row.clientHostPid = pick([0, 17]);
  if (chance(0.2)) row.taskId = 't9';
  return row;
}

const entryOf = (id) => {
  if (chance(0.35)) return undefined;
  const entry = {};
  if (chance(0.8)) entry.stage = pick(['connecting', 'requesting', 'streaming', 'tool_running', 'cancelling', 'idle', 'resource_wait']);
  if (chance(0.1)) entry.closed = true;
  if (chance(0.5)) entry.askStartedAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.3)) entry.taskWaits = pick([0, 1, 2]);
  if (chance(0.5)) entry.lastProgressAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.3)) entry.lastStreamDeltaAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.3)) entry.toolStartedAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.3)) entry.requestSentAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.3)) entry.lastTransportAt = BASE - Math.floor(next() * HOUR);
  if (chance(0.4)) entry.lastToolCall = pick(['bash', 'read', '', null]);
  return entry;
};

const liveOf = () => {
  if (chance(0.7)) return undefined;
  const live = {};
  if (chance(0.7)) live.todo = todoOf();
  if (chance(0.6)) live.totalInputTokens = pick([5, 0, 100]);
  if (chance(0.6)) live.totalOutputTokens = pick([5, 0, 100]);
  if (chance(0.6)) live.totalToolCalls = pick([0, 9]);
  return live;
};

// One case's listings over its data directory (`MIXDOG_DATA_DIR` already set): per step the daemon's
// scripted state and what Node answered, or the message of the error its listing threw.
async function runSteps(everyId) {
  const steps = [];
  let now = BASE;
  for (let step = 0; step < 3; step += 1) {
    now += pick([0, 1000, 10 * 60_000, 2 * HOUR]);
    const running = everyId.filter(() => chance(0.4));
    Date.now = () => now;
    let listed;
    try {
      listed = await rowsMod.listStoredAgentWorkersAsync({ runningSessionIds: () => new Set(running) });
    } catch (error) {
      steps.push({ now, running, error: error.message });
      continue;
    }    const ids = listed.map((row) => row.sessionId);
    const entries = {};
    const live = {};
    const awaiting = ids.filter(() => chance(0.25));
    for (const id of ids) {
      const entry = entryOf(id);
      if (entry) entries[id] = entry;
      const session = liveOf();
      if (session) live[id] = session;
    }
    let groups = null;
    const tokens = {};
    const ledger = (map) => {
      groups = Object.fromEntries([...map].map(([owner, set]) => [owner, [...set]]));
      const out = new Map();
      for (const owner of map.keys()) if (chance(0.6)) out.set(owner, `tok${Math.floor(next() * 1000)}`);
      for (const [owner, token] of out) tokens[owner] = token;
      return out;
    };
    const rows = progress.withTurnProgress(
      progress.withLedgerToken(
        progress.withLiveUsage(
          progress.withLiveTodo(listed, (id) => live[id] ?? null),
          (id) => live[id] ?? null
        ),
        ledger
      ),
      (id) => entries[id],
      runtimeState.isTurnInFlight,
      (id) => awaiting.includes(id)
    );
    steps.push({ now, running, entries, live, awaiting, groups, ledger: tokens, listed, rows: JSON.parse(JSON.stringify(rows)) });
  }
  return steps;
}

const cases = [];
const root = mkdtempSync(join(tmpdir(), 'agent-pool-'));
for (let n = 0; n < 90; n += 1) {
  const dir = join(root, `case${n}`);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  const leads = [0, 1, 2].filter(() => chance(0.5)).map((i) => `lead_${n}_${i}`);
  const kids = Array.from({ length: Math.floor(next() * 9) }, (_, i) => `kid_${n}_${i}`);
  const owner = () => pick([...leads, `gone_${n}`, undefined, ' ']);
  const childRows = kids.map((id) => childRow(id, owner(), pick([...kids, ...leads])));
  if (chance(0.15)) childRows.push(5, 'x');
  if (chance(0.2)) childRows.push({ ...childRows[0], tag: 'dup' });
  if (chance(0.1)) childRows.push({ sessionId: 'bad id!', tag: 'x', status: 'running' });
  const leadRows = leads.filter(() => chance(0.85)).map(leadRow);
  if (kids.length && chance(0.2)) leadRows.push(leadRow(kids[0]));
  const tombstones = {};
  for (const row of childRows) {
    if (row && row.tag && chance(0.2)) {
      const base = { tag: row.tag, reapedAt: pick([iso(BASE - HOUR), iso(BASE - 9 * 24 * HOUR), BASE - HOUR, 'x', null]) };
      if (row.ownerSessionId && chance(0.6)) base.parentSessionId = row.ownerSessionId;
      else if (chance(0.5)) base.clientHostPid = row.clientHostPid;
      tombstones[`k${Object.keys(tombstones).length}`] = base;
    }
  }
  const asMap = (rows) => Object.fromEntries(rows.map((r, i) => [r?.sessionId ?? `x${i}`, r]));
  const index = (rows, extra) => {
    const shape = pick(['list', 'map', 'map', 'none', 'junk']);
    if (shape === 'none') return null;
    if (shape === 'junk') return pick(['{not json', '[]', '"s"', 'null']);
    return JSON.stringify({ version: 2, workers: shape === 'list' ? rows : asMap(rows), ...extra });
  };
  const files = { agentIndex: index(childRows, { tombstones }), leadIndex: index(leadRows, {}), headers: {} };
  if (files.agentIndex === null && chance(0.7)) files.agentIndex = index(childRows, { tombstones });
  for (const id of leads) if (chance(0.8)) files.headers[id] = JSON.stringify(leadHeader(id));
  for (const row of childRows) {
    if (row?.sessionId && /^[A-Za-z0-9_-]+$/.test(row.sessionId) && chance(0.7)) {
      files.headers[row.sessionId] = JSON.stringify(sessionHeader(row.sessionId, row, pick(leads.length ? leads : [`gone_${n}`])));
    }
  }
  for (const lead of leadRows) {
    if (!(lead.sessionId in files.headers) && chance(0.3)) {
      files.headers[lead.sessionId] = chance(0.5) ? JSON.stringify({ id: lead.sessionId, owner: 'agent', agent: 'ada', messages: [] }) : JSON.stringify(leadHeader(lead.sessionId));
    }
  }
  if (chance(0.1)) files.headers[kids[0] ?? `z_${n}`] = pick(['{broken', '[1,2]', '"x"']);
  if (files.agentIndex !== null) writeFileSync(join(dir, 'agent-workers.json'), files.agentIndex);
  if (files.leadIndex !== null) writeFileSync(join(dir, 'lead-workers.json'), files.leadIndex);
  for (const [id, text] of Object.entries(files.headers)) writeFileSync(join(dir, 'sessions', `${id}.json`), text);

  const steps = await runSteps([...kids, ...leads, `gone_${n}`]);
  cases.push({ files, steps });
}
// Listings Node's own code throws on: a null row in the child index (`row.sessionId`).
for (const [n, agentIndex] of [
  [90, JSON.stringify({ workers: [null] })],
  [91, JSON.stringify({ workers: { first: { sessionId: 'kid_91', tag: 't', agent: 'worker', status: 'running' }, second: null } })],
]) {
  const dir = join(root, `case${n}`);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  writeFileSync(join(dir, 'agent-workers.json'), agentIndex);
  cases.push({ files: { agentIndex, leadIndex: null, headers: {} }, steps: await runSteps(['kid_91']) });
}
rmSync(root, { recursive: true, force: true });

const setDir = join(FIXTURES_ROOT, 'agent-pool');
mkdirSync(setDir, { recursive: true });
writeJson(join(setDir, 'pool-twin.json'), {
  domain: 'agent-pool-twin',
  recorder: 'benchmarks/rust-core/recorders/record-agent-pool.mjs',
  base: BASE,
  // The stall warn point (resolveAgentStallThresholds(agent).warn * 1000) of every agent name used.
  stallWarnMs: Object.fromEntries(
    [...new Set(cases.flatMap((c) => c.steps.flatMap((s) => (s.listed ?? []).map((row) => row.agent))))].map((agent) => [
      String(agent),
      stall.resolveAgentStallThresholds(agent).warn * 1000,
    ])
  ),
  cases,
});
writeSetManifest(setDir, {
  set: 'agent-pool',
  recorder: 'benchmarks/rust-core/recorders/record-agent-pool.mjs',
  command: 'node benchmarks/rust-core/recorders/record-agent-pool.mjs --tree <dir with node_modules>',
  identityTree: tree,
});
console.log(`agent pool: ${cases.length} cases, ${cases.reduce((s, c) => s + c.steps.reduce((t, st) => t + (st.rows?.length ?? 0), 0), 0)} rows`);
process.exit(0);
