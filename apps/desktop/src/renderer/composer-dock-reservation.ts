import type { TranscriptItem } from "./desktop-types";
import { asRecord } from "./text-format";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory } from "../../../../src/runtime/shared/tool-surface.mjs";

/**
 * Composer-dock reservation rules (pure; see ComposerDock.tsx for the DOM).
 *
 * Chrome above the input sits in flow, so each height change resizes the
 * transcript viewport. The review slot is therefore RESERVED whenever a diff
 * can still arrive, so the result fills existing geometry instead of resizing
 * the viewport a second time. Nothing here holds freed space on a timer.
 */

/** Does this tool row belong to work that can CHANGE files? The shared
 *  classifier owns the answer (Patch = apply_patch and its aliases), an
 *  aggregate card carries its categories as a count map, and a card that
 *  already published a uiDiff has touched files by definition. */
export function toolTouchesFiles(item: TranscriptItem | null | undefined): boolean {
  if (!item || item.kind !== "tool") return false;
  if (typeof item.uiDiff === "string" && item.uiDiff) return true;
  const categories = asRecord(item.categories);
  if (categories && Object.hasOwn(categories, "Patch")) return true;
  return classifyToolCategory(String(item.name || "")) === "Patch";
}

/** The current turn (everything after the last user row, plus the live tail)
 *  has touched files, so a review result is plausible. */
export function turnTouchesFiles(
  items: readonly TranscriptItem[],
  streamingTail: TranscriptItem | null | undefined,
): boolean {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user") break;
    if (toolTouchesFiles(item)) return true;
  }
  return toolTouchesFiles(streamingTail);
}

/** A turn that can actually produce a diff reserves the collapsed review row,
 *  so a result arriving mid-stream (or the first authoritative read of an idle
 *  scope) fills existing geometry instead of shrinking the transcript
 *  viewport. Reserving it for EVERY live turn left a conversation-only turn
 *  floating an empty 36px plate above the input (user: DIFF가 없는 경우에도
 *  스크립트가 좀 떠있네). */
export function reviewSlotReserved({
  touchesFiles,
  turnLive,
  reviewPending,
}: {
  touchesFiles: boolean;
  turnLive: boolean;
  reviewPending: boolean;
}): boolean {
  return touchesFiles && (turnLive || reviewPending);
}

/** The review bar's first authoritative worker read for a scope is still in
 *  flight. Pending only while a read will actually run: an inactive pane, an
 *  empty turn, a draft, or a scope the shared cache already answered never
 *  asks, so none of them may reserve. */
export function reviewScopePending({
  active,
  hasTurnActivity,
  sessionId,
  scopeKey,
  settledScope,
  cached,
}: {
  active: boolean;
  hasTurnActivity: boolean;
  sessionId: string;
  scopeKey: string;
  settledScope: string;
  cached: boolean;
}): boolean {
  return active && hasTurnActivity && Boolean(sessionId)
    && settledScope !== scopeKey && !cached;
}
