#!/usr/bin/env node
// A member's whole turn in a group room (`apps/desktop/src/main/agent-room-turn.ts`): `speakInRoom`
// (the calls it answers, how each ends) over `memberTurn` (the rows handed, the session, the wait,
// the post) and `combinedCall`. The real TypeScript is bundled with esbuild (the private helpers get
// an export line appended to a copy of the source; no logic changes) and driven with a scripted
// host that logs every call and can change the exchange's state (stop, a newer message, a removed
// member) at a named call.
//
//   node benchmarks/rust-core/recorders/record-room-member-turn.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-member-turn/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-member-turn-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'turn.mjs');
await esbuild.build({
  stdin: {
    contents: `${readFileSync(join(main, 'agent-room-turn.ts'), 'utf8')}\nexport { combinedCall };\n`,
    sourcefile: join(main, 'agent-room-turn.ts'),
    resolveDir: main,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const turn = await import(pathToFileURL(outfile).href);

const MEMBERS = [
  { id: 'bench', name: 'Bench', route: { provider: 'openai', model: 'gpt-5' }, description: '' },
  { id: 'alpha', name: 'Alpha', route: undefined, description: '' },
  { id: 'gh', name: 'Git Hub', route: undefined, description: '' },
];
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const assistant = (id, text) => ({ kind: 'assistant', id, text });
const done = (id, at, extra = {}) => ({ kind: 'turndone', id, at, status: 'done', ...extra });
const answered = (text = 'Hello there.') => ({ busy: false, items: [{ kind: 'user', id: 'u', at: 1 }, assistant('a', text), done(9, 2000, { finalAssistantId: 'a' })] });
const busy = () => ({ busy: true, items: [] });
const user = (id, text, extra = {}) => ({ id, kind: 'user', text, at: 1, ...extra });
const speechRow = (id, speaker, text) => ({ id, kind: 'speech', speaker, name: speaker, text, at: 1 });

/** One scripted host bound to one room; `script.hooks` change the exchange at a named call. */
function world(script) {
  const calls = [];
  const counts = {};
  let clock = 1000;
  let seq = 0;
  let reads = 0;
  const room = {
    name: 'Release room',
    members: script.members ?? ['bench', 'alpha', 'gh'],
    cursors: clone(script.cursors) ?? {},
    ...(script.seen ? { seen: clone(script.seen) } : {}),
    shareTools: script.shareTools === true,
  };
  const state = {
    stop: false,
    speaking: '',
    speakingName: '',
    typingId: '',
    memberSession: '',
    approval: null,
    pending: null,
    calls: [],
    waiting: script.waiting ?? true,
    failures: clone(script.failures) ?? [],
  };
  const fire = (name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    for (const hook of script.hooks ?? []) {
      if (hook.on !== name || (hook.n ?? 1) !== counts[name]) continue;
      if (hook.do === 'stop') state.stop = true;
      if (hook.do === 'pending') state.pending = { to: [] };
      if (hook.do === 'remove') room.members = room.members.filter((id) => id !== 'bench');
    }
  };
  const host = {
    roomId: 'room01',
    pollMs: 25,
    now: () => (clock += 1),
    newId: () => `n${(seq += 1)}`,
    room: () => {
      if (script.roomThrows) throw new Error(script.roomThrows);
      return room;
    },
    rows: async () => {
      calls.push(['rows']);
      fire('rows');
      return clone(script.rows ?? []);
    },
    post: async (rows) => {
      calls.push(['post', rows]);
      if (script.postFails) throw new Error(script.postFails);
    },
    republish: () => calls.push(['republish']),
    memberSession: async (member) => {
      calls.push(['memberSession', member.id]);
      fire('memberSession');
      if (script.sessionThrows) throw new Error(script.sessionThrows);
      return script.session ?? 'sess1';
    },
    switchedOff: async (agentId) => {
      calls.push(['switchedOff', agentId]);
      fire('switchedOff');
      const list = script.switchedOff ?? [false];
      const value = list[Math.min((counts.switchedOff ?? 1) - 1, list.length - 1)];
      if (value === 'throw') throw new Error('switch check failed');
      return value;
    },
    submit: async (sessionId, prompt, options) => {
      calls.push(['submit', sessionId, prompt, options ?? null]);
      fire('submit');
      if (script.submitThrows) throw new Error(script.submitThrows);
      return script.submit ?? true;
    },
    readSnapshot: async (sessionId) => {
      calls.push(['readSnapshot', sessionId]);
      const list = script.snapshots ?? [answered()];
      const next = list[Math.min(reads, list.length - 1)];
      reads += 1;
      fire('readSnapshot');
      if (next && next.throw) throw new Error(next.throw);
      return next ?? null;
    },
    abort: async (sessionId) => {
      calls.push(['abort', sessionId]);
      if (script.abortRejects) throw new Error('abort failed');
    },
    persist: async () => {
      calls.push(['persist']);
      if (script.persistRejects) throw new Error('persist boom');
    },
    sleep: async (ms) => {
      calls.push(['sleep', ms]);
    },
    log: (line) => calls.push(['log', line]),
  };
  return { host, state, room, calls };
}

const labelsOf = (script) => new Map((script.labelled === false ? [] : MEMBERS).map((member) => [member.id, { ...member }]));

/** The calls a scenario answers: ids, hops, askers, relays, and what each one's watch is told. */
function callsOf(specs, log) {
  return specs.map((spec) => {
    const call = { agentId: 'bench', ...spec.call };
    call.onSettled = (detail) => log.push(['settled', spec.call.id ?? null, detail]);
    if (spec.follow) {
      call.follow = async (id) => {
        log.push(['follow', spec.call.id ?? null, id]);
        if (spec.follow === 'throws') throw new Error('record failed');
      };
    }
    return call;
  });
}

async function scenario(name, script = {}, turnInput = {}, callSpecs = []) {
  const { host, state, room, calls } = world(script);
  const log = calls;
  const turnArg = { addressed: [], instruction: '', mentionedBy: '', scene: 'work', ...turnInput };
  const covered = callsOf(callSpecs, log);
  let answer;
  try {
    answer = await turn.speakInRoom(host, state, labelsOf(script), 'bench', turnArg, covered);
  } catch (error) {
    answer = { threw: error.message };
  }
  // Late log lines of a rejected background save land after the turn.
  await new Promise((resolve) => setImmediate(resolve));
  return {
    name,
    script,
    turn: turnArg,
    callSpecs,
    answer,
    calls,
    state: { speaking: state.speaking, speakingName: state.speakingName, typingId: state.typingId, memberSession: state.memberSession, approval: state.approval, waiting: state.waiting, failures: state.failures },
    room: { members: room.members, cursors: room.cursors, seen: room.seen ?? null, lastSpeaker: room.lastSpeaker ?? null, lastAt: room.lastAt ?? null },
    flags: covered.map((call) => ({ used: call.used ?? null, followed: call.followed ?? null })),
  };
}

const hooks = (...list) => list;
const U1 = [user('r1', 'Ship it?')];
const scenarios = [
  await scenario('a user waiting gets the member answer', { rows: U1, snapshots: [busy(), answered('Yes, ship it.')] }),
  await scenario('the answer mentions a peer', { rows: U1, snapshots: [answered('Ask @Alpha about it.')] }),
  await scenario('a first turn sees the recent rows, a later one only the new ones', { rows: [user('r1', 'old'), speechRow('r2', 'alpha', 'reply'), user('r3', 'new')], cursors: { bench: 'r1' } }),
  await scenario('rows it was already handed come back marked seen', { rows: [user('r1', 'q'), speechRow('r2', 'alpha', 'a'), speechRow('r3', 'gh', 'b')], cursors: { bench: 'gone' }, seen: { bench: 'r2' }, waiting: false }, { addressed: ['bench'] }),
  await scenario('a waiting user keeps their newest message in view', { rows: [user('r1', 'q'), speechRow('r2', 'alpha', 'a')], cursors: { bench: 'r2' } }),
  await scenario('nothing new and nobody asking is a pass with nothing posted', { rows: [speechRow('r1', 'bench', 'mine')], waiting: false }),
  await scenario('an @mention alone calls the member', { rows: [speechRow('r1', 'alpha', 'hi @Bench')], waiting: false }, { mentionedBy: 'alpha' }),
  await scenario('the moderator note calls the member', { rows: [speechRow('r1', 'alpha', 'x')], waiting: false }, { instruction: ' look at it ' }),
  await scenario('a casual scene', { rows: U1 }, { scene: 'casual' }),
  await scenario('a pass reply posts a pass row', { rows: [speechRow('r1', 'alpha', 'x')], waiting: false, snapshots: [answered('(pass)')] }, { addressed: ['bench'] }),
  await scenario('a waiting user turns a trailing pass into the words before it', { rows: U1, snapshots: [answered('Fine by me. (pass)')] }),
  await scenario('a reaction alone is a pass with nothing posted', { rows: U1, snapshots: [{ busy: false, items: [done(9, 2000, { reacted: true })] }] }),
  await scenario('a finished turn without text passes', { rows: [speechRow('r1', 'alpha', 'x')], waiting: false, snapshots: [{ busy: false, items: [user('u', 'x'), done(9, 2000)] }] }, { addressed: ['bench'] }),
  await scenario('a failed turn is held as a failure', { rows: U1, snapshots: [{ busy: false, items: [done(9, 2000, { status: 'failed', detail: 'model overloaded' })] }] }),
  await scenario('a failed turn with no detail', { rows: U1, snapshots: [{ busy: false, items: [done(9, 2000, { status: 'failed' })] }] }),
  await scenario('a usage limit stops the exchange instead of failing', { rows: U1, snapshots: [{ busy: false, items: [done(9, 2000, { status: 'failed', quota: { provider: 'openai', resetAt: 1700000000000 } })] }] }),
  await scenario('a cancelled turn fails', { rows: U1, snapshots: [{ busy: false, items: [done(9, 2000, { status: 'cancelled' })] }] }),
  await scenario('held failures are posted before the next speech', { rows: U1, failures: [{ id: 'alpha', name: 'Alpha', reason: 'boom' }] }),
  await scenario('tools are shared when the room shares them', { rows: U1, shareTools: true, snapshots: [{ busy: false, items: [user('u', 'x'), { kind: 'tool', name: 'shell', result: 'ok', at: 1600 }, assistant('a', 'done'), done(9, 2000, { finalAssistantId: 'a' })] }] }),
  await scenario('a submit the daemon refuses fails the turn', { rows: U1, submit: false }),
  await scenario('a submit that throws fails the turn', { rows: U1, submitThrows: 'daemon down' }),
  await scenario('a session that cannot be made fails the turn', { rows: U1, sessionThrows: 'no session' }),
  await scenario('six failed reads fail the turn', { rows: U1, snapshots: Array.from({ length: 6 }, (_, i) => ({ throw: `e${i}` })) }),
  await scenario('a save that fails is logged', { rows: U1, persistRejects: true }),
  await scenario('an abort that fails is ignored', { rows: U1, abortRejects: true, hooks: hooks({ on: 'submit', do: 'stop' }) }),
  await scenario('a member that is not in the room gets no turn', { rows: U1, members: ['alpha', 'gh'], cursors: { bench: 'r0' }, seen: { bench: 'r0' } }),
  await scenario('a bot switched off gets no turn', { rows: U1, switchedOff: [true] }),
  await scenario('a bot switched off while its session was made', { rows: U1, switchedOff: [false, true], cursors: { bench: 'r0' } }),
  await scenario('a switch check that throws before the turn', { rows: U1, switchedOff: ['throw'] }),
  await scenario('a room that no longer exists', { rows: U1, roomThrows: 'room gone' }),
  await scenario('removed while its session was made', { rows: U1, cursors: { bench: 'r0' }, hooks: hooks({ on: 'memberSession', do: 'remove' }) }),
  await scenario('removed during the wait aborts its turn', { rows: U1, snapshots: [busy(), busy(), answered()], hooks: hooks({ on: 'readSnapshot', do: 'remove' }) }),
  await scenario('a stop while the session was made', { rows: U1, cursors: { bench: 'r0' }, hooks: hooks({ on: 'memberSession', do: 'stop' }) }),
  await scenario('a stop that lands at the submit', { rows: U1, hooks: hooks({ on: 'submit', do: 'stop' }) }),
  await scenario('a stop during the wait', { rows: U1, snapshots: [busy(), busy(), answered()], hooks: hooks({ on: 'readSnapshot', n: 2, do: 'stop' }) }),
  await scenario('a newer message while the session was made restores the cursor', { rows: U1, cursors: { bench: 'r0' }, hooks: hooks({ on: 'memberSession', do: 'pending' }) }),
  await scenario('a newer message while the session was made on a first turn', { rows: U1, hooks: hooks({ on: 'memberSession', do: 'pending' }) }),
  await scenario('a newer message during the wait cuts the turn short', { rows: U1, cursors: { bench: 'r0' }, snapshots: [busy(), busy(), answered()], hooks: hooks({ on: 'readSnapshot', do: 'pending' }) }),
  await scenario('a newer message that lands with the answer', { rows: U1, cursors: { bench: 'r0' }, snapshots: [answered()], hooks: hooks({ on: 'readSnapshot', do: 'pending' }) }),
  await scenario('a stop beats a newer message', { rows: U1, snapshots: [busy(), answered()], hooks: hooks({ on: 'readSnapshot', do: 'pending' }, { on: 'readSnapshot', do: 'stop' }) }),
  await scenario('a relay call is a relay turn', { rows: [], waiting: false, snapshots: [answered('Reported.')] }, {}, [{ call: { id: 'c1', hop: 2, relay: 'task output', askedBy: '' }, follow: 'ok' }]),
  await scenario('a relay beside a new user row is no system turn', { rows: U1, snapshots: [answered('Reported.')] }, {}, [{ call: { id: 'c1', relay: 'task output' }, follow: 'ok' }]),
  await scenario('two calls share one turn: first unused id, highest hop, joined askers and relays', { rows: U1 }, {}, [
    { call: { id: 'c1', hop: 1, askedBy: 'Lead', used: true }, follow: 'ok' },
    { call: { id: 'c2', hop: 3, askedBy: 'Lead', relay: 'a' }, follow: 'ok' },
    { call: { id: 'c3', hop: 2, askedBy: 'Other', relay: 'b' }, follow: 'ok' },
  ]),
  await scenario('every call used: the turn takes a fresh id', { rows: U1 }, {}, [{ call: { id: 'c1', used: true }, follow: 'ok' }, { call: { id: 'c2', used: true, followed: true }, follow: 'ok' }]),
  await scenario('calls without ids get no id', { rows: U1 }, {}, [{ call: { askedBy: 'Lead' } }, { call: {} }]),
  await scenario('a record that cannot be written fails the calls before submit', { rows: U1 }, {}, [{ call: { id: 'c1' }, follow: 'throws' }]),
  await scenario('a cut-short turn marks its submission id used', { rows: U1, snapshots: [busy(), answered()], hooks: hooks({ on: 'readSnapshot', do: 'pending' }) }, {}, [{ call: { id: 'c1' }, follow: 'ok' }, { call: { id: 'c2' }, follow: 'ok' }, { call: {} }]),
  await scenario('a turn cut short before it was submitted leaves the ids unused', { rows: U1, hooks: hooks({ on: 'memberSession', do: 'pending' }) }, {}, [{ call: { id: 'c1' }, follow: 'ok' }]),
  await scenario('a stopped turn cancels its calls', { rows: U1, hooks: hooks({ on: 'submit', do: 'stop' }) }, {}, [{ call: { id: 'c1' }, follow: 'ok' }]),
  await scenario('a removed member cancels its calls', { rows: U1, members: ['alpha'] }, {}, [{ call: { id: 'c1' }, follow: 'ok' }]),
  await scenario('a failed turn fails its calls', { rows: U1, submit: false }, {}, [{ call: { id: 'c1' }, follow: 'ok' }]),
  await scenario('a pass settles its calls done with no words', { rows: [speechRow('r1', 'alpha', 'x')], waiting: false, snapshots: [answered('(pass)')] }, { addressed: ['bench'] }, [{ call: { id: 'c1' }, follow: 'ok' }]),
  await scenario('a turn that throws settles its calls failed and rethrows', { rows: U1, switchedOff: ['throw'] }, {}, [{ call: { id: 'c1' }, follow: 'ok' }]),
];

const combinedCases = [];
for (const [name, specs, turnId] of [
  ['none', [], 'x'],
  ['an unused id', [{ id: 'c1' }, { id: 'c2' }], 'c1'],
  ['a call whose watch follows another id', [{ id: 'c1', followed: true }, { id: 'c2' }], 'c2'],
  ['the same id twice', [{ id: 'c1' }, { id: 'c1', followed: true }], 'c1'],
  ['no follow function', [{ id: 'c1', noFollow: true }, { id: 'c2' }], 'rturn_x'],
  ['no id never follows', [{ askedBy: 'a' }, { id: 'c2' }], 'rturn_x'],
  ['hops and relays', [{ id: 'c1', hop: '2', relay: 'x' }, { id: 'c2', hop: 'bad', relay: '' }, { hop: 5, relay: 'y', askedBy: 'A' }], 'c1'],
  ['relay only', [{ id: 'c1', relay: 'x' }, { id: 'c2', relay: 'y' }], 'c1'],
]) {
  const log = [];
  const calls = specs.map((spec) => ({ agentId: 'bench', ...spec, ...(spec.noFollow ? {} : { follow: async (id) => log.push(['follow', spec.id ?? null, id]) }) }));
  const host = { newId: () => 'n1' };
  const call = turn.combinedCall(host, 'bench', calls);
  await call.follow(turnId);
  combinedCases.push({
    name,
    specs,
    turnId,
    combined: { agentId: call.agentId, id: call.id ?? null, hop: call.hop ?? null, askedBy: call.askedBy, relay: call.relay, relayOnly: call.relayOnly },
    log,
    flags: calls.map((each) => ({ used: each.used ?? null, followed: each.followed ?? null })),
  });
}

const finalOut = join(FIXTURES_ROOT, 'room-member-turn');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 desktop agent-room-turn.ts speakInRoom does with a scripted host; `now` counts up from 1000, ids are n1, n2, ...; hooks change the exchange at a named host call',
  scenarios,
  combined: combinedCases,
});
writeSetManifest(out, {
  set: 'room-member-turn',
  recorder: 'benchmarks/rust-core/recorders/record-room-member-turn.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-member-turn.mjs --tree <tree>',
  extra: { scenarios: scenarios.length, combined: combinedCases.length },
});
commitStage(out, finalOut);
console.log(`scenarios=${scenarios.length} combined=${combinedCases.length}`);
