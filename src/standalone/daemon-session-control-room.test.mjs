// `session send` into a group room (daemon-session-control.mjs): a message to
// one named member, run by the desktop room host (agent-room-host.mjs); a
// member's own session is never a send target.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionControl } from './daemon-session-control.mjs';
import { createAgentTaskSessions } from '../session-runtime/agent-task-sessions.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from '../session-runtime/agent-home-delivery.mjs';
import { createWorkspaceToolHandlers } from '../session-runtime/internal-tool-executor/workspace-tools.mjs';
import { registerAgentRoomHost } from '../runtime/shared/agent-room-host.mjs';
import { roomMemberSessionId, roomSessionId } from '../runtime/agent/orchestrator/session/agent-room.mjs';

const ROOM = roomSessionId('abc123');
const MEMBER = roomMemberSessionId('abc123', 'rel');

/** A desktop room host whose members are gh and rel; `asks` records each ask. */
function fakeRoomHost(t) {
  const asks = [];
  const host = {
    member: async (_room, { to, prompt }) => {
      const agentId = { rel: 'rel', Release: 'rel', gh: 'gh' }[to];
      if (!agentId) throw new Error('A message to room "R" must name the member it is for');
      return { agentId, name: agentId, sessionId: roomMemberSessionId('abc123', agentId), text: prompt };
    },
    ask: async (room, request) => {
      asks.push([room, request]);
      return true;
    },
    relay: async () => ({ settled: Promise.resolve('done') }),
  };
  t.after(registerAgentRoomHost(host));
  return { asks };
}

function lead() {
  const sends = [];
  const service = {
    submitSession: async (params) => {
      sends.push(params);
      return { accepted: true };
    },
  };
  const handler = createWorkspaceToolHandlers({
    rt: { session: { id: 'sess_lead_1', title: 'Current' }, config: {} },
    executeSessionControl: createSessionControl({ getSessionService: () => service }),
  }).session;
  const run = async (args) =>
    JSON.parse(await handler(args, { callerCtx: { callerSessionId: 'sess_lead_1' }, callerCwd: '/project' }));
  return { run, sends };
}

test('a send to a room fails clearly with no desktop attached, and a member session is never a target', async () => {
  const h = lead();
  await assert.rejects(
    h.run({ action: 'send', session_id: ROOM, to: 'rel', prompt: 'hi' }),
    /cannot send to sess_room_abc123: group rooms run in the desktop app, and no desktop app is attached/
  );
  await assert.rejects(
    h.run({ action: 'send', session_id: MEMBER, prompt: 'hi' }),
    /is a group-room member's session; send to its room \(session_id sess_room_abc123\) with to: <member>/
  );
  assert.deepEqual(h.sends, [], 'nothing reaches either session');
});

test("a room send without a resolvable member fails; with one it is the member's message from the sender", async (t) => {
  const { asks } = fakeRoomHost(t);
  const h = lead();
  await assert.rejects(
    h.run({ action: 'send', session_id: ROOM, prompt: 'status?' }),
    /session: .*must name the member/
  );
  await assert.rejects(
    h.run({ action: 'send', session_id: MEMBER, to: 'rel', prompt: 'hi' }),
    /group-room member's session/
  );
  assert.deepEqual(await h.run({ action: 'send', session_id: ROOM, to: 'Release', prompt: 'status?' }), {
    sessionId: ROOM,
    to: 'rel',
    accepted: true,
    reportsBack: false,
    reportsBackReason: 'only a bot conversation gets session results reported back; check that session for the result',
  });
  assert.deepEqual(asks, [[ROOM, { agentId: 'rel', prompt: 'status?', from: { sessionId: 'sess_lead_1' } }]]);
  assert.deepEqual(h.sends, [], 'the room log itself never runs a turn');
});

test('a bot-to-bot chain through a room counts on and is refused past MAX_BOT_HOPS', async (t) => {
  const { MAX_BOT_HOPS } = await import('../runtime/shared/bot-hops.mjs');
  const limit = /Bot-to-bot chain limit reached; ask the user before continuing\./;
  const { asks } = fakeRoomHost(t);
  const service = {
    materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
    submitSession: async () => ({ accepted: true }),
  };
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: async () => {},
    watches: { add: async () => {}, list: async () => [], remove: async () => {} },
    loadSession: async () => null,
    agentName: async (id) => `Name ${id}`,
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  const run = createSessionControl({ getSessionService: () => service, agentTasks });
  const send = (sessionId, context, extra = {}) =>
    run({ action: 'send', session_id: sessionId, prompt: 'ping', ...extra }, context);
  // A bot's send into the room is one hop on; the member's turn carries it.
  const sent = await send(ROOM, { callerSessionId: 'sess_home_a', callerAgentId: 'a', callerHop: 1 }, { to: 'rel' });
  assert.equal(sent.hop, 2);
  assert.equal(asks.at(-1)[1].hop, 2);
  // A coding session's send in a bot-descended turn carries its hop as well.
  await send(ROOM, { callerSessionId: 'sess_lead_1', callerHop: 1 }, { to: 'rel' });
  assert.equal(asks.at(-1)[1].hop, 2);
  // The member, in the turn that send started (hop MAX_BOT_HOPS), can send nowhere further…
  const member = { callerSessionId: MEMBER, callerAgentId: 'rel', callerHop: MAX_BOT_HOPS };
  await assert.rejects(send('sess_home_b', member), limit);
  await assert.rejects(send(ROOM, member, { to: 'gh' }), limit);
  await assert.rejects(send(ROOM, { ...member, callerHop: 0 }, { to: 'rel' }), /must target another session/);
  // …and a send that would reach the room past the limit is refused before the room sees it.
  const count = asks.length;
  await assert.rejects(
    send(ROOM, { callerSessionId: 'sess_home_a', callerAgentId: 'a', callerHop: MAX_BOT_HOPS }, { to: 'rel' }),
    limit
  );
  assert.equal(asks.length, count);
});

test("a bot's room send reports the member's answer back to the bot and wakes it", async (t) => {
  const { asks } = fakeRoomHost(t);
  const dir = mkdtempSync(join(tmpdir(), 'session-control-room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = { id: 'sess_home_lead', owner: 'cli', agent: 'lead', sourceType: 'lead', messages: [], generation: 1 };
  const wakes = [];
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => (id === home.id ? home : null),
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: createRoutineResultQueue(join(dir, 'routine-results.json')),
    live: () => ({ busy: () => false, notice: () => {}, wake: async (id, prompt) => wakes.push([id, prompt]) }),
    retryLater: () => {},
    log: () => {},
  });
  let queued = null;
  const submits = [];
  const service = {
    materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
    submitSession: async (params) => {
      submits.push(params);
      return { accepted: true };
    },
  };
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: (agentId, report) => {
      queued = delivery.enqueueTask(agentId, report);
      return queued;
    },
    watches: {
      add: (watch) => delivery.watchTask(watch),
      list: () => delivery.taskWatches(),
      remove: (runId) => delivery.unwatchTask(runId),
    },
    loadSession: async () => null,
    agentName: async () => 'Mixy',
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  const handler = createWorkspaceToolHandlers({
    rt: { session: home, config: {} },
    executeSessionControl: createSessionControl({ getSessionService: () => service, agentTasks }),
  }).session;
  const result = JSON.parse(
    await handler(
      { action: 'send', session_id: ROOM, to: 'rel', prompt: 'is v2 ready?' },
      { callerCtx: { callerSessionId: home.id }, callerCwd: '/project' }
    )
  );
  assert.deepEqual(result, { sessionId: ROOM, to: 'rel', accepted: true, reportsBack: true, hop: 1 });
  assert.deepEqual(submits, [], 'the room host takes the turn, not a prompt to any session');
  const [[room, ask]] = asks;
  assert.equal(room, ROOM);
  assert.deepEqual(
    [ask.agentId, ask.prompt, ask.from],
    ['rel', 'is v2 ready?', { sessionId: home.id, agentId: 'lead' }]
  );
  assert.match(ask.id, /^atask_/);
  assert.equal(ask.hop, 1, "the member's turn carries the send's hop");
  const [watch] = await delivery.taskWatches();
  assert.deepEqual([watch.runId, watch.taskSessionId], [ask.id, MEMBER], "the member's turn is the watched turn");
  // The member answered in the room: its words report back to the bot.
  ask.onSettled({ status: 'done', result: { content: 'v2 is ready' } });
  for (let i = 0; i < 10 && !queued; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await delivery.drain(await queued);
  const [reported] = home.messages;
  assert.match(reported.content, /Session "sess_rmem_abc123_rel" \(sess_rmem_abc123_rel\) reported \(completed\)/);
  assert.match(reported.content, /v2 is ready/);
  assert.equal(wakes.length, 1);
  assert.deepEqual(await delivery.taskWatches(), []);
});
