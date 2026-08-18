import type { TranscriptItem } from "./desktop-types";
import { completionTone, isVisibleTranscriptItem } from "./TranscriptView";

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
      _tag: "TurnGap";
      key: string;
      turnKey: string;
    }
  | {
      _tag: "UserMessage";
      key: string;
      turnKey: string;
      item: TranscriptItem;
      attachedUser: boolean;
    }
  | {
      _tag: "AssistantPart";
      key: string;
      turnKey: string;
      item: TranscriptItem;
      completion?: TranscriptItem;
      active?: boolean;
      live?: boolean;
    }
  | {
      _tag: "Thinking";
      key: string;
      turnKey: string;
      active: true;
    }
  | {
      _tag: "Error";
      key: string;
      turnKey: string;
    };

export function isCompletionTranscriptItem(item: TranscriptItem | undefined): boolean {
  return item?.kind === "statusdone" || item?.kind === "turndone";
}

export function transcriptRowKey(
  sessionKey: string,
  item: TranscriptItem | undefined,
  index: number,
): string {
  const id = item?.id;
  return id !== undefined && id !== null
    ? `${sessionKey}:${String(id)}`
    : `${sessionKey}:${item?.kind || "row"}-${index}`;
}

interface TranscriptRowBuilder {
  rows: TranscriptRowModel[];
  currentTurnKey: string;
  previousRowWasUser: boolean;
}

function beginBuilderTurn(
  builder: TranscriptRowBuilder,
  sessionKey: string,
  turnKey: string,
): void {
  if (builder.rows.length > 0 && builder.currentTurnKey && turnKey !== builder.currentTurnKey) {
    builder.rows.push({
      _tag: "TurnGap",
      key: `${sessionKey}:gap:${turnKey}`,
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
): void {
  beginBuilderTurn(builder, sessionKey, turnKey);
  if (item.kind === "user") {
    builder.rows.push({
      _tag: "UserMessage",
      key: transcriptRowKey(sessionKey, item, index),
      turnKey,
      item,
      attachedUser: builder.previousRowWasUser,
    });
    builder.previousRowWasUser = true;
    return;
  }
  builder.rows.push({
    _tag: "AssistantPart",
    key: transcriptRowKey(sessionKey, item, index),
    turnKey,
    item,
    completion,
  });
  builder.previousRowWasUser = false;
}

export interface SettledTranscriptProjection {
  rows: readonly TranscriptRowModel[];
  currentTurnKey: string;
  previousRowWasUser: boolean;
  itemCount: number;
  settledItemIds: ReadonlySet<unknown>;
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
  const lastItemByTurn = new Map<string, number>();
  const lastCompletionByTurn = new Map<string, number>();
  const lastAssistantByTurn = new Map<string, number>();
  const settledItemIds = new Set<unknown>();
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || "";
    lastItemByTurn.set(turnKey, index);
    if (item?.id != null) settledItemIds.add(item.id);
    if (item?.kind === "assistant") lastAssistantByTurn.set(turnKey, index);
    if (isCompletionTranscriptItem(item)) lastCompletionByTurn.set(turnKey, index);
  });
  // A successful turn's "Thought for …" completion belongs to the assistant
  // row it closes, not to a row of its own.
  const completionByIndex = new Map<number, TranscriptItem>();
  const foldedCompletions = new Set<number>();
  items.forEach((item, index) => {
    if (item?.kind !== "turndone") return;
    const turnKey = turnKeys[index] || "";
    if (failedTurns.has(turnKey) || completionTone(item) !== "complete") return;
    const assistantIndex = lastAssistantByTurn.get(turnKey);
    if (assistantIndex === undefined) return;
    completionByIndex.set(assistantIndex, item);
    foldedCompletions.add(index);
  });
  const builder: TranscriptRowBuilder = {
    rows: [],
    currentTurnKey: "",
    previousRowWasUser: false,
  };
  const pushFailure = (turnKey: string) => {
    beginBuilderTurn(builder, sessionKey, turnKey);
    builder.rows.push({ _tag: "Error", key: `${sessionKey}:failed:${turnKey}`, turnKey });
    builder.previousRowWasUser = false;
  };
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || "";
    const failed = failedTurns.has(turnKey);
    if (failed && isCompletionTranscriptItem(item)) {
      // One status row per failed turn, at its last completion marker.
      if (index === lastCompletionByTurn.get(turnKey)) pushFailure(turnKey);
      return;
    }
    if (foldedCompletions.has(index)) return;
    if (!isVisibleTranscriptItem(item)) return;
    pushBuilderItem(builder, sessionKey, item, index, turnKey, completionByIndex.get(index));
    // A turn that failed without ever emitting a completion marker still owes
    // the reader one status row after its last content row.
    if (failed && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
      pushFailure(turnKey);
    }
  });
  return {
    rows: builder.rows,
    currentTurnKey: builder.currentTurnKey,
    previousRowWasUser: builder.previousRowWasUser,
    itemCount: items.length,
    settledItemIds,
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
  const liveItemAlreadySettled = liveItem?.id != null
    && settled.settledItemIds.has(liveItem.id);
  if (liveItem && !liveItemAlreadySettled) {
    beginBuilderTurn(builder, sessionKey, activeTurnKey);
    builder.rows.push({
      _tag: "AssistantPart",
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
      _tag: "Thinking",
      key: `${sessionKey}:thinking:${activeTurnKey}`,
      turnKey: activeTurnKey,
      active: true,
    });
    builder.previousRowWasUser = false;
  }

  queuedPrompts.forEach((item, index) => {
    pushBuilderItem(
      builder,
      sessionKey,
      item,
      itemCount + activePrompts.length + index,
      `pending:${String(item.id ?? index)}`,
    );
  });
  return builder.rows;
}

export function projectTranscriptRows({
  sessionKey,
  items,
  turnKeys,
  failedTurns,
  pendingItems = [],
  liveItem,
  thinking = false,
}: {
  sessionKey: string;
  items: readonly TranscriptItem[];
  turnKeys: readonly string[];
  failedTurns: ReadonlySet<string>;
  pendingItems?: readonly (TranscriptItem & { queuedBehindTurn?: boolean })[];
  liveItem?: TranscriptItem | null;
  thinking?: boolean;
}): TranscriptRowModel[] {
  return appendLiveTranscriptRows({
    sessionKey,
    settled: projectSettledTranscriptRows({ sessionKey, items, turnKeys, failedTurns }),
    pendingItems,
    liveItem,
    thinking,
  });
}

/** The user prompt that opened a turn — the retry action resubmits it. */
export function turnPromptText(
  items: readonly TranscriptItem[],
  turnKeys: readonly string[],
  turnKey: string,
): string {
  for (let index = 0; index < items.length; index += 1) {
    if ((turnKeys[index] || "") !== turnKey) continue;
    const item = items[index];
    if (item?.kind !== "user") continue;
    const text = String(item.text ?? "").trim();
    if (text) return text;
  }
  return "";
}
