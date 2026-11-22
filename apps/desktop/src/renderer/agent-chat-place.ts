import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { splitAskUser, toolCallsOf } from './ask-user-record';
import { turnOf } from './conversation-turn-index';
import { carriedFold, carriedLatest } from './list-carry';
import { asRecord } from './text-format';
import { desktopToolDisplayIdentity } from './transcript-tool-core';
import { toolActivityResultValue } from './transcript-tool-result';
import type { TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import {
  type RoutineTrigger,
  isRoutineQuietReply,
  normalizeRoutineTrigger,
} from '../shared/core-src/runtime/shared/routine-trigger.mjs';

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

/** Where each member of a group room last spoke, by row, carried on from the rows a frame made them from. */
const newestSpeech = carriedLatest((row: TranscriptRowModel, at: number) => {
  const item = 'item' in row ? (row.item as TranscriptItem | undefined) : undefined;
  return item?.kind === 'notice' && item.room?.kind === 'speech' && item.room.speaker
    ? ([item.room.speaker, at] as const)
    : undefined;
});

/** The members of `asking` whose handed-off question cards `rows[index]` of a
 *  group room carries (agent-task-line.tsx RoomHandoffQuestions): each under
 *  its newest words, a member with none in view under the last row. */
export function roomQuestionSeatsAt(
  rows: readonly TranscriptRowModel[],
  index: number,
  asking: readonly string[]
): string[] {
  if (!asking.length) return [];
  const seats = newestSpeech(rows);
  return asking.filter((speaker) => (seats.get(speaker) ?? rows.length - 1) === index);
}

/** A group room's typing row: the host's transient overlay naming who speaks
 *  now, appended under a fresh id per turn and dropped between turns. */
export function isRoomTypingItem(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'notice' && item.room?.kind === 'typing';
}

/** The bot that sent a user-kind row (`fromAgent`, a bot's `session send`
 *  into this chat); '' for the user's own and a lead's message. */
function chatBotSenderOf(item: TranscriptItem | undefined): string {
  return item?.kind === 'user' && typeof item.fromAgent === 'string' ? item.fromAgent : '';
}

/** A tool round's `session` calls, aggregated members included, in call
 *  order: the call and its arguments. */
function sessionCallsOf(items: readonly TranscriptItem[]): { member: TranscriptItem; args: Record<string, unknown> }[] {
  const calls: { member: TranscriptItem; args: Record<string, unknown> }[] = [];
  for (const item of items) {
    for (const member of toolCallsOf(item)) {
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
  /** The first line of the session's latest progress update since this
   *  hand-off (a hidden `working` report), shown by its line while it works. */
  progress?: string;
  /** The newest open hand-off to its session: its line carries that
   *  session's pending question card (agent-task-line.tsx). */
  prompt?: boolean;
};

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

/** A progress update's line (routine-result.mjs agentTaskMessage `line`;
 *  an older row has only its one-line summary). */
function progressLineOf(record: Record<string, unknown>): string {
  const line = typeof record.line === 'string' && record.line ? record.line : record.summary;
  return typeof line === 'string' ? line.trim() : '';
}

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

const NO_HANDOFFS: Handoff[] = [];
const NO_HANDOFF_INDEX: HandoffIndex = { lines: new Map(), hiddenReports: new Set(), waits: new Map() };

/** A row a hand-off index is made of: a tool round that handed work off, a task report. */
function handsOffOrReports(row: TranscriptRowModel): boolean {
  if (row._tag === 'ToolActivity') return handoffsOf(row.items).length > 0;
  return row._tag === 'AssistantPart' && row.item.kind === 'notice' && asRecord(row.item.routine)?.kind === 'task';
}

/** What the hand-off rounds and task reports of a row list leave open. */
type HandoffWalk = Pick<HandoffIndex, 'hiddenReports' | 'waits'> & {
  /** Per turn, its rounds with open hand-offs, oldest first: the row and its hand-offs. */
  rounds: Map<string, [number, Handoff[]][]>;
};

/** `places`: the rows that hand work off or report on a task, oldest first. No other row is read. */
function walkHandoffs(rows: readonly TranscriptRowModel[], places: readonly number[]): HandoffWalk {
  const taskReport = (row: TranscriptRowModel) =>
    row._tag === 'AssistantPart' ? asRecord(row.item.routine) : null;
  const answered = new Map<string, SessionEnds>();
  for (const at of places) {
    const ends = reportEnds(taskReport(rows[at]));
    if (ends?.sendIds.length) noteEnds(answered, ends.sessionId, ends.sendIds);
  }
  // Walking back: the terminal reports after each row, and each turn's
  // rounds with open handoffs, newest first.
  const after = new Map<string, SessionEnds>();
  const rounds = new Map<string, [number, Handoff[]][]>();
  const lineSessions = new Set<string>();
  const waits = new Map<number, string>();
  const waited = new Set<string>();
  const hiddenReports = new Set<number>();
  // Per session, the latest progress update after the row the walk is at.
  const progress = new Map<string, string>();
  for (let place = places.length - 1; place >= 0; place -= 1) {
    const at = places[place];
    const row = rows[at];
    if (row._tag === 'AssistantPart') {
      const record = taskReport(row);
      if (record?.kind !== 'task') continue;
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
      const line = record.status === 'working' ? progressLineOf(record) : '';
      if (line && sessionId && !progress.has(sessionId)) progress.set(sessionId, line);
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
    const open = handoffsOf(row.items)
      .filter((handoff) => !handoffEnded(answered, after, handoff))
      .map((handoff) => {
        const line = progress.get(handoff.sessionId);
        return line ? { ...handoff, progress: line } : handoff;
      });
    if (!open.length) continue;
    // The newest open hand-off to a session carries that session's question
    // card; walking back, that is the first one met (the last in its round).
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (lineSessions.has(open[i].sessionId)) continue;
      lineSessions.add(open[i].sessionId);
      open[i] = { ...open[i], prompt: true };
    }
    const turn = rounds.get(row.turnKey) ?? [];
    turn.push([at, open]);
    rounds.set(row.turnKey, turn);
  }
  for (const [at, sessionId] of waits) {
    if (!lineSessions.has(sessionId)) continue;
    waits.delete(at);
    hiddenReports.add(at);
  }
  for (const turn of rounds.values()) turn.reverse();
  return { rounds, hiddenReports, waits };
}

/** The row a turn's hand-off lines sit at: its live reply, else its live band, else its last finished reply that paints;
 *  undefined when it has none. Read from the turn index, which holds the turn's rows of each kind. */
function handoffAnchor(rows: readonly TranscriptRowModel[], turnKey: string): number | undefined {
  const turn = turnOf(rows, turnKey);
  if (!turn) return undefined;
  let band: number | undefined;
  for (let place = turn.liveRows.length - 1; place >= 0; place -= 1) {
    const at = turn.liveRows[place];
    const row = rows[at];
    if (row._tag === 'Thinking') band ??= at;
    else if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') return at;
  }
  if (band !== undefined) return band;
  for (let place = turn.replyRows.length - 1; place >= 0; place -= 1) {
    const at = turn.replyRows[place];
    const row = rows[at];
    if (row._tag !== 'AssistantPart' || row.live) continue;
    if (!agentReplyUnfinished(row.live, row.item) && !routineReplyIsQuiet(row.item)) return at;
  }
  return undefined;
}

/** What a hand-off index is carried on with. */
interface HandoffCarry {
  /** The rows last read. */
  rows: readonly TranscriptRowModel[];
  /** The rows that hand work off or report on a task, oldest first; `changed`: one came, went or changed since the walk. */
  places: number[];
  changed: boolean;
  walk: HandoffWalk | null;
  /** The turns a row of which came, went or changed since the lines were placed. */
  touched: Set<string>;
  /** Per turn with open hand-offs: the row its lines sit at (undefined: each round carries its own), and the rows that
   *  carry them. */
  anchors: Map<string, number | undefined>;
  placed: Map<string, number[]>;
}

/** Places a turn's open hand-offs in `lines`: all at its anchor, or each round's at the round. */
function placeHandoffs(
  state: HandoffCarry,
  lines: Map<number, Handoff[]>,
  turnKey: string,
  rounds: readonly [number, Handoff[]][],
  anchor: number | undefined
): void {
  state.anchors.set(turnKey, anchor);
  if (anchor === undefined) {
    for (const [at, open] of rounds) lines.set(at, open);
    state.placed.set(
      turnKey,
      rounds.map(([at]) => at)
    );
    return;
  }
  lines.set(
    anchor,
    rounds.flatMap(([, open]) => open)
  );
  state.placed.set(turnKey, [anchor]);
}

/** The hand-off index of a row list. Rows carried on from ones already indexed (list-carry.ts) are read from the first
 *  that changed. The hand-off rounds and task reports are walked again only when one of them came, went or changed; a
 *  turn's lines are placed again only when one of its rows did, and its anchor is read only then. A frame that moves no
 *  line is given the index made before. */
const handoffIndexOf = carriedFold<TranscriptRowModel, HandoffCarry, HandoffIndex>({
  make: () => ({
    rows: [],
    places: [],
    changed: false,
    walk: null,
    touched: new Set(),
    anchors: new Map(),
    placed: new Map(),
  }),
  rewind(state, from) {
    for (let at = from; at < state.rows.length; at += 1) state.touched.add(state.rows[at].turnKey);
    while (state.places.length > 0 && (state.places.at(-1) as number) >= from) {
      state.places.pop();
      state.changed = true;
    }
  },
  read(state, rows, from) {
    for (let at = from; at < rows.length; at += 1) {
      const row = rows[at];
      state.touched.add(row.turnKey);
      if (!handsOffOrReports(row)) continue;
      state.places.push(at);
      state.changed = true;
    }
    state.rows = rows;
  },
  result(state, rows, held) {
    const touched = [...state.touched];
    state.touched.clear();
    if (state.places.length === 0) {
      state.walk = null;
      state.anchors.clear();
      state.placed.clear();
      return NO_HANDOFF_INDEX;
    }
    if (state.changed || !state.walk || !held) {
      // The rounds were walked again: every open turn's lines are placed, at the anchor known for it unless one of its
      // rows changed.
      state.walk = walkHandoffs(rows, state.places);
      state.changed = false;
      for (const turnKey of touched) state.anchors.delete(turnKey);
      const anchors = state.anchors;
      state.anchors = new Map();
      state.placed = new Map();
      const lines = new Map<number, Handoff[]>();
      for (const [turnKey, rounds] of state.walk.rounds) {
        const anchor = anchors.has(turnKey) ? anchors.get(turnKey) : handoffAnchor(rows, turnKey);
        placeHandoffs(state, lines, turnKey, rounds, anchor);
      }
      return { lines, hiddenReports: state.walk.hiddenReports, waits: state.walk.waits };
    }
    // The same rounds: only a turn one of whose rows changed can have moved its anchor.
    let lines: Map<number, Handoff[]> | null = null;
    for (const turnKey of touched) {
      const rounds = state.walk.rounds.get(turnKey);
      if (!rounds) continue;
      const anchor = handoffAnchor(rows, turnKey);
      if (anchor === state.anchors.get(turnKey)) continue;
      lines ??= new Map(held.lines);
      for (const at of state.placed.get(turnKey) ?? []) lines.delete(at);
      placeHandoffs(state, lines, turnKey, rounds, anchor);
    }
    return lines ? { lines, hiddenReports: held.hiddenReports, waits: held.waits } : held;
  },
});

/** The hand-off lines `rows[index]` paints (handoffIndexOf): a turn's live
 *  reply, live band or last reply, or a round of a turn with no reply. */
export function handoffLinesAt(rows: readonly TranscriptRowModel[], index: number): Handoff[] {
  return handoffIndexOf(rows).lines.get(index) ?? NO_HANDOFFS;
}

/** A hand-off line and the open hand-offs it stands for. */
export type HandoffGroup = {
  /** The target and kind: stable while the group's members come and go, so
   *  the line (and the question card under it) is never remounted. */
  key: string;
  handoff: Handoff;
  count: number;
};

/** The lines a block paints: hand-offs to one target collapse into one line
 *  with a count. A line's state (working, waiting for approval, a question)
 *  is read live from its target session, so one target is one state; an
 *  ended hand-off is no longer among `handoffs`, so it never joins a working
 *  one. The data keeps every hand-off with its own send id; only the paint
 *  merges. The merged line keeps the first's place and the question card if
 *  any of them carries it. */
export function collapseHandoffs(handoffs: readonly Handoff[]): HandoffGroup[] {
  const groups = new Map<string, HandoffGroup>();
  for (const handoff of handoffs) {
    const key = `${handoff.created ? 'created' : 'send'}:${handoff.sessionId}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, handoff, count: 1 });
      continue;
    }
    group.count += 1;
    if (handoff.prompt && !group.handoff.prompt) group.handoff = { ...group.handoff, prompt: true };
  }
  return [...groups.values()];
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
 *  text. Until complete the typing bubble stands for it and the part paints
 *  nothing. */
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
  const together = (row: TranscriptRowModel) => {
    const posted = rowItem(row)?.posted === true || rowItem(rows[index])?.posted === true;
    if (row.turnKey === rows[index].turnKey && !posted) return true;
    const other = rowTime(row);
    return !at || !other || minuteOf(other) === minuteOf(at);
  };
  const waits = (row: TranscriptRowModel) => Boolean(rowItem(row)?.steer);
  const grouped = (hit: { sender: Sender; row: TranscriptRowModel } | null) =>
    (own.side === 'agent' || own.side === 'user') &&
    hit?.sender.side === own.side &&
    hit.sender.speaker === own.speaker &&
    Boolean(hit.sender.bot) === Boolean(own.bot) &&
    (hit.sender.source ?? '') === (own.source ?? '') &&
    waits(hit.row) === waits(rows[index]) &&
    together(hit.row);
  let newDay = false;
  if (at) {
    let previous = 0;
    for (let back = index - 1; back >= 0 && !previous; back -= 1) previous = rowTime(rows[back]);
    newDay = !previous || dayOf(previous) !== dayOf(at);
  }
  return { ...own, first: newDay || !grouped(neighbour(-1)), last: !grouped(neighbour(1)), at, newDay };
}
