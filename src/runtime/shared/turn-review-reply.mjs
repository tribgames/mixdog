// The turn review bar's wire reply, shared by a session runtime and the
// daemon's cold-session read: a summary leaves the patch text out, and an
// unchanged review answers with its tag instead of being sent again.
import { createHash } from 'node:crypto';

// Every review kind carries its files with their counts (summed own-write
// deltas), so a collapsed bar never needs the patch text.
const SUMMARY_KINDS = new Set(['worktree', 'scoped', 'tool']);

/** `readReview(options)` answers the review itself. `summary` reaches it too,
 *  so a review rebuilt from its record never generates the patch it would
 *  only drop; `known` stays on this side. */
export async function turnReviewReply(readReview, options = {}) {
  const { known, ...reviewOptions } = options || {};
  const summary = reviewOptions.summary === true;
  let review = (await readReview(reviewOptions)) ?? {
    supported: false,
    files: [],
    patch: '',
  };
  // Already a reply (a session runtime answers through this too): keep its tag.
  if (typeof review.etag === 'string') return known === review.etag ? { unchanged: true, etag: review.etag } : review;
  // A collapsed bar shows files and line counts only, so the patch text
  // (tens of KB mid-turn) is left out until the bar is opened.
  if (summary && SUMMARY_KINDS.has(review.snapshotKind) && review.patch) {
    review = { ...review, patch: '', patchOmitted: true };
  }
  // The review bar re-reads every few seconds during a turn; an unchanged
  // review answers with its tag instead of re-sending every patch. The tag
  // covers everything sent (`historyTurns` included), so a summary and a full
  // review never share one.
  const etag = createHash('sha256').update(JSON.stringify(review)).digest('hex').slice(0, 32);
  return known === etag ? { unchanged: true, etag } : { ...review, etag };
}
