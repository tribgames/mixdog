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
import { type RoutineTrigger, normalizeRoutineTrigger } from '../../../../src/runtime/shared/routine-trigger.mjs';

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

/** A bot's answer to this chat's own send (routine-result.mjs agentTaskMessage
 *  with `routine.agentId`): who answered and what. null for any other row,
 *  and for a start or a wait, which stay faint lines. */
export function chatBotReplyOf(
  item: TranscriptItem | undefined
): { agentId: string; text: string; sessionId: string } | null {
  if (item?.kind !== 'notice' || !item.routine || typeof item.routine !== 'object') return null;
  const { kind, agentId, status, summary, sessionId } = item.routine as Record<string, unknown>;
  if (kind !== 'task' || typeof agentId !== 'string' || !agentId) return null;
  // Failed and cancelled results keep their status line.
  if (status !== 'completed' || typeof summary !== 'string' || !summary.trim()) return null;
  return { agentId, text: summary, sessionId: typeof sessionId === 'string' ? sessionId : '' };
}

/** Whether a `session send` call finished with `accepted: true`: a running
 *  call, an error and a refused send were not sent. */
function sendAccepted(item: TranscriptItem): boolean {
  if (item.isError) return false;
  return asRecord(toolActivityResultValue(item))?.accepted === true;
}

/** The sends to another bot's home chat among a tool round's calls
 *  (`session` action `send`), from the stored calls: the recipient, its home
 *  session, the message and when. */
export function chatBotSendsOf(
  items: readonly TranscriptItem[]
): { id: string; agentId: string; sessionId: string; prompt: string; at: number }[] {
  const sends: { id: string; agentId: string; sessionId: string; prompt: string; at: number }[] = [];
  for (const item of items) {
    const members =
      item.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as TranscriptItem[]) : [item];
    for (const member of members) {
      if (member.kind !== 'tool') continue;
      const identity = desktopToolDisplayIdentity(member.name, member.args);
      const args = asRecord(identity.args);
      const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
      const agentId = agentIdOfHomeSession(sessionId);
      if (identity.name !== 'session' || args?.action !== 'send' || !agentId) continue;
      if (!sendAccepted(member)) continue;
      const at = Number(member.startedAt ?? member.at);
      sends.push({
        id: String(member.id ?? sends.length),
        agentId,
        sessionId,
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        at: Number.isFinite(at) && at > 0 ? at : 0,
      });
    }
  }
  return sends;
}

type BotSend = ReturnType<typeof chatBotSendsOf>[number];

/** The row index of the bubble that carries its turn's "sent to" lines: the
 *  turn's last finished reply of the agent itself. -1: the turn has none. */
function sendCarrierIndex(rows: readonly TranscriptRowModel[], turnKey: string | undefined): number {
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at];
    if (
      row.turnKey === turnKey &&
      row._tag === 'AssistantPart' &&
      row.item.kind === 'assistant' &&
      !agentReplyUnfinished(row.live, row.item)
    ) {
      return at;
    }
  }
  return -1;
}

/** The sends of the turn that sit under the bubble at `rows[index]` (the
 *  turn's last agent reply), inside its group. */
export function carriedBotSends(rows: readonly TranscriptRowModel[], index: number): BotSend[] {
  const row = rows[index];
  if (row?._tag !== 'AssistantPart' || sendCarrierIndex(rows, row.turnKey) !== index) return [];
  return rows.flatMap((other) =>
    other._tag === 'ToolActivity' && other.turnKey === row.turnKey ? chatBotSendsOf(other.items) : []
  );
}

/** Where a tool round's sends are drawn: `carried` under the turn's reply
 *  bubble, `pending` nowhere yet (the reply is still coming), `aside` as a
 *  line of their own (the turn has no text reply). */
export function botSendsPlacement(rows: readonly TranscriptRowModel[], index: number): 'carried' | 'pending' | 'aside' {
  const { turnKey } = rows[index];
  if (sendCarrierIndex(rows, turnKey) >= 0) return 'carried';
  const coming = rows.some(
    (other) =>
      other.turnKey === turnKey && (other._tag === 'Thinking' || (other._tag === 'AssistantPart' && other.live))
  );
  return coming ? 'pending' : 'aside';
}

type Sender = { side: AgentChatSide; speaker: string; source?: string; bot?: boolean };

/** null: a row that neither groups nor breaks a group (tool rounds, the live
 *  band, turn gaps). */
function rowSender(row: TranscriptRowModel | undefined, cardKey?: string): Sender | null {
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
    if (item.kind === 'assistant') return { side: 'agent', speaker: '' };
    // A schedule's or webhook's result is a routine card under the agent's
    // face, consecutive runs of one routine in one card (routineGroupStart);
    // an old result row without the marker stays a bubble.
    const routine = chatRoutineOf(item);
    if (routine) return { side: 'agent', speaker: '', source: `${routine.kind}:${routine.name}` };
    const botReply = chatBotReplyOf(item);
    if (botReply) return { side: 'agent', speaker: botReply.agentId, bot: true };
    if (item.kind === 'notice' && !item.room && !item.routine && /^(?:⏱|🔗)\s/u.test(String(item.text || ''))) {
      return { side: 'agent', speaker: '' };
    }
    if (item.kind === 'notice' && item.room?.kind === 'speech')
      return { side: 'agent', speaker: item.room.speaker || '' };
    // A member typing is the transient typing bubble (agentTypingLead).
    if (item.kind === 'notice' && item.room?.kind === 'typing') return null;
    // A quiet pass or task start paints nothing, so it neither groups nor breaks a run.
    if (roomPassIsQuiet(item) || taskReportIsQuiet(item.routine)) return null;
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
    const sender = rowSender(rows[back], cardKey);
    if (!sender || sender.side === 'hidden') continue;
    return !(sender.side === 'agent' && sender.speaker === speaker && !sender.source);
  }
  return true;
}

/** Whether the live band at `rows[index]` shows the typing bubble: not once
 *  the reply right above it is complete (that bubble is the reply, whole). */
export function agentTypingShown(rows: readonly TranscriptRowModel[], index: number): boolean {
  const above = rows[index - 1];
  if (above?._tag !== 'AssistantPart' || !above.live || above.item.kind !== 'assistant') return true;
  return agentReplyUnfinished(above.live, above.item);
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
export function routineGroupOf(
  rows: readonly TranscriptRowModel[],
  index: number,
  cardKey?: string
): number[] | null {
  const source = rowSender(rows[index], cardKey)?.source;
  if (!source) return null;
  const members = [index];
  for (const step of [-1, 1]) {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows[next], cardKey);
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
  const own = rowSender(rows[index], cardKey);
  if (!own) return null;
  const at = rowTime(rows[index]);
  const neighbour = (step: number) => {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows[next], cardKey);
      if (sender && sender.side !== 'hidden') return sender;
    }
    return null;
  };
  const grouped = (other: Sender | null) =>
    (own.side === 'agent' || own.side === 'user') &&
    other?.side === own.side &&
    other.speaker === own.speaker &&
    Boolean(other.bot) === Boolean(own.bot) &&
    (other.source ?? '') === (own.source ?? '');
  let newDay = false;
  if (at) {
    let previous = 0;
    for (let back = index - 1; back >= 0 && !previous; back -= 1) previous = rowTime(rows[back]);
    newDay = !previous || dayOf(previous) !== dayOf(at);
  }
  return { ...own, first: newDay || !grouped(neighbour(-1)), last: !grouped(neighbour(1)), at, newDay };
}
