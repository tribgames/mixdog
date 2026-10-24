// Group rooms, host side: the user invites several agents into ONE chat
// (session/agent-room.mjs). This host keeps each room's record, posts every
// row into the room's log session through the daemon, and drives the members
// strictly one at a time: after the user's addressees, a supervisor step on the
// Maintainer model picks each next speaker or ends the talk, under hard caps.
// A member speaks from its own session per room, sees only the rows new since
// it last spoke, and its tools follow the same approval rules as its home chat.
// The room's log is a plain session, so the transcript, read cursors, unread
// counts and the phone all work unchanged. A round in flight lives in memory
// only: a restarted host marks it interrupted and never resumes it.
import { randomBytes } from 'node:crypto';
import {
  type RoomConfig,
  type RoomRow,
  normalizeRoomConfig,
  parseRoomAsk,
  roomIdOfSession,
  roomMemberNamed,
  roomMemberOfSession,
  roomMemberSessionId,
  roomSessionId,
  type roomTurnPrompt,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type {
  RoomDecision,
  RoomSupervisorInput,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room-supervisor.mjs';
import type { AgentRoomHost, AgentRoomTurnDetail } from '../../../../src/runtime/shared/agent-room-host.mjs';
import { readJsonState, writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { type AgentCatalogRow, MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';
import type {
  DesktopAgentRoomSummary,
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
  ToolApprovalDecision,
} from '../shared/contract';
import { roomMemberSwitchedOffError } from '../shared/room-error-codes';
import { routeParams } from './agent-home-sessions';
import { type RoomExchangeHost, runRoomExchangeIn } from './agent-room-exchange';
import { createRoomLog } from './agent-room-log';
import { createRoomRecords } from './agent-room-records';
import type { MemberLabel, RoomCall, RoomExchangeOptions, RoomTurnHost, RunState } from './agent-room-turn';
import { catalogWithRooms, decorateRoomSnapshot, roomSummary } from './agent-room-views';

export interface AgentRoomRecord extends RoomConfig {
  id: string;
  createdAt: number;
  /** Per member: the id of the last room row it was shown. */
  cursors: Record<string, string>;
  /** Per member: the id of the newest row a prompt its session took was
   *  handed. A turn cut short restores the cursor but not this, so the rows
   *  it hands again are context, and a cursor the log read no longer holds
   *  never re-hands older rows as new (rowsSinceCursor). */
  seen?: Record<string, string>;
  /** Who said the last line: an agent id, or 'user'. */
  lastSpeaker?: string;
  lastAt?: number;
  /** The last words said in the room (list preview). */
  lastPreview?: string;
  /** Set while an exchange runs; a record still carrying it at start-up was
   *  cut off by a restart. */
  running?: { startedAt: number } | null;
  /** The members of a user-addressed set the message cap cut off: "더 진행"
   *  gives them their turns before any whole-room batch. */
  owed?: string[] | null;
  /** Submission ids of accepted user messages, newest last (bounded). */
  submissions?: string[];
}

export interface AgentRoomStoreDoc {
  rooms: Record<string, AgentRoomRecord>;
}

export interface AgentRoomStore {
  load(): Promise<AgentRoomStoreDoc>;
  save(doc: AgentRoomStoreDoc): Promise<void>;
}

export interface AgentRoomDeps {
  store: AgentRoomStore;
  listAgents(): Promise<unknown>;
  /** Mixy's display name (agents/lead/agent.json `name`); '' for the default. */
  leadName?(): Promise<string>;
  /** The route Mixy follows (`getLeadHomeRoute`): its own, else Main's; null
   *  when neither is set. */
  mixyRoute?(): Promise<unknown>;
  /** Per-id definition presence from the files (`agentDefinitionPresence`):
   *  only 'deleted' removes a member from its rooms. */
  agentPresence?(agentIds: string[]): Promise<unknown>;
  sessionExists(sessionId: string): Promise<boolean>;
  createSession(sessionId: string, params: Record<string, unknown>): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Post rows into a room's log (the daemon's `appendRoomRows`); resolves
   *  `{ rows }`, the rows as stored: a user row's `upload` taken in, its files
   *  kept as stored references. */
  appendRows(sessionId: string, rows: RoomRow[]): Promise<unknown>;
  /** The transcript items of a session, read without publishing. */
  readItems(sessionId: string): Promise<unknown[]>;
  /** A member's turn: its prompt, text or parts with the user's stored files
   *  (submitted like a chat prompt), under submission `id` and at bot-to-bot
   *  `hop` when given. */
  submit(
    sessionId: string,
    prompt: ReturnType<typeof roomTurnPrompt>,
    options?: { id?: string; hop?: number; roomRow?: string }
  ): Promise<boolean>;
  /** One supervisor step on the Maintainer model (the daemon's
   *  `decideRoomTurn`): the next speaker, finish, null for no usable answer, or
   *  `unmanaged` when no Maintainer model is configured. */
  decideTurn(input: RoomSupervisorInput): Promise<RoomDecision | { action: 'unmanaged' } | null>;
  readSnapshot(sessionId: string): Promise<SessionSnapshot>;
  abort(sessionId: string): Promise<void>;
  approve(sessionId: string, approvalId: string, decision: ToolApprovalDecision): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  /** "대화 초기화" of the room's log: emptied in place, the old one kept
   *  archived; resolves the archived id (null when nothing was kept). */
  startOver(sessionId: string): Promise<string | null>;
  /** "대화 초기화" of a member's session: emptied in place, no copy kept, its
   *  prompt rebuilt from the current rules. */
  resetMember(sessionId: string): Promise<void>;
  taskWorkspace(): Promise<string>;
  /** Publish the room log's held snapshot again (through `decorate`). */
  republish(sessionId: string): void;
  republishCatalog(): void;
  now?(): number;
  /** [0, 1); draws each exchange's message budget. */
  random?(): number;
  sleep?(ms: number): Promise<void>;
  newId?(): string;
  pollMs?: number;
  log?(line: string): void;
}

const SUBMISSION_IDS = 64;

function promptText(prompt: DesktopPromptContent): string {
  if (typeof prompt === 'string') return prompt.trim();
  return prompt
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** The files a user message carries up with its row: image and file parts,
 *  and the pasted / attached texts its tokens name; null when it has none. */
function roomUpload(
  prompt: DesktopPromptContent,
  pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'>
): NonNullable<RoomRow['upload']> | null {
  const parts = typeof prompt === 'string' ? [] : prompt.filter((part) => part.type !== 'text');
  const pastedImages = Object.keys(pasted.pastedImages ?? {}).length ? pasted.pastedImages : undefined;
  const pastedTexts = Object.keys(pasted.pastedTexts ?? {}).length ? pasted.pastedTexts : undefined;
  const hasUpload = parts.length || pastedImages || pastedTexts;
  return hasUpload ? { parts, ...(pastedImages && { pastedImages }), ...(pastedTexts && { pastedTexts }) } : null;
}

/** The route a room's log session is stored with: the model of the first
 *  member that has one ({} when none does). */
async function roomLogRoute(
  members: string[],
  rows: AgentCatalogRow[],
  mixyRoute: () => Promise<unknown> | undefined
): Promise<Record<string, unknown>> {
  let logRoute: Record<string, unknown> = {};
  for (const id of members) {
    logRoute = routeParams(id === MIXY_AGENT_ID ? await mixyRoute() : rows.find((row) => row.id === id)?.route);
    if (logRoute.model) break;
  }
  return logRoute;
}

export { inLogOrder } from './agent-room-log';

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

function roomDocOf(value: unknown): AgentRoomStoreDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The room records are not an object.');
  }
  const { rooms } = value as Partial<AgentRoomStoreDoc>;
  return { rooms: rooms && typeof rooms === 'object' ? rooms : {} };
}

/** A JSON file of room records, written whole and atomically. A damaged file
 *  (NUL-filled, truncated) never loses the rooms for good: it is kept aside
 *  and the last good copy, which every save keeps, is restored. */
export function createAgentRoomFileStore(filePath: string): AgentRoomStore {
  let chain: Promise<void> = Promise.resolve();
  return {
    load() {
      return readJsonState(filePath, { validate: roomDocOf, fallback: { rooms: {} } });
    },
    save(doc) {
      // The record as of this call, whatever the host changes while the write waits its turn.
      const snapshot = structuredClone(doc);
      chain = chain
        .catch(() => undefined)
        .then(async () => {
          await writeJsonAtomicAsync(filePath, snapshot, { backup: true });
        });
      return chain;
    },
  };
}

export function createAgentRooms(deps: AgentRoomDeps) {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newId = deps.newId ?? (() => `${now().toString(36)}${randomBytes(4).toString('hex')}`);
  const pollMs = deps.pollMs ?? 500;
  const log = deps.log ?? ((line: string) => console.warn(`[mixdog-rooms] ${line}`));
  const records = createRoomRecords(deps);
  const {
    loadRecords,
    ready: recordsReady,
    refreshNames,
    memberLabels,
    persist,
    roomOf,
    names,
  } = records;
  const running = new Map<string, RunState>();
  /** Per room, the send/ask requests still on their way to route(): Stop
   *  cancels them even when no exchange runs yet. */
  type IntakeRequest = { stopped: boolean; release(): void };
  const intakes = new Map<string, Set<IntakeRequest>>();
  const roomLog = createRoomLog(deps, records.rooms);
  const post = roomLog.post;
  const roomRows = roomLog.rows;

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

  /** The member's own session in the room, created on first use. Whether the
   *  member still belongs is checked in the room writes' queue, the one a
   *  removal runs in: a member removed before never gets a session, and one
   *  removed after finds it created, to delete. */
  function ensureMemberSession(roomId: string, member: { id: string; route: unknown }): Promise<string> {
    const sessionId = roomMemberSessionId(roomId, member.id);
    return writer(async () => {
      if (!records.rooms()[roomId]?.members.includes(member.id)) {
        throw new Error(`"${member.id}" is not a member of that room.`);
      }
      if (await deps.sessionExists(sessionId)) return sessionId;
      await deps.createSession(sessionId, {
        ...(member.id === MIXY_AGENT_ID
          ? routeParams(await deps.mixyRoute?.())
          : { ...routeParams(member.route), sessionProfile: { homeAgent: member.id } }),
        cwd: await deps.taskWorkspace(),
        desktopSession: { classification: 'task', projectPath: null },
      });
      return sessionId;
    });
  }

  /** What a member's turn in this room needs from the host. */
  const turnHost = (roomId: string): RoomTurnHost => ({
    roomId,
    room: () => roomOf(roomId),
    rows: () => roomRows(roomId),
    post: (rows) => post(roomId, rows),
    republish: () => deps.republish(roomSessionId(roomId)),
    memberSession: (member) => ensureMemberSession(roomId, member),
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
    exists: () => Boolean(records.rooms()[roomId]),
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

  async function create(input: Record<string, unknown>): Promise<{ sessionId: string; roomId: string }> {
    await ready();
    const config = normalizeRoomConfig(input);
    const rows = contactAgentRows(await deps.listAgents());
    const known = new Set([MIXY_AGENT_ID, ...rows.map((row) => row.id)]);
    const missing = config.members.find((id) => !known.has(id));
    if (missing) throw new Error(`Agent "${missing}" is not available.`);
    // The room's log is a stored session, and a session without a model is
    // never stored (nothing is auto-picked): it takes the model of the first
    // member that has one, and a room of members without any cannot start.
    const logRoute = await roomLogRoute(config.members, rows, () => deps.mixyRoute?.());
    if (!logRoute.model) throw new Error('No model selected. Choose a model for one of the room members first.');
    await refreshNames();
    const roomId = newId();
    const sessionId = roomSessionId(roomId);
    await deps.createSession(sessionId, {
      ...logRoute,
      cwd: await deps.taskWorkspace(),
      desktopSession: { classification: 'task', projectPath: null },
    });
    records.rooms()[roomId] = { ...config, id: roomId, createdAt: now(), cursors: {}, running: null };
    await persist();
    await deps.renameSession(sessionId, config.name).catch((error) => log(`room title: ${String(error)}`));
    deps.republishCatalog();
    return { sessionId, roomId };
  }

  async function update(roomId: string, patch: Record<string, unknown>): Promise<DesktopAgentRoomSummary> {
    await ready();
    const room = roomOf(roomId);
    const config = normalizeRoomConfig({ ...room, ...patch } as Record<string, unknown>);
    if (config.members.some((id) => !room.members.includes(id))) {
      const known = new Set([MIXY_AGENT_ID, ...contactAgentRows(await deps.listAgents()).map((row) => row.id)]);
      const missing = config.members.find((id) => !known.has(id));
      if (missing) throw new Error(`Agent "${missing}" is not available.`);
    }
    await refreshNames();
    const renamed = config.name !== room.name;
    // Members taken out leave as a deleted bot does; the roster keeps its identity.
    const gone = new Set(room.members.filter((id) => !config.members.includes(id)));
    if (gone.size) removeFromRoom(room, gone);
    const { members, ...settings } = config;
    Object.assign(room, settings);
    room.members.splice(0, room.members.length, ...members);
    await persist();
    if (renamed) await deps.renameSession(roomSessionId(roomId), config.name).catch(() => undefined);
    deps.republishCatalog();
    // Their conversations go with them (no one owns them afterwards; a member
    // added back starts a fresh one), as a deleted bot's do.
    const failed = await deleteSessions([...gone].map((id) => roomMemberSessionId(roomId, id)));
    if (failed) {
      throw new Error(`The room was updated, but ${failed} conversations of removed members could not be deleted.`);
    }
    return summaryOf(room);
  }

  async function remove(roomId: string): Promise<void> {
    await ready();
    const room = roomOf(roomId);
    stop(roomSessionId(roomId));
    delete records.rooms()[roomId];
    roomLog.forget(roomId);
    await persist();
    const failed = await deleteSessions([
      ...room.members.map((id) => roomMemberSessionId(roomId, id)),
      roomSessionId(roomId),
    ]);
    deps.republishCatalog();
    if (failed) throw new Error(`The room was removed, but ${failed} of its conversations could not be deleted.`);
  }

  // Membership belongs to the agent's existence: a bot proven deleted leaves
  // every room it was in, in the operation that finds out. A restored bot does
  // not rejoin (`update` adds it back by hand); a room keeps its id and log
  // however few members remain.

  /** The calls of `calls` addressed to `gone` end cancelled and leave it
   *  (in place: the exchange shares the array). */
  function cancelCallsTo(calls: RoomCall[], gone: ReadonlySet<string>): void {
    const kept = calls.filter((call) => !gone.has(call.agentId));
    for (const call of calls) if (gone.has(call.agentId)) call.onSettled?.({ status: 'cancelled' });
    calls.splice(0, calls.length, ...kept);
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

  /** `gone` out of `room`'s members and everything kept for them (owed turns,
   *  cursors, seen rows, calls waiting on them). The members array stays the
   *  same array: an exchange in flight holds it as its roster. */
  function removeFromRoom(room: AgentRoomRecord, gone: ReadonlySet<string>): void {
    room.members.splice(0, room.members.length, ...room.members.filter((id) => !gone.has(id)));
    if (room.owed) room.owed = room.owed.filter((id) => !gone.has(id));
    for (const id of gone) {
      delete room.cursors[id];
      if (room.seen) delete room.seen[id];
    }
    cancelOwedTo(room.id, gone);
  }

  /** `agentIds` out of every room's members; Mixy is never removed. Who left
   *  which room. */
  function dropMembers(agentIds: readonly string[]): Array<{ roomId: string; agentId: string }> {
    const ids = new Set(agentIds.filter((id) => id !== MIXY_AGENT_ID));
    const left: Array<{ roomId: string; agentId: string }> = [];
    for (const room of Object.values(records.rooms())) {
      const gone = new Set(room.members.filter((id) => ids.has(id)));
      if (!gone.size) continue;
      removeFromRoom(room, gone);
      for (const agentId of gone) left.push({ roomId: room.id, agentId });
    }
    return left;
  }

  /** Each of `sessionIds` deleted, whatever happens to the others; how many
   *  could not be. */
  async function deleteSessions(sessionIds: string[]): Promise<number> {
    let failed = 0;
    for (const id of sessionIds) await deps.deleteSession(id).catch(() => (failed += 1));
    return failed;
  }

  const memberSessionsOf = (left: Array<{ roomId: string; agentId: string }>) =>
    left.map(({ roomId, agentId }) => roomMemberSessionId(roomId, agentId));

  /** A bot whose definition was proven deleted leaves every room, saved, and
   *  its room conversations are deleted as a room's are on removal. */
  const forgetMember = (agentId: string): Promise<void> =>
    writer(async () => {
      await ready();
      const left = dropMembers([agentId]);
      if (!left.length) return;
      await persist();
      deps.republishCatalog();
      const failed = await deleteSessions(memberSessionsOf(left));
      if (failed) {
        throw new Error(`The member left its rooms, but ${failed} of its conversations could not be deleted.`);
      }
    });

  /** Once, as the rooms load: members whose definition is proven deleted
   *  (`agentDefinitionPresence`; an unknown or failed check proves nothing)
   *  leave, and the rooms are saved. */
  async function pruneDeleted(): Promise<void> {
    const ids = [...new Set(Object.values(records.rooms()).flatMap((room) => room.members))];
    if (!deps.agentPresence || !ids.some((id) => id !== MIXY_AGENT_ID)) return;
    const presence = (await deps.agentPresence(ids).catch(() => null)) as Record<string, unknown> | null;
    if (!presence || typeof presence !== 'object') return;
    const left = dropMembers(ids.filter((id) => presence[id] === 'deleted'));
    if (!left.length) return;
    await persist();
    deps.republishCatalog();
    // Load must not fail on a conversation that stays behind: it is logged.
    const failed = await deleteSessions(memberSessionsOf(left));
    if (failed) log(`${failed} conversations of members who left their rooms could not be deleted`);
  }

  let prepared: Promise<void> | null = null;
  /** The rooms loaded and pruned; every mutation starts here. */
  function ready(): Promise<void> {
    prepared ??= recordsReady()
      .then(pruneDeleted)
      .catch((error) => {
        prepared = null;
        throw error;
      });
    return prepared;
  }

  /** The one writer of room records (rooms created, changed, removed, members
   *  forgotten): each runs whole, read to save, after the one before it. */
  let writes: Promise<unknown> = Promise.resolve();
  function writer<T>(write: () => Promise<T>): Promise<T> {
    const done = writes.then(write);
    writes = done.catch(() => undefined);
    return done;
  }

  async function leave(roomId: string): Promise<void> {
    await ready();
    roomOf(roomId);
    stop(roomSessionId(roomId));
    await deps.setArchived(roomSessionId(roomId), true);
  }

  /** "대화 초기화": the room keeps its id, members and limits. Its log starts
   *  empty (the old one kept archived), every member's cursor restarts, and
   *  each member's own session is emptied with its prompt rebuilt, so the next
   *  exchange starts fresh. Refused while members are speaking. */
  async function reset(roomId: string): Promise<{ archivedSessionId: string | null }> {
    await ready();
    const room = roomOf(roomId);
    if (running.has(roomId)) throw new Error('The room is still talking; stop it or wait before resetting.');
    const archivedSessionId = await deps.startOver(roomSessionId(roomId));
    roomLog.forget(roomId);
    room.cursors = {};
    delete room.seen;
    room.owed = null;
    delete room.lastSpeaker;
    delete room.lastPreview;
    room.lastAt = now();
    await persist();
    deps.republishCatalog();
    const failed: string[] = [];
    for (const id of room.members) {
      const sessionId = roomMemberSessionId(roomId, id);
      if (!(await deps.sessionExists(sessionId).catch(() => false))) continue;
      await deps.resetMember(sessionId).catch((error) => {
        log(`room ${roomId} member ${id} reset: ${String(error)}`);
        failed.push(id);
      });
    }
    if (failed.length) {
      throw new Error(`The room was reset, but ${failed.length} of its members could not start over.`);
    }
    return { archivedSessionId };
  }

  /** A message the user sent into the room (any surface's composer), with the
   *  files it carries: image and file parts, and the pasted / attached texts
   *  its tokens name (`pasted`, the submit options' side tables). */
  const send = (
    sessionId: string,
    prompt: DesktopPromptContent,
    submissionId = '',
    pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'> = {}
  ): Promise<boolean> =>
    intake(roomIdOfSession(sessionId), (request) => acceptSend(request, sessionId, prompt, submissionId, pasted));

  async function acceptSend(
    request: IntakeRequest,
    sessionId: string,
    prompt: DesktopPromptContent,
    submissionId: string,
    pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'>
  ): Promise<boolean> {
    await ready();
    const roomId = roomIdOfSession(sessionId);
    const room = roomOf(roomId);
    // A retried submission (phone after a lost reply) that was durably
    // accepted before — this process or an earlier one — is acknowledged once.
    if (submissionId && room.submissions?.includes(submissionId)) return true;
    const labels = await memberLabels(room);
    // Names resolve against every member first, so a switched-off "Bench lead"
    // is never mistaken for "Bench"; a switched-off target is then refused.
    const parsed = parseRoomAsk(promptText(prompt), [...labels.values()]);
    if (parsed.error === 'member') throw new Error('No member of this room has that name.');
    const off = parsed.to.find((id) => labels.get(id)?.disabled);
    if (off) throw roomMemberSwitchedOffError(labels.get(off)?.name ?? off);
    // The files go up with the row: the log's intake stores them as a chat
    // prompt's are (agent-room-delivery.mjs), and the members the message
    // reaches get them on their next turn.
    const upload = roomUpload(prompt, pasted);
    if (!parsed.text && !upload) throw new Error('Write a message to send.');
    const row: RoomRow = {
      // The submission id is the row's id, so the sender's pending bubble
      // (released by id) gives way to this row instead of standing under it.
      id: /^[A-Za-z0-9_-]{1,100}$/.test(submissionId) ? submissionId : `user_${newId()}`,
      kind: 'user',
      at: now(),
      text: parsed.text,
      ...(parsed.to.length ? { to: parsed.to, toName: parsed.to.map((id) => labels.get(id)?.name ?? id) } : {}),
      ...(upload ? { upload } : {}),
    };
    await post(roomId, [row]);
    Object.assign(room, { lastSpeaker: 'user', lastAt: row.at });
    // Recorded only once the row is in the log, and saved with the room
    // before the submission is acknowledged.
    if (submissionId) room.submissions = [...(room.submissions ?? []), submissionId].slice(-SUBMISSION_IDS);
    // Taken up as soon as the row is in the log, before the save yields: a
    // member's older answer cannot land meanwhile, and a second message never
    // starts an exchange of its own beside this one.
    if (!request.stopped) route(roomId, { to: parsed.to, waiting: true });
    request.release();
    await persist();
    deps.republishCatalog();
    return true;
  }

  /** The member a message from another session addresses (room host
   *  `member`, agent-room-host.mjs): `to` (an agent id or display name), else
   *  a leading `@name` in `prompt`; its member session exists afterwards. */
  async function addressee(
    sessionId: string,
    { to, prompt }: { to?: unknown; prompt?: unknown }
  ): Promise<{ agentId: string; name: string; sessionId: string; text: string }> {
    await ready();
    const roomId = roomIdOfSession(sessionId);
    const room = roomOf(roomId);
    const labels = await memberLabels(room);
    const members = [...labels.values()];
    const named = typeof to === 'string' ? to.trim() : '';
    const asked = typeof prompt === 'string' ? prompt.trim() : '';
    // `to`, else a leading `@name`, resolved against `list`.
    const resolveIn = (list: MemberLabel[]) => {
      let id = roomMemberNamed(named, list);
      let body = asked;
      if (!named && asked.startsWith('@')) {
        const parsed = parseRoomAsk(`/ask ${asked.slice(1)}`, list);
        if (parsed.to.length === 1 && parsed.text) [id, body] = [parsed.to[0], parsed.text];
      }
      return { id, body };
    };
    const { id: agentId, body: text } = resolveIn(members);
    const roster = members.map((member) => `${member.name} (${member.id})`).join(', ');
    if (agentId && labels.get(agentId)?.disabled) {
      throw new Error(`"${labels.get(agentId)?.name ?? agentId}" in room "${room.name}" is switched off.`);
    }
    if (!agentId) {
      throw new Error(
        named
          ? `"${named}" is not a member of room "${room.name}"; its members are ${roster}.`
          : `A message to room "${room.name}" must name the member it is for (to: agent id or name); its members are ${roster}.`
      );
    }
    const member = labels.get(agentId) as MemberLabel;
    return { agentId, name: member.name, sessionId: await ensureMemberSession(roomId, member), text };
  }

  /** A message from another session (`from`) into the room, for member
   *  `agentId` alone: posted as a user-kind row naming its real sender, then
   *  routed like a user message to that member, and no other member follows
   *  up. `id` / `onSettled`: the member's turn's submission id and end. */
  const ask = (sessionId: string, options: Parameters<AgentRoomHost['ask']>[1]): Promise<boolean> =>
    intake(roomIdOfSession(sessionId), (request) => acceptAsk(request, sessionId, options));

  async function acceptAsk(
    request: IntakeRequest,
    sessionId: string,
    { agentId, prompt, from, id = '', hop = 0, onSettled, follow }: Parameters<AgentRoomHost['ask']>[1]
  ): Promise<boolean> {
    await ready();
    const roomId = roomIdOfSession(sessionId);
    const room = roomOf(roomId);
    if (!room.members.includes(agentId)) throw new Error(`"${agentId}" is not a member of room "${room.name}".`);
    const labels = await memberLabels(room);
    if (labels.get(agentId)?.disabled) throw new Error(`"${labels.get(agentId)?.name ?? agentId}" is switched off.`);
    const content = prompt as DesktopPromptContent;
    const upload = roomUpload(content, {});
    const text = promptText(content);
    if (!text && !upload) throw new Error('Write a message to send.');
    const fromAgent = from.agentId || '';
    const fromName = fromAgent ? (names.get(fromAgent) ?? fromAgent) : 'Lead';
    const row: RoomRow = {
      id: `ask_${newId()}`,
      kind: 'user',
      at: now(),
      text,
      to: [agentId],
      toName: [labels.get(agentId)?.name ?? agentId],
      fromSession: from.sessionId,
      ...(fromAgent ? { fromAgent } : {}),
      fromName,
      ...(upload ? { upload } : {}),
    };
    await post(roomId, [row]);
    room.lastAt = row.at;
    const call: RoomCall = {
      agentId,
      askedBy: fromName,
      ...(id ? { id } : {}),
      ...(hop > 0 ? { hop } : {}),
      ...(onSettled ? { onSettled } : {}),
      ...(follow ? { follow } : {}),
    };
    if (request.stopped) onSettled?.({ status: 'cancelled' });
    else route(roomId, { to: [agentId], waiting: true, only: true, calls: [call] });
    request.release();
    await persist();
    deps.republishCatalog();
    return true;
  }

  /** Member session `sessionId` relays its own reported work (`prompt`, the
   *  agent-home-delivery wake prompt) in one turn in its room, once the room
   *  is idle; `settled` resolves that turn's end status ('done' when it
   *  finished). */
  async function relay(
    sessionId: string,
    prompt: string,
    { id = '', hop = 0, follow }: NonNullable<Parameters<AgentRoomHost['relay']>[2]> = {}
  ) {
    await ready();
    const member = roomMemberOfSession(sessionId);
    if (!member) throw new TypeError('Not a group-room member session.');
    const room = roomOf(member.roomId);
    if (!room.members.includes(member.agentId)) throw new Error('That agent is no longer a member of the room.');
    let settle: (status: string) => void = () => undefined;
    const settled = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const call: RoomCall = {
      agentId: member.agentId,
      relay: prompt,
      ...(id ? { id } : {}),
      ...(hop > 0 ? { hop } : {}),
      ...(follow ? { follow } : {}),
      onSettled: (detail) => settle(detail.status),
    };
    // A relay never cuts a member off: while the room talks it waits in the
    // room's queue, which the exchange's end drains.
    if (running.get(member.roomId)?.stop) call.onSettled?.({ status: 'cancelled' });
    else if (running.has(member.roomId))
      relayQueue.set(member.roomId, [...(relayQueue.get(member.roomId) ?? []), call]);
    else route(member.roomId, { to: [member.agentId], waiting: false, only: true, calls: [call] });
    return { settled };
  }

  /** "더 진행": the named members a capped message still owes a turn, else
   *  another bounded batch the supervisor steers (it must pick a member only
   *  while the user's newest message has no answer; otherwise it may finish
   *  at once when nothing is open). */
  async function proceed(roomId: string): Promise<void> {
    await ready();
    const room = roomOf(roomId);
    if (running.has(roomId)) return;
    const owed = (room.owed ?? []).filter((id) => room.members.includes(id));
    if (owed.length) return start(roomId, { to: owed });
    start(roomId, {});
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

  const decorate = (sessionId: string, snapshot: SessionSnapshot): SessionSnapshot =>
    decorateRoomSnapshot(running.get(roomIdOfSession(sessionId)), snapshot);

  const summaryOf = (room: AgentRoomRecord): DesktopAgentRoomSummary => roomSummary(room, names, running.has(room.id));

  const withRooms = (rows: DesktopSessionSummary[]): DesktopSessionSummary[] =>
    catalogWithRooms(rows, records.rooms(), summaryOf);

  /** Start-up: an exchange a restart cut off is marked interrupted, its
   *  speaking member is stopped, and nothing resumes on its own. */
  async function recover(): Promise<string[]> {
    await loadRecords();
    // No rooms: nothing to recover or list, so start-up asks the daemon nothing.
    if (!Object.keys(records.rooms()).length) return [];
    await ready();
    const cut = Object.values(records.rooms()).filter((room) => room.running);
    for (const room of cut) {
      room.running = null;
      for (const id of room.members) void deps.abort(roomMemberSessionId(room.id, id)).catch(() => undefined);
      await post(room.id, [{ id: `row_${newId()}`, kind: 'interrupted', at: now(), text: '' }]).catch((error) =>
        log(`room ${room.id} interrupted notice: ${String(error)}`)
      );
    }
    if (cut.length) await persist();
    deps.republishCatalog();
    return cut.map((room) => room.id);
  }

  return {
    ready,
    create: (input: Record<string, unknown>) => writer(() => create(input)),
    update: (roomId: string, patch: Record<string, unknown>) => writer(() => update(roomId, patch)),
    remove: (roomId: string) => writer(() => remove(roomId)),
    forgetMember,
    leave,
    reset,
    send,
    member: addressee,
    ask,
    relay,
    proceed,
    stop,
    approve,
    decorate,
    withRooms,
    recover,
    isRoom: (sessionId: string) => Boolean(roomIdOfSession(sessionId)),
    isRunning: (roomId: string) => running.has(roomId),
  };
}

export type AgentRooms = ReturnType<typeof createAgentRooms>;
