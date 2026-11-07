#!/usr/bin/env node
// Golden twin of what Node's desktop host does around the agent definition calls: the home thread retire / restore /
// reconcile of apps/desktop/src/main/agent-home-sessions.ts, the greetings and the Mixy status decision of
// apps/desktop/src/main/mixy-first.ts, and the greeting text of apps/desktop/src/shared/agent-greeting.ts, run over
// scripted worlds whose every dependency call is logged.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-agent-lifecycle.mjs --tree <dir>
import { writeFileSync } from 'node:fs';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
console.warn = () => {};
const { createAgentHomeSessions } = await importFrom(tree, 'apps/desktop/src/main/agent-home-sessions.ts');
const { createAgentGreetings, resolveMixyCreated } = await importFrom(tree, 'apps/desktop/src/main/mixy-first.ts');
const { agentGreetingKickoff } = await importFrom(tree, 'apps/desktop/src/shared/agent-greeting.ts');
const { agentHomeSessionId } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/agent-home.mjs');

let seed = 0x51a7c3;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];
const unwrap = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
const homeOf = (id) => agentHomeSessionId(id);

// --- home lifecycle: retire / reconcile / restore ---------------------------------------------------
const AGENTS = ['ada', 'bob', 'cy', 'dee', 'lead', 'Bad Id', 'a.b'];
const NAMES = { ada: 'Ada', bob: '', cy: 'Cy the bot', dee: 'Dee', 'a.b': 'Dotted' };
const PRESENCE = ['present', 'deleted', 'unknown', undefined];

function freshWorld() {
  const sessions = AGENTS.filter(() => chance(0.6)).map(homeOf).filter(Boolean);
  return {
    sessions,
    archived: sessions.filter(() => chance(0.3)),
    retired: sessions.filter(() => chance(0.4)),
    presence: Object.fromEntries(AGENTS.map((id) => [id, pick(PRESENCE)]).filter(([, state]) => state !== undefined)),
    failPresence: chance(0.1),
  };
}

function lifecycleRig(world) {
  const log = [];
  const set = (list, id, on) => {
    const at = list.indexOf(id);
    if (on && at < 0) list.push(id);
    if (!on && at >= 0) list.splice(at, 1);
  };
  const deps = {
    async listAgents() {
      return [];
    },
    async mixyCreated() {
      return true;
    },
    async readSession(id) {
      return { id };
    },
    async createSession() {},
    async setRoute() {},
    async setArchived(id, archived) {
      log.push(['setArchived', id, archived]);
      set(world.archived, id, archived);
    },
    async isRetired(id) {
      log.push(['isRetired', id]);
      return world.retired.includes(id);
    },
    async setRetired(id, retired) {
      log.push(['setRetired', id, retired]);
      set(world.retired, id, retired);
    },
    async nameRetired(id, name) {
      log.push(['nameRetired', id, name]);
    },
    async archivedAgentName(id) {
      log.push(['archivedAgentName', id]);
      return NAMES[id] ?? '';
    },
    knownSessionIds: () => [...world.sessions],
    async agentPresence(ids) {
      log.push(['agentPresence', ids]);
      if (world.failPresence) throw new Error('presence unreadable');
      return structuredClone(world.presence);
    },
    async taskWorkspace() {
      return '/work';
    },
    async forgetRoomMember(id) {
      log.push(['forgetRoomMember', id]);
    },
    async clearSession() {},
    mintArchiveId: () => 'sess_archive_1',
  };
  return { deps, log };
}

const lifecycle = [];
for (let n = 0; n < 40; n += 1) {
  const world = freshWorld();
  const initial = structuredClone(world);
  const rig = lifecycleRig(world);
  const home = createAgentHomeSessions(rig.deps);
  const ops = [];
  for (let step = 0; step < 6; step += 1) {
    if (step > 0 && chance(0.4)) {
      const patch = { presence: Object.fromEntries(AGENTS.map((id) => [id, pick(PRESENCE)]).filter(([, state]) => state !== undefined)), failPresence: chance(0.1) };
      Object.assign(world, structuredClone(patch));
      ops.push({ op: 'world', patch });
      continue;
    }
    const kind = pick(['retire', 'retire', 'reconcile', 'restore']);
    rig.log.length = 0;
    if (kind === 'retire') {
      const ids = AGENTS.filter(() => chance(0.4)).concat(chance(0.2) ? ['ada'] : []);
      ops.push({ op: 'retire', ids, ...(await unwrap(() => home.retire(ids))), log: structuredClone(rig.log) });
    } else if (kind === 'reconcile') {
      ops.push({ op: 'reconcile', ...(await unwrap(() => home.reconcile())), log: structuredClone(rig.log) });
    } else {
      const agent = pick(AGENTS);
      ops.push({ op: 'restore', agent, ...(await unwrap(() => home.restore(agent))), log: structuredClone(rig.log) });
    }
  }
  lifecycle.push({ world: initial, ops });
}

// --- greetings --------------------------------------------------------------------------------------
const ROUTE_LEAFS = [
  { provider: 'openai', model: 'gpt-x' },
  [{ provider: 'anthropic', model: 'opus' }],
  { provider: 'openai' },
  null,
  [],
];
const row = (id) => ({
  id,
  custom: chance(0.85),
  kind: chance(0.85) ? 'bot' : 'agent',
  disabled: chance(0.15),
  label: chance(0.7) ? `Label ${id}` : '',
  description: chance(0.6) ? `Does ${id}\nthings` : '',
  route: pick(ROUTE_LEAFS),
});
const ROWS = ['ada', 'bob', 'cy', 'dee', 'eve', 'lead', 'fay'];
const catalog = () => [...ROWS.filter(() => chance(0.7)).map(row), ...(chance(0.2) ? [null, { id: 7, custom: true }] : [])];

const greetingRuns = [];
for (let n = 0; n < 40; n += 1) {
  let stored = chance(0.3) ? null : ROWS.filter(() => chance(0.4));
  let current = catalog();
  const initial = structuredClone({ stored, catalog: current });
  const log = [];
  let failGreet = new Set();
  const deps = {
    async read() {
      log.push(['read']);
      return stored ? [...stored] : null;
    },
    async write(ids) {
      log.push(['write', [...ids]]);
      stored = [...ids];
    },
    async listAgents() {
      log.push(['listAgents']);
      return structuredClone(current);
    },
    async greet(agent) {
      log.push(['greet', agent]);
      if (failGreet.has(agent.id)) throw new Error('home thread unavailable');
    },
  };
  const greeter = createAgentGreetings(deps);
  const ops = [];
  for (let step = 0; step < 5; step += 1) {
    log.length = 0;
    if (chance(0.3)) {
      current = catalog();
      failGreet = new Set(ROWS.filter(() => chance(0.2)));
      ops.push({ op: 'world', catalog: structuredClone(current), fail: [...failGreet] });
      continue;
    }
    if (chance(0.3)) {
      const agent = pick(ROWS);
      ops.push({ op: 'noteCreated', agent, ...(await unwrap(() => greeter.noteCreated(agent))), log: structuredClone(log) });
    } else {
      const agents = chance(0.2) ? null : structuredClone(current);
      ops.push({ op: 'reconcile', agents, ...(await unwrap(() => greeter.reconcile(agents))), log: structuredClone(log) });
    }
  }
  greetingRuns.push({ initial, ops });
}

// --- greeting text ----------------------------------------------------------------------------------
const kickoff = [
  ['Ada', 'Writes the weekly report'],
  ['Ada "the Bot"', 'Line one\r\nLine two\n\nLine three'],
  ['  Spaced\nName  ', ''],
  ['한글 봇', '한국어로 보고서를 씁니다'],
].map(([name, description]) => ({ name, description, text: agentGreetingKickoff({ name, description }) }));

// --- the status decision ----------------------------------------------------------------------------
const statusRuns = [];
for (const status of [null, {}, { exists: null }, { exists: 'yes' }]) {
  for (const sessions of [[], [homeOf('lead')]]) {
    const calls = [];
    const outcome = await unwrap(() =>
      resolveMixyCreated({ status, sessionIds: async () => sessions, setCreated: async (value) => void calls.push(value) })
    );
    statusRuns.push({ status, sessions, ...outcome, setCreated: calls });
  }
}
for (const created of [true, false, null, undefined, 'x']) {
  for (const exists of [true, false]) {
    for (const sessions of [[], [homeOf('lead')], ['sess_other']]) {
      const calls = [];
      const status = created === undefined ? { exists } : { created, exists };
      const outcome = await unwrap(() =>
        resolveMixyCreated({ status, sessionIds: async () => sessions, setCreated: async (value) => void calls.push(value) })
      );
      statusRuns.push({ status, sessions, ...outcome, setCreated: calls });
    }
  }
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-lifecycle-twin.json`,
  `${JSON.stringify({ domain: 'agent-lifecycle-twin', recorder: 'benchmarks/rust-core/recorders/record-agent-lifecycle.mjs', lifecycle, greetings: greetingRuns, kickoff, statusRuns }, null, 1)}\n`
);
console.log(`recorded ${lifecycle.length} lifecycle, ${greetingRuns.length} greeting scenarios, ${kickoff.length} kickoffs, ${statusRuns.length} status runs`);
