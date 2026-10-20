// Agent mode's bubble runs (agent-chat-row.tsx): which side a transcript row
// sits on, and whether it opens a run of one sender (face, name, tail) or
// closes it (time). Tool rounds and the live band neither group nor break a
// run; a date divider goes where the day changes.
import { splitAskUser } from './ask-user-record';
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
  // A task session's report (agent-task-line.tsx) is a faint line, not a routine.
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

type Sender = { side: AgentChatSide; speaker: string; source?: string };

/** null: a row that neither groups nor breaks a group (tool rounds, the live
 *  band, turn gaps). */
function rowSender(row: TranscriptRowModel | undefined): Sender | null {
  if (!row || row._tag === 'TurnGap' || row._tag === 'Thinking') return null;
  // Tool rounds stay out of a chat; a question card among them is a card
  // between the runs.
  if (row._tag === 'ToolActivity') {
    const { asked, waiting } = splitAskUser(row.items, true);
    return asked.length || waiting ? { side: 'aside', speaker: '' } : null;
  }
  // A routine fire's turn opens with its marker row, not a user bubble.
  if (row._tag === 'UserMessage') {
    return chatRoutineTriggerOf(row.item) ? { side: 'aside', speaker: '' } : { side: 'user', speaker: '' };
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
    if (item.kind === 'notice' && !item.room && !item.routine && /^(?:⏱|🔗)\s/u.test(String(item.text || ''))) {
      return { side: 'agent', speaker: '' };
    }
    if (item.kind === 'notice' && item.room?.kind === 'speech')
      return { side: 'agent', speaker: item.room.speaker || '' };
    // A member typing is the transient typing bubble (agentTypingLead).
    if (item.kind === 'notice' && item.room?.kind === 'typing') return null;
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
export function agentTypingLead(rows: readonly TranscriptRowModel[], index: number, speaker: string): boolean {
  for (let back = index - 1; back >= 0; back -= 1) {
    const sender = rowSender(rows[back]);
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
export function routineGroupOf(rows: readonly TranscriptRowModel[], index: number): number[] | null {
  const source = rowSender(rows[index])?.source;
  if (!source) return null;
  const members = [index];
  for (const step of [-1, 1]) {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows[next]);
      if (!sender || sender.side === 'hidden') continue;
      if (sender.source !== source) break;
      members.push(next);
    }
  }
  return members.sort((a, b) => a - b);
}

/** At a turn's last row (the live band aside), the items of every tool round
 *  of that turn, oldest first: its artifacts' cards close the turn, under its
 *  reply. null at any other row, for a turn with no tool round, and while the
 *  turn runs (its live band or a streaming reply part is still in the rows). */
export function turnEndToolItems(rows: readonly TranscriptRowModel[], index: number): TranscriptItem[] | null {
  const row = rows[index];
  if (!row || row._tag === 'Thinking') return null;
  const { turnKey } = row;
  if (
    rows.some(
      (other) =>
        other.turnKey === turnKey && (other._tag === 'Thinking' || (other._tag === 'AssistantPart' && other.live))
    )
  ) {
    return null;
  }
  if (rows.slice(index + 1).some((next) => next.turnKey === turnKey && next._tag !== 'Thinking')) return null;
  const items = rows
    .slice(0, index + 1)
    .flatMap((earlier) => (earlier._tag === 'ToolActivity' && earlier.turnKey === turnKey ? earlier.items : []));
  return items.length ? items : null;
}

/** The chat place of `rows[index]`; null for a row outside the grouping. */
export function agentChatPlace(rows: readonly TranscriptRowModel[], index: number): AgentChatPlace | null {
  const own = rowSender(rows[index]);
  if (!own) return null;
  const at = rowTime(rows[index]);
  const neighbour = (step: number) => {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const sender = rowSender(rows[next]);
      if (sender && sender.side !== 'hidden') return sender;
    }
    return null;
  };
  const grouped = (other: Sender | null) =>
    (own.side === 'agent' || own.side === 'user') &&
    other?.side === own.side &&
    other.speaker === own.speaker &&
    (other.source ?? '') === (own.source ?? '');
  let newDay = false;
  if (at) {
    let previous = 0;
    for (let back = index - 1; back >= 0 && !previous; back -= 1) previous = rowTime(rows[back]);
    newDay = !previous || dayOf(previous) !== dayOf(at);
  }
  return { ...own, first: newDay || !grouped(neighbour(-1)), last: !grouped(neighbour(1)), at, newDay };
}
