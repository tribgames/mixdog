// One member's turn in a group room (agent-rooms.ts drives the exchange):
// hand the member the rows new since it last spoke, wait for its answer while
// relaying any approval it asks for, then post its words or a pass.
import {
  type RoomRow,
  type RoomTurn,
  type RoomTurnAnswer,
  isPassReply,
  roomMentionOf,
  roomTurnPrompt,
  roomUsageLimit,
  rowsSinceCursor,
  withoutPassMarker,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { AgentRoomTurnDetail } from '../../../../src/runtime/shared/agent-room-host.mjs';
import { PROMPT_ORIGIN_AGENT_REPORT as AGENT_REPORT_ORIGIN } from '../../../../src/runtime/shared/prompt-origin.mjs';
import type { SessionSnapshot } from '../shared/contract';
import type { AgentRoomRecord } from './agent-rooms';
import { sessionFinalAnswer } from './session-final-answer';

/** The exchange of one room in flight. */
export interface RunState {
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
  /** A message sent (or a relay asked for) while members were speaking: the
   *  turns still queued are dropped at the next turn boundary and its
   *  exchange runs next. */
  pending: RoomExchangeOptions | null;
  /** The calls this exchange still owes a turn (shared with the exchange, which
   *  takes them out as members answer): a removed member's end cancelled. */
  calls: RoomCall[];
  /** The user's newest message has no answer from this exchange yet: set when
   *  a user message starts it, cleared by its first speech. A reply the member
   *  in flight finishes after a newer message is not an answer to it. */
  waiting: boolean;
  /** Turns that failed and are not shown yet: a run of them posts as one row
   *  (postFailures) before the next row of any kind lands. */
  failures: Array<{ id: string; name: string; reason: string }>;
}

/** A member's turn another session waits on: a message it sent into the room
 *  (`askedBy`), or the member relaying its own reported work (`relay`).
 *  `id`: the submission id the caller watches; `used`: a turn cut short was
 *  already submitted under it (never submitted again); `hop`: its place in a
 *  bot-to-bot chain (bot-hops.mjs); `onSettled`: its end, in a session turn's
 *  shape, called once; `follow(submissionId)`: the caller's watch follows the
 *  turn submitted under another id that answers it (awaited before submit). */
export interface RoomCall {
  agentId: string;
  id?: string;
  used?: boolean;
  /** Its watch follows another submission id than its own. */
  followed?: boolean;
  hop?: number;
  askedBy?: string;
  relay?: string;
  /** A combined call (combinedCall) whose every call is a relay. */
  relayOnly?: boolean;
  onSettled?(detail: AgentRoomTurnDetail): void;
  follow?(submissionId: string): unknown;
}

/** One exchange's start: the called members (`to`), whether a message waits
 *  for an answer, `only` (the called members answer, nobody follows) and the
 *  turns other sessions wait on. */
export interface RoomExchangeOptions {
  to?: string[];
  waiting?: boolean;
  only?: boolean;
  /** The request (or a request merged into it) addressed the whole room,
   *  as its sender stated it (scheduler.route). */
  everyone?: boolean;
  calls?: RoomCall[];
}

export interface MemberLabel {
  id: string;
  name: string;
  route: unknown;
  description: string;
  /** Switched off: still a member (name, session, history), but never a new speaker. */
  disabled?: boolean;
}

/** What a member's turn needs from the room host, bound to one room. */
export interface RoomTurnHost {
  roomId: string;
  /** The room's record; throws once the room no longer exists. */
  room(): AgentRoomRecord;
  /** The room's rows in log order. */
  rows(): Promise<RoomRow[]>;
  post(rows: RoomRow[]): Promise<void>;
  /** Publish the room log's held snapshot again. */
  republish(): void;
  /** The member's own session in this room, created on first use. */
  memberSession(member: { id: string; route: unknown }): Promise<string>;
  /** Whether the member's bot is switched off now (it may be turned off mid-exchange). */
  switchedOff(agentId: string): Promise<boolean>;
  submit(
    sessionId: string,
    prompt: ReturnType<typeof roomTurnPrompt>,
    options?: { id?: string; hop?: number; roomRow?: string; origin?: typeof AGENT_REPORT_ORIGIN }
  ): Promise<boolean>;
  readSnapshot(sessionId: string): Promise<SessionSnapshot>;
  abort(sessionId: string): Promise<void>;
  persist(): Promise<void>;
  now(): number;
  newId(): string;
  sleep(ms: number): Promise<void>;
  pollMs: number;
  log(line: string): void;
}

const TOOL_SUMMARY = 400;

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

/** The held failures as one failed-pass row naming every member and each
 *  distinct reason; nothing is posted when none is held. */
export async function postFailures(host: RoomTurnHost, state: RunState): Promise<void> {
  const failures = state.failures.splice(0);
  if (!failures.length) return;
  const names = [...new Set(failures.map((failure) => failure.name))];
  const reasons = [...new Set(failures.map((failure) => failure.reason).filter(Boolean))];
  await host.post([
    {
      id: `row_${host.newId()}`,
      kind: 'pass',
      speaker: failures[0].id,
      name: names[0],
      names,
      at: host.now(),
      text: '',
      failed: true,
      reason: reasons,
    },
  ]);
}

/** A pass never shows its marker: while the user waits, what the member
 *  wrote before "(pass)" is its answer; otherwise the turn is a pass. */
function spokenText(answer: NonNullable<ReturnType<typeof sessionFinalAnswer>>, waiting: boolean): string {
  const passed = answer.status !== 'done' || isPassReply(answer.text);
  return answer.status === 'done' && (!passed || waiting) ? withoutPassMarker(answer.text) : '';
}

/** One member's turn: hand it the new rows, wait for its answer (relaying
 *  any approval it asks for into the room), then post its words or a pass.
 *  The turns other sessions wait on for this member (`calls`) are all
 *  answered by this one turn: each is told how it ended, done with the posted
 *  words ('' for a pass), failed, or cancelled on a stop. A turn a newer
 *  message cut short settles none of them: the exchange hands them on to the
 *  next one (a submission id this turn used is not used again). The turn
 *  takes the first unused submission id among them (a fresh one when all are
 *  used) and their highest hop; every covered call's watch follows that id,
 *  recorded before the turn is submitted (a failed record fails the calls
 *  and submits nothing). */
export async function speakInRoom(
  host: RoomTurnHost,
  state: RunState,
  labels: Map<string, MemberLabel>,
  agentId: string,
  turn: RoomTurn,
  calls: RoomCall[] = []
): Promise<RoomTurnAnswer> {
  const settle = (detail: AgentRoomTurnDetail) => {
    for (const call of calls) call.onSettled?.(detail);
  };
  const call = calls.length ? combinedCall(host, agentId, calls) : undefined;
  const outcome = { text: '', failed: false, submitted: false, removed: false };
  let answer: RoomTurnAnswer;
  try {
    answer = await memberTurn(host, state, labels, agentId, turn, call, outcome);
  } catch (error) {
    settle({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const result = typeof answer === 'string' ? answer : answer.result;
  if (result === 'superseded') {
    if (outcome.submitted) for (const each of calls) if (each.id === call?.id) each.used = true;
  } else if (result === 'stopped' || outcome.removed) settle({ status: 'cancelled' });
  else if (outcome.failed) settle({ status: 'failed', error: 'The member could not reply in the room.' });
  else settle({ status: 'done', result: { content: outcome.text } });
  return answer;
}

/** One turn's view of every call it answers: its submission id (the first
 *  unused one, else a fresh one), the highest hop, every asker and every
 *  relay; its `follow(id)` points every covered call's watch at that id. */
function combinedCall(host: RoomTurnHost, agentId: string, calls: RoomCall[]): RoomCall {
  const unused = calls.find((call) => call.id && !call.used)?.id;
  const id = unused || (calls.some((call) => call.id) ? `rturn_${host.newId()}` : '');
  const hop = Math.max(0, ...calls.map((call) => Number(call.hop) || 0));
  const askedBy = [...new Set(calls.map((call) => call.askedBy).filter(Boolean))].join(', ');
  const relay = calls
    .map((call) => call.relay)
    .filter(Boolean)
    .join('\n\n');
  // Every covered watch points at this turn: the calls answered under another
  // id, and a call whose own id is this turn's after an earlier turn had it
  // follow another (its old alias is replaced). A record that cannot be
  // written fails the turn before it is submitted.
  const follow = async (turnId: string) => {
    for (const each of calls) {
      if (!each.id || !each.follow || (each.id === turnId && !each.followed)) continue;
      await each.follow(turnId);
      each.followed = each.id !== turnId;
    }
  };
  // Every call is a relay of the member's own reported work: a turn the
  // runtime starts, not the user or a peer asking.
  const relayOnly = calls.length > 0 && calls.every((call) => Boolean(call.relay));
  return { agentId, ...(id ? { id } : {}), ...(hop > 0 ? { hop } : {}), askedBy, relay, relayOnly, follow };
}

type HaltOutcome = 'stopped' | 'unavailable' | 'superseded';

/** Reads the member's session until it has answered: the answer and the
 *  snapshot it came from, or how the turn was halted (`halted`: null while it
 *  may go on). Six reads in a row that fail end the wait with the error. */
async function pollForAnswer(
  host: RoomTurnHost,
  state: RunState,
  sessionId: string,
  startedAt: number,
  halted: () => Promise<HaltOutcome> | null
): Promise<{ answer: NonNullable<ReturnType<typeof sessionFinalAnswer>>; snapshot: SessionSnapshot } | HaltOutcome> {
  let snapshot: SessionSnapshot = null;
  let misses = 0;
  for (;;) {
    const halt = halted();
    if (halt) return await halt;
    await host.sleep(host.pollMs);
    try {
      snapshot = await host.readSnapshot(sessionId);
      misses = 0;
    } catch (error) {
      misses += 1;
      if (misses >= 6) throw error;
      continue;
    }
    if (state.stop) return 'stopped';
    const approval = (snapshot?.toolApproval as Record<string, unknown> | null | undefined) ?? null;
    if (String(approval?.id ?? '') !== String(state.approval?.id ?? '')) {
      state.approval = approval;
      host.republish();
    }
    const answer = sessionFinalAnswer(snapshot, startedAt) ?? emptyFinishedTurn(snapshot, startedAt);
    if (answer) return { answer, snapshot };
  }
}

async function memberTurn(
  host: RoomTurnHost,
  state: RunState,
  labels: Map<string, MemberLabel>,
  agentId: string,
  { addressed, instruction, mentionedBy, scene }: RoomTurn,
  call: RoomCall | undefined,
  outcome: { text: string; failed: boolean; submitted: boolean; removed: boolean }
): Promise<RoomTurnAnswer> {
  const { now, newId } = host;
  const room = host.room();
  const member = labels.get(agentId) ?? { id: agentId, name: agentId, route: undefined, description: '' };
  // A member removed from the room (its bot was deleted) gets no turn, and one
  // in flight is aborted: nothing is posted, its cursors go, its calls end
  // cancelled (speakInRoom).
  let sessionId = '';
  const gone = () => !room.members.includes(agentId);
  const left = async (): Promise<'unavailable'> => {
    outcome.removed = true;
    delete room.cursors[agentId];
    if (room.seen) delete room.seen[agentId];
    if (sessionId) await host.abort(sessionId).catch(() => undefined);
    return 'unavailable';
  };
  if (gone()) return await left();
  // A bot switched off since the exchange began stays a member (cursors,
  // session, history) but takes no turn; the calls waiting on it end cancelled.
  if (await host.switchedOff(agentId)) {
    outcome.removed = true;
    return 'unavailable';
  }
  // Whether the user's newest message still has no answer in the room.
  const waiting = state.waiting;
  const rows = await host.rows();
  let shown = rowsSinceCursor(rows, room.cursors[agentId], agentId, room.seen?.[agentId]);
  // A user still waiting keeps their newest message in view, as context
  // when this member was already handed it.
  const asked = waiting ? [...rows].reverse().find((row) => row.kind === 'user') : undefined;
  if (asked && !shown.some((row) => row.id === asked.id)) shown = [{ ...asked, seen: true }, ...shown];
  // Nothing new, nobody asking for it (the user, a peer's @mention or the
  // supervisor's note) and no user waiting: there is no turn to hand, so
  // none is; the member counts as passing and nothing is posted.
  const called = addressed.length > 0 || Boolean(mentionedBy) || Boolean(instruction.trim()) || Boolean(call);
  if (!waiting && !called && !shown.some((row) => !row.seen)) return 'pass';
  Object.assign(state, {
    speaking: agentId,
    speakingName: member.name,
    typingId: `room-typing-${newId()}`,
    memberSession: '',
    approval: null,
  });
  host.republish();
  // A newer user message cuts this turn short: its answer would only
  // respond to rows older than that message, so nothing is posted for it
  // (no speech, no pass), the member's session is aborted, and the rows it
  // was handed come again on its next turn, marked as already shown
  // (`seen` stays), with the message that cut it off as the new request.
  const cursorBefore = room.cursors[agentId];
  const interrupted = () => Boolean(state.pending) && !state.stop;
  const cutShort = async (): Promise<'superseded'> => {
    if (cursorBefore === undefined) delete room.cursors[agentId];
    else room.cursors[agentId] = cursorBefore;
    if (state.memberSession) await host.abort(state.memberSession).catch(() => undefined);
    return 'superseded';
  };
  const passRow = (): RoomRow => ({
    id: `row_${newId()}`,
    kind: 'pass',
    speaker: agentId,
    name: member.name,
    at: now(),
    text: '',
  });
  let answer: ReturnType<typeof sessionFinalAnswer> = null;
  let snapshot: SessionSnapshot = null;
  let startedAt = 0;
  try {
    sessionId = await host.memberSession(member);
    state.memberSession = sessionId;
    if (gone()) return await left();
    const prompt = roomTurnPrompt({
      roomName: room.name,
      self: member,
      members: room.members.map((id) => labels.get(id) ?? { id, name: id }),
      rows: shown,
      shareTools: room.shareTools,
      addressed,
      mentionedBy: mentionedBy ? (labels.get(mentionedBy)?.name ?? mentionedBy) : '',
      instruction,
      scene,
      waiting,
      askedBy: call?.askedBy ?? '',
      relay: call?.relay ?? '',
    });
    const last = rows.at(-1);
    if (last) room.cursors[agentId] = last.id;
    // Every covered call's watch follows this turn, durably, before the turn
    // can start; a record that fails throws, so the turn is never submitted
    // and its calls end failed (below).
    if (call?.id) await call.follow?.(call.id);
    // Synchronous: null when the turn may proceed, else the halt's outcome.
    const halted = () => {
      if (state.stop) return Promise.resolve('stopped' as const);
      if (gone()) return left();
      if (interrupted()) return cutShort();
      return null;
    };
    const haltedBefore = halted();
    if (haltedBefore) return await haltedBefore;
    // Switched off while its session, the room history or the call records
    // were awaited: still no turn, and the rows it was not handed stay new.
    if (await host.switchedOff(agentId)) {
      if (cursorBefore === undefined) delete room.cursors[agentId];
      else room.cursors[agentId] = cursorBefore;
      outcome.removed = true;
      return 'unavailable';
    }
    // Stop, removal or a newer message may have landed during that read.
    // Nothing may yield between this check and the submit below.
    const haltedAfter = halted();
    if (haltedAfter) return await haltedAfter;
    startedAt = now();
    // From here the submission id counts as used, even when the call throws.
    outcome.submitted = true;
    // The newest user row this prompt shows: what a reaction must hit to
    // count as this turn's answer (message-reactions.mjs).
    const shownUser = [...shown].reverse().find((row) => row.kind === 'user');
    const options = {
      ...(call?.id ? { id: call.id } : {}),
      ...(call?.hop ? { hop: call.hop } : {}),
      ...(shownUser?.id ? { roomRow: shownUser.id } : {}),
      // A relay turn that hands the member no new user row is system-caused
      // (pending-message-entry.mjs PROMPT_ORIGIN_AGENT_REPORT): the prompt-
      // cache warmer does not learn from it.
      ...(call?.relayOnly && !shownUser ? { origin: AGENT_REPORT_ORIGIN } : {}),
    };
    if (!(await host.submit(sessionId, prompt, options))) throw new Error('the turn was not accepted');
    // The member's session now holds every row up to the newest: a cut
    // short restores the cursor, never this.
    const handed = rows.at(-1)?.id;
    if (handed) room.seen = { ...room.seen, [agentId]: handed };
    // Stop's abort may have run before the daemon accepted this turn.
    if (state.stop) {
      await host.abort(sessionId).catch(() => undefined);
      return 'stopped';
    }
    const polled = await pollForAnswer(host, state, sessionId, startedAt, halted);
    if (typeof polled === 'string') return polled;
    ({ answer, snapshot } = polled);
  } catch (error) {
    host.log(
      `${agentId} could not speak in room ${host.roomId}: ${error instanceof Error ? error.message : String(error)}`
    );
    if (state.stop) return 'stopped';
    if (gone()) return await left();
    if (interrupted()) return await cutShort();
    outcome.failed = true;
    state.failures.push({
      id: agentId,
      name: member.name,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { result: 'pass', failed: true };
  } finally {
    state.approval = null;
    // A save in passing: one that fails is logged; the exchange's own saves
    // decide whether the room can go on.
    void host.persist().catch((error) => host.log(`room ${host.roomId} save failed: ${String(error)}`));
  }
  if (!answer || state.stop) return 'stopped';
  if (gone()) return await left();
  if (interrupted()) {
    const cut = await cutShort();
    void host.persist().catch((error) => host.log(`room ${host.roomId} save failed: ${String(error)}`));
    return cut;
  }
  // A relay of the member's own work is no turn to pass either.
  const text = spokenText(answer, waiting || Boolean(call?.relay));
  // A member whose answer was a reaction on the user's row alone has taken
  // its turn: the reaction shows under that row, and no pass row is posted.
  if (!text && answer.reacted === true) return 'pass';
  if (!text) {
    outcome.failed = answer.status !== 'done';
    if (!outcome.failed) {
      await host.post([passRow()]);
      return 'pass';
    }
    const items = (snapshot?.items ?? []) as Array<Record<string, unknown>>;
    const done = items.find((item) => item.kind === 'turndone' && item.id === answer.id);
    // A usage limit fails every member alike: the exchange stops on it and
    // says so once, instead of showing this turn as one more failure.
    const usage = roomUsageLimit(done, (member.route ?? {}) as { provider?: string; model?: string });
    if (usage) return { result: 'pass', failed: true, usage };
    state.failures.push({
      id: agentId,
      name: member.name,
      reason: typeof done?.detail === 'string' ? done.detail : '',
    });
    return { result: 'pass', failed: true };
  }
  outcome.text = text;
  return await postSpeech(host, state, room, labels, agentId, member, text, snapshot, startedAt);
}

/** The member's answer `text` as a speech row in the room's log, with the
 *  files and tools of the turn that began at `startedAt`. */
async function postSpeech(
  host: RoomTurnHost,
  state: RunState,
  room: ReturnType<RoomTurnHost['room']>,
  labels: Map<string, MemberLabel>,
  agentId: string,
  member: MemberLabel,
  text: string,
  snapshot: SessionSnapshot,
  startedAt: number
): Promise<RoomTurnAnswer> {
  const row: RoomRow = {
    id: `row_${host.newId()}`,
    kind: 'speech',
    speaker: agentId,
    name: member.name,
    at: host.now(),
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
  await postFailures(host, state);
  await host.post([row]);
  state.waiting = false;
  // The cursor stays on the last row this turn was handed: a message that
  // landed while the member spoke sits after it and reaches the next turn
  // (the member's own speech is left out of what it is shown).
  Object.assign(room, { lastSpeaker: agentId, lastAt: row.at });
  return { result: 'speech', mention };
}
