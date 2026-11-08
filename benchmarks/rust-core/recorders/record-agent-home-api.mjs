#!/usr/bin/env node
// Golden twin of the agent home, agent memory and agent pool methods: what Node's real host code
// answers (apps/desktop/src/main/agent-home-sessions.ts createAgentHomeSessions open/reset,
// agent-memory.ts listAgentMemory/deleteAgentMemory, and the pool listing of
// session/store-agent-worker-rows.mjs listStoredAgentWorkersAsync) over scripted worlds. A home
// scenario runs open/reset calls against an in-memory session world whose every dependency call
// is logged; the flight scenarios start several calls of one agent together (the first dependency
// call parks on a gate) to record which share one in-flight result; the memory cases script the
// memory runtime's text replies; the pool cases list rows through Node's pool listing over a real
// data directory of worker indexes.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-agent-home-api.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
// A refused route refresh is warned about and never fails an open: the scripted failure is expected.
console.warn = () => {};
const { createAgentHomeSessions } = await importFrom(tree, 'apps/desktop/src/main/agent-home-sessions.ts');
const { listAgentMemory, deleteAgentMemory } = await importFrom(tree, 'apps/desktop/src/main/agent-memory.ts');
const rowsMod = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-agent-worker-rows.mjs');

let seed = 0x2f6e2b1;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];

// --- agent home ----------------------------------------------------------------------------------
const ROUTES = {
  ada: { provider: 'openai', model: 'gpt-x', effort: 'high' },
  bob: null,
  cy: [{ provider: 'anthropic', model: 'opus', fast: true, autoEffort: false, modelParameters: { temperature: 0.5 } }],
  dee: { provider: 'openai' },
};
const ROUTE_VARIANTS = [
  { provider: 'openai', model: 'gpt-x', effort: 'high' },
  { provider: 'openai', model: 'gpt-x' },
  { provider: 'openai', model: 'gpt-y', effort: 'low' },
  { provider: 'google', model: 'gem' },
];
const AGENT_IDS = ['ada', 'bob', 'cy', 'dee', 'lead', 'ghost', 'wkr', 'Bad Id', 'a.b', ' ada '];

// Contacts are custom agents marked `kind: bot` and not switched off; the catalog also lists others.
const CATALOG_EXTRAS = [
  { id: 'wkr', custom: true, kind: 'agent', route: ROUTES.ada },
  { id: 'worker', custom: false, kind: 'bot', route: ROUTES.ada },
  null,
];
const agentRows = (ids) => [
  ...ids.map((id) => ({ id, custom: true, kind: 'bot', disabled: id === 'dee', route: ROUTES[id] ?? null })),
  ...CATALOG_EXTRAS,
];

function freshWorld() {
  const sessions = {};
  for (const id of ['ada', 'cy', 'lead', 'a.b']) {
    if (chance(0.5)) sessions[`sess_home_${id.replaceAll('.', '_')}`] = { route: pick(ROUTE_VARIANTS), turns: chance(0.6) };
  }
  return {
    agents: ['ada', 'bob', 'cy', 'dee'].filter(() => chance(0.85)),
    mixyRoute: chance(0.8) ? pick(ROUTE_VARIANTS) : null,
    mixyCreated: chance(0.6),
    sessions,
    archived: Object.keys(sessions).filter(() => chance(0.3)),
    retired: Object.keys(sessions).filter(() => chance(0.2)),
    running: [],
    setRouteFails: chance(0.2),
    clearFails: chance(0.1),
  };
}

function patchOf(world) {
  const patch = {};
  if (chance(0.3)) patch.mixyCreated = !world.mixyCreated;
  if (chance(0.3)) patch.agents = ['ada', 'bob', 'cy', 'dee'].filter(() => chance(0.7));
  if (chance(0.3)) patch.mixyRoute = chance(0.7) ? pick(ROUTE_VARIANTS) : null;
  if (chance(0.3)) {
    const sessions = structuredClone(world.sessions);
    for (const id of Object.keys(sessions)) if (chance(0.5)) sessions[id].route = pick(ROUTE_VARIANTS);
    patch.sessions = sessions;
  }
  if (chance(0.25)) patch.running = Object.keys(world.sessions).filter(() => chance(0.5));
  if (chance(0.15)) patch.setRouteFails = !world.setRouteFails;
  if (chance(0.15)) patch.clearFails = !world.clearFails;
  return patch;
}

function sessionMissing(id) {
  return Object.assign(new Error(`Session ${id} is not available`), { code: 'SESSION_NOT_AVAILABLE' });
}

// With a gate, the first dependency call of every resolution (the catalog, or Mixy's route) waits on
// `gate.promise`; `world.catalogFailures` makes that many catalog reads reject.
function homeRig(world, gate = null) {
  const log = [];
  let archiveCount = 0;
  const has = (list, id) => list.includes(id);
  const set = (list, id, on) => {
    const at = list.indexOf(id);
    if (on && at < 0) list.push(id);
    if (!on && at >= 0) list.splice(at, 1);
  };
  const deps = {
    async listAgents() {
      if (gate) await gate.promise;
      log.push(['listAgents']);
      if (world.catalogFailures > 0) {
        world.catalogFailures -= 1;
        throw new Error('The catalog is unavailable.');
      }
      return agentRows(world.agents);
    },
    async mixyRoute() {
      if (gate) await gate.promise;
      log.push(['mixyRoute']);
      return world.mixyRoute;
    },
    async mixyCreated() {
      log.push(['mixyCreated']);
      return world.mixyCreated;
    },
    async readSession(id) {
      log.push(['readSession', id]);
      const session = world.sessions[id];
      if (!session) throw sessionMissing(id);
      return { ...session.route };
    },
    async createSession(id, params) {
      log.push(['createSession', id, params]);
      world.sessions[id] = { route: { provider: params.provider, model: params.model, effort: params.effort }, turns: false };
    },
    async setRoute(id, route) {
      log.push(['setRoute', id, route]);
      if (world.setRouteFails) throw new Error('The provider is signed out.');
      world.sessions[id].route = { ...route };
    },
    async setArchived(id, archived) {
      log.push(['setArchived', id, archived]);
      set(world.archived, id, archived);
    },
    async isRetired(id) {
      return has(world.retired, id);
    },
    async setRetired(id, retired) {
      log.push(['setRetired', id, retired]);
      set(world.retired, id, retired);
    },
    async nameRetired() {},
    async archivedAgentName() {
      return '';
    },
    knownSessionIds: () => [],
    async agentPresence() {
      return {};
    },
    async taskWorkspace() {
      log.push(['taskWorkspace']);
      return '/work';
    },
    async clearSession(id, archiveAs) {
      log.push(['clearSession', id, archiveAs]);
      if (world.clearFails || has(world.running, id)) throw new Error('The session is running a turn.');
      const session = world.sessions[id];
      if (session?.turns) {
        world.sessions[archiveAs] = structuredClone(session);
        session.turns = false;
      }
    },
    mintArchiveId() {
      archiveCount += 1;
      return `sess_archive_${archiveCount}`;
    },
  };
  return { deps, log };
}

const unwrap = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const homes = [];
for (let n = 0; n < 80; n += 1) {
  const world = freshWorld();
  const initial = structuredClone(world);
  const rig = homeRig(world);
  const home = createAgentHomeSessions(rig.deps);
  const ops = [];
  for (let step = 0; step < 7; step += 1) {
    if (step > 0 && chance(0.5)) {
      const patch = patchOf(world);
      Object.assign(world, structuredClone(patch));
      ops.push({ op: 'world', patch });
      continue;
    }
    const agent = pick(AGENT_IDS);
    const op = chance(0.55) ? 'open' : 'reset';
    rig.log.length = 0;
    const outcome = await unwrap(() => (op === 'open' ? home.open(agent) : home.reset(agent)));
    // A real caller's next request arrives in a later turn of the event loop, after the failed flight's
    // cleanup microtasks have dropped it from the single-flight map.
    await new Promise((resolve) => setImmediate(resolve));
    ops.push({ op, agent, ...outcome, log: structuredClone(rig.log) });
  }
  homes.push({ world: initial, ops });
}

// --- flights: calls of one agent in flight together ---------------------------------------------------
// `hold` parks the first dependency call of every resolution until `release`; `start` begins a call
// without waiting for it; `settle` waits for every started call and records each outcome (in start
// order) with the dependency calls made since the last settle.
const SESSION_ADA = { route: ROUTES.ada, turns: true };
const flightWorld = (over = {}) => ({
  agents: ['ada'],
  mixyRoute: null,
  mixyCreated: false,
  sessions: {},
  archived: [],
  retired: [],
  running: [],
  setRouteFails: false,
  clearFails: false,
  catalogFailures: 0,
  ...over,
});
// `then = [call, kind]` makes that call in the continuation of the started one, the moment it settles,
// with nothing in between (a caller that awaits a reset and opens at once).
const start = (call, kind, then = null) => ({ op: 'start', call, kind, agent: 'ada', ...(then ? { then: { call: then[0], kind: then[1], agent: 'ada' } } : {}) });
// `abandon` drops the caller of a started call: nothing waits for its answer any more.
const abandon = (call) => ({ op: 'abandon', call });
const HOLD = { op: 'hold' };
const RELEASE = { op: 'release' };
const SETTLE = { op: 'settle' };
// `drain` lets every flight run to its end with nobody waiting, and records the dependency calls made.
const DRAIN = { op: 'drain' };
const FLIGHT_CASES = [
  { name: 'concurrent opens of a new home share one create; a later open starts a new flight', world: flightWorld(), ops: [HOLD, start('a', 'open'), start('b', 'open'), start('c', 'open'), RELEASE, SETTLE, start('d', 'open'), SETTLE] },
  { name: 'concurrent opens share a failure; the next open retries', world: flightWorld({ catalogFailures: 1 }), ops: [HOLD, start('a', 'open'), start('b', 'open'), RELEASE, SETTLE, start('c', 'open'), SETTLE] },
  { name: 'concurrent opens of an agent that is not there share the refusal', world: flightWorld({ agents: [] }), ops: [HOLD, start('a', 'open'), start('b', 'open'), RELEASE, SETTLE, { op: 'world', patch: { agents: ['ada'] } }, start('c', 'open'), SETTLE] },
  { name: 'a reset queues behind an open', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('open', 'open'), start('reset', 'reset'), RELEASE, SETTLE] },
  { name: 'a reset runs after the failed open it queued behind', world: flightWorld({ catalogFailures: 1, sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('open', 'open'), start('reset', 'reset'), RELEASE, SETTLE] },
  { name: 'an open joins the reset in flight', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('reset', 'reset'), start('open', 'open'), RELEASE, SETTLE] },
  { name: 'an open shares the failure of the reset it joined; later calls start new flights', world: flightWorld({ clearFails: true, sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('reset', 'reset'), start('open', 'open'), RELEASE, SETTLE, { op: 'world', patch: { clearFails: false } }, start('again', 'open'), SETTLE, start('last', 'reset'), SETTLE] },
  { name: 'resets queue one behind another and an open joins the last', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('first', 'reset'), start('second', 'reset'), start('open', 'open'), RELEASE, SETTLE] },
  { name: 'a reset runs on after the reset before it failed', world: flightWorld({ clearFails: true, sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('first', 'reset'), start('second', 'reset'), RELEASE, SETTLE] },
  { name: 'an open after a reset after an open joins the reset', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('first', 'open'), start('reset', 'reset'), start('second', 'open'), RELEASE, SETTLE] },
  // The reset's flight leaves the map a few turns after its caller resumes; an open's before.
  { name: 'an open made the moment an awaited reset returns joins that reset', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('reset', 'reset', ['now', 'open']), RELEASE, SETTLE, start('later', 'open'), SETTLE] },
  { name: 'an open made the moment a failed reset rejects joins its failure', world: flightWorld({ clearFails: true, sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('reset', 'reset', ['now', 'open']), RELEASE, SETTLE, { op: 'world', patch: { clearFails: false } }, start('later', 'open'), SETTLE] },
  { name: 'an open that joined a reset and opens again at once joins it again', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('reset', 'reset'), start('open', 'open', ['again', 'open']), RELEASE, SETTLE] },
  { name: 'a call made the moment an awaited open returns starts its own flight', world: flightWorld(), ops: [HOLD, start('first', 'open', ['second', 'open']), RELEASE, SETTLE] },
  { name: 'a reset made the moment an awaited open returns runs its own reset', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('open', 'open', ['reset', 'reset']), RELEASE, SETTLE] },
  // Promises run whether or not anything awaits them.
  { name: 'a flight whose caller is gone still completes and leaves the map', world: flightWorld(), ops: [HOLD, start('gone', 'open'), abandon('gone'), RELEASE, DRAIN, start('later', 'open'), SETTLE] },
  { name: 'a flight with every caller gone but one still answers that one', world: flightWorld(), ops: [HOLD, start('gone', 'open'), start('stays', 'open'), abandon('gone'), RELEASE, SETTLE] },
  { name: 'a failed flight with every caller gone leaves the map and the next open retries', world: flightWorld({ catalogFailures: 1 }), ops: [HOLD, start('gone', 'open'), abandon('gone'), RELEASE, DRAIN, start('later', 'open'), SETTLE] },
  { name: 'a reset queued behind an open still runs when both callers are gone', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('open', 'open'), start('reset', 'reset'), abandon('open'), abandon('reset'), RELEASE, DRAIN, start('later', 'open'), SETTLE] },
  { name: 'resets whose callers are all gone run one behind another and leave the map', world: flightWorld({ sessions: { sess_home_ada: SESSION_ADA } }), ops: [HOLD, start('first', 'reset'), start('second', 'reset'), abandon('first'), abandon('second'), RELEASE, DRAIN, start('later', 'open'), SETTLE] },
];
const flights = [];
for (const flight of FLIGHT_CASES) {
  const world = structuredClone(flight.world);
  const gate = { promise: Promise.resolve(), open: () => {} };
  const rig = homeRig(world, gate);
  const home = createAgentHomeSessions(rig.deps);
  const pending = [];
  const ops = [];
  // A call is made, and its answer noted by the very first reaction on its promise, so that the call
  // `then` names is made in the same turn the first one settles.
  const call = (op) => {
    const record = { call: op.call, outcome: null, followed: null, gone: false };
    const note = (outcome) => {
      record.outcome = outcome;
      if (op.then) record.followed = call(op.then);
    };
    const promise = op.kind === 'open' ? home.open(op.agent) : home.reset(op.agent);
    record.done = promise.then(
      (result) => note({ result }),
      (error) => note({ error: error instanceof Error ? error.message : String(error) })
    );
    return record;
  };
  const answered = async (record) => {
    await record.done;
    return [{ call: record.call, ...record.outcome }, ...(record.followed ? await answered(record.followed) : [])];
  };
  // The next request arrives in a later turn of the event loop, after every flight's cleanup.
  const barrier = () => new Promise((resolve) => setImmediate(resolve));
  for (const op of flight.ops) {
    if (op.op === 'hold') gate.promise = new Promise((resolve) => (gate.open = resolve));
    else if (op.op === 'release') gate.open();
    else if (op.op === 'world') Object.assign(world, structuredClone(op.patch));
    else if (op.op === 'start') pending.push(call(op));
    else if (op.op === 'abandon') pending.find((record) => record.call === op.call).gone = true;
    else {
      const calls = [];
      for (const record of pending) if (!record.gone) calls.push(...(await answered(record)));
      pending.length = 0;
      await barrier();
      ops.push({ op: op.op, ...(op.op === 'settle' ? { calls } : {}), log: structuredClone(rig.log) });
      rig.log.length = 0;
      continue;
    }
    ops.push(op);
  }
  flights.push({ name: flight.name, world: flight.world, ops });
}

// --- agent memory ----------------------------------------------------------------------------------
const entry = (id, revision, summary) => ({ id, index_revision: revision, summary });
const page = (entries, nextOffset) => JSON.stringify({ entries, nextOffset });
const LIST_CASES = [
  { agent: 'gh', replies: [page([entry(1, 'r1', 'Prefers tabs'), entry(2, 'r1', 'Line one\nLine two 한글')], null)] },
  { agent: 'gh', replies: [page([entry(1, 'r1', 'a')], 100), page([entry(2, 'r1', 'b')], 200), page([], null)] },
  { agent: 'gh', replies: [page([entry(1, 'r1', 'a')], 0)] },
  { agent: 'gh', replies: [page([entry(1, 'r1', 'a')], 100), page([entry(2, 'r1', 'b')], 50)] },
  { agent: 'gh', replies: [page([entry(null, null, 'Archived')], null)] },
  { agent: 'gh', replies: [JSON.stringify({ entries: [{ id: 3, index_revision: 'r1' }], nextOffset: null })] },
  { agent: 'gh', replies: [JSON.stringify({ nextOffset: null })] },
  { agent: 'gh', replies: ['oops, not json'] },
  { agent: 'gh', replies: [''] },
  { agent: 'gh', replies: ['null'] },
  { agent: 'gh', replies: ['5'] },
  { agent: 'gh', replies: ['{"entries":{},"nextOffset":null}'] },
  { agent: 'gh', replies: ['{"entries":5}'] },
  { agent: 'gh', replies: ['{"entries":true}'] },
  { agent: 'gh', replies: ['{"entries":"ab"}'] },
  { agent: 'gh', replies: ['{"entries":[null]}'] },
  { agent: 'gh', replies: ['{"entries":[7,[1],"x",{"id":"4","index_revision":9,"summary":null}],"nextOffset":"100"}'] },
  { agent: 'gh', replies: [page([{ id: '12', index_revision: 'r', summary: 5 }], 150.5), page([], 200), page([], null)] },
  { agent: 'Bad Id', replies: [] },
  { agent: '', replies: [] },
  { agent: 'a.b', replies: [page([], null)] },
];
const DELETE_CASES = [
  { agent: 'gh', id: 1, revision: 'r1', reply: 'core deleted 1' },
  { agent: 'gh', id: 7, revision: 'r9', reply: 'memory indices changed since the list; list again' },
  { agent: 'gh', id: 2, revision: 'r1', reply: 'core entry 2 not found' },
  { agent: 'gh', id: 2, revision: 'r1', reply: '' },
  { agent: 'gh', id: 0, revision: 'r1', reply: 'core deleted 0' },
  { agent: 'gh', id: -1, revision: 'r1', reply: 'core deleted -1' },
  { agent: 'gh', id: 1.5, revision: 'r1', reply: 'core deleted 1' },
  { agent: 'gh', id: 9007199254740993, revision: 'r1', reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: '', reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: 'x'.repeat(200), reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: 'x'.repeat(201), reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: '한'.repeat(200), reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: '😀'.repeat(101), reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: null, reply: 'core deleted 1' },
  { agent: 'gh', id: 1, revision: 5, reply: 'core deleted 1' },
  { agent: 'Bad Id', id: 1, revision: 'r1', reply: 'core deleted 1' },
];

const memoryList = [];
for (const c of LIST_CASES) {
  const calls = [];
  const replies = [...c.replies];
  const control = async (method, args) => {
    calls.push([method, ...args]);
    return replies.shift();
  };
  memoryList.push({ ...c, ...(await unwrap(() => listAgentMemory(control, c.agent))), calls });
}
const memoryDelete = [];
for (const c of DELETE_CASES) {
  const calls = [];
  const control = async (method, args) => {
    calls.push([method, ...args]);
    return c.reply;
  };
  const outcome = await unwrap(async () => {
    await deleteAgentMemory(control, c.agent, { id: c.id, indexRevision: c.revision });
    return null;
  });
  memoryDelete.push({ ...c, entryId: String(c.id), ...outcome, calls });
}

// --- agent pool --------------------------------------------------------------------------------------
const TAGS = ['b-worker', 'B-worker', 'a-worker', 'ä-worker', 'z-worker', 'Z-worker', 'worker 10', 'worker 9', ''];
const STARTS = ['2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05Z', '2026-01-02T03:04:06.500Z', '2025-12-31T23:59:59.999Z', '', null, undefined, 'not a date', 1767323045000, '2026-01-02'];
const poolCases = [];
const POOL_NOW = Date.parse('2026-01-02T03:10:00.000Z');
Date.now = () => POOL_NOW;
const poolRoot = mkdtempSync(join(tmpdir(), 'agent-home-pool-'));
for (let n = 0; n < 40; n += 1) {
  const count = 1 + Math.floor(next() * 9);
  const children = [];
  const leads = [];
  for (let i = 0; i < count; i += 1) {
    const row = { sessionId: `sess_${n}_${i}`, tag: pick(TAGS), startedAt: pick(STARTS), agent: 'ada', status: pick(['running', 'idle', 'failed']) };
    if (row.startedAt === undefined) delete row.startedAt;
    (chance(0.3) ? leads : children).push(row);
  }
  // A lead row replaces a child row of the same session id.
  if (children.length && chance(0.4)) leads.push({ ...children[0], tag: pick(TAGS), status: 'lead' });
  // Node's own listing over the two worker indexes as files in a data directory of its own.
  const dir = join(poolRoot, `case${n}`);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  const files = {
    agentIndex: JSON.stringify({ version: 2, workers: children }),
    leadIndex: JSON.stringify({ version: 2, workers: leads }),
    headers: {},
  };
  writeFileSync(join(dir, 'agent-workers.json'), files.agentIndex);
  writeFileSync(join(dir, 'lead-workers.json'), files.leadIndex);
  const running = [...children, ...leads].map((row) => row.sessionId).filter(() => chance(0.4));
  const listed = await rowsMod.listStoredAgentWorkersAsync({ runningSessionIds: () => new Set(running) });
  poolCases.push({ now: POOL_NOW, running, files, rows: JSON.parse(JSON.stringify(listed)) });
}
rmSync(poolRoot, { recursive: true, force: true });

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-home-api-twin.json`,
  `${JSON.stringify({ domain: 'agent-home-api-twin', recorder: 'benchmarks/rust-core/recorders/record-agent-home-api.mjs', routes: ROUTES, catalogExtras: CATALOG_EXTRAS, homes, flights, memoryList, memoryDelete, poolCases }, null, 1)}\n`
);
// `--ref <commit>` names the commit the tree is compared against for the manifest's identity (default HEAD).
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree, args.get('ref'));
console.log(`recorded ${homes.length} home scenarios, ${flights.length} flight scenarios, ${memoryList.length} list, ${memoryDelete.length} delete, ${poolCases.length} pool cases`);
// Node's header cache keeps a timer for its persisted headers.
process.exit(0);
