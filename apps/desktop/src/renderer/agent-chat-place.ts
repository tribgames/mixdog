// Agent mode's bubble runs (agent-chat-row.tsx): which side a transcript row
// sits on, and whether it opens a run of one sender (face, name, tail) or
// closes it (time). Tool rounds and the live band neither group nor break a
// run; a date divider goes where the day changes.
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { splitAskUser } from './ask-user-record';
import { asRecord } from './text-format';
import { desktopToolDisplayIdentity } from './transcript-tool-core';
import { toolActivityResultValue } from './transcript-tool-result';
import type { TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import {
  type RoutineTrigger,
  isRoutineQuietReply,
  normalizeRoutineTrigger,
} from '../../../../src/runtime/shared/routine-trigger.mjs';

export type AgentChatSide = 'agent' | 'user' | 'aside' | 'hidden';
export interface AgentChatPlace {
  side: AgentChatSide;
  /** The speaking member in a room; '' for the thread's own agent. */
  speaker: string;
  /** `kind:name` of the routine whose result this bubble is. */
  source?: string;
  /** Another bot's message into this chat: its name carries the "봇 메시지" tag. */
  bot?: boolean;
  first: boolean;
  last: boolean;
  /** The row's own time (0 when it has none). */
  at: number;
  /** A date divider goes above this row. */
  newDay: boolean;
}

function rowItem(row: TranscriptRowModel | undefined): TranscriptItem | undefined {
  return row && (row._tag === 'UserMessage' || row._tag === 'AssistantPart') ? row.item : undefined;
}

/** A routine result notice (routine-result.mjs `routine` marker); null for
 *  any other row, and for the "results omitted" line. */
export function chatRoutineOf(item: TranscriptItem | undefined): {
  kind: 'schedule' | 'webhook';
  name: string;
  failed: boolean;
  /** The run is still going (a live row its result replaces). */
  running: boolean;
  /** The run finished but its result did not reach this thread. */
  deliveryFailed: boolean;
  summary: string;
  runSessionId: string;
  /** A failed run's stored class and whether it switched the routine off. */
  reason: string;
  paused: boolean;
} | null {
  const routine = item?.kind === 'notice' && item.routine && typeof item.routine === 'object' ? item.routine : null;
  const { kind, name, status, summary, delivery, runSessionId, reason, paused } = (routine ?? {}) as Record<
    string,
    unknown
  >;
  // A task session's report (agent-task-line.tsx) is its own card, not a routine.
  if (typeof name !== 'string' || !name || kind === 'task') return null;
  return {
    kind: kind === 'webhook' ? 'webhook' : 'schedule',
    name,
    failed: status === 'failed',
    running: status === 'running',
    deliveryFailed: delivery === 'failed',
    summary: typeof summary === 'string' ? summary : '',
    runSessionId: typeof runSessionId === 'string' ? runSessionId : '',
    reason: typeof reason === 'string' ? reason : '',
    paused: paused === true,
  };
}

/** The routine fire a user row delivered (routine-trigger.mjs); null for any other row. */
export function chatRoutineTriggerOf(item: TranscriptItem | undefined): RoutineTrigger | null {
  return item?.kind === 'user' ? normalizeRoutineTrigger(item.routineTrigger) : null;
}

/** A room member's pass that left no trace (RoomTranscriptRow renders null):
 *  only a failed turn shows a line. */
export function roomPassIsQuiet(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'notice' && item.room?.kind === 'pass' && !item.room.failed;
}

/** A routine turn's "nothing new" reply (routine-trigger.mjs ROUTINE_QUIET):
 *  kept in the record, painted as nothing. */
export function routineReplyIsQuiet(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'assistant' && isRoutineQuietReply(item.text);
}

const TASK_REPORT_SHOWN = new Set(['blocked', 'completed', 'failed', 'cancelled']);

/** A task session's report that paints nothing (agent-task-line.tsx): its
 *  start and progress. Only a wait for the user and the turn's end show. */
export function taskReportIsQuiet(routine: unknown): boolean {
  const record = asRecord(routine);
  return record?.kind === 'task' && !TASK_REPORT_SHOWN.has(String(record.status ?? ''));
}

/** A group room's typing row: the host's transient overlay naming who speaks
 *  now, appended under a fresh id per turn and dropped between turns. */
export function isRoomTypingItem(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'notice' && item.room?.kind === 'typing';
}

/** The bot that sent a user-kind row (`fromAgent`, a bot's `session send`
 *  into this chat); '' for the user's own and a lead's message. */
export function chatBotSenderOf(item: TranscriptItem | undefined): string {
  return item?.kind === 'user' && typeof item.fromAgent === 'string' ? item.fromAgent : '';
}

/** A tool round's `session` calls, aggregated members included, in call
 *  order: the call and its arguments. */
function sessionCallsOf(items: readonly TranscriptItem[]): { member: TranscriptItem; args: Record<string, unknown> }[] {
  const calls: { member: TranscriptItem; args: Record<string, unknown> }[] = [];
  for (const item of items) {
    const members =
      item.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as TranscriptItem[]) : [item];
    for (const member of members) {
      if (member.kind !== 'tool') continue;
      const identity = desktopToolDisplayIdentity(member.name, member.args);
      const args = asRecord(identity.args);
      if (identity.name === 'session' && args) calls.push({ member, args });
    }
  }
  return calls;
}

/** Work an agent handed to a session in one `session` call, which reports
 *  back when that session's turn ends: an accepted send to an ordinary
 *  session or to another bot's chat (`agentId`, that bot; '' otherwise), or a
 *  task session it created (`created`; `name` its title then, '' for a send).
 *  `sendId`: the id the send's result named; its terminal report carries it. */
export type Handoff = {
  id: string;
  sessionId: string;
  sendId: string;
  agentId: string;
  name: string;
  created: boolean;
};

/** The handoffs of one stored tool item, in call order. A running call, an
 *  error and a refused send handed nothing over; a call whose session reports
 *  nothing back (`reportsBack: false`, a create with `notify: false`) has no
 *  end to wait for. */
function itemHandoffs(item: TranscriptItem): Handoff[] {
  const handoffs: Handoff[] = [];
  for (const { member, args } of sessionCallsOf([item])) {
    const result = asRecord(toolActivityResultValue(member));
    if (member.isError || result?.reportsBack === false) continue;
    const id = String(member.id ?? handoffs.length);
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (args.action === 'send' && sessionId && result?.accepted === true) {
      const sendId = typeof result.sendId === 'string' ? result.sendId : '';
      handoffs.push({ id, sessionId, sendId, agentId: agentIdOfHomeSession(sessionId), name: '', created: false });
    }
    const created = typeof result?.session_id === 'string' ? result.session_id : '';
    if (args.action === 'create' && args.notify !== false && created) {
      const name = typeof result?.title === 'string' ? result.title : '';
      handoffs.push({ id, sessionId: created, sendId: '', agentId: '', name, created: true });
    }
  }
  return handoffs;
}

// Stored items do not change: each is parsed once, not on every snapshot.
const itemHandoffsCache = new WeakMap<TranscriptItem, Handoff[]>();

/** The handoffs among a tool round's calls, in call order. */
function handoffsOf(items: readonly TranscriptItem[]): Handoff[] {
  return items.flatMap((item) => {
    let handoffs = itemHandoffsCache.get(item);
    if (!handoffs) {
      handoffs = itemHandoffs(item);
      itemHandoffsCache.set(item, handoffs);
    }
    return handoffs;
  });
}

const TASK_REPORT_ENDED = new Set(['completed', 'failed', 'cancelled']);

/** The terminal task report rows of one session: whether one names no send
 *  (an older report), and the sends the others name. */
type SessionEnds = { uncorrelated: boolean; sendIds: Set<string> };

/** The sends a terminal task report answers: one turn can answer several
 *  sends folded into it, and its report lists them all (`sendIds`, with
 *  `sendId` the first). null for any other record. */
function reportEnds(record: Record<string, unknown> | null): { sessionId: string; sendIds: string[] } | null {
  if (record?.kind !== 'task' || typeof record.sessionId !== 'string') return null;
  if (!TASK_REPORT_ENDED.has(String(record.status))) return null;
  const sendIds = [record.sendId, ...(Array.isArray(record.sendIds) ? record.sendIds : [])].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
  return { sessionId: record.sessionId, sendIds };
}

function noteEnds(ends: Map<string, SessionEnds>, sessionId: string, sendIds: readonly string[]): void {
  const session = ends.get(sessionId) ?? { uncorrelated: false, sendIds: new Set<string>() };
  if (!sendIds.length) session.uncorrelated = true;
  for (const id of sendIds) session.sendIds.add(id);
  ends.set(sessionId, session);
}

/** Whether `handoff`'s turn has ended. A report naming its send ends it
 *  wherever that report sits in the rows (a report can be stored before the
 *  call that asked for it); a report naming no send (an older one), or a
 *  handoff with no send id (a created session, an older send), matches by
 *  session, and only from a report after the handoff — an older report never
 *  closes a later resend to the same session. */
function handoffEnded(answered: Map<string, SessionEnds>, after: Map<string, SessionEnds>, handoff: Handoff): boolean {
  if (handoff.sendId && answered.get(handoff.sessionId)?.sendIds.has(handoff.sendId)) return true;
  const later = after.get(handoff.sessionId);
  return Boolean(later) && (later?.uncorrelated === true || !handoff.sendId);
}

type HandoffIndex = {
  /** Row index → the hand-off lines that row paints, in call order. */
  lines: Map<number, Handoff[]>;
  /** Task report rows that paint nothing: a start or progress, and a wait
   *  for the user that a hand-off line already carries, that a later wait of
   *  the same session repeats, or that the session's later end closed. */
  hiddenReports: Set<number>;
  /** The other wait rows, by row index: their session. Each shows only while
   *  that session waits for the user (taskReportHidden). */
  waits: Map<number, string>;
};

const handoffIndexCache = new WeakMap<readonly TranscriptRowModel[], HandoffIndex>();
const NO_HANDOFFS: Handoff[] = [];

/** Where the `rows` snapshot draws the work its agent handed to sessions,
 *  built once per snapshot (rows are immutable: a new snapshot is a new
 *  array) in linear passes. A handoff keeps its line until that session's
 *  terminal report of it (handoffEnded). A turn's lines are one block on one
 *  carrier row: its live reply part (the typing bubble while it streams, the
 *  whole reply once complete, then the same row settled: one row identity
 *  from streaming through the turn's end), else its live band while it runs
 *  (below the typing bubble), else its last reply, else each round keeps its
 *  own at its row (a turn with no text reply). */
function handoffIndexOf(rows: readonly TranscriptRowModel[]): HandoffIndex {
  const cached = handoffIndexCache.get(rows);
  if (cached) return cached;
  const liveReplies = new Map<string | undefined, number>();
  const bands = new Map<string | undefined, number>();
  const replies = new Map<string | undefined, number>();
  const answered = new Map<string, SessionEnds>();
  rows.forEach((row, at) => {
    if (row._tag === 'Thinking') bands.set(row.turnKey, at);
    if (row._tag !== 'AssistantPart') return;
    if (row.item.kind === 'assistant' && row.live) liveReplies.set(row.turnKey, at);
    else if (
      row.item.kind === 'assistant' &&
      !agentReplyUnfinished(row.live, row.item) &&
      !routineReplyIsQuiet(row.item)
    ) {
      replies.set(row.turnKey, at);
    }
    const ends = row.item.kind === 'notice' ? reportEnds(asRecord(row.item.routine)) : null;
    if (ends?.sendIds.length) noteEnds(answered, ends.sessionId, ends.sendIds);
  });
  // Walking back: the terminal reports after each row, and each turn's
  // rounds with open handoffs, newest first.
  const after = new Map<string, SessionEnds>();
  const turns = new Map<string | undefined, [number, Handoff[]][]>();
  const lineSessions = new Set<string>();
  const waits = new Map<number, string>();
  const waited = new Set<string>();
  const hiddenReports = new Set<number>();
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at];
    if (row._tag === 'AssistantPart') {
      const record = row.item.kind === 'notice' ? asRecord(row.item.routine) : null;
      if (record?.kind !== 'task') continue;
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
      // Only the latest wait of a session that has not ended since can show.
      if (record.status === 'blocked' && sessionId && !waited.has(sessionId) && !after.has(sessionId)) {
        waited.add(sessionId);
        waits.set(at, sessionId);
      } else if (!TASK_REPORT_ENDED.has(String(record.status))) hiddenReports.add(at);
      const ends = reportEnds(record);
      if (ends) noteEnds(after, ends.sessionId, ends.sendIds);
      continue;
    }
    if (row._tag !== 'ToolActivity') continue;
    const open = handoffsOf(row.items).filter((handoff) => !handoffEnded(answered, after, handoff));
    if (!open.length) continue;
    for (const handoff of open) lineSessions.add(handoff.sessionId);
    const turn = turns.get(row.turnKey) ?? [];
    turn.push([at, open]);
    turns.set(row.turnKey, turn);
  }
  for (const [at, sessionId] of waits) {
    if (!lineSessions.has(sessionId)) continue;
    waits.delete(at);
    hiddenReports.add(at);
  }
  const lines = new Map<number, Handoff[]>();
  for (const [turnKey, rounds] of turns) {
    rounds.reverse();
    const anchor = liveReplies.get(turnKey) ?? bands.get(turnKey) ?? replies.get(turnKey);
    if (anchor === undefined) for (const [at, open] of rounds) lines.set(at, open);
    else
      lines.set(
        anchor,
        rounds.flatMap(([, open]) => open)
      );
  }
  const built = { lines, hiddenReports, waits };
  handoffIndexCache.set(rows, built);
  return built;
}

/** The hand-off lines `rows[index]` paints (handoffIndexOf): a turn's live
 *  reply, live band or last reply, or a round of a turn with no reply. */
export function handoffLinesAt(rows: readonly TranscriptRowModel[], index: number): Handoff[] {
  return handoffIndexOf(rows).lines.get(index) ?? NO_HANDOFFS;
}

/** Whether the task report at `rows[index]` paints nothing: a start or
 *  progress, a wait its hand-off line (or a later wait of that session)
 *  already shows or the session's end closed, and — given `waiting`, the
 *  sessions waiting for the user now (the attention index's `needsUser`) —
 *  a wait of a session that no longer waits. The row renderer and the
 *  height estimates (transcriptRowVariant) take this one decision. */
export function taskReportHidden(
  rows: readonly TranscriptRowModel[],
  index: number,
  waiting?: ReadonlySet<string>
): boolean {
  const found = handoffIndexOf(rows);
  if (found.hiddenReports.has(index)) return true;
  const session = found.waits.get(index);
  return Boolean(session && waiting && !waiting.has(session));
}

type Sender = { side: AgentChatSide; speaker: string; source?: string; bot?: boolean };

/** null: a row that neither groups nor breaks a group (tool rounds, the live
 *  band, turn gaps). */
function rowSender(rows: readonly TranscriptRowModel[], index: number, cardKey?: string): Sender | null {
  const row = rows[index];
  if (!row || row._tag === 'TurnGap' || row._tag === 'Thinking') return null;
  // Tool rounds stay out of a chat; a question card among them is a card
  // between the runs. Only the call holding the live card (`cardKey`,
  // askUserCardKey) is one; any other waiting call paints nothing.
  if (row._tag === 'ToolActivity') {
    const { asked, waiting } = splitAskUser(row.items, cardKey !== undefined, cardKey);
    return asked.length || waiting ? { side: 'aside', speaker: '' } : null;
  }
  // A routine fire's turn opens with its marker row, not a user bubble; a
  // bot's message into this chat is that bot's bubble, not the user's.
  if (row._tag === 'UserMessage') {
    if (chatRoutineTriggerOf(row.item)) return { side: 'aside', speaker: '' };
    const bot = chatBotSenderOf(row.item);
    return bot ? { side: 'agent', speaker: bot, bot: true } : { side: 'user', speaker: '' };
  }
  const item = rowItem(row);
  if (row._tag === 'AssistantPart' && item) {
    // An unfinished reply part paints nothing (agentReplyUnfinished).
    if (agentReplyUnfinished(row.live, item)) return null;
    if (item.kind === 'assistant') return routineReplyIsQuiet(item) ? null : { side: 'agent', speaker: '' };
    // A schedule's or webhook's result is a routine card under the agent's
    // face, consecutive runs of one routine in one card (routineGroupStart);
    // an old result row without the marker stays a bubble.
    const routine = chatRoutineOf(item);
    if (routine) return { side: 'agent', speaker: '', source: `${routine.kind}:${routine.name}` };
    if (item.kind === 'notice' && !item.room && !item.routine && /^(?:⏱|🔗)\s/u.test(String(item.text || ''))) {
      return { side: 'agent', speaker: '' };
    }
    if (item.kind === 'notice' && item.room?.kind === 'speech')
      return { side: 'agent', speaker: item.room.speaker || '' };
    // A member typing is the transient typing bubble (agentTypingLead).
    if (item.kind === 'notice' && item.room?.kind === 'typing') return null;
    // A quiet pass or a task report that paints nothing (a start, a wait its
    // hand-off line shows) neither groups nor breaks a run.
    if (roomPassIsQuiet(item) || taskReportHidden(rows, index)) return null;
    // No turn status in a chat: "Response complete", "Thought for…",
    // compaction (agent mode compacts silently) — none of it shows.
    if (item.kind === 'statusdone' || item.kind === 'turndone') return { side: 'hidden', speaker: '' };
  }
  return { side: 'aside', speaker: '' };
}

function rowTime(row: TranscriptRowModel | undefined): number {
  const at = rowItem(row)?.at;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
}

const dayOf = (at: number) => new Date(at).toDateString();
const minuteOf = (at: number) => Math.floor(at / 60_000);

/** Whether the typing bubble at `rows[index]` (the live band, or a room's
 *  typing row) opens its own run under `speaker`'s face and name: it does
 *  unless that agent's words are right above it. */
export function agentTypingLead(
  rows: readonly TranscriptRowModel[],
  index: number,
  speaker: string,
  cardKey?: string
): boolean {
  for (let back = index - 1; back >= 0; back -= 1) {
    const sender = rowSender(rows, back, cardKey);
    if (!sender || sender.side === 'hidden') continue;
    return !(sender.side === 'agent' && sender.speaker === speaker && !sender.source);
  }
  return true;
}

/** Whether the live band at `rows[index]` shows the typing bubble: not once
 *  the reply right above it is complete (that bubble is the reply, whole),
 *  nor while that reply part carries the turn's hand-off lines (it shows the
 *  typing bubble itself, above them, and the reply replaces it in place). */
export function agentTypingShown(rows: readonly TranscriptRowModel[], index: number): boolean {
  const above = rows[index - 1];
  if (above?._tag !== 'AssistantPart' || !above.live || above.item.kind !== 'assistant') return true;
  return agentReplyUnfinished(above.live, above.item) && !handoffLinesAt(rows, index - 1).length;
}

/** A live reply part that is not complete yet: still streaming, or with no
 *  text. Like a messenger, a bot's bubble appears whole when its message is
 *  complete: until then the typing bubble stands for it and the part paints
 *  nothing. (A part also opens before its first text, reasoning first:
 *  painted then, it was an empty bubble that replaced the 62px typing bubble
 *  with a 46px one, and the followed transcript dropped 16px.) The part's
 *  final commit swaps the typing bubble for the whole bubble in one layout. */
export function agentReplyUnfinished(live: boolean | undefined, item: TranscriptItem): boolean {
  return (
    Boolean(live) && item.kind === 'assistant' && (Boolean(item.streaming) || String(item.text || '').trim() === '')
  );
}

/** The routine run `rows[index]` belongs to, as the indexes of its card:
 *  every consecutive result of one routine (rows outside the grouping in
 *  between are skipped), oldest first. null for any other row. */
export function routineGroupOf(rows: readonly TranscriptRowModel[], index: number, cardKey?: string): number[] | null {
  const source = rowSender(rows, index, cardKey)?.source;
  if (!source) return null;
  const members = [index];
  for (const step of [-1, 1]) {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows, next, cardKey);
      if (!sender || sender.side === 'hidden') continue;
      if (sender.source !== source) break;
      members.push(next);
    }
  }
  return members.sort((a, b) => a - b);
}

/** Whether `rows[index]` is the last row of its turn (the live band aside)
 *  and that turn no longer runs (no live band or streaming reply part). */
export function isEndedTurnLastRow(rows: readonly TranscriptRowModel[], index: number): boolean {
  const row = rows[index];
  if (!row || row._tag === 'Thinking') return false;
  const { turnKey } = row;
  if (
    rows.some(
      (other) =>
        other.turnKey === turnKey && (other._tag === 'Thinking' || (other._tag === 'AssistantPart' && other.live))
    )
  ) {
    return false;
  }
  return !rows.slice(index + 1).some((next) => next.turnKey === turnKey && next._tag !== 'Thinking');
}

/** At a turn's last row (the live band aside), the items of every tool round
 *  of that turn, oldest first: its artifacts' cards close the turn, under its
 *  reply. null at any other row, for a turn with no tool round, and while the
 *  turn runs (its live band or a streaming reply part is still in the rows). */
export function turnEndToolItems(rows: readonly TranscriptRowModel[], index: number): TranscriptItem[] | null {
  if (!isEndedTurnLastRow(rows, index)) return null;
  const { turnKey } = rows[index];
  const items = rows
    .slice(0, index + 1)
    .flatMap((earlier) => (earlier._tag === 'ToolActivity' && earlier.turnKey === turnKey ? earlier.items : []));
  return items.length ? items : null;
}

/** The chat place of `rows[index]`; null for a row outside the grouping. */
export function agentChatPlace(
  rows: readonly TranscriptRowModel[],
  index: number,
  cardKey?: string
): AgentChatPlace | null {
  const own = rowSender(rows, index, cardKey);
  if (!own) return null;
  const at = rowTime(rows[index]);
  const neighbour = (step: number) => {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows, next, cardKey);
      if (sender && sender.side !== 'hidden') return { sender, row: rows[next] };
    }
    return null;
  };
  // A run shows one time, on its last bubble: bubbles of one turn always join,
  // other turns join only when sent in the same minute.
  const together = (row: TranscriptRowModel) => {
    if (row.turnKey === rows[index].turnKey) return true;
    const other = rowTime(row);
    return !at || !other || minuteOf(other) === minuteOf(at);
  };
  const grouped = (hit: { sender: Sender; row: TranscriptRowModel } | null) =>
    (own.side === 'agent' || own.side === 'user') &&
    hit?.sender.side === own.side &&
    hit.sender.speaker === own.speaker &&
    Boolean(hit.sender.bot) === Boolean(own.bot) &&
    (hit.sender.source ?? '') === (own.source ?? '') &&
    together(hit.row);
  let newDay = false;
  if (at) {
    let previous = 0;
    for (let back = index - 1; back >= 0 && !previous; back -= 1) previous = rowTime(rows[back]);
    newDay = !previous || dayOf(previous) !== dayOf(at);
  }
  return { ...own, first: newDay || !grouped(neighbour(-1)), last: !grouped(neighbour(1)), at, newDay };
}
