// One bounded exchange of a group room (agent-rooms.ts owns the records):
// the user's addressees speak first, then a supervisor step on the Maintainer
// model picks each next speaker or ends the talk, under hard caps. A message
// sent meanwhile runs the next exchange straight away.
import {
  type RoomRow,
  roomMessageBudget,
  roomUserWaiting,
  runRoomExchange,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import {
  type RoomDecision,
  type RoomSupervisorInput,
  roomSupervisorRows,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room-supervisor.mjs';
import { type MemberLabel, type RoomTurnHost, type RunState, speakInRoom } from './agent-room-turn';
import type { AgentRoomRecord } from './agent-rooms';

/** What an exchange needs from the room host, bound to one room. */
export interface RoomExchangeHost {
  roomId: string;
  /** The room's record; throws once the room no longer exists. */
  room(): AgentRoomRecord;
  exists(): boolean;
  /** Marks the room running with this state (the views read it). */
  track(state: RunState): void;
  untrack(): void;
  rows(): Promise<RoomRow[]>;
  post(rows: RoomRow[]): Promise<void>;
  labels(room: AgentRoomRecord): Promise<Map<string, MemberLabel>>;
  turn: RoomTurnHost;
  decideTurn(input: RoomSupervisorInput): Promise<RoomDecision | { action: 'unmanaged' } | null>;
  persist(): Promise<void>;
  /** Publish the room log's held snapshot again. */
  republish(): void;
  republishCatalog(): void;
  now(): number;
  newId(): string;
  random(): number;
  log(line: string): void;
}

type SupervisorStep = Parameters<Parameters<typeof runRoomExchange>[0]['decide']>[0];

/** One supervisor step: nobody is typing while it decides; a failed or
 *  unusable answer is logged and falls back (null). */
async function supervisorDecision(
  host: RoomExchangeHost,
  state: RunState,
  room: AgentRoomRecord,
  members: MemberLabel[],
  step: SupervisorStep
) {
  Object.assign(state, { speaking: '', speakingName: '', memberSession: '' });
  host.republish();
  const decision = await host
    .decideTurn({
      roomName: room.name,
      members: members.map(({ id, name, description }) => ({ id, name, description })),
      rows: roomSupervisorRows(await host.rows()),
      turns: step.turns,
      mustPick: step.mustPick,
      last: step.last,
      remaining: step.remaining,
    })
    .catch((error) => {
      host.log(`room ${host.roomId} supervisor failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
  if (decision === null) host.log(`room ${host.roomId} supervisor gave no usable decision; falling back`);
  return decision ?? null;
}

/** The exchange's end: the room is released (unless a message sent meanwhile
 *  hands it straight to the next exchange) and saved, and the views publish. */
async function settleExchange(host: RoomExchangeHost, state: RunState): Promise<void> {
  const chains = () => Boolean(state.pending) && !state.stop && host.exists();
  const release = () => {
    host.untrack();
    if (host.exists()) host.room().running = null;
  };
  // A message sent meanwhile runs the next exchange straight away: the room
  // stays busy across the hand-off. A view published idle in between
  // dropped the typing band and flipped the composer's stop button for a
  // moment, and the followed transcript hopped up and down by their sizes.
  const handsOff = chains();
  if (!handsOff) release();
  await host.persist();
  host.republishCatalog();
  if (!handsOff) host.republish();
  else if (!chains()) {
    // The stop button came in while the room was saved.
    release();
    await host.persist();
    host.republishCatalog();
    host.republish();
  }
}

/** One bounded exchange; a message sent meanwhile runs the next one.
 *  `waiting`: a user message starts it (unset: read from the log). */
export async function runRoomExchangeIn(
  host: RoomExchangeHost,
  { to = [], waiting }: { to?: string[]; waiting?: boolean }
): Promise<void> {
  const room = host.room();
  const state: RunState = {
    stop: false,
    speaking: '',
    speakingName: '',
    typingId: '',
    memberSession: '',
    approval: null,
    pending: null,
    waiting: waiting === true,
  };
  host.track(state);
  room.running = { startedAt: host.now() };
  // Any new exchange settles what an earlier capped one still owed.
  room.owed = null;
  await host.persist();
  host.republishCatalog();
  host.republish();
  try {
    if (waiting === undefined) state.waiting = roomUserWaiting(await host.rows());
    const labels = await host.labels(room);
    const members = room.members.map((id) => labels.get(id) ?? { id, name: id, route: undefined, description: '' });
    const result = await runRoomExchange({
      members: room.members,
      to,
      maxRounds: room.maxRounds,
      // A user-addressed set keeps the full cap; a free exchange stops at a
      // budget drawn each time, so it does not always end at the same count.
      maxMessages: to.length ? room.maxMessages : roomMessageBudget(room.members.length, room.maxMessages, host.random),
      speak: (agentId, turn) => speakInRoom(host.turn, state, labels, agentId, turn),
      decide: (step) => supervisorDecision(host, state, room, members, step),
      stopped: () => state.stop,
      superseded: () => Boolean(state.pending),
      // Only a user still waiting forces a pick: a "Continue" after the
      // talk was answered may end at once when nothing is open.
      waiting: state.waiting,
    });
    if (result.outcome === 'capped') {
      const { limit, rounds, messages, remaining } = result;
      if (remaining?.length) room.owed = remaining;
      await host.post([{ id: `row_${host.newId()}`, kind: 'cap', at: host.now(), text: '', limit, rounds, messages }]);
    } else if (result.outcome === 'stopped') {
      await host.post([{ id: `row_${host.newId()}`, kind: 'stopped', at: host.now(), text: '' }]);
    }
  } catch (error) {
    host.log(`room ${host.roomId} exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await settleExchange(host, state);
  }
  if (state.pending && !state.stop && host.exists()) await runRoomExchangeIn(host, state.pending);
}
