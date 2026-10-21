// Group rooms, host side: the user invites several agents into ONE chat
// (session/agent-room.mjs). This host keeps each room's record, posts every
// row into the room's log session through the daemon, and drives the members
// strictly one at a time: after the user's addressees, a supervisor step on the
// Maintainer model picks each next speaker or ends the talk, under hard caps.
// A member speaks from its own session per room, sees only the rows new since
// it last spoke, and its write tools always ask the user (room-member-gate.mjs).
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
  roomMemberSessionId,
  roomSessionId,
  type roomTurnPrompt,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type {
  RoomDecision,
  RoomSupervisorInput,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room-supervisor.mjs';
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
import { routeParams } from './agent-home-sessions';
import { type RoomExchangeHost, runRoomExchangeIn } from './agent-room-exchange';
import { createRoomLog } from './agent-room-log';
import { createRoomRecords } from './agent-room-records';
import type { RoomTurnHost, RunState } from './agent-room-turn';
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
  /** Mixy's own route (getLeadStatus `route`), null when it has none. */
  mixyRoute?(): Promise<unknown>;
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
   *  (submitted like a chat prompt). */
  submit(sessionId: string, prompt: ReturnType<typeof roomTurnPrompt>): Promise<boolean>;
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
  const { loadRecords, ready, refreshNames, memberLabels, persist, roomOf, names } = records;
  const running = new Map<string, RunState>();
  const roomLog = createRoomLog(deps, records.rooms);
  const post = roomLog.post;
  const roomRows = roomLog.rows;

  async function ensureMemberSession(roomId: string, member: { id: string; route: unknown }): Promise<string> {
    const sessionId = roomMemberSessionId(roomId, member.id);
    if (await deps.sessionExists(sessionId)) return sessionId;
    await deps.createSession(sessionId, {
      ...(member.id === MIXY_AGENT_ID
        ? routeParams(await deps.mixyRoute?.())
        : { ...routeParams(member.route), sessionProfile: { homeAgent: member.id } }),
      cwd: await deps.taskWorkspace(),
      desktopSession: { classification: 'task', projectPath: null },
    });
    return sessionId;
  }

  /** What a member's turn in this room needs from the host. */
  const turnHost = (roomId: string): RoomTurnHost => ({
    roomId,
    room: () => roomOf(roomId),
    rows: () => roomRows(roomId),
    post: (rows) => post(roomId, rows),
    republish: () => deps.republish(roomSessionId(roomId)),
    memberSession: (member) => ensureMemberSession(roomId, member),
    submit: (sessionId, prompt) => deps.submit(sessionId, prompt),
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
    untrack: () => running.delete(roomId),
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
  const exchange = (roomId: string, options: { to?: string[]; waiting?: boolean }) =>
    runRoomExchangeIn(exchangeHost(roomId), options);

  const start = (roomId: string, options: { to?: string[]; waiting?: boolean }) => {
    // A save that fails outside the exchange's own try (before it, or in its
    // finally) is logged, never left as an unhandled rejection.
    void exchange(roomId, options).catch((error) =>
      log(`room ${roomId} exchange failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  };

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
    Object.assign(room, config);
    await persist();
    if (renamed) await deps.renameSession(roomSessionId(roomId), config.name).catch(() => undefined);
    deps.republishCatalog();
    return summaryOf(room);
  }

  async function remove(roomId: string): Promise<void> {
    await ready();
    const room = roomOf(roomId);
    stop(roomSessionId(roomId));
    delete records.rooms()[roomId];
    roomLog.forget(roomId);
    await persist();
    const failed: string[] = [];
    for (const id of room.members) {
      await deps.deleteSession(roomMemberSessionId(roomId, id)).catch(() => failed.push(id));
    }
    await deps.deleteSession(roomSessionId(roomId)).catch(() => failed.push('room'));
    deps.republishCatalog();
    if (failed.length) {
      throw new Error(`The room was removed, but ${failed.length} of its conversations could not be deleted.`);
    }
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
  async function send(
    sessionId: string,
    prompt: DesktopPromptContent,
    submissionId = '',
    pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'> = {}
  ): Promise<boolean> {
    await ready();
    const roomId = roomIdOfSession(sessionId);
    const room = roomOf(roomId);
    // A retried submission (phone after a lost reply) that was durably
    // accepted before — this process or an earlier one — is acknowledged once.
    if (submissionId && room.submissions?.includes(submissionId)) return true;
    const labels = await memberLabels(room);
    const parsed = parseRoomAsk(promptText(prompt), [...labels.values()]);
    if (parsed.error === 'member') throw new Error('No member of this room has that name.');
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
    const active = running.get(roomId);
    if (active) {
      // Several messages sent meanwhile run as one exchange: every member any
      // of them addressed keeps its turn, in the order named.
      active.pending = { to: [...new Set([...(active.pending?.to ?? []), ...parsed.to])], waiting: true };
      // The member speaking answers rows older than this message: cut it off
      // now (its turn posts nothing) rather than at the next turn boundary.
      if (active.speaking && active.memberSession) void deps.abort(active.memberSession).catch(() => undefined);
    } else start(roomId, { to: parsed.to, waiting: true });
    await persist();
    deps.republishCatalog();
    return true;
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
   *  else gets a turn. */
  function stop(sessionId: string): boolean {
    const state = running.get(roomIdOfSession(sessionId));
    if (!state) return false;
    state.stop = true;
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
    create,
    update,
    remove,
    leave,
    reset,
    send,
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
