#!/usr/bin/env node
// One bounded exchange of a group room (`apps/desktop/src/main/agent-room-exchange.ts`):
// `runRoomExchangeIn` over members' turns (`speakInRoom`), the supervisor step, the caps, the
// hand-over of calls, and the exchange's end. The real TypeScript is bundled with esbuild (no
// logic changes) and driven with a scripted room host that logs every call and can change the
// exchange (stop, a newer request, a deleted room) at a named call. A request that arrives
// meanwhile runs the next exchange inside the same call, as it does in the app.
//
//   node benchmarks/rust-core/recorders/record-room-exchange.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-exchange/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-exchange-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const outfile = join(sandbox, 'exchange.mjs');
await esbuild.build({
  entryPoints: [join(tree, 'apps/desktop/src/main/agent-room-exchange.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const { runRoomExchangeIn } = await import(pathToFileURL(outfile).href);

const MEMBERS = [
  { id: 'bench', name: 'Bench', route: { provider: 'openai', model: 'gpt-5' }, description: 'tester' },
  { id: 'alpha', name: 'Alpha', route: undefined, description: 'reviewer' },
  { id: 'gh', name: 'Git Hub', route: undefined, description: '' },
];
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const answered = (text) => ({ busy: false, items: [{ kind: 'user', id: 'u', at: 1 }, { kind: 'assistant', id: 'a', text }, { kind: 'turndone', id: 9, at: 5000, status: 'done', finalAssistantId: 'a' }] });
const user = (id, text, extra = {}) => ({ id, kind: 'user', text, at: 1, ...extra });
const speechRow = (id, speaker, text) => ({ id, kind: 'speech', speaker, name: speaker, text, at: 1 });

/** One scripted room host. Speaking members answer from `script.answers[agent]` (a list, the last
 *  repeats; a string is the reply text; `{fail: detail}` a failed turn; `{usage: true}` a usage
 *  limit). `decisions` scripts the supervisor. `hooks` act at the n-th call of a named method. */
function world(script) {
  const calls = [];
  const counts = {};
  let clock = 1000;
  let seq = 0;
  const reads = {};
  const room = {
    name: 'Release room',
    members: script.members ?? ['bench', 'alpha', 'gh'],
    cursors: {},
    shareTools: false,
    maxRounds: script.maxRounds ?? 4,
    maxMessages: script.maxMessages ?? 6,
    running: null,
    owed: script.owed ?? undefined,
  };
  let exists = true;
  let tracked = null;
  const states = [];
  const fire = (name, state) => {
    counts[name] = (counts[name] ?? 0) + 1;
    for (const hook of script.hooks ?? []) {
      if (hook.on !== name || (hook.n ?? 1) !== counts[name]) continue;
      const target = state ?? tracked;
      if (hook.do === 'stop') target.stop = true;
      if (hook.do === 'pending') target.pending = clone(hook.request ?? { to: [], waiting: false });
      if (hook.do === 'deleteRoom') exists = false;
      if (hook.do === 'removeMember') room.members = room.members.filter((id) => id !== hook.member);
    }
  };
  const sessionAgent = (sessionId) => sessionId.replace('sess_', '');
  const turn = {
    roomId: 'room01',
    pollMs: 25,
    now: () => (clock += 1),
    newId: () => `n${(seq += 1)}`,
    room: () => {
      if (!exists && script.throwWhenGone) throw new Error('room gone');
      return room;
    },
    rows: async () => {
      calls.push(['rows']);
      fire('rows');
      return clone(script.rows ?? []);
    },
    post: async (rows) => {
      calls.push(['post', rows]);
      fire('post');
      if (script.postFails) throw new Error(script.postFails);
    },
    republish: () => calls.push(['republish']),
    memberSession: async (member) => {
      calls.push(['memberSession', member.id]);
      fire('memberSession');
      return `sess_${member.id}`;
    },
    switchedOff: async (agentId) => {
      calls.push(['switchedOff', agentId]);
      return (script.switchedOff ?? []).includes(agentId);
    },
    submit: async (sessionId, prompt, options) => {
      calls.push(['submit', sessionId, typeof prompt === 'string' ? prompt.length : 'parts', options ?? null]);
      fire('submit');
      if (script.submitThrows) throw new Error(script.submitThrows);
      return true;
    },
    readSnapshot: async (sessionId) => {
      const agent = sessionAgent(sessionId);
      calls.push(['readSnapshot', sessionId]);
      const list = script.answers?.[agent] ?? ['Fine.'];
      const next = list[Math.min(reads[agent] ?? 0, list.length - 1)];
      reads[agent] = (reads[agent] ?? 0) + 1;
      fire('readSnapshot');
      if (next && next.fail !== undefined) return { busy: false, items: [{ kind: 'turndone', id: 9, at: 5000, status: 'failed', detail: next.fail }] };
      if (next && next.usage) return { busy: false, items: [{ kind: 'turndone', id: 9, at: 5000, status: 'failed', quota: { provider: 'openai', resetAt: 1700000000000 } }] };
      return answered(next);
    },
    abort: async (sessionId) => {
      calls.push(['abort', sessionId]);
    },
    persist: async () => {
      calls.push(['persist']);
      fire('persist');
      counts.persistCalls = (counts.persistCalls ?? 0) + 1;
      if ((script.persistFails ?? []).includes(counts.persistCalls)) throw new Error('disk full');
    },
    sleep: async (ms) => {
      calls.push(['sleep', ms]);
    },
    log: (line) => calls.push(['log', line]),
  };
  const decisionAt = () => {
    const list = script.decisions ?? [{ action: 'finish', scene: 'work' }];
    return list[Math.min(counts.decideTurn - 1, list.length - 1)];
  };
  const host = {
    roomId: 'room01',
    room: turn.room,
    exists: () => exists,
    track: (state) => {
      calls.push(['track']);
      tracked = state;
      states.push(state);
    },
    untrack: (state) => {
      calls.push(['untrack']);
      if (tracked !== state) return false;
      tracked = null;
      return true;
    },
    failRelays: (error) => calls.push(['failRelays', error]),
    rows: turn.rows,
    post: turn.post,
    labels: async () => {
      calls.push(['labels']);
      return new Map(MEMBERS.map((member) => [member.id, { ...member, ...(script.disabled?.includes(member.id) ? { disabled: true } : {}) }]));
    },
    turn,
    decideTurn: async (input) => {
      counts.decideTurn = (counts.decideTurn ?? 0) + 1;
      calls.push(['decideTurn', { roomName: input.roomName, members: input.members, rows: input.rows.map((row) => row.id), turns: input.turns, mustPick: input.mustPick, last: input.last, remaining: input.remaining }]);
      fire('decideTurn');
      const decision = decisionAt();
      if (decision === 'throws') throw new Error('model down');
      return decision;
    },
    persist: turn.persist,
    republish: turn.republish,
    republishCatalog: () => calls.push(['republishCatalog']),
    now: turn.now,
    newId: turn.newId,
    random: () => script.random ?? 0.5,
    log: turn.log,
  };
  return { host, room, calls, states, exists: () => exists };
}

async function scenario(name, script = {}, request = {}, callSpecs = []) {
  const { host, room, calls } = world(script);
  // A request that names nobody is addressed to the whole room (the caller states it, never read off `to`).
  const options = { to: [], waiting: true, only: false, everyone: !(request.to ?? []).length, ...request };
  const covered = callSpecs.map((spec) => {
    const call = { agentId: spec.agentId ?? 'bench', ...spec.call };
    call.onSettled = (detail) => calls.push(['settled', spec.call?.id ?? spec.agentId ?? null, detail]);
    return call;
  });
  options.calls = covered;
  let result = 'ok';
  try {
    await runRoomExchangeIn(host, options);
  } catch (error) {
    result = { threw: error.message };
  }
  await new Promise((resolve) => setImmediate(resolve));
  return {
    name,
    script,
    request,
    callSpecs,
    result,
    calls,
    room: { members: room.members, cursors: room.cursors, running: room.running, owed: room.owed ?? null },
  };
}

const hooks = (...list) => list;
const U1 = [user('r1', 'Ship it?')];
const scenarios = [
  await scenario('the user is answered by the named member and the supervisor finishes', { rows: U1 }, { to: ['bench'] }),
  await scenario('a free exchange: the supervisor picks, then finishes', { rows: U1, decisions: [{ action: 'speak', member: 'alpha', instruction: 'check it', scene: 'work' }, { action: 'finish', scene: 'work' }] }),
  await scenario('named members speak first, the supervisor adds one', { rows: U1, decisions: [{ action: 'speak', member: 'gh', scene: 'casual' }, { action: 'finish' }] }, { to: ['bench', 'alpha'] }),
  await scenario('a whole-room request after the named members', { rows: U1, decisions: [{ action: 'finish' }] }, { to: ['bench'], everyone: true }),
  await scenario('no model to moderate: everyone speaks once', { rows: U1, decisions: [{ action: 'unmanaged' }] }),
  await scenario('a supervisor that fails falls back', { rows: U1, decisions: ['throws'] }),
  await scenario('a supervisor with no usable answer falls back', { rows: U1, decisions: [null] }),
  await scenario('not waiting: the exchange may end with nobody speaking', { rows: [speechRow('r1', 'alpha', 'done')], decisions: [{ action: 'finish' }] }, { waiting: false }),
  await scenario('the message cap posts a cap row and owes the rest', { rows: U1, maxMessages: 2, decisions: [{ action: 'speak', member: 'alpha' }, { action: 'speak', member: 'gh' }, { action: 'speak', member: 'bench' }] }),
  await scenario('the round cap', { rows: U1, maxRounds: 1, decisions: [{ action: 'speak', member: 'alpha' }, { action: 'speak', member: 'gh' }, { action: 'speak', member: 'bench' }] }),
  await scenario('a usage limit posts one notice instead of a failure', { rows: U1, answers: { bench: [{ usage: true }] } }, { to: ['bench'] }),
  await scenario('a failed turn is posted as one failed pass', { rows: U1, answers: { bench: [{ fail: 'overloaded' }], alpha: [{ fail: 'overloaded' }], gh: [{ fail: 'boom' }] } }),
  await scenario('a stop posts the stopped row', { rows: U1, hooks: hooks({ on: 'submit', do: 'stop' }) }, { to: ['bench'] }),
  await scenario('a newer request runs the next exchange straight away', { rows: U1, hooks: hooks({ on: 'submit', do: 'pending', request: { to: ['alpha'], waiting: false, only: true } }), decisions: [{ action: 'finish' }] }, { to: ['bench'] }),
  await scenario('a newer request keeps the room busy across the hand-off', { rows: U1, hooks: hooks({ on: 'readSnapshot', do: 'pending', request: { to: ['gh'], waiting: true } }) }, { to: ['alpha'] }),
  await scenario('a stop while the room is saved at the end releases it', { rows: U1, hooks: hooks({ on: 'post', do: 'pending', request: { to: ['alpha'], waiting: false } }, { on: 'persist', n: 3, do: 'stop' }) }, { to: ['bench'] }),
  await scenario('the room deleted at the end is not chained', { rows: U1, hooks: hooks({ on: 'readSnapshot', do: 'pending', request: { to: ['alpha'], waiting: false } }, { on: 'readSnapshot', do: 'deleteRoom' }) }, { to: ['bench'] }),
  await scenario('a save that fails at the start abandons the exchange', { rows: U1, persistFails: [1] }, { to: ['bench'] }, [{ call: { id: 'c1' }, agentId: 'bench' }]),
  await scenario('a save that fails at the end abandons it and fails the held calls', { rows: U1, persistFails: [3] }, { to: ['bench'] }, [{ call: { id: 'c1' }, agentId: 'alpha' }]),
  await scenario('a post that fails is logged and the exchange ends', { rows: U1, postFails: 'disk full' }, { to: ['bench'] }),
  await scenario('a speak that throws ends the exchange', { rows: U1, submitThrows: 'daemon down' }, { to: ['bench'] }),
  await scenario('a turn that throws ends the exchange: no failures, no notice, calls handed on', { rows: U1, throwWhenGone: true, hooks: hooks({ on: 'post', do: 'deleteRoom' }) }, { to: ['bench', 'alpha'], only: true }, [{ call: { id: 'c1' }, agentId: 'gh' }]),
  await scenario('a switched-off bot never speaks', { rows: U1, disabled: ['alpha'], decisions: [{ action: 'speak', member: 'alpha' }, { action: 'finish' }] }),
  await scenario('calls ride the member turn and end done', { rows: U1 }, { to: ['bench'], only: true }, [{ call: { id: 'c1', relay: 'task output' }, agentId: 'bench' }]),
  await scenario('a call no turn took is cancelled when no exchange follows', { rows: U1, decisions: [{ action: 'finish' }] }, { to: ['bench'], only: true }, [{ call: { id: 'c1' }, agentId: 'bench' }, { call: { id: 'c2' }, agentId: 'gh' }]),
  await scenario('a call no turn took is handed to the next exchange', { rows: U1, hooks: hooks({ on: 'submit', do: 'pending', request: { to: ['alpha'], waiting: false } }) }, { to: ['bench'], only: true }, [{ call: { id: 'c1' }, agentId: 'gh' }]),
  await scenario('a stopped exchange cancels its calls', { rows: U1, hooks: hooks({ on: 'submit', do: 'stop' }) }, { to: ['bench'], only: true }, [{ call: { id: 'c1' }, agentId: 'gh' }]),
  await scenario('the budget of a free exchange is drawn', { rows: U1, random: 0.99, decisions: [{ action: 'speak', member: 'alpha' }, { action: 'finish' }] }),
];

const finalOut = join(FIXTURES_ROOT, 'room-exchange');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 desktop agent-room-exchange.ts runRoomExchangeIn does with a scripted room host; a newer request chains inside the same call; `now` counts up from 1000, ids are n1, n2, ...',
  scenarios,
});
writeSetManifest(out, {
  set: 'room-exchange',
  recorder: 'benchmarks/rust-core/recorders/record-room-exchange.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-exchange.mjs --tree <tree>',
  extra: { scenarios: scenarios.length },
});
commitStage(out, finalOut);
console.log(`scenarios=${scenarios.length}`);
