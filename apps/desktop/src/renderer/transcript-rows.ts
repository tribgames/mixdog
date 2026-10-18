import type { TranscriptItem } from './desktop-types';
import type { TurnChangesRef } from './turn-changes-model';
import { completionTone } from './transcript-primitives';
import { isVisibleTranscriptItem } from './transcript-row';
import { streamingTextPaints } from './use-paced-transcript-text';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isTranscriptCancelledStatusText } from '../../../../src/runtime/shared/tool-execution-contract.mjs';

/**
 * Transcript projection: turn semantics are preserved as explicit row tags,
 * while the virtualizer consumes one flat stable-key list.
 *
 * Every visibility decision (hidden internal prompts, suppressed tool
 * failures, completions folded into their assistant row, failed-turn status
 * rows, live output, optimistic prompts, and thinking state) happens HERE.
 */
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
      /** Nothing but the live activity band follows this part: its streamed
       *  text may still be revealing. Any later row (a tool card, the next
       *  part) clears it, which reveals the text whole in that same commit. */
      newest?: boolean;
      /** This row holds the last turndone of a checkpoint: its changed-files card follows. */
      turnChanges?: TurnChangesRef;
    }
  | {
      _tag: 'ToolActivity';
      key: string;
      turnKey: string;
      items: readonly TranscriptItem[];
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
}

/** pending:${id} and turn:${id} are one submission. The virtualizer identifies
 *  rows by key, so the prefix flip must not re-key the submission's rows: a
 *  re-keyed row remounts (the thinking timer restarts) and paints one frame at
 *  the flat row estimate (the turn gap bounced the transcript by 40px). */
export function submissionIdentity(turnKey: string): string {
  if (turnKey.startsWith('pending:')) return turnKey.slice('pending:'.length);
  if (turnKey.startsWith('turn:')) return turnKey.slice('turn:'.length);
  return turnKey;
}

function thinkingRowKey(sessionKey: string, turnKey: string): string {
  return `${sessionKey}:thinking:${submissionIdentity(turnKey)}`;
}

function beginBuilderTurn(builder: TranscriptRowBuilder, sessionKey: string, turnKey: string): void {
  if (builder.rows.length > 0 && builder.currentTurnKey && turnKey !== builder.currentTurnKey) {
    builder.rows.push({
      _tag: 'TurnGap',
      key: `${sessionKey}:gap:${submissionIdentity(turnKey)}`,
      turnKey,
    });
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
  beginBuilderTurn(builder, sessionKey, turnKey);
  if (item.kind === 'user') {
    builder.rows.push({
      _tag: 'UserMessage',
      key: transcriptRowKey(sessionKey, item, index),
      turnKey,
      item,
      attachedUser: builder.previousRowWasUser,
    });
    builder.previousRowWasUser = true;
    return;
  }
  builder.rows.push({
    _tag: 'AssistantPart',
    key: transcriptRowKey(sessionKey, item, index),
    turnKey,
    item,
    completion,
    ...(turnChanges ? { turnChanges } : {}),
  });
  builder.previousRowWasUser = false;
}

/** One changed-files card per checkpoint, at the LAST turndone carrying it
 *  (a completion wake can close the same checkpoint again). A turndone names
 *  its checkpoint, else its turn's prompt does (`checkpointId ?? id`). */
function turnChangesByCompletion(
  items: readonly TranscriptItem[],
  turnKeys: readonly string[]
): Map<number, TurnChangesRef> {
  const promptCheckpoint = new Map<string, string>();
  const lastByCheckpoint = new Map<string, number>();
  let lastVisiblePrompt = -1;
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || '';
    if (item?.kind === 'user') {
      const id = item.checkpointId ?? item.id;
      if (!promptCheckpoint.has(turnKey) && id !== undefined && id !== null && id !== '') {
        promptCheckpoint.set(turnKey, String(id));
      }
      if (isVisibleTranscriptItem(item) && !isTranscriptCancelledStatusText(item.text)) lastVisiblePrompt = index;
      return;
    }
    // An archived turn's Undo/Reapply would act on files and the model state
    // of a conversation the model no longer holds.
    if (item?.kind !== 'turndone' || item.archived === true) return;
    const checkpointId =
      typeof item.checkpointId === 'string' && item.checkpointId ? item.checkpointId : promptCheckpoint.get(turnKey);
    if (checkpointId) lastByCheckpoint.set(checkpointId, index);
  });
  const cards = new Map<number, TurnChangesRef>();
  for (const [checkpointId, index] of lastByCheckpoint) {
    const id = items[index]?.id;
    cards.set(index, {
      checkpointId,
      boundary: id !== undefined && id !== null ? String(id) : `${checkpointId}:${index}`,
      trailing: index > lastVisiblePrompt,
    });
  }
  return cards;
}

interface PendingToolActivityItem {
  item: TranscriptItem;
  index: number;
  turnKey: string;
}

// A tool group's row key is the key it was FIRST shown under, remembered per
// member id. Keying by the first member alone re-keyed (and remounted) a group
// whenever an older history page supplied the tools a window cut had split
// off its head; keying by the last member would re-key it on every tool a
// live turn appends. Any member that was already shown carries the group's
// key into the next projection, so both growth directions keep it.
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
  let key = own;
  for (const id of ids) {
    const remembered = memory.get(id);
    // One key per row within a projection, whatever the memory says.
    if (remembered && !builder.toolGroupKeys.has(remembered)) {
      key = remembered;
      break;
    }
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
  beginBuilderTurn(builder, sessionKey, first.turnKey);
  const key = toolActivityRowKey(builder, sessionKey, pending);
  builder.toolGroupKeys.add(key);
  builder.rows.push({
    _tag: 'ToolActivity',
    key,
    turnKey: first.turnKey,
    items: pending.map(({ item }) => item),
  });
  builder.previousRowWasUser = false;
}

interface SettledTranscriptProjection {
  rows: readonly TranscriptRowModel[];
  currentTurnKey: string;
  previousRowWasUser: boolean;
  itemCount: number;
  /** The last settled item is a successful completion folded into its
   *  assistant row: that row's footer now stands where the live band was. */
  endsWithFoldedCompletion: boolean;
  hasSettledItem(id: unknown): boolean;
}

/** Whether an id belongs to a settled item; the id set is built on first use. */
function settledItemLookup(items: readonly TranscriptItem[]): (id: unknown) => boolean {
  let settledItemIds: Set<unknown> | null = null;
  return (id: unknown): boolean => {
    if (id === undefined || id === null) return false;
    if (!settledItemIds) {
      settledItemIds = new Set(
        items.map((item) => item?.id).filter((itemId) => itemId !== undefined && itemId !== null)
      );
    }
    return settledItemIds.has(id);
  };
}

/** Each turn's last item, last completion marker and last assistant item. */
function lastIndexesByTurn(items: readonly TranscriptItem[], turnKeys: readonly string[]) {
  const lastItemByTurn = new Map<string, number>();
  const lastCompletionByTurn = new Map<string, number>();
  const lastAssistantByTurn = new Map<string, number>();
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || '';
    lastItemByTurn.set(turnKey, index);
    if (item?.kind === 'assistant') lastAssistantByTurn.set(turnKey, index);
    if (isCompletionTranscriptItem(item)) lastCompletionByTurn.set(turnKey, index);
  });
  return { lastItemByTurn, lastCompletionByTurn, lastAssistantByTurn };
}

/** A successful turn's "Thought for …" completion belongs to the assistant
 *  row it closes, not to a row of its own; its changed-files card moves with
 *  it. */
function foldTurnCompletions(
  items: readonly TranscriptItem[],
  turnKeys: readonly string[],
  failedTurns: ReadonlySet<string>,
  lastAssistantByTurn: ReadonlyMap<string, number>
) {
  const completionByIndex = new Map<number, TranscriptItem>();
  const foldedCompletions = new Set<number>();
  const turnChangesByIndex = turnChangesByCompletion(items, turnKeys);
  items.forEach((item, index) => {
    if (item?.kind !== 'turndone') return;
    const turnKey = turnKeys[index] || '';
    if (failedTurns.has(turnKey) || completionTone(item) !== 'complete') return;
    const assistantIndex = lastAssistantByTurn.get(turnKey);
    if (assistantIndex === undefined) return;
    completionByIndex.set(assistantIndex, item);
    foldedCompletions.add(index);
    // A folded completion's card rides on the assistant row it folds into.
    const card = turnChangesByIndex.get(index);
    if (card) {
      turnChangesByIndex.delete(index);
      turnChangesByIndex.set(assistantIndex, card);
    }
  });
  return { completionByIndex, foldedCompletions, turnChangesByIndex };
}

function pushFailureRow(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  turnKey: string,
  item?: TranscriptItem,
  turnChanges?: TurnChangesRef
): void {
  // Hidden continuation/recovery turns do not create another visible error
  // surface. Any visible prompt, output or tool activity seals this run.
  // A run never swallows a distinct checkpoint's changes card, so two
  // card-bearing checkpoints keep separate rows.
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
  beginBuilderTurn(builder, sessionKey, turnKey);
  builder.rows.push({
    _tag: 'AssistantPart',
    key: transcriptRowKey(sessionKey, item, index),
    turnKey,
    item: {
      ...item,
      kind: 'turndone',
      status: 'cancelled',
      elapsedMs: 0,
    } as TranscriptItem,
  });
  builder.previousRowWasUser = false;
}

/**
 * Settled half of the projection. During streaming only the live tail changes
 * per publication tick, so callers memoize this result on the settled inputs
 * and re-run just `appendLiveTranscriptRows` per tick — the O(items) walk and
 * its per-turn maps run only when a settled item actually lands. Settled row
 * object identity also stays stable across ticks, so memoized row renderers
 * skip unchanged rows.
 */
export function projectSettledTranscriptRows({
  sessionKey,
  items,
  turnKeys,
  failedTurns,
}: {
  sessionKey: string;
  items: readonly TranscriptItem[];
  turnKeys: readonly string[];
  failedTurns: ReadonlySet<string>;
}): SettledTranscriptProjection {
  const { lastItemByTurn, lastCompletionByTurn, lastAssistantByTurn } = lastIndexesByTurn(items, turnKeys);
  const { completionByIndex, foldedCompletions, turnChangesByIndex } = foldTurnCompletions(
    items,
    turnKeys,
    failedTurns,
    lastAssistantByTurn
  );
  const builder: TranscriptRowBuilder = {
    rows: [],
    currentTurnKey: '',
    previousRowWasUser: false,
    toolGroupKeys: new Set(),
  };
  let pendingToolActivity: PendingToolActivityItem[] = [];
  const flushToolActivity = () => {
    pushToolActivity(builder, sessionKey, pendingToolActivity);
    pendingToolActivity = [];
  };
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || '';
    const failed = failedTurns.has(turnKey);
    if (failed && isCompletionTranscriptItem(item)) {
      // One status row per failed turn, at its last completion marker.
      if (index === lastCompletionByTurn.get(turnKey)) {
        flushToolActivity();
        pushFailureRow(builder, sessionKey, turnKey, item, turnChangesByIndex.get(index));
      }
      return;
    }
    if (foldedCompletions.has(index)) {
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
      if (failed && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
        flushToolActivity();
        pushFailureRow(builder, sessionKey, turnKey, item);
      }
      return;
    }
    flushToolActivity();
    pushBuilderItem(
      builder,
      sessionKey,
      item,
      index,
      turnKey,
      completionByIndex.get(index),
      turnChangesByIndex.get(index)
    );
    // A turn that failed without ever emitting a completion marker still owes
    // the reader one status row after its last content row.
    if (failed && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
      pushFailureRow(builder, sessionKey, turnKey, item);
    }
  });
  flushToolActivity();
  return {
    rows: builder.rows,
    currentTurnKey: builder.currentTurnKey,
    previousRowWasUser: builder.previousRowWasUser,
    itemCount: items.length,
    endsWithFoldedCompletion: items.length > 0 && foldedCompletions.has(items.length - 1),
    hasSettledItem: settledItemLookup(items),
  };
}

/** Per-tick half: pending prompts, the live tail, and the thinking row are
 *  appended onto the memoized settled rows without mutating them. */
export function appendLiveTranscriptRows({
  sessionKey,
  settled,
  pendingItems = [],
  liveItem,
  thinking = false,
}: {
  sessionKey: string;
  settled: SettledTranscriptProjection;
  pendingItems?: readonly (TranscriptItem & { queuedBehindTurn?: boolean })[];
  liveItem?: TranscriptItem | null;
  thinking?: boolean;
}): TranscriptRowModel[] {
  const builder: TranscriptRowBuilder = {
    rows: [...settled.rows],
    currentTurnKey: settled.currentTurnKey,
    previousRowWasUser: settled.previousRowWasUser,
    toolGroupKeys: new Set(),
  };
  const itemCount = settled.itemCount;
  const activePrompts = pendingItems.filter((item) => item.queuedBehindTurn !== true);
  const queuedPrompts = pendingItems.filter((item) => item.queuedBehindTurn === true);
  activePrompts.forEach((item, index) => {
    pushBuilderItem(builder, sessionKey, item, itemCount + index, `pending:${String(item.id ?? index)}`);
  });

  const activeTurnKey = builder.currentTurnKey || `${sessionKey}:active`;
  // A delayed lane can briefly publish a tail whose id has already settled.
  // Never create a second stable-key row for that stale publication.
  const liveItemAlreadySettled = liveItem?.id != null && settled.hasSettledItem(liveItem.id);
  // A streaming reply with nothing to paint yet (only whitespace or markdown
  // markers) opens no row: its row takes a line and moves the band below it,
  // so the followed transcript moved up before any reply text painted. It
  // opens with the first text that shows, which it paints in that commit.
  const liveItemPaintsNothing =
    liveItem?.kind === 'assistant' && Boolean(liveItem.streaming) && !streamingTextPaints(String(liveItem.text || ''));
  if (liveItem && !liveItemAlreadySettled && !liveItemPaintsNothing) {
    beginBuilderTurn(builder, sessionKey, activeTurnKey);
    builder.rows.push({
      _tag: 'AssistantPart',
      key: transcriptRowKey(sessionKey, liveItem, itemCount),
      turnKey: activeTurnKey,
      item: liveItem,
      active: true,
      live: true,
    });
    builder.previousRowWasUser = false;
  }
  if (thinking) {
    beginBuilderTurn(builder, sessionKey, activeTurnKey);
    builder.rows.push({
      _tag: 'Thinking',
      key: thinkingRowKey(sessionKey, activeTurnKey),
      turnKey: activeTurnKey,
      active: true,
    });
    builder.previousRowWasUser = false;
  }

  let newest = builder.rows.length - 1;
  while (newest >= 0 && builder.rows[newest]._tag === 'Thinking') newest -= 1;
  const newestRow = builder.rows[newest];
  if (newestRow?._tag === 'AssistantPart' && newestRow.item.kind === 'assistant') {
    builder.rows[newest] = { ...newestRow, newest: true };
  }

  queuedPrompts.forEach((item, index) => {
    pushBuilderItem(
      builder,
      sessionKey,
      item,
      itemCount + activePrompts.length + index,
      `pending:${String(item.id ?? index)}`
    );
  });
  return builder.rows;
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
