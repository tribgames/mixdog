import type { TranscriptItem } from "./desktop-types";
import { completionTone, isVisibleTranscriptItem } from "./TranscriptView";

/**
 * OpenCode-style transcript projection: turn semantics are preserved as
 * explicit row tags, while the virtualizer consumes one flat stable-key list.
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
  const lastItemByTurn = new Map<string, number>();
  const lastCompletionByTurn = new Map<string, number>();
  const lastAssistantByTurn = new Map<string, number>();
  items.forEach((item, index) => {
    const turnKey = turnKeys[index] || "";
    lastItemByTurn.set(turnKey, index);
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
  const rows: TranscriptRowModel[] = [];
  let currentTurnKey = "";
  let previousRowWasUser = false;
  const beginTurn = (turnKey: string) => {
    if (rows.length > 0 && currentTurnKey && turnKey !== currentTurnKey) {
      rows.push({
        _tag: "TurnGap",
        key: `${sessionKey}:gap:${turnKey}`,
        turnKey,
      });
      previousRowWasUser = false;
    }
    currentTurnKey = turnKey;
  };
  const pushFailure = (turnKey: string) => {
    beginTurn(turnKey);
    rows.push({ _tag: "Error", key: `${sessionKey}:failed:${turnKey}`, turnKey });
    previousRowWasUser = false;
  };
  const pushItem = (
    item: TranscriptItem,
    index: number,
    turnKey: string,
    completion?: TranscriptItem,
  ) => {
    beginTurn(turnKey);
    if (item.kind === "user") {
      rows.push({
        _tag: "UserMessage",
        key: transcriptRowKey(sessionKey, item, index),
        turnKey,
        item,
        attachedUser: previousRowWasUser,
      });
      previousRowWasUser = true;
      return;
    }
    rows.push({
      _tag: "AssistantPart",
      key: transcriptRowKey(sessionKey, item, index),
      turnKey,
      item,
      completion,
    });
    previousRowWasUser = false;
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
    pushItem(item, index, turnKey, completionByIndex.get(index));
    // A turn that failed without ever emitting a completion marker still owes
    // the reader one status row after its last content row.
    if (failed && !lastCompletionByTurn.has(turnKey) && index === lastItemByTurn.get(turnKey)) {
      pushFailure(turnKey);
    }
  });

  const activePrompts = pendingItems.filter((item) => item.queuedBehindTurn !== true);
  const queuedPrompts = pendingItems.filter((item) => item.queuedBehindTurn === true);
  activePrompts.forEach((item, index) => {
    pushItem(item, items.length + index, `pending:${String(item.id ?? index)}`);
  });

  const activeTurnKey = currentTurnKey || `${sessionKey}:active`;
  // A delayed lane can briefly publish a tail whose id has already settled.
  // Never create a second stable-key row for that stale publication.
  const liveItemAlreadySettled = liveItem?.id != null
    && items.some((item) => item?.id === liveItem.id);
  if (liveItem && !liveItemAlreadySettled) {
    beginTurn(activeTurnKey);
    rows.push({
      _tag: "AssistantPart",
      key: transcriptRowKey(sessionKey, liveItem, items.length),
      turnKey: activeTurnKey,
      item: liveItem,
      active: true,
      live: true,
    });
    previousRowWasUser = false;
  }
  if (thinking) {
    beginTurn(activeTurnKey);
    rows.push({
      _tag: "Thinking",
      key: `${sessionKey}:thinking:${activeTurnKey}`,
      turnKey: activeTurnKey,
      active: true,
    });
    previousRowWasUser = false;
  }

  queuedPrompts.forEach((item, index) => {
    pushItem(
      item,
      items.length + activePrompts.length + index,
      `pending:${String(item.id ?? index)}`,
    );
  });
  return rows;
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
