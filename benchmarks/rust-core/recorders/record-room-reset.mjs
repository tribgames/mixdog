#!/usr/bin/env node
// `room/reset`: Node's `createAgentRooms(...).reset(roomId)` (apps/desktop/src/main/agent-rooms.ts) run on its real code
// with a scripted daemon. A room is created, spoken in by its members (so it holds cursors, a last speaker and a preview),
// then reset. Each case records the stored room record before and after, the clears the host was asked for in order
// (the log's `startOver`, then each member's `resetMember`), which member sessions existed, and the result or error text.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-room-reset.mjs --tree <exact b6f10295a export>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, exactProductIdentity, importFrom, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createAgentRooms } = await importFrom(tree, 'apps/desktop/src/main/agent-rooms.ts');

const AGENTS = ['gh', 'rel', 'bench'].map((id) => ({ id, custom: true, kind: 'bot', label: id, route: { provider: 'openai', model: 'gpt-5' } }));
const ROTATE = (input) => {
  const ids = input.members.map((member) => member.id);
  const last = input.last || input.rows.findLast((row) => row.kind === 'speech')?.speaker || '';
  return { action: 'speak', agentId: ids[(ids.indexOf(last) + 1) % ids.length] };
};

async function scenario(name, { gate = null, startOver = () => 'sess_archived_room', failMembers = [], dropSessions = [], roomId: asked = null }) {
  const sessions = new Set();
  const calls = [];
  const saved = { doc: { rooms: {} } };
  let clock = 1_000;
  let ids = 0;
  const answers = new Map();
  const rooms = createAgentRooms({
    store: { load: async () => structuredClone(saved.doc), save: async (doc) => { saved.doc = structuredClone(doc); } },
    listAgents: async () => AGENTS,
    sessionExists: async (id) => sessions.has(id),
    createSession: async (id) => { sessions.add(id); },
    renameSession: async () => {},
    appendRows: async (_id, rows) => ({ added: rows.length, rows }),
    readItems: async () => [],
    submit: async (id) => {
      if (gate) await gate.promise;
      answers.set(id, { text: `said by ${id.split('_').at(-1)}`, at: clock + 1 });
      return true;
    },
    decideTurn: async (input) => ROTATE(input),
    readSnapshot: async (id) => ({
      busy: false,
      items: [
        { id: 'u', kind: 'user', text: 'p' },
        { id: 'a', kind: 'assistant', text: answers.get(id).text },
        { id: 'd', kind: 'turndone', at: answers.get(id).at, status: 'done', finalAssistantId: 'a' },
      ],
    }),
    abort: async () => {},
    approve: async () => true,
    deleteSession: async (id) => { sessions.delete(id); },
    setArchived: async () => {},
    startOver: async (id) => { calls.push(['startOver', id]); return startOver(id); },
    resetMember: async (id) => { calls.push(['resetMember', id]); if (failMembers.some((who) => id.endsWith(`_${who}`))) throw new Error('could not clear'); },
    taskWorkspace: async () => '/tmp',
    republish: () => {},
    republishCatalog: () => {},
    now: () => (clock += 1),
    random: () => 0.999999,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    newId: () => `id${String((ids += 1)).padStart(6, '0')}`,
    log: () => {},
  });
  const { sessionId, roomId } = await rooms.create({ name: 'Release check', members: ['gh', 'rel', 'bench'], maxRounds: 1, maxMessages: 30 });
  await rooms.send(sessionId, 'old question');
  if (!gate) for (let i = 0; i < 2000 && rooms.isRunning(roomId); i += 1) await new Promise((r) => setImmediate(r));
  for (const id of dropSessions) sessions.delete(id.replace('<room>', roomId));
  const before = structuredClone(saved.doc.rooms[roomId]);
  const existing = [...sessions].filter((id) => id !== sessionId).sort();
  const running = rooms.isRunning(roomId);
  calls.length = 0;
  let outcome;
  try {
    outcome = { ok: true, value: await rooms.reset(asked ?? roomId) };
  } catch (error) {
    outcome = { ok: false, error: error.message };
  }
  const after = structuredClone(saved.doc.rooms[roomId]);
  gate?.release();
  for (let i = 0; i < 2000 && rooms.isRunning(roomId); i += 1) await new Promise((r) => setImmediate(r));
  // inject is what the scripted daemon did: the members whose clear failed, and what the log's start-over answered (a string, null, or a throw).
  const inject = { failMembers, startOver: startOver === startOverNull ? null : startOver === startOverThrows ? 'throws' : 'sess_archived_room' };
  return { name, roomId, logSession: sessionId, running, existing, inject, before, outcome, calls, after };
}

const startOverNull = () => null;
const startOverThrows = () => { throw new Error('archive failed'); };
const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const cases = [
  await scenario('success', {}),
  await scenario('a member session that does not exist is skipped', { dropSessions: ['sess_rmem_<room>_bench'] }),
  await scenario('nothing kept in the log', { startOver: startOverNull }),
  await scenario('still talking', { gate: gate() }),
  await scenario('one member fails to start over', { failMembers: ['rel'] }),
  await scenario('two members fail to start over', { failMembers: ['gh', 'bench'] }),
  await scenario('the log cannot start over', { startOver: startOverThrows }),
  await scenario('unknown room', { roomId: 'nosuchroom' }),
];
const dir = join(FIXTURES_ROOT, 'phone-chat-core');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'room-reset.json'), `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-room-reset.mjs', cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
writeSetManifest(dir, { set: 'phone-chat-core', recorder: 'benchmarks/rust-core/recorders/record-phone-chat-core.mjs + record-remote-session.mjs + record-room-reset.mjs', command: 'node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/<recorder>.mjs --tree <tree>, for each of the three recorders', identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146') });
