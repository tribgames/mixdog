// The turn review bar's wire reply, shared by a session runtime and the
// daemon's cold-session read: a summary leaves the patch text out, and an
// unchanged review answers with its tag instead of being sent again.
import { createHash } from 'node:crypto';

/** Per-file line counts of a unified diff, shaped like a Git snapshot's
 *  files (the turn review bar renders either the same way). */
function filesFromPatch(patch) {
  const files = [];
  let current = null;
  for (const line of String(patch || '').split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = {
        path: header[2],
        oldPath: header[1] === header[2] ? null : header[1],
        status: 'M',
        additions: 0,
        deletions: 0,
        binary: false,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'A';
    else if (line.startsWith('deleted file mode')) current.status = 'D';
    else if (line.startsWith('rename from')) current.status = 'R';
    else if (line.startsWith('Binary files')) current.binary = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }
  return files;
}

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
  // A collapsed bar shows files and line counts only. A Git-backed review
  // carries those per file, so its patch text (tens of KB mid-turn) is
  // left out until the bar is opened; other kinds count from the patch.
  if (summary && (review.snapshotKind === 'worktree' || review.snapshotKind === 'scoped') && review.patch) {
    review = { ...review, patch: '', patchOmitted: true };
  } else if (summary && review.snapshotKind === 'tool' && review.patch && !review.files?.length) {
    // A contended worktree (several sessions on one repo) reviews this
    // session's own tool edits and counts lines from the patch; the counts
    // travel as files instead.
    review = { ...review, files: filesFromPatch(review.patch), patch: '', patchOmitted: true };
  }
  // The review bar re-reads every few seconds during a turn; an unchanged
  // review answers with its tag instead of re-sending every patch. The tag
  // covers what is sent, so a summary and a full review never share one.
  const etag = createHash('sha256').update(JSON.stringify(review)).digest('hex').slice(0, 32);
  return known === etag ? { unchanged: true, etag } : { ...review, etag };
}
