#!/usr/bin/env node
// Golden twin of the agent home, agent memory and agent pool methods: what Node's real host code
// answers (apps/desktop/src/main/agent-home-sessions.ts createAgentHomeSessions open/reset,
// agent-memory.ts listAgentMemory/deleteAgentMemory, and the pool order of
// session/store-agent-worker-pool.mjs listStoredAgentWorkers) over scripted worlds. A home
// scenario runs open/reset calls against an in-memory session world whose every dependency call
// is logged; the memory cases script the memory runtime's text replies; the pool cases list rows
// through Node's own ordering.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-agent-home-api.mjs --tree <dir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
// A refused route refresh is warned about and never fails an open: the scripted failure is expected.
console.warn = () => {};
const { createAgentHomeSessions } = await importFrom(tree, 'apps/desktop/src/main/agent-home-sessions.ts');
const { listAgentMemory, deleteAgentMemory } = await importFrom(tree, 'apps/desktop/src/main/agent-memory.ts');
const { listStoredAgentWorkers } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-agent-worker-pool.mjs');

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

function homeRig(world) {
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
      log.push(['listAgents']);
      return agentRows(world.agents);
    },
    async mixyRoute() {
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
  const listed = listStoredAgentWorkers({
    now: 0,
    runningSessionIds: new Set(),
    storedAgentWorkerIndexRows: () => children,
    projectChildWorkerRow: (row) => row,
    storedLeadWorkerRows: () => leads,
    projectLeadWorkerRow: (row) => row,
    pruneOrphanChildRows: () => {},
  });
  poolCases.push({ children, leads, order: listed.map((row) => row.sessionId), rows: listed });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-home-api-twin.json`,
  `${JSON.stringify({ domain: 'agent-home-api-twin', recorder: 'benchmarks/rust-core/recorders/record-agent-home-api.mjs', routes: ROUTES, catalogExtras: CATALOG_EXTRAS, homes, memoryList, memoryDelete, poolCases }, null, 1)}\n`
);
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${homes.length} home scenarios, ${memoryList.length} list, ${memoryDelete.length} delete, ${poolCases.length} pool cases`);
