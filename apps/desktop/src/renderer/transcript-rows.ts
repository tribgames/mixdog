import type { TranscriptItem } from './desktop-types';
import { CarriedFacts, keptFrom, noteCarried } from './list-carry';
import type { TurnChangesRef } from './turn-changes-model';
import { completionTone } from './transcript-primitives';
import { isVisibleTranscriptItem } from './transcript-row';
import { streamingTextPaints } from './use-transcript-text-reveal';
import { isLiveOnlyTranscriptRow } from '../../../../packages/protocol-client/src/rows.ts';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isProcessRestartStatusText, isTranscriptCancelledStatusText } from '../../../../packages/protocol-client/src/shared/tool-execution-contract.mjs';

/** Where the turn end `items` close with is (-1: they close with none): their last item, or the one before it when the
 *  last is the reply that end names (`finalAssistantId`; an end can settle before its reply does). */
export function closingEnd(items: readonly TranscriptItem[]): number {
  const last = items.length - 1;
  const tail = items[last];
  if (tail?.kind === 'turndone') return last;
  const end = items[last - 1];
  const named = end?.kind === 'turndone' && tail?.kind === 'assistant' && end.finalAssistantId != null;
  return named && String(end.finalAssistantId) === String(tail.id) ? last - 1 : -1;
}

export type TranscriptRowModel =
  | {
      _tag: 'TurnGap';
      key: string;
      turnKey: string;
    }
  | {
      _tag: 'UserMessage';
      key: string;
      turnKey: string;
      item: TranscriptItem;
      attachedUser: boolean;
    }
  | {
      _tag: 'AssistantPart';
      key: string;
      turnKey: string;
      item: TranscriptItem;
      completion?: TranscriptItem;
      active?: boolean;
      live?: boolean;
      /** This row holds the last turndone of a checkpoint: its changed-files card follows. */
      turnChanges?: TurnChangesRef;
    }
  | {
      _tag: 'ToolActivity';
      key: string;
      turnKey: string;
      items: readonly TranscriptItem[];
      /** A running turn ends in this group: its next call lands here, so the
       *  group does not read finished between two calls (appendLiveTranscriptRows). */
      open?: boolean;
    }
  | {
      _tag: 'Thinking';
      key: string;
      turnKey: string;
      active: true;
    }
  | {
      _tag: 'Error';
      key: string;
      turnKey: string;
      item?: TranscriptItem;
      failures: { turnKey: string; item?: TranscriptItem }[];
      turnChanges?: TurnChangesRef;
    };

function isCompletionTranscriptItem(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'statusdone' || item?.kind === 'turndone';
}

/** Whether a row shows only conversation a compaction took out of the model
 *  context: rendered dimmed, with no action that would act on model state. */
export function transcriptRowArchived(row: TranscriptRowModel): boolean {
  if (row._tag === 'ToolActivity') return row.items.length > 0 && row.items.every((item) => item?.archived === true);
  if (row._tag === 'UserMessage' || row._tag === 'AssistantPart' || row._tag === 'Error') {
    return row.item?.archived === true;
  }
  return false;
}

function transcriptRowKey(sessionKey: string, item: TranscriptItem | undefined, index: number): string {
  const id = item?.id;
  return id !== undefined && id !== null
    ? `${sessionKey}:${String(id)}`
    : `${sessionKey}:${item?.kind || 'row'}-${index}`;
}

interface TranscriptRowBuilder {
  rows: TranscriptRowModel[];
  currentTurnKey: string;
  previousRowWasUser: boolean;
  /** Tool group keys already used in this projection. */
  toolGroupKeys: Set<string>;
  /** Message row keys this builder placed. */
  rowKeys: Set<string>;
  /** Message row keys placed before this builder started (the settled rows
   *  under a live append). */
  priorRowKey?: (key: string) => boolean;
}

/** Claims `key` for one message row; false when a row already carries it. */
function claimRowKey(builder: TranscriptRowBuilder, key: string): boolean {
  if (builder.rowKeys.has(key) || builder.priorRowKey?.(key)) return false;
  builder.rowKeys.add(key);
  return true;
}

/** pending:${id} and turn:${id} are one submission and share one row identity. */
export function submissionIdentity(turnKey: string): string {
  if (turnKey.startsWith('pending:')) return turnKey.slice('pending:'.length);
  if (turnKey.startsWith('turn:')) return turnKey.slice('turn:'.length);
  return turnKey;
}

function thinkingRowKey(sessionKey: string, turnKey: string): string {
  return `${sessionKey}:thinking:${submissionIdentity(turnKey)}`;
}

// A row model is made once for the item it shows and stands while that item is the same object and holds the same place
// (its key, its turn, what its turn's end folded into it): a projection made again hands the same row on. Each lives as
// long as its item.
/** The gap that opens a turn, by the item (or tool group) whose row follows it. */
const gapRows = new WeakMap<object, TranscriptRowModel>();
const messageRows = new WeakMap<TranscriptItem, TranscriptRowModel>();
const liveRows = new WeakMap<TranscriptItem, TranscriptRowModel>();
const cancelledRows = new WeakMap<TranscriptItem, TranscriptRowModel>();
/** A tool group's row, by its first item. */
const groupRows = new WeakMap<TranscriptItem, TranscriptRowModel>();
/** The same group while a running turn ends in it, by its row. */
const openGroupRows = new WeakMap<TranscriptRowModel, TranscriptRowModel>();

const sameTurnChanges = (left: TurnChangesRef | undefined, right: TurnChangesRef | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.checkpointId === right.checkpointId &&
    left.boundary === right.boundary &&
    left.trailing === right.trailing &&
    left.reclosed === right.reclosed);

/** `anchor`: the item (or tool group's first item) whose row begins the turn. */
function beginBuilderTurn(builder: TranscriptRowBuilder, sessionKey: string, turnKey: string, anchor?: object): void {
  if (builder.rows.length > 0 && builder.currentTurnKey && turnKey !== builder.currentTurnKey) {
    const key = `${sessionKey}:gap:${submissionIdentity(turnKey)}`;
    const held = anchor ? gapRows.get(anchor) : undefined;
    const gap: TranscriptRowModel =
      held && held.key === key && held.turnKey === turnKey ? held : { _tag: 'TurnGap', key, turnKey };
    if (anchor && gap !== held) gapRows.set(anchor, gap);
    builder.rows.push(gap);
    builder.previousRowWasUser = false;
  }
  builder.currentTurnKey = turnKey;
}

function pushBuilderItem(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  item: TranscriptItem,
  index: number,
  turnKey: string,
  completion?: TranscriptItem,
  turnChanges?: TurnChangesRef
): void {
  const key = transcriptRowKey(sessionKey, item, index);
  // The row already placed under this key is the one copy (its turn gap too).
  if (!claimRowKey(builder, key)) return;
  beginBuilderTurn(builder, sessionKey, turnKey, item);
  const held = messageRows.get(item);
  if (item.kind === 'user') {
    const attachedUser = builder.previousRowWasUser;
    const row: TranscriptRowModel =
      held?._tag === 'UserMessage' && held.key === key && held.turnKey === turnKey && held.attachedUser === attachedUser
        ? held
        : { _tag: 'UserMessage', key, turnKey, item, attachedUser };
    if (row !== held) messageRows.set(item, row);
    builder.rows.push(row);
    builder.previousRowWasUser = true;
    return;
  }
  const row: TranscriptRowModel =
    held?._tag === 'AssistantPart' &&
    held.key === key &&
    held.turnKey === turnKey &&
    held.completion === completion &&
    sameTurnChanges(held.turnChanges, turnChanges)
      ? held
      : { _tag: 'AssistantPart', key, turnKey, item, completion, ...(turnChanges ? { turnChanges } : {}) };
  if (row !== held) messageRows.set(item, row);
  builder.rows.push(row);
  builder.previousRowWasUser = false;
}

interface PendingToolActivityItem {
  item: TranscriptItem;
  index: number;
  turnKey: string;
}

const TOOL_GROUP_KEY_SESSIONS = 16;
const toolGroupKeys = new Map<string, Map<string, string>>();

function toolGroupKeyMemory(sessionKey: string): Map<string, string> {
  let memory = toolGroupKeys.get(sessionKey);
  if (memory) toolGroupKeys.delete(sessionKey);
  else memory = new Map();
  toolGroupKeys.set(sessionKey, memory);
  while (toolGroupKeys.size > TOOL_GROUP_KEY_SESSIONS) {
    const oldest = toolGroupKeys.keys().next().value;
    if (oldest === undefined) break;
    toolGroupKeys.delete(oldest);
  }
  return memory;
}

function toolActivityRowKey(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  pending: readonly PendingToolActivityItem[]
): string {
  const first = pending[0] as PendingToolActivityItem;
  const ids = pending
    .map(({ item }) => item?.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String);
  const own = `${transcriptRowKey(sessionKey, first.item, first.index)}:tool-activity`;
  if (ids.length === 0) return own;
  const memory = toolGroupKeyMemory(sessionKey);
  let key: string | undefined;
  for (const id of ids) {
    const remembered = memory.get(id);
    // One key per row within a projection, whatever the memory says.
    if (remembered && !builder.toolGroupKeys.has(remembered)) {
      key = remembered;
      break;
    }
  }
  if (key === undefined) {
    key = own;
    for (let copy = 2; builder.toolGroupKeys.has(key); copy += 1) key = `${own}:${copy}`;
  }
  for (const id of ids) memory.set(id, key);
  return key;
}

function pushToolActivity(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  pending: readonly PendingToolActivityItem[]
): void {
  const first = pending[0];
  if (!first) return;
  beginBuilderTurn(builder, sessionKey, first.turnKey, first.item);
  const key = toolActivityRowKey(builder, sessionKey, pending);
  builder.toolGroupKeys.add(key);
  const held = groupRows.get(first.item);
  const row: TranscriptRowModel =
    held?._tag === 'ToolActivity' &&
    held.key === key &&
    held.turnKey === first.turnKey &&
    held.items.length === pending.length &&
    pending.every(({ item }, at) => held.items[at] === item)
      ? held
      : { _tag: 'ToolActivity', key, turnKey: first.turnKey, items: pending.map(({ item }) => item) };
  if (row !== held) groupRows.set(first.item, row);
  builder.rows.push(row);
  builder.previousRowWasUser = false;
}

interface SettledTranscriptProjection {
  rows: readonly TranscriptRowModel[];
  currentTurnKey: string;
  previousRowWasUser: boolean;
  itemCount: number;
  /** The settled items close with a successful completion (`closingEnd`)
   *  folded into its assistant row: that row's footer now stands where the
   *  live band was. */
  endsWithFoldedCompletion: boolean;
  /** The turn the settled items leave open: their last item's, unless they close with a turn's end ('' then, and for
   *  no item). It is not always `currentTurnKey`: a prompt that places no row (a hidden wake kickoff) opens a turn
   *  after the last row's turn has ended. */
  openTurnKey: string;
  hasSettledItem(id: unknown): boolean;
  /** Whether a settled message row carries `key`. */
  hasRowKey(key: string): boolean;
}

function pushFailureRow(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  turnKey: string,
  item?: TranscriptItem,
  turnChanges?: TurnChangesRef
): void {
  const previous = builder.rows.at(-1);
  if (
    previous?._tag === 'Error' &&
    !(previous.turnChanges && turnChanges && previous.turnChanges.checkpointId !== turnChanges.checkpointId)
  ) {
    previous.failures.push({ turnKey, item });
    builder.rows[builder.rows.length - 1] = {
      ...previous,
      turnKey,
      item,
      ...(turnChanges ? { turnChanges } : {}),
    };
    builder.currentTurnKey = turnKey;
    builder.previousRowWasUser = false;
    return;
  }
  beginBuilderTurn(builder, sessionKey, turnKey);
  builder.rows.push({
    _tag: 'Error',
    key: `${sessionKey}:failed:${turnKey}`,
    turnKey,
    item,
    failures: [{ turnKey, item }],
    ...(turnChanges ? { turnChanges } : {}),
  });
  builder.previousRowWasUser = false;
}

/** A cancelled prompt's status text reads as a cancelled completion row. */
function pushCancelledPromptRow(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  item: TranscriptItem,
  index: number,
  turnKey: string
): void {
  const key = transcriptRowKey(sessionKey, item, index);
  if (!claimRowKey(builder, key)) return;
  beginBuilderTurn(builder, sessionKey, turnKey, item);
  const held = cancelledRows.get(item);
  const row: TranscriptRowModel =
    held && held.key === key && held.turnKey === turnKey
      ? held
      : {
          _tag: 'AssistantPart',
          key,
          turnKey,
          item: {
            ...item,
            kind: 'turndone',
            status: 'cancelled',
            ...(isProcessRestartStatusText(item.text) ? { cause: 'restart' } : {}),
            elapsedMs: 0,
          } as TranscriptItem,
        };
  if (row !== held) cancelledRows.set(item, row);
  builder.rows.push(row);
  builder.previousRowWasUser = false;
}

interface SettledTranscriptInput {
  sessionKey: string;
  items: readonly TranscriptItem[];
  turnKeys: readonly string[];
  failedTurns: ReadonlySet<string>;
}

/** What the items say of one turn that reaches back to a row already placed. */
interface TurnFacts {
  /** The turn's first item. */
  first: number;
  /** Its last visible assistant item: a successful end folds into that row. */
  lastAssistant: number | undefined;
  /** Its ends that read as complete, oldest first. */
  dones: readonly number[];
}

const NO_DONES: readonly number[] = [];
const NO_ROWS: readonly TranscriptRowModel[] = [];
const NO_TURNS: ReadonlySet<string> = new Set();

/** The settled rows of a session's items, carried on from the projection made before.
 *
 *  A projection reads the items from the first one that changed, and places rows from the last point before it where no
 *  tool group was open (a mark). What an item says of rows placed earlier is kept as facts that are undone and folded again
 *  from that item: a turn's end folded into its last reply, the changed-files card of a checkpoint a later end closes again,
 *  a card no longer trailing once a prompt follows it. A row those reach is placed again from its turn's first item. A
 *  failed turn is always placed whole. Every row placed before the mark is the row of the projection before. */
export function createSettledProjector(): { project(input: SettledTranscriptInput): SettledTranscriptProjection } {
  let held: { input: SettledTranscriptInput; rows: readonly TranscriptRowModel[]; output: SettledTranscriptProjection } | null =
    null;
  let version = 0;
  let rowKeys = new Set<string>();
  let toolGroupKeys = new Set<string>();
  /** How many settled items carry each id. */
  let itemIds = new Map<unknown, number>();
  /** The marks, oldest first: the item each stands before, the rows placed by then, and the builder's state there. */
  let markItems: number[] = [];
  let markRows: number[] = [];
  let markTurns: string[] = [];
  let markAfterUser: boolean[] = [];
  let turns = new CarriedFacts<string, TurnFacts>();
  /** Per checkpoint, the last end that carries it: where its changed-files card sits. */
  let cardOwners = new CarriedFacts<string, number>();
  /** Per turn, the checkpoint its first prompt names. */
  let promptCheckpoints = new CarriedFacts<string, string>();
  /** Per end that carries a checkpoint, that checkpoint. */
  let endCheckpoints = new CarriedFacts<number, string>();
  /** Those ends, every turn's end, and the visible prompts, in transcript order. */
  let ends: number[] = [];
  let turnEnds: number[] = [];
  let visiblePrompts: number[] = [];

  const forget = () => {
    held = null;
    rowKeys = new Set();
    toolGroupKeys = new Set();
    itemIds = new Map();
    markItems = [];
    markRows = [];
    markTurns = [];
    markAfterUser = [];
    turns = new CarriedFacts();
    cardOwners = new CarriedFacts();
    promptCheckpoints = new CarriedFacts();
    endCheckpoints = new CarriedFacts();
    ends = [];
    turnEnds = [];
    visiblePrompts = [];
  };
  const countId = (id: unknown, by: 1 | -1) => {
    if (id === undefined || id === null) return;
    const count = (itemIds.get(id) ?? 0) + by;
    if (count > 0) itemIds.set(id, count);
    else itemIds.delete(id);
  };
  /** The last mark at or before item `index`; -1 when there is none. */
  const markBefore = (index: number): number => {
    let low = 0;
    let high = markItems.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((markItems[middle] as number) <= index) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };

  function project(input: SettledTranscriptInput): SettledTranscriptProjection {
    const { sessionKey, items, turnKeys, failedTurns } = input;
    if (held && held.input.sessionKey !== sessionKey) forget();
    const prior = held;
    if (
      prior &&
      prior.input.items === items &&
      prior.input.turnKeys === turnKeys &&
      prior.input.failedTurns === failedTurns
    ) {
      return prior.output;
    }
    const oldItems = prior?.input.items ?? [];
    const oldKeys = prior?.input.turnKeys ?? [];
    const oldFailed = prior?.input.failedTurns ?? NO_TURNS;
    const keyAt = (index: number) => turnKeys[index] || '';
    // The first item that is another object, or whose turn was renamed (a turn's end renames the items it holds).
    const kept = prior ? Math.min(keptFrom(items, oldItems), keptFrom(turnKeys, oldKeys)) : 0;
    // The first item whose row may differ from the one placed before.
    let dirty = kept;
    const reaches = (index: number) => {
      if (index < dirty) dirty = index;
    };
    const firstOf = (turnKey: string, otherwise: number) => turns.get(turnKey)?.first ?? otherwise;

    // A failed turn's status row sits at its last item or last end: a turn that is failed, was failed, or stops being
    // one is placed again from its first item.
    for (let index = kept; index < oldItems.length; index += 1) {
      const turnKey = oldKeys[index] || '';
      if (oldFailed.has(turnKey)) reaches(firstOf(turnKey, kept));
    }
    if (oldFailed !== failedTurns) {
      for (const turnKey of oldFailed) if (!failedTurns.has(turnKey)) reaches(firstOf(turnKey, kept));
      for (const turnKey of failedTurns) if (!oldFailed.has(turnKey)) reaches(firstOf(turnKey, kept));
    }

    // The facts of the items from `kept` on are undone, then folded from the new ones.
    const turnsBefore = new Map<string, TurnFacts | undefined>();
    const ownersBefore = new Map<string, number | undefined>();
    const promptBefore = visiblePrompts.at(-1) ?? -1;
    const endBefore = turnEnds.at(-1) ?? -1;
    turns.rewind(kept, (turnKey, facts) => {
      if (!turnsBefore.has(turnKey)) turnsBefore.set(turnKey, facts);
    });
    cardOwners.rewind(kept, (checkpointId, owner) => {
      if (!ownersBefore.has(checkpointId)) ownersBefore.set(checkpointId, owner);
    });
    promptCheckpoints.rewind(kept);
    endCheckpoints.rewind(kept);
    while (ends.length > 0 && (ends.at(-1) as number) >= kept) ends.pop();
    while (turnEnds.length > 0 && (turnEnds.at(-1) as number) >= kept) turnEnds.pop();
    while (visiblePrompts.length > 0 && (visiblePrompts.at(-1) as number) >= kept) visiblePrompts.pop();
    for (let index = kept; index < oldItems.length; index += 1) countId(oldItems[index]?.id, -1);
    for (let index = kept; index < items.length; index += 1) {
      const item = items[index];
      const turnKey = keyAt(index);
      countId(item?.id, 1);
      const facts = turns.get(turnKey);
      let next: TurnFacts = facts ?? { first: index, lastAssistant: undefined, dones: NO_DONES };
      if (item?.kind === 'assistant' && isVisibleTranscriptItem(item)) next = { ...next, lastAssistant: index };
      else if (item?.kind === 'turndone' && completionTone(item) === 'complete') {
        next = { ...next, dones: [...next.dones, index] };
      }
      if (next !== facts) {
        if (!turnsBefore.has(turnKey)) turnsBefore.set(turnKey, facts);
        turns.set(index, turnKey, next);
      }
      if (failedTurns.has(turnKey)) reaches(next.first);
      if (item?.kind === 'user') {
        // A turndone names its checkpoint, else its turn's prompt does (`checkpointId ?? id`).
        const id = item.checkpointId ?? item.id;
        if (!promptCheckpoints.has(turnKey) && id !== undefined && id !== null && id !== '') {
          promptCheckpoints.set(index, turnKey, String(id));
        }
        if (isVisibleTranscriptItem(item) && !isTranscriptCancelledStatusText(item.text)) visiblePrompts.push(index);
      }
      if (item?.kind === 'turndone') turnEnds.push(index);
      if (item?.kind === 'turndone' && item.archived !== true) {
        // An archived turn's Undo/Reapply would act on files and the model state
        // of a conversation the model no longer holds.
        const checkpointId =
          typeof item.checkpointId === 'string' && item.checkpointId
            ? item.checkpointId
            : promptCheckpoints.get(turnKey);
        if (checkpointId) {
          if (!ownersBefore.has(checkpointId)) ownersBefore.set(checkpointId, cardOwners.get(checkpointId));
          cardOwners.set(index, checkpointId, index);
          endCheckpoints.set(index, index, checkpointId);
          ends.push(index);
        }
      }
    }
    // A turn's end folds into its last reply, and moves there when the reply or the ends change.
    for (const [turnKey, before] of turnsBefore) {
      const after = turns.get(turnKey);
      const was = before?.dones ?? NO_DONES;
      const now = after?.dones ?? NO_DONES;
      const sameEnds = was.length === now.length && was.every((index, at) => index === now[at]);
      const replyMoved = before?.lastAssistant !== after?.lastAssistant && (was.length > 0 || now.length > 0);
      // An end among the items read again may be another object in the same place: the reply shows it.
      const endRead = (was.at(-1) ?? -1) >= kept || (now.at(-1) ?? -1) >= kept;
      if (!sameEnds || replyMoved || endRead) reaches(Math.min(before?.first ?? kept, after?.first ?? kept));
    }
    // One changed-files card per checkpoint, at the LAST turndone carrying it (a completion wake can close the same
    // checkpoint again): the end that had it, and the one that has it now, are placed again.
    for (const [checkpointId, before] of ownersBefore) {
      const after = cardOwners.get(checkpointId);
      if (before === after) continue;
      if (before !== undefined && before < kept) reaches(firstOf(keyAt(before), before));
      if (after !== undefined && after < kept) reaches(firstOf(keyAt(after), after));
    }
    // A card trails on the transcript's last turn end: the end that was last, and the one that is now.
    const lastEnd = turnEnds.at(-1) ?? -1;
    if (lastEnd !== endBefore) {
      for (const end of [endBefore, lastEnd]) {
        const checkpointId = endCheckpoints.get(end);
        if (end >= 0 && end < kept && checkpointId !== undefined && cardOwners.get(checkpointId) === end) {
          reaches(firstOf(keyAt(end), end));
        }
      }
    }
    // And only while no visible prompt follows it: the cards between the last prompt before and the last one now.
    const lastPrompt = visiblePrompts.at(-1) ?? -1;
    if (lastPrompt !== promptBefore) {
      const low = Math.min(lastPrompt, promptBefore);
      const high = Math.max(lastPrompt, promptBefore);
      for (let at = ends.length - 1; at >= 0 && (ends[at] as number) > low; at -= 1) {
        const end = ends[at] as number;
        if (end <= high && end < kept && cardOwners.get(endCheckpoints.get(end) as string) === end) {
          reaches(firstOf(keyAt(end), end));
        }
      }
    }

    const failed = (turnKey: string) => failedTurns.has(turnKey);
    // The mark the rows are placed from: every failed turn among the items after it begins after it.
    let mark = prior ? markBefore(dirty) : -1;
    for (let scanned = kept; mark >= 0 && failedTurns.size > 0; ) {
      const start = markItems[mark] as number;
      let lowest = start;
      for (let index = start; index < scanned; index += 1) {
        if (failed(keyAt(index))) lowest = Math.min(lowest, firstOf(keyAt(index), index));
      }
      if (lowest >= start) break;
      scanned = start;
      mark = markBefore(lowest);
    }
    const from = mark >= 0 ? (markItems[mark] as number) : 0;
    const rowsKept = mark >= 0 ? (markRows[mark] as number) : 0;
    const priorRows = prior?.rows ?? NO_ROWS;
    for (let at = rowsKept; at < priorRows.length; at += 1) {
      const row = priorRows[at] as TranscriptRowModel;
      if (row._tag === 'ToolActivity') toolGroupKeys.delete(row.key);
      else if (row._tag === 'UserMessage' || row._tag === 'AssistantPart') rowKeys.delete(row.key);
    }
    if (mark < 0) {
      // Nothing is kept: the key sets hold no row.
      rowKeys.clear();
      toolGroupKeys.clear();
    }
    markItems.length = mark + 1;
    markRows.length = mark + 1;
    markTurns.length = mark + 1;
    markAfterUser.length = mark + 1;
    const builder: TranscriptRowBuilder = {
      rows: priorRows.slice(0, rowsKept),
      currentTurnKey: mark >= 0 ? (markTurns[mark] as string) : '',
      previousRowWasUser: mark >= 0 ? (markAfterUser[mark] as boolean) : false,
      toolGroupKeys,
      rowKeys,
    };

    // Each failed turn's last item and last completion marker.
    const lastItemByTurn = new Map<string, number>();
    const lastCompletionByTurn = new Map<string, number>();
    if (failedTurns.size > 0) {
      for (let index = from; index < items.length; index += 1) {
        const turnKey = keyAt(index);
        if (!failed(turnKey)) continue;
        lastItemByTurn.set(turnKey, index);
        if (isCompletionTranscriptItem(items[index])) lastCompletionByTurn.set(turnKey, index);
      }
    }
    /** A successful turn's "Thought for …" completion belongs to the assistant row it closes, not to a row of its own. */
    const folded = (item: TranscriptItem | undefined, turnKey: string): boolean =>
      item?.kind === 'turndone' &&
      !failed(turnKey) &&
      completionTone(item) === 'complete' &&
      turns.get(turnKey)?.lastAssistant !== undefined;
    const cardAt = (index: number): TurnChangesRef | undefined => {
      const checkpointId = endCheckpoints.get(index);
      if (checkpointId === undefined || cardOwners.get(checkpointId) !== index) return undefined;
      const id = items[index]?.id;
      const trailing = index === lastEnd && index > lastPrompt;
      // An earlier end closed the same checkpoint (a completion wake closes it again): the card stood there already.
      let reclosed = false;
      for (let at = ends.length - 1; trailing && !reclosed && at >= 0 && (ends[at] as number) > lastPrompt; at -= 1) {
        const end = ends[at] as number;
        reclosed = end < index && endCheckpoints.get(end) === checkpointId;
      }
      return {
        checkpointId,
        boundary: id !== undefined && id !== null ? String(id) : `${checkpointId}:${index}`,
        trailing,
        ...(reclosed ? { reclosed } : {}),
      };
    };
    /** The completion a reply row closes with, and the card that rides on the row with it. */
    const closing = (index: number, turnKey: string) => {
      const facts = failed(turnKey) ? undefined : turns.get(turnKey);
      if (!facts || facts.lastAssistant !== index || facts.dones.length === 0) return null;
      let card: TurnChangesRef | undefined;
      for (let at = facts.dones.length - 1; at >= 0 && !card; at -= 1) card = cardAt(facts.dones[at] as number);
      return { completion: items[facts.dones.at(-1) as number], card };
    };
    let pendingToolActivity: PendingToolActivityItem[] = [];
    // Live-only rows met inside a group: a reload has none to end it, so they follow it.
    let heldLiveOnly: PendingToolActivityItem[] = [];
    // Each failed turn's last row placed so far: the fallback failure row's item.
    const lastShownByTurn = new Map<string, TranscriptItem>();
    const pushContentItem = (item: TranscriptItem, index: number, turnKey: string) => {
      const closed = closing(index, turnKey);
      pushBuilderItem(
        builder,
        sessionKey,
        item,
        index,
        turnKey,
        closed?.completion,
        closed ? closed.card : cardAt(index)
      );
      if (failed(turnKey)) lastShownByTurn.set(turnKey, item);
    };
    const flushToolActivity = () => {
      pushToolActivity(builder, sessionKey, pendingToolActivity);
      pendingToolActivity = [];
      const live = heldLiveOnly;
      heldLiveOnly = [];
      for (const { item, index, turnKey } of live) pushContentItem(item, index, turnKey);
    };
    const placeItem = (item: TranscriptItem, index: number, turnKey: string) => {
      if (failed(turnKey) && isCompletionTranscriptItem(item)) {
        // One status row per failed turn, at its last completion marker.
        if (index === lastCompletionByTurn.get(turnKey)) {
          flushToolActivity();
          pushFailureRow(builder, sessionKey, turnKey, item, cardAt(index));
        }
        return;
      }
      if (folded(item, turnKey)) {
        flushToolActivity();
        return;
      }
      if (item?.kind === 'user' && isTranscriptCancelledStatusText(item.text)) {
        flushToolActivity();
        pushCancelledPromptRow(builder, sessionKey, item, index, turnKey);
        return;
      }
      if (!isVisibleTranscriptItem(item)) return;
      if (item.kind === 'tool') {
        if (pendingToolActivity.length > 0 && pendingToolActivity[0]?.turnKey !== turnKey) {
          flushToolActivity();
        }
        pendingToolActivity.push({ item, index, turnKey });
        if (failed(turnKey)) lastShownByTurn.set(turnKey, item);
        return;
      }
      if (pendingToolActivity[0]?.turnKey === turnKey && isLiveOnlyTranscriptRow(item)) {
        heldLiveOnly.push({ item, index, turnKey });
        return;
      }
      flushToolActivity();
      pushContentItem(item, index, turnKey);
    };
    for (let index = from; index < items.length; index += 1) {
      // A mark: no group is open, and the last row is not a status row a later failure joins.
      if (
        pendingToolActivity.length === 0 &&
        heldLiveOnly.length === 0 &&
        builder.rows.at(-1)?._tag !== 'Error' &&
        (markItems.length === 0 || builder.rows.length > (markRows.at(-1) as number))
      ) {
        markItems.push(index);
        markRows.push(builder.rows.length);
        markTurns.push(builder.currentTurnKey);
        markAfterUser.push(builder.previousRowWasUser);
      }
      const item = items[index] as TranscriptItem;
      const turnKey = keyAt(index);
      placeItem(item, index, turnKey);
      // A turn that failed without ever emitting a completion marker still owes
      // the reader one status row where it ends, whatever its last item shows.
      if (failed(turnKey) && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
        flushToolActivity();
        pushFailureRow(builder, sessionKey, turnKey, lastShownByTurn.get(turnKey));
      }
    }
    flushToolActivity();

    // The rows placed again that are the rows held leave the list as it was.
    let unchanged = prior !== null && builder.rows.length === priorRows.length;
    for (let at = rowsKept; unchanged && at < priorRows.length; at += 1) unchanged = builder.rows[at] === priorRows[at];
    const rows = unchanged ? priorRows : builder.rows;
    if (prior && !unchanged) noteCarried(rows, priorRows, rowsKept);
    version += 1;
    const made = version;
    let ownIds: Set<unknown> | null = null;
    let ownKeys: Set<string> | null = null;
    const last = closingEnd(items);
    const output: SettledTranscriptProjection = {
      rows,
      currentTurnKey: builder.currentTurnKey,
      previousRowWasUser: builder.previousRowWasUser,
      itemCount: items.length,
      endsWithFoldedCompletion: last >= 0 && folded(items[last], keyAt(last)),
      openTurnKey: last < 0 && items.length > 0 ? keyAt(items.length - 1) : '',
      // The projector's own sets answer for its newest projection; an older one still read answers from its own rows.
      hasSettledItem(id) {
        if (id === undefined || id === null) return false;
        if (made === version) return itemIds.has(id);
        ownIds ??= new Set(items.map((item) => item?.id));
        return ownIds.has(id);
      },
      hasRowKey(key) {
        if (made === version) return rowKeys.has(key);
        ownKeys ??= new Set(
          rows.flatMap((row) => (row._tag === 'UserMessage' || row._tag === 'AssistantPart' ? [row.key] : []))
        );
        return ownKeys.has(key);
      },
    };
    held = { input, rows, output };
    return output;
  }
  return { project };
}

/** The settled rows of `items`, placed from nothing. */
export function projectSettledTranscriptRows(input: SettledTranscriptInput): SettledTranscriptProjection {
  return createSettledProjector().project(input);
}

/** Per-tick half: pending prompts, the live tail, the messages sent while the
 *  turn runs, and the thinking row are appended onto the memoized settled rows
 *  without mutating them. */
export function appendLiveTranscriptRows({
  sessionKey,
  settled,
  pendingItems = [],
  steerItems = [],
  liveItem,
  thinking = false,
  opening = false,
  turnRunning = false,
  prior,
}: {
  /** What runs has settled no row yet after a turn's end: its band and its arriving reply open a turn of their own
   *  instead of reopening the ended turn, whose footer and cards stand. */
  opening?: boolean;
  /** The rows this made last: a row that is the same again is that row, and the list says how many of its leading rows
   *  are the ones `prior` holds. */
  prior?: readonly TranscriptRowModel[];
  sessionKey: string;
  settled: SettledTranscriptProjection;
  pendingItems?: readonly TranscriptItem[];
  /** Sent while the turn runs, not read yet: user bubbles after the live
   *  output, where their durable rows land once the model reads them. */
  steerItems?: readonly TranscriptItem[];
  liveItem?: TranscriptItem | null;
  thinking?: boolean;
  /** The session reports a running turn: the tool group it ends in stays open. */
  turnRunning?: boolean;
}): TranscriptRowModel[] {
  const builder: TranscriptRowBuilder = {
    rows: [...settled.rows],
    currentTurnKey: settled.currentTurnKey,
    previousRowWasUser: settled.previousRowWasUser,
    toolGroupKeys: new Set(),
    rowKeys: new Set(),
    priorRowKey: (key) => settled.hasRowKey(key),
  };
  const itemCount = settled.itemCount;
  pendingItems.forEach((item, index) => {
    pushBuilderItem(builder, sessionKey, item, itemCount + index, `pending:${String(item.id ?? index)}`);
  });

  // The live rows are the open turn's: a pending prompt's, else the one the settled items leave open, else (they close
  // with an end still winding down) the last row's.
  const openTurnKey = pendingItems.length > 0 ? '' : settled.openTurnKey;
  const activeTurnKey = (!opening && (openTurnKey || builder.currentTurnKey)) || `${sessionKey}:active`;
  if (liveItem) pushLiveAssistantRow(builder, sessionKey, settled, liveItem, activeTurnKey);

  steerItems.forEach((item, index) => {
    pushBuilderItem(
      builder,
      sessionKey,
      item,
      itemCount + pendingItems.length + index,
      `pending:${String(item.id ?? index)}`
    );
  });
  if (thinking) {
    pushThinkingRow(builder, sessionKey, steerItems.length ? builder.currentTurnKey : activeTurnKey, prior?.at(-1));
  }
  const opened = turnRunning ? openTailToolActivity(builder.rows) : -1;
  settledUnder.set(builder.rows, { rows: settled.rows, opened });
  const under = prior ? settledUnder.get(prior) : undefined;
  if (prior && under) {
    // The settled rows both lists begin with, less the group either shows open in place of its settled row.
    let kept = Math.min(keptFrom(settled.rows, under.rows), settled.rows.length, under.rows.length);
    for (const at of [opened, under.opened]) {
      if (at >= 0 && at < kept && builder.rows[at] !== prior[at]) kept = at;
    }
    noteCarried(builder.rows, prior, kept);
  }
  return builder.rows;
}

/** The settled rows a live list was appended to, and the row it shows open (-1: none), by the list. */
const settledUnder = new WeakMap<readonly TranscriptRowModel[], { rows: readonly TranscriptRowModel[]; opened: number }>();

function pushLiveAssistantRow(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  settled: SettledTranscriptProjection,
  liveItem: TranscriptItem,
  activeTurnKey: string
): void {
  const alreadySettled = liveItem.id != null && settled.hasSettledItem(liveItem.id);
  const paintsNothing =
    liveItem.kind === 'assistant' && Boolean(liveItem.streaming) && !streamingTextPaints(String(liveItem.text || ''));
  const key = transcriptRowKey(sessionKey, liveItem, settled.itemCount);
  if (alreadySettled || paintsNothing || !claimRowKey(builder, key)) return;
  beginBuilderTurn(builder, sessionKey, activeTurnKey, liveItem);
  const held = liveRows.get(liveItem);
  const row: TranscriptRowModel =
    held && held.key === key && held.turnKey === activeTurnKey
      ? held
      : { _tag: 'AssistantPart', key, turnKey: activeTurnKey, item: liveItem, active: true, live: true };
  if (row !== held) liveRows.set(liveItem, row);
  builder.rows.push(row);
  builder.previousRowWasUser = false;
}

/** `held`: the row that ended the list made before. */
function pushThinkingRow(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  turnKey: string,
  held?: TranscriptRowModel
): void {
  beginBuilderTurn(builder, sessionKey, turnKey);
  const key = thinkingRowKey(sessionKey, turnKey);
  builder.rows.push(
    held?._tag === 'Thinking' && held.key === key && held.turnKey === turnKey
      ? held
      : { _tag: 'Thinking', key, turnKey, active: true }
  );
  builder.previousRowWasUser = false;
}

/** Shows the tool group a running turn ends in as open; the row it replaced, or -1. */
function openTailToolActivity(rows: TranscriptRowModel[]): number {
  let tail = rows.length - 1;
  const passes = (row: TranscriptRowModel | undefined) =>
    row?._tag === 'Thinking' || (row?._tag === 'AssistantPart' && !row.live && isLiveOnlyTranscriptRow(row.item));
  while (tail >= 0 && passes(rows[tail])) tail -= 1;
  const row = rows[tail];
  if (row?._tag !== 'ToolActivity') return -1;
  let open = openGroupRows.get(row);
  if (!open) {
    open = { ...row, open: true };
    openGroupRows.set(row, open);
  }
  rows[tail] = open;
  return tail;
}

const TURN_CHROME_KINDS = new Set(['user', 'turndone', 'statusdone', 'notice']);

/** Whether the turn produced assistant or tool output before it ended — a
 *  retry then continues from that output instead of resubmitting the prompt. */
export function turnSampledOutput(
  items: readonly TranscriptItem[],
  turnKeys: readonly string[],
  turnKey: string
): boolean {
  for (let index = 0; index < items.length; index += 1) {
    if ((turnKeys[index] || '') !== turnKey) continue;
    if (!TURN_CHROME_KINDS.has(String(items[index]?.kind || ''))) return true;
  }
  return false;
}

/** The user prompt that opened a turn — the retry action resubmits it. */
export function turnPromptText(items: readonly TranscriptItem[], turnKeys: readonly string[], turnKey: string): string {
  for (let index = 0; index < items.length; index += 1) {
    if ((turnKeys[index] || '') !== turnKey) continue;
    const item = items[index];
    if (item?.kind !== 'user') continue;
    const text = String(item.text ?? '').trim();
    if (text) return text;
  }
  return '';
}
