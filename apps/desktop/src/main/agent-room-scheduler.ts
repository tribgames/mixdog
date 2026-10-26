// Group rooms, turn scheduling (agent-rooms.ts): the one owner of what runs in
// each room. An exchange in flight, the send/ask requests still on their way
// to it, and the relays held back while it talks live here only; requests
// route into the exchange that runs, or start one.
import { roomIdOfSession, roomSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { AgentRoomTurnDetail } from '../../../../src/runtime/shared/agent-room-host.mjs';
import type { ToolApprovalDecision } from '../shared/contract';
import { type RoomExchangeHost, runRoomExchangeIn } from './agent-room-exchange';
import type { createRoomLog } from './agent-room-log';
import type { createRoomRecords } from './agent-room-records';
import type { RoomCall, RoomExchangeOptions, RoomTurnHost, RunState } from './agent-room-turn';
import type { AgentRoomDeps } from './agent-rooms';

type RoomRecords = ReturnType<typeof createRoomRecords>;
type RoomLog = ReturnType<typeof createRoomLog>;

/** What the scheduler reads from the host: the room records, the room's log,
 *  a member's session, and the daemon calls a turn makes. */
export interface RoomSchedulerHost {
  deps: Pick<
    AgentRoomDeps,
    'submit' | 'readSnapshot' | 'abort' | 'approve' | 'decideTurn' | 'republish' | 'republishCatalog'
  >;
  rooms: RoomRecords['rooms'];
  roomOf: RoomRecords['roomOf'];
  memberLabels: RoomRecords['memberLabels'];
  persist: RoomRecords['persist'];
  rows: RoomLog['rows'];
  post: RoomLog['post'];
  memberSession(roomId: string, member: { id: string; route: unknown }): Promise<string>;
  now(): number;
  newId(): string;
  sleep(ms: number): Promise<void>;
  random(): number;
  pollMs: number;
  log(line: string): void;
}

/** Per room, the send/ask requests still on their way to route(): Stop
 *  cancels them even when no exchange runs yet. */
export type IntakeRequest = { stopped: boolean; release(): void };

/** `call` with an `onSettled` that runs once, whichever path ends it first. */
function settlesOnce(call: RoomCall): RoomCall {
  const onSettled = call.onSettled;
  if (!onSettled) return call;
  let done = false;
  return {
    ...call,
    onSettled: (detail) => {
      if (done) return;
      done = true;
      onSettled(detail);
    },
  };
}

/** The calls of `calls` addressed to `gone` end cancelled and leave it
 *  (in place: the exchange shares the array). */
function cancelCallsTo(calls: RoomCall[], gone: ReadonlySet<string>): void {
  const kept = calls.filter((call) => !gone.has(call.agentId));
  for (const call of calls) if (gone.has(call.agentId)) call.onSettled?.({ status: 'cancelled' });
  calls.splice(0, calls.length, ...kept);
}

export function createRoomScheduler(host: RoomSchedulerHost) {
  const { deps, roomOf, rows: roomRows, post, memberLabels, persist, now, newId, sleep, random, pollMs, log } = host;
  const running = new Map<string, RunState>();
  const intakes = new Map<string, Set<IntakeRequest>>();

  /** Runs one send/ask with its own cancellation latch, registered before the
   *  first await; it is released when the request reaches route() or fails. */
  async function intake<T>(roomId: string, run: (request: IntakeRequest) => Promise<T>): Promise<T> {
    const pending = intakes.get(roomId) ?? new Set<IntakeRequest>();
    const request: IntakeRequest = {
      stopped: false,
      release() {
        if (pending.delete(request) && !pending.size) intakes.delete(roomId);
      },
    };
    pending.add(request);
    intakes.set(roomId, pending);
    try {
      return await run(request);
    } finally {
      request.release();
    }
  }

  /** What a member's turn in this room needs from the host. */
  const turnHost = (roomId: string): RoomTurnHost => ({
    roomId,
    room: () => roomOf(roomId),
    rows: () => roomRows(roomId),
    post: (rows) => post(roomId, rows),
    republish: () => deps.republish(roomSessionId(roomId)),
    memberSession: (member) => host.memberSession(roomId, member),
    switchedOff: async (agentId) => (await memberLabels(roomOf(roomId))).get(agentId)?.disabled === true,
    submit: (sessionId, prompt, options) => deps.submit(sessionId, prompt, options),
    readSnapshot: (sessionId) => deps.readSnapshot(sessionId),
    abort: (sessionId) => deps.abort(sessionId),
    persist,
    now: () => now(),
    newId: () => newId(),
    sleep: (ms) => sleep(ms),
    pollMs,
    log,
  });

  /** What an exchange in this room needs from the host. */
  const exchangeHost = (roomId: string): RoomExchangeHost => ({
    roomId,
    room: () => roomOf(roomId),
    exists: () => Boolean(host.rooms()[roomId]),
    track: (state) => running.set(roomId, state),
    untrack: (state) => running.get(roomId) === state && running.delete(roomId),
    failRelays: (error) => dropRelays(roomId, { status: 'failed', error }),
    rows: () => roomRows(roomId),
    post: (rows) => post(roomId, rows),
    labels: memberLabels,
    turn: turnHost(roomId),
    decideTurn: (input) => deps.decideTurn(input),
    persist,
    republish: () => deps.republish(roomSessionId(roomId)),
    republishCatalog: () => deps.republishCatalog(),
    now: () => now(),
    newId: () => newId(),
    random,
    log,
  });
  const exchange = (roomId: string, options: RoomExchangeOptions) => runRoomExchangeIn(exchangeHost(roomId), options);

  const start = (roomId: string, options: RoomExchangeOptions) => {
    // A save that fails outside the exchange's own try (before it, or in its
    // finally) is logged, never left as an unhandled rejection; a call it
    // carried ends failed (a call settles once).
    void exchange(roomId, options)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`room ${roomId} exchange failed: ${message}`);
        for (const call of options.calls ?? []) call.onSettled?.({ status: 'failed', error: message });
      })
      .then(() => drainRelays(roomId));
  };

  /** Relays held back per room while its talk runs: a relay never cuts a
   *  member off, it waits for the exchange in flight to end. */
  const relayQueue = new Map<string, RoomCall[]>();

  /** An exchange in `roomId` ended: the relays it held back run as one
   *  exchange, each member once, unless another exchange already took the
   *  room (its own end drains them). */
  function drainRelays(roomId: string): void {
    const queued = relayQueue.get(roomId);
    if (!queued?.length || running.has(roomId)) return;
    relayQueue.delete(roomId);
    const to = [...new Set(queued.map((call) => call.agentId))];
    route(roomId, { to, waiting: false, only: true, calls: queued });
  }

  /** The stop button, or a save the room's talk needed failed: the relays held
   *  back end (cancelled, or failed); the delivery retries them later. */
  function dropRelays(roomId: string, detail: AgentRoomTurnDetail = { status: 'cancelled' }): void {
    const queued = relayQueue.get(roomId) ?? [];
    relayQueue.delete(roomId);
    for (const call of queued) call.onSettled?.(detail);
  }

  /** Route a new request into room `roomId`: it starts an exchange, or, while
   *  one runs, is merged into the one that runs next (every member any of
   *  them called keeps its turn, in the order named; `only` holds when every
   *  merged request is `only`), and the member speaking is cut off: its
   *  answer would respond to older rows. Each call settles once. */
  function route(roomId: string, options: Required<Pick<RoomExchangeOptions, 'to' | 'waiting'>> & RoomExchangeOptions) {
    const calls = (options.calls ?? []).map(settlesOnce);
    const active = running.get(roomId);
    if (!active) return start(roomId, { ...options, calls });
    // A stopping exchange hands nothing on: calls that arrive now end cancelled.
    if (active.stop) {
      for (const call of calls) call.onSettled?.({ status: 'cancelled' });
      calls.length = 0;
    }
    const prior = active.pending;
    active.pending = {
      to: [...new Set([...(prior?.to ?? []), ...options.to])],
      waiting: prior?.waiting === true || options.waiting,
      only: (prior ? prior.only === true : true) && options.only === true,
      calls: [...(prior?.calls ?? []), ...calls],
    };
    if (active.speaking && active.memberSession) void deps.abort(active.memberSession).catch(() => undefined);
  }

  /** A member's relay `call` in room `roomId`: a relay never cuts a member
   *  off: while the room talks it waits in the room's queue, which the
   *  exchange's end drains. */
  function relayWhenIdle(roomId: string, call: RoomCall): void {
    if (running.get(roomId)?.stop) call.onSettled?.({ status: 'cancelled' });
    else if (running.has(roomId)) relayQueue.set(roomId, [...(relayQueue.get(roomId) ?? []), call]);
    else route(roomId, { to: [call.agentId], waiting: false, only: true, calls: [call] });
  }

  /** `gone` left room `roomId`: what is owed to them ends. Their calls waiting
   *  in the room's exchange, in the exchange that runs next and in the relay
   *  queue end cancelled, and they are no queued target. Their turn in flight
   *  (or about to start) notices the removal itself (memberTurn). */
  function cancelOwedTo(roomId: string, gone: ReadonlySet<string>): void {
    const queued = relayQueue.get(roomId);
    if (queued) {
      cancelCallsTo(queued, gone);
      if (!queued.length) relayQueue.delete(roomId);
    }
    const state = running.get(roomId);
    if (!state) return;
    cancelCallsTo(state.calls, gone);
    if (state.pending) {
      if (state.pending.calls) cancelCallsTo(state.pending.calls, gone);
      state.pending.to = state.pending.to?.filter((id) => !gone.has(id));
    }
  }

  /** The stop button: the speaking member's turn is cancelled and no one
   *  else gets a turn, not even a relay held back. */
  function stop(sessionId: string): boolean {
    const roomId = roomIdOfSession(sessionId);
    dropRelays(roomId);
    const incoming = intakes.get(roomId);
    for (const request of incoming ?? []) request.stopped = true;
    const state = running.get(roomId);
    if (!state) return Boolean(incoming?.size);
    state.stop = true;
    for (const call of state.pending?.calls ?? []) call.onSettled?.({ status: 'cancelled' });
    state.pending = null;
    if (state.memberSession) void deps.abort(state.memberSession).catch(() => undefined);
    return true;
  }

  /** An approval the room shows on behalf of its speaking member. */
  async function approve(sessionId: string, approvalId: string, decision: ToolApprovalDecision): Promise<boolean> {
    const state = running.get(roomIdOfSession(sessionId));
    if (!state?.memberSession || String(state.approval?.id ?? '') !== approvalId) return false;
    const accepted = await deps.approve(state.memberSession, approvalId, decision);
    state.approval = null;
    deps.republish(sessionId);
    return accepted;
  }

  return {
    intake,
    start,
    route,
    relayWhenIdle,
    cancelOwedTo,
    stop,
    approve,
    /** The exchange running in `roomId`, if any. */
    state: (roomId: string) => running.get(roomId),
    isRunning: (roomId: string) => running.has(roomId),
  };
}

export type RoomScheduler = ReturnType<typeof createRoomScheduler>;
