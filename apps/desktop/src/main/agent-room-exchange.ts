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
import {
  type MemberLabel,
  type RoomCall,
  type RoomExchangeOptions,
  type RoomTurnHost,
  type RunState,
  postFailures,
  speakInRoom,
} from './agent-room-turn';
import type { AgentRoomRecord } from './agent-rooms';

/** What an exchange needs from the room host, bound to one room. */
export interface RoomExchangeHost {
  roomId: string;
  /** The room's record; throws once the room no longer exists. */
  room(): AgentRoomRecord;
  exists(): boolean;
  /** Marks the room running with this state (the views read it). */
  track(state: RunState): void;
  /** Stops tracking `state`; false when the room is no longer this state's. */
  untrack(state: RunState): boolean;
  /** The relays held back for the room end failed (`error`). */
  failRelays(error: string): void;
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
      members: members
        .filter(({ id }) => room.members.includes(id))
        .map(({ id, name, description }) => ({ id, name, description })),
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
  const release = () => releaseExchange(host, state);
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
 *  `waiting`: a user message starts it (unset: read from the log). `only`:
 *  the called members answer and nobody follows. Every one of `calls` rides
 *  its member's next turn (one turn answers them all); one no turn answered
 *  is handed to the next exchange, or ends cancelled when none follows. */
export async function runRoomExchangeIn(
  host: RoomExchangeHost,
  { to = [], waiting, only = false, everyone, calls: given = [] }: RoomExchangeOptions
): Promise<void> {
  const calls = [...given];
  const room = host.room();
  const state: RunState = {
    stop: false,
    speaking: '',
    speakingName: '',
    typingId: '',
    memberSession: '',
    approval: null,
    pending: null,
    calls,
    waiting: waiting === true,
    failures: [],
  };
  host.track(state);
  try {
    room.running = { startedAt: host.now() };
    // Any new exchange settles what an earlier capped one still owed.
    room.owed = null;
    await host.persist();
    host.republishCatalog();
    host.republish();
    await exchangeTurns(host, state, room, { to, only, waiting, everyone }, calls);
    await settleExchange(host, state);
  } catch (error) {
    abandonExchange(host, state, calls, error);
    throw error;
  }
  if (state.pending && !state.stop && host.exists()) await runRoomExchangeIn(host, state.pending);
}

/** The room is released, when this exchange still holds it. */
function releaseExchange(host: RoomExchangeHost, state: RunState): void {
  if (host.untrack(state) && host.exists()) host.room().running = null;
}

/** A save the exchange depends on failed (its start, or its hand-off): the
 *  room is released, so nothing waits on it forever, and every call this
 *  exchange or the next one held, and every relay held back, ends failed. */
function abandonExchange(host: RoomExchangeHost, state: RunState, calls: RoomCall[], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  host.log(`room ${host.roomId} exchange stopped: ${message}`);
  releaseExchange(host, state);
  const held = [...calls, ...(state.pending?.calls ?? [])];
  calls.length = 0;
  state.pending = null;
  for (const call of held) call.onSettled?.({ status: 'failed', error: message });
  host.failRelays(message);
  host.republishCatalog();
  host.republish();
}

/** The exchange's turns; a failing turn or notice is logged, and the calls no
 *  turn took are handed on (handOverCalls). */
async function exchangeTurns(
  host: RoomExchangeHost,
  state: RunState,
  room: AgentRoomRecord,
  {
    to,
    only,
    waiting,
    everyone,
  }: { to: string[]; only: boolean; waiting: boolean | undefined; everyone: boolean | undefined },
  calls: RoomCall[]
): Promise<void> {
  try {
    if (waiting === undefined) state.waiting = roomUserWaiting(await host.rows());
    const labels = await host.labels(room);
    // A switched-off bot stays a member but takes no new turn.
    const speaking = room.members.filter((id) => labels.get(id)?.disabled !== true);
    const members = speaking.map((id) => labels.get(id) ?? { id, name: id, route: undefined, description: '' });
    const result = await runRoomExchange({
      members: speaking,
      to,
      maxRounds: room.maxRounds,
      // A user-addressed set keeps the full cap; a free exchange stops at a
      // budget drawn each time, so it does not always end at the same count.
      maxMessages: to.length ? room.maxMessages : roomMessageBudget(speaking.length, room.maxMessages, host.random),
      // A member's turn answers every call waiting on it; a turn a newer
      // message cut short hands them back, for the next exchange.
      speak: async (agentId, turn) => {
        const taken = calls.filter((call) => call.agentId === agentId);
        calls.splice(0, calls.length, ...calls.filter((call) => call.agentId !== agentId));
        const answer = await speakInRoom(host.turn, state, labels, agentId, turn, taken);
        if ((typeof answer === 'string' ? answer : answer.result) === 'superseded') calls.push(...taken);
        return answer;
      },
      decide: (step) => supervisorDecision(host, state, room, members, step),
      stopped: () => state.stop,
      superseded: () => Boolean(state.pending),
      // Only a user still waiting forces a pick: a "Continue" after the
      // talk was answered may end at once when nothing is open.
      waiting: state.waiting,
      only,
      wholeRoom: everyone,
    });
    await postFailures(host.turn, state);
    if (result.outcome === 'limited') {
      // No supervisor step ran after the turn that met the limit, so the
      // member still in `speakingName` is the one that did.
      const { usage } = result;
      await host.post([
        {
          id: `row_${host.newId()}`,
          kind: 'cap',
          at: host.now(),
          text: '',
          name: state.speakingName,
          limit: 'usage',
          usage,
        },
      ]);
    } else if (result.outcome === 'capped') {
      const { limit, rounds, messages, remaining } = result;
      if (remaining?.length) room.owed = remaining;
      await host.post([{ id: `row_${host.newId()}`, kind: 'cap', at: host.now(), text: '', limit, rounds, messages }]);
    } else if (result.outcome === 'stopped') {
      await host.post([{ id: `row_${host.newId()}`, kind: 'stopped', at: host.now(), text: '' }]);
    }
  } catch (error) {
    host.log(`room ${host.roomId} exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    handOverCalls(host, state, calls);
  }
}

/** The calls no turn of this exchange took: the next exchange (a message sent
 *  meanwhile) gives them their turns; with none to follow they end cancelled. */
function handOverCalls(host: RoomExchangeHost, state: RunState, calls: RoomCall[]): void {
  const next = state.pending;
  if (next && !state.stop && host.exists()) {
    if (!calls.length) return;
    next.to = [...new Set([...(next.to ?? []), ...calls.map((call) => call.agentId)])];
    next.calls = [...calls, ...(next.calls ?? [])];
  } else for (const call of [...calls, ...(next?.calls ?? [])]) call.onSettled?.({ status: 'cancelled' });
  calls.length = 0;
}
