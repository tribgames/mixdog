import type { TranscriptItem } from './desktop-types';
import type { TurnChangesRef } from './turn-changes-model';
import { completionTone } from './transcript-primitives';
import { isVisibleTranscriptItem } from './transcript-row';
import { streamingTextPaints } from './use-transcript-text-reveal';
import { isLiveOnlyTranscriptRow } from '../../../../packages/protocol-client/src/rows.ts';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isProcessRestartStatusText, isTranscriptCancelledStatusText } from '../../../../packages/protocol-client/src/shared/tool-execution-contract.mjs';

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
  const key = transcriptRowKey(sessionKey, item, index);
  // The row already placed under this key is the one copy (its turn gap too).
  if (!claimRowKey(builder, key)) return;
  beginBuilderTurn(builder, sessionKey, turnKey);
  if (item.kind === 'user') {
    builder.rows.push({
      _tag: 'UserMessage',
      key,
      turnKey,
      item,
      attachedUser: builder.previousRowWasUser,
    });
    builder.previousRowWasUser = true;
    return;
  }
  builder.rows.push({
    _tag: 'AssistantPart',
    key,
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
  /** Message row keys the settled rows carry. */
  rowKeys: ReadonlySet<string>;
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
    if (item?.kind === 'assistant' && isVisibleTranscriptItem(item)) lastAssistantByTurn.set(turnKey, index);
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
  beginBuilderTurn(builder, sessionKey, turnKey);
  builder.rows.push({
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
  });
  builder.previousRowWasUser = false;
}

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
    rowKeys: new Set(),
  };
  let pendingToolActivity: PendingToolActivityItem[] = [];
  // Live-only rows met inside a group: a reload has none to end it, so they follow it.
  let heldLiveOnly: PendingToolActivityItem[] = [];
  // Each turn's last row placed so far: the fallback failure row's item.
  const lastShownByTurn = new Map<string, TranscriptItem>();
  const pushContentItem = (item: TranscriptItem, index: number, turnKey: string) => {
    pushBuilderItem(
      builder,
      sessionKey,
      item,
      index,
      turnKey,
      completionByIndex.get(index),
      turnChangesByIndex.get(index)
    );
    lastShownByTurn.set(turnKey, item);
  };
  const flushToolActivity = () => {
    pushToolActivity(builder, sessionKey, pendingToolActivity);
    pendingToolActivity = [];
    const held = heldLiveOnly;
    heldLiveOnly = [];
    for (const { item, index, turnKey } of held) pushContentItem(item, index, turnKey);
  };
  const placeItem = (item: TranscriptItem, index: number, turnKey: string) => {
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
      lastShownByTurn.set(turnKey, item);
      return;
    }
    if (pendingToolActivity[0]?.turnKey === turnKey && isLiveOnlyTranscriptRow(item)) {
      heldLiveOnly.push({ item, index, turnKey });
      return;
    }
    flushToolActivity();
    pushContentItem(item, index, turnKey);
  };
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || '';
    placeItem(item, index, turnKey);
    // A turn that failed without ever emitting a completion marker still owes
    // the reader one status row where it ends, whatever its last item shows.
    if (failedTurns.has(turnKey) && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
      flushToolActivity();
      pushFailureRow(builder, sessionKey, turnKey, lastShownByTurn.get(turnKey));
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
    rowKeys: builder.rowKeys,
  };
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
  turnRunning = false,
}: {
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
    priorRowKey: (key) => settled.rowKeys.has(key),
  };
  const itemCount = settled.itemCount;
  pendingItems.forEach((item, index) => {
    pushBuilderItem(builder, sessionKey, item, itemCount + index, `pending:${String(item.id ?? index)}`);
  });

  const activeTurnKey = builder.currentTurnKey || `${sessionKey}:active`;
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
  if (thinking) pushThinkingRow(builder, sessionKey, steerItems.length ? builder.currentTurnKey : activeTurnKey);
  if (turnRunning) openTailToolActivity(builder.rows);
  return builder.rows;
}

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
  beginBuilderTurn(builder, sessionKey, activeTurnKey);
  builder.rows.push({
    _tag: 'AssistantPart',
    key,
    turnKey: activeTurnKey,
    item: liveItem,
    active: true,
    live: true,
  });
  builder.previousRowWasUser = false;
}

function pushThinkingRow(builder: TranscriptRowBuilder, sessionKey: string, turnKey: string): void {
  beginBuilderTurn(builder, sessionKey, turnKey);
  builder.rows.push({ _tag: 'Thinking', key: thinkingRowKey(sessionKey, turnKey), turnKey, active: true });
  builder.previousRowWasUser = false;
}

function openTailToolActivity(rows: TranscriptRowModel[]): void {
  let tail = rows.length - 1;
  const passes = (row: TranscriptRowModel | undefined) =>
    row?._tag === 'Thinking' || (row?._tag === 'AssistantPart' && !row.live && isLiveOnlyTranscriptRow(row.item));
  while (tail >= 0 && passes(rows[tail])) tail -= 1;
  const row = rows[tail];
  if (row?._tag === 'ToolActivity') rows[tail] = { ...row, open: true };
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
