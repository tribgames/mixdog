import type { TranscriptItem } from './desktop-types';
import { turnReviewScope } from './renderer-logic.mjs';
import { adoptLastTurnReview } from './session-changes-store';
import { leadReviewSnapshotKindCache, rememberAgentReviews, reviewTagCache } from './turn-review-cache';
import {
  decodeTurnReviewCapabilityValue,
  TURN_REVIEW_CAPABILITY,
  type TurnReviewCapabilityValue,
} from './turn-review-model';

/** The capability's reply, or null when the read failed. */
export type TurnReviewReadResult = { value?: unknown } | null;

/** The entry read of each scope being prefetched. The island's own entry read
 *  takes its answer instead of asking again. */
const prefetchesInFlight = new Map<string, Promise<TurnReviewReadResult>>();

/** The newest read issued per scope, prefetch and mounted reader alike. An
 *  older answer of a scope is dropped, so a delayed read never overwrites the
 *  files, counts and cached patch a newer read already published. */
const latestRequests = new Map<string, number>();
let requestGeneration = 0;

export function beginTurnReviewRequest(scopeKey: string): number {
  requestGeneration += 1;
  latestRequests.set(scopeKey, requestGeneration);
  return requestGeneration;
}

export function isLatestTurnReviewRequest(scopeKey: string, generation: number): boolean {
  return latestRequests.get(scopeKey) === generation;
}

/** Ends a request; a superseded one leaves the newer request's mark alone. */
export function endTurnReviewRequest(scopeKey: string, generation: number): boolean {
  const latest = isLatestTurnReviewRequest(scopeKey, generation);
  if (latest) latestRequests.delete(scopeKey);
  return latest;
}

export function turnReviewPrefetch(scopeKey: string): Promise<TurnReviewReadResult> | undefined {
  return prefetchesInFlight.get(scopeKey);
}

/** What an answered review read leaves behind: the "last turn changes" source
 *  and the scope's cached review (which releases the island's entry hold).
 *  Null when the answer names no review for this checkpoint. */
export function recordTurnReviewAnswer(
  sessionId: string,
  scopeKey: string,
  requestedCheckpoint: string,
  value: TurnReviewCapabilityValue
) {
  const decoded = decodeTurnReviewCapabilityValue(value);
  if (!decoded) return null;
  const { leadPatch, snapshotKind, checkpointId, files, reviews, historyTurns } = decoded;
  // Until the runtime opens the new turn (and before its first tool),
  // it still answers with the previous turn's review. Shown under the
  // new prompt, that brought the old diff back above the composer.
  if (checkpointId && requestedCheckpoint !== 'none' && checkpointId !== requestedCheckpoint) return null;
  // The "Last turn changes" source follows this same read.
  adoptLastTurnReview(sessionId, decoded);
  // A `none` scope names no turn, so nothing read under it is kept for
  // a later mount to show as its own review.
  if (requestedCheckpoint !== 'none') {
    rememberAgentReviews(
      scopeKey,
      reviews,
      leadPatch,
      files,
      snapshotKind,
      checkpointId,
      // No tag for a cached summary: a later read must get it again (and
      // queue its refresh), never an `unchanged` that skips the refresh.
      value?.reason !== 'cached' && typeof value?.etag === 'string' ? value.etag : '',
      historyTurns
    );
  }
  return decoded;
}

/** The island's entry read (the collapsed bar's summary), asked when a session
 *  is about to open rather than after its island mounts. The mounted island
 *  then finds the answer cached and paints its bar in the first commit. */
export function prefetchTurnReview(sessionId: string, items: readonly TranscriptItem[]): void {
  const scope = turnReviewScope(items as TranscriptItem[]);
  const scopeKey = `${sessionId}:${scope.key}`;
  const api = window.mixdogDesktop as
    | {
        invokeCapability?: (request: {
          capability: string;
          args: unknown[];
          sessionId?: string;
        }) => Promise<{ value?: unknown }>;
      }
    | undefined;
  if (!sessionId || scope.key === 'none' || !scope.hasActivity || !api?.invokeCapability) return;
  if (leadReviewSnapshotKindCache.has(scopeKey) || prefetchesInFlight.has(scopeKey)) return;
  const known = reviewTagCache.get(scopeKey) ?? '';
  const generation = beginTurnReviewRequest(scopeKey);
  const read = api
    .invokeCapability({
      capability: TURN_REVIEW_CAPABILITY,
      args: [{ refresh: false, ...(known ? { known } : {}), summary: true }],
      sessionId,
    })
    .then(
      (result) => {
        const value = (result?.value ?? null) as TurnReviewCapabilityValue;
        if (value?.unchanged !== true && isLatestTurnReviewRequest(scopeKey, generation)) {
          recordTurnReviewAnswer(sessionId, scopeKey, scope.key, value);
        }
        return result ?? null;
      },
      () => null
    )
    .finally(() => {
      endTurnReviewRequest(scopeKey, generation);
      prefetchesInFlight.delete(scopeKey);
    });
  prefetchesInFlight.set(scopeKey, read);
}
