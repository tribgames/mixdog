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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type RoomConfig,
  type RoomRow,
  type RoomTurn,
  type RoomTurnAnswer,
  isPassReply,
  normalizeRoomConfig,
  parseRoomAsk,
  roomIdOfSession,
  roomMemberOfSession,
  roomMemberSessionId,
  roomMentionOf,
  roomRowsOfItems,
  roomMessageBudget,
  roomSessionId,
  roomTurnPrompt,
  roomUserWaiting,
  rowsSinceCursor,
  runRoomExchange,
  withoutPassMarker,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import {
  type RoomDecision,
  type RoomSupervisorInput,
  roomSupervisorRows,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room-supervisor.mjs';
import { plainPreviewText } from '../../../../src/runtime/shared/plain-preview.mjs';
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
import { sessionFinalAnswer } from './session-final-answer';

export interface AgentRoomRecord extends RoomConfig {
  id: string;
  createdAt: number;
  /** Per member: the id of the last room row it was shown. */
  cursors: Record<string, string>;
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
   *  `decideRoomTurn`): the next speaker, finish, or null for no usable answer. */
  decideTurn(input: RoomSupervisorInput): Promise<RoomDecision | null>;
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

/** The exchange of one room in flight. */
interface RunState {
  stop: boolean;
  speaking: string;
  speakingName: string;
  /** The typing row's id for the turn in flight, unique for the room's life.
   *  The views carry a typing row's id over to the message that replaces it
   *  (transcript-identity.ts), so an id built from speaker and round came back
   *  in the next exchange: two rows shared one key, and the transcript's rows
   *  fought over one measured size and shook up and down. */
  typingId: string;
  memberSession: string;
  approval: Record<string, unknown> | null;
  /** A message sent while members were speaking: the turns still queued are
   *  dropped at the next turn boundary and its exchange runs next. */
  pending: { to: string[] } | null;
}

const TOOL_SUMMARY = 400;
const RECENT_ROWS = 200;
const SUBMISSION_IDS = 64;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A catalog row's display name, as its contact row shows it. */
function agentName(row: { id: string; label?: unknown; definition?: unknown }): string {
  const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return text((definition as { name?: unknown }).name) || text(row.label) || row.id;
}

/** A catalog row's description, '' when it has none (the supervisor prompt
 *  keeps its first line, bounded). */
function agentDescription(row: { description?: unknown; definition?: unknown }): string {
  const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return text(row.description) || text((definition as { description?: unknown }).description);
}

interface MemberLabel {
  id: string;
  name: string;
  route: unknown;
  description: string;
}

function promptText(prompt: DesktopPromptContent): string {
  if (typeof prompt === 'string') return prompt.trim();
  return prompt
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** A finished member turn's tool calls, one bounded line each. */
function toolSummaries(snapshot: SessionSnapshot, startedAt: number): Array<{ name: string; summary: string }> {
  const items = (snapshot?.items ?? []) as Array<Record<string, unknown>>;
  let start = items.length;
  while (start > 0 && items[start - 1]?.kind !== 'user') start -= 1;
  return items
    .slice(start)
    .filter((item) => item.kind === 'tool' && (Number(item.at) || startedAt) >= startedAt)
    .map((item) => {
      const result = typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
      return { name: String(item.name || 'tool'), summary: result.slice(0, TOOL_SUMMARY) };
    });
}

/** A turn that finished without any reply text: a member saying nothing
 *  passes (sessionFinalAnswer waits for text, which never comes). */
function emptyFinishedTurn(snapshot: SessionSnapshot, startedAt: number): ReturnType<typeof sessionFinalAnswer> {
  if (!snapshot || snapshot.busy || snapshot.streamingTail) return null;
  const items = (snapshot.items ?? []) as Array<Record<string, unknown>>;
  const done = [...items].reverse().find((item) => item.kind === 'turndone');
  if (done?.status !== 'done' || typeof done.at !== 'number' || done.at < startedAt) return null;
  const last = items.at(-1);
  if (last !== done) return null;
  const answer = items.find((item) => item.id === done.finalAssistantId && item.kind === 'assistant');
  if (answer && String(answer.text ?? '').trim()) return null;
  return { id: done.id as string, at: done.at, status: 'done', text: '' };
}

/** A JSON file of room records, written whole and atomically. */
export function createAgentRoomFileStore(filePath: string): AgentRoomStore {
  let chain: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as AgentRoomStoreDoc;
        return { rooms: parsed && typeof parsed.rooms === 'object' && parsed.rooms ? parsed.rooms : {} };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { rooms: {} };
        throw error;
      }
    },
    save(doc) {
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      chain = chain
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dirname(filePath), { recursive: true });
          const temp = `${filePath}.${process.pid}.tmp`;
          await writeFile(temp, body, 'utf8');
          await rename(temp, filePath);
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
  let doc: AgentRoomStoreDoc = { rooms: {} };
  let loaded: Promise<void> | null = null;
  const running = new Map<string, RunState>();
  /** Rows this host posted, per room: read back with the log, so a row the
   *  log's projection has not caught up with is never missed. */
  const recent = new Map<string, RoomRow[]>();
  /** Agent display names by id, refreshed whenever the agents are listed. */
  const names = new Map<string, string>();

  let stored: Promise<void> | null = null;
  /** The room records alone: no daemon call. */
  function loadRecords(): Promise<void> {
    stored ??= deps.store.load().then((value) => {
      doc = value;
    });
    return stored;
  }

  function ready(): Promise<void> {
    loaded ??= loadRecords().then(refreshNames);
    return loaded;
  }

  async function refreshNames(): Promise<void> {
    // Every user-made definition names its member, a bot or not: a member of
    // a 1.3.0 room that is a workflow agent now keeps its name.
    const listed = await deps.listAgents().catch(() => []);
    const rows = Array.isArray(listed)
      ? listed.filter((row): row is AgentCatalogRow & { id: string } => {
          const entry = row as AgentCatalogRow | null;
          return entry?.custom === true && typeof entry.id === 'string' && Boolean(entry.id);
        })
      : [];
    for (const row of rows) names.set(row.id, agentName(row));
    names.set(MIXY_AGENT_ID, await mixyName());
  }
  const mixyName = async () => (await deps.leadName?.().catch(() => '')) || 'Mixy';
  const persist = () => deps.store.save(doc);
  const roomOf = (roomId: string): AgentRoomRecord => {
    const room = doc.rooms[roomId];
    if (!room) throw new Error('This room no longer exists.');
    return room;
  };

  async function memberLabels(room: AgentRoomRecord): Promise<Map<string, MemberLabel>> {
    const rows = contactAgentRows(await deps.listAgents().catch(() => []));
    const labels = new Map<string, MemberLabel>();
    const lead = room.members.includes(MIXY_AGENT_ID) ? await mixyName() : '';
    for (const id of room.members) {
      const row = rows.find((entry) => entry.id === id);
      const isLead = id === MIXY_AGENT_ID;
      const rowName = row ? agentName(row) : (names.get(id) ?? id);
      const name = isLead ? lead : rowName;
      if (row) names.set(id, name);
      const rowDescription = row ? agentDescription(row) : '';
      const description = isLead ? "The user's main assistant." : rowDescription;
      labels.set(id, { id, name, route: row?.route, description });
    }
    return labels;
  }

  async function post(roomId: string, rows: RoomRow[]): Promise<void> {
    const stored = (await deps.appendRows(roomSessionId(roomId), rows)) as { rows?: unknown } | undefined;
    // The log's copies: a user row's files as stored references, never bytes.
    const kept = Array.isArray(stored?.rows) ? (stored.rows as RoomRow[]) : rows;
    const list = [...(recent.get(roomId) ?? []), ...kept].slice(-RECENT_ROWS);
    recent.set(roomId, list);
    // The list row's preview follows every spoken line, as a home thread's does.
    const said = [...rows].reverse().find((row) => row.kind === 'user' || row.kind === 'speech');
    const room = doc.rooms[roomId];
    if (said && room) {
      room.lastPreview = plainPreviewText(said.text).slice(0, 200);
      deps.republishCatalog();
    }
  }

  async function roomRows(roomId: string): Promise<RoomRow[]> {
    const read = roomRowsOfItems(await deps.readItems(roomSessionId(roomId)).catch(() => []));
    const ids = new Set(read.map((row) => row.id));
    return [...read, ...(recent.get(roomId) ?? []).filter((row) => !ids.has(row.id))];
  }

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

  /** One member's turn: hand it the new rows, wait for its answer (relaying
   *  any approval it asks for into the room), then post its words or a pass. */
  async function speak(
    roomId: string,
    state: RunState,
    labels: Map<string, MemberLabel>,
    agentId: string,
    { addressed, instruction, mentionedBy, scene }: RoomTurn
  ): Promise<RoomTurnAnswer> {
    const room = roomOf(roomId);
    const member = labels.get(agentId) ?? { id: agentId, name: agentId, route: undefined, description: '' };
    Object.assign(state, {
      speaking: agentId,
      speakingName: member.name,
      typingId: `room-typing-${newId()}`,
      approval: null,
    });
    deps.republish(roomSessionId(roomId));
    const passRow = (failed = false): RoomRow => ({
      id: `row_${newId()}`,
      kind: 'pass',
      speaker: agentId,
      name: member.name,
      at: now(),
      text: '',
      ...(failed ? { failed: true } : {}),
    });
    let answer: ReturnType<typeof sessionFinalAnswer> = null;
    let snapshot: SessionSnapshot = null;
    let startedAt = 0;
    // Whether the user's newest message still has no answer in the room.
    let waiting = false;
    try {
      const sessionId = await ensureMemberSession(roomId, member);
      state.memberSession = sessionId;
      const rows = await roomRows(roomId);
      waiting = roomUserWaiting(rows);
      const prompt = roomTurnPrompt({
        roomName: room.name,
        self: member,
        members: room.members.map((id) => labels.get(id) ?? { id, name: id }),
        rows: rowsSinceCursor(rows, room.cursors[agentId], agentId),
        shareTools: room.shareTools,
        addressed,
        mentionedBy: mentionedBy ? (labels.get(mentionedBy)?.name ?? mentionedBy) : '',
        instruction,
        scene,
      });
      const last = rows.at(-1);
      if (last) room.cursors[agentId] = last.id;
      if (state.stop) return 'stopped';
      startedAt = now();
      if (!(await deps.submit(sessionId, prompt))) throw new Error('the turn was not accepted');
      let misses = 0;
      while (!answer) {
        if (state.stop) return 'stopped';
        await sleep(pollMs);
        try {
          snapshot = await deps.readSnapshot(sessionId);
          misses = 0;
        } catch (error) {
          misses += 1;
          if (misses >= 6) throw error;
          continue;
        }
        const approval = (snapshot?.toolApproval as Record<string, unknown> | null | undefined) ?? null;
        if (String(approval?.id ?? '') !== String(state.approval?.id ?? '')) {
          state.approval = approval;
          deps.republish(roomSessionId(roomId));
        }
        answer = sessionFinalAnswer(snapshot, startedAt) ?? emptyFinishedTurn(snapshot, startedAt);
      }
    } catch (error) {
      log(`${agentId} could not speak in room ${roomId}: ${error instanceof Error ? error.message : String(error)}`);
      if (state.stop) return 'stopped';
      await post(roomId, [passRow(true)]);
      return 'pass';
    } finally {
      state.approval = null;
      void persist();
    }
    if (!answer || (answer.status === 'cancelled' && state.stop)) return 'stopped';
    // A pass never shows its marker: while the user waits, what the member
    // wrote before "(pass)" is its answer; otherwise the turn is a pass.
    const passed = answer.status !== 'done' || isPassReply(answer.text);
    const text = answer.status === 'done' && (!passed || waiting) ? withoutPassMarker(answer.text) : '';
    if (!text) {
      await post(roomId, [passRow(answer.status !== 'done')]);
      return 'pass';
    }
    const row: RoomRow = {
      id: `row_${newId()}`,
      kind: 'speech',
      speaker: agentId,
      name: member.name,
      at: now(),
      text,
      // The log takes in the files this turn produced (agent-room-delivery.mjs).
      ...(state.memberSession ? { artifactsFrom: { sessionId: state.memberSession, since: startedAt } } : {}),
    };
    // The one peer the speech addresses: shown on its bubble, and a turn for
    // that peer, never authority.
    const mention = roomMentionOf(
      row.text,
      room.members.map((id) => labels.get(id) ?? { id, name: id }),
      agentId
    );
    if (mention) Object.assign(row, { to: [mention], toName: [labels.get(mention)?.name ?? mention] });
    const tools = toolSummaries(snapshot, startedAt);
    if (tools.length) row.tools = tools;
    await post(roomId, [row]);
    Object.assign(room, { lastSpeaker: agentId, lastAt: row.at });
    room.cursors[agentId] = row.id;
    return { result: 'speech', mention };
  }

  /** One bounded exchange; a message sent meanwhile runs the next one. */
  async function exchange(roomId: string, { to = [] }: { to?: string[] }) {
    const room = roomOf(roomId);
    const state: RunState = {
      stop: false,
      speaking: '',
      speakingName: '',
      typingId: '',
      memberSession: '',
      approval: null,
      pending: null,
    };
    running.set(roomId, state);
    room.running = { startedAt: now() };
    // Any new exchange settles what an earlier capped one still owed.
    room.owed = null;
    await persist();
    deps.republishCatalog();
    deps.republish(roomSessionId(roomId));
    try {
      const labels = await memberLabels(room);
      const members = room.members.map((id) => labels.get(id) ?? { id, name: id, route: undefined, description: '' });
      const result = await runRoomExchange({
        members: room.members,
        to,
        maxRounds: room.maxRounds,
        // A user-addressed set keeps the full cap; a free exchange stops at a
        // budget drawn each time, so it does not always end at the same count.
        maxMessages: to.length ? room.maxMessages : roomMessageBudget(room.members.length, room.maxMessages, random),
        speak: (agentId, turn) => speak(roomId, state, labels, agentId, turn),
        decide: async (step) => {
          // Nobody is typing while the supervisor decides.
          Object.assign(state, { speaking: '', speakingName: '', memberSession: '' });
          deps.republish(roomSessionId(roomId));
          const decision = await deps
            .decideTurn({
              roomName: room.name,
              members: members.map(({ id, name, description }) => ({ id, name, description })),
              rows: roomSupervisorRows(await roomRows(roomId)),
              turns: step.turns,
              mustPick: step.mustPick,
              last: step.last,
              remaining: step.remaining,
            })
            .catch((error) => {
              log(`room ${roomId} supervisor failed: ${error instanceof Error ? error.message : String(error)}`);
              return undefined;
            });
          if (decision === null) log(`room ${roomId} supervisor gave no usable decision; falling back`);
          return decision ?? null;
        },
        stopped: () => state.stop,
        superseded: () => Boolean(state.pending),
      });
      if (result.outcome === 'capped') {
        const { limit, rounds, messages, remaining } = result;
        if (remaining?.length) room.owed = remaining;
        await post(roomId, [{ id: `row_${newId()}`, kind: 'cap', at: now(), text: '', limit, rounds, messages }]);
      } else if (result.outcome === 'stopped') {
        await post(roomId, [{ id: `row_${newId()}`, kind: 'stopped', at: now(), text: '' }]);
      }
    } catch (error) {
      log(`room ${roomId} exchange failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.delete(roomId);
      if (doc.rooms[roomId]) doc.rooms[roomId].running = null;
      await persist();
      deps.republishCatalog();
      deps.republish(roomSessionId(roomId));
    }
    if (state.pending && !state.stop && doc.rooms[roomId]) await exchange(roomId, state.pending);
  }

  const start = (roomId: string, options: { to?: string[] }) => {
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
    let logRoute: Record<string, unknown> = {};
    for (const id of config.members) {
      logRoute = routeParams(
        id === MIXY_AGENT_ID ? await deps.mixyRoute?.() : rows.find((row) => row.id === id)?.route
      );
      if (logRoute.model) break;
    }
    if (!logRoute.model) throw new Error('No model selected. Choose a model for one of the room members first.');
    await refreshNames();
    const roomId = newId();
    const sessionId = roomSessionId(roomId);
    await deps.createSession(sessionId, {
      ...logRoute,
      cwd: await deps.taskWorkspace(),
      desktopSession: { classification: 'task', projectPath: null },
    });
    doc.rooms[roomId] = { ...config, id: roomId, createdAt: now(), cursors: {}, running: null };
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
    delete doc.rooms[roomId];
    recent.delete(roomId);
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
    recent.delete(roomId);
    room.cursors = {};
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
    const parts = typeof prompt === 'string' ? [] : prompt.filter((part) => part.type !== 'text');
    const pastedImages = Object.keys(pasted.pastedImages ?? {}).length ? pasted.pastedImages : undefined;
    const pastedTexts = Object.keys(pasted.pastedTexts ?? {}).length ? pasted.pastedTexts : undefined;
    const hasUpload = parts.length || pastedImages || pastedTexts;
    const upload = hasUpload
      ? { parts, ...(pastedImages ? { pastedImages } : {}), ...(pastedTexts ? { pastedTexts } : {}) }
      : null;
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
    await persist();
    deps.republishCatalog();
    const active = running.get(roomId);
    if (active) active.pending = { to: parsed.to };
    else start(roomId, { to: parsed.to });
    return true;
  }

  /** "더 진행": the named members a capped message still owes a turn, else
   *  another bounded batch the supervisor steers (it picks at least one
   *  member before it may finish). */
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

  /** The room log as its views see it: busy while members speak (so the
   *  composer offers stop), the speaking member's pending approval, and a
   *  typing row naming who is speaking. */
  function decorate(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot {
    const state = running.get(roomIdOfSession(sessionId));
    if (!state || !snapshot || typeof snapshot !== 'object') return snapshot;
    const typing = state.speaking
      ? [
          {
            kind: 'notice',
            id: state.typingId,
            tone: 'info',
            text: `${state.speakingName}…`,
            room: {
              kind: 'typing',
              speaker: state.speaking,
              name: state.speakingName,
            },
          },
        ]
      : [];
    return {
      ...snapshot,
      busy: true,
      ...(state.approval ? { toolApproval: state.approval } : {}),
      items: [...(snapshot.items ?? []), ...typing],
    } as SessionSnapshot;
  }

  function summaryOf(room: AgentRoomRecord): DesktopAgentRoomSummary {
    return {
      id: room.id,
      name: room.name,
      members: [...room.members],
      maxRounds: room.maxRounds,
      maxMessages: room.maxMessages,
      shareTools: room.shareTools,
      ...(room.lastSpeaker ? { lastSpeaker: room.lastSpeaker } : {}),
      ...(room.lastPreview ? { lastPreview: room.lastPreview } : {}),
      memberNames: Object.fromEntries(room.members.map((id) => [id, names.get(id) ?? id])),
      ...(running.has(room.id) ? { running: true } : {}),
    };
  }

  /** The session catalog with every room's log stamped (a room whose log has
   *  no catalog row yet gets one) and member sessions left out. */
  function withRooms(rows: DesktopSessionSummary[]): DesktopSessionSummary[] {
    const listed = new Set<string>();
    const stamped = rows.flatMap((row) => {
      if (roomMemberOfSession(row.id)) return [];
      const roomId = roomIdOfSession(row.id);
      const room = roomId ? doc.rooms[roomId] : undefined;
      if (!room) return roomId ? [] : [row];
      listed.add(roomId);
      return [{ ...row, title: room.name, agentRoom: summaryOf(room) }];
    });
    const unlisted = Object.values(doc.rooms)
      .filter((room) => !listed.has(room.id))
      .map(
        (room): DesktopSessionSummary => ({
          id: roomSessionId(room.id),
          preview: '',
          title: room.name,
          updatedAt: room.lastAt ?? room.createdAt,
          activityAt: room.lastAt ?? room.createdAt,
          messageCount: 0,
          cwd: '',
          classification: 'task',
          projectPath: null,
          agentRoom: summaryOf(room),
        })
      );
    return [...unlisted, ...stamped];
  }

  /** Start-up: an exchange a restart cut off is marked interrupted, its
   *  speaking member is stopped, and nothing resumes on its own. */
  async function recover(): Promise<string[]> {
    await loadRecords();
    // No rooms: nothing to recover or list, so start-up asks the daemon nothing.
    if (!Object.keys(doc.rooms).length) return [];
    await ready();
    const cut = Object.values(doc.rooms).filter((room) => room.running);
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
