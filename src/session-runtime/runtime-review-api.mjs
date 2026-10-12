import { registerCacheInvalidationListener } from '../runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import { turnReviewReply } from '../runtime/shared/turn-review-reply.mjs';
import {
  getSessionReviewDiff,
  getTurnReviewDiff,
  revertTurnReview,
  revertTurnReviewFile,
} from '../runtime/shared/turn-snapshot.mjs';
import { noteTurnWorktreeChange } from '../runtime/shared/turn-worktree-snapshot.mjs';

// Tool writes (apply_patch, mutating shell commands, git, watcher events)
// reach the live review snapshot as its change signal: a review poll right
// after them captures the worktree, an unsignaled poll may reuse the last one.
registerCacheInvalidationListener((paths) => noteTurnWorktreeChange(paths));

export function createRuntimeReviewApi({ getCwd, getSessionId }) {
  return {
    // `known` (the client's tag) and `summary` are answered here, so an
    // unchanged review crosses the wire as a short tag reply.
    getTurnReviewDiff: (options = {}) =>
      turnReviewReply((reviewOptions) => getTurnReviewDiff(getCwd(), getSessionId(), reviewOptions), options),
    getSessionReviewDiff: () => getSessionReviewDiff(getCwd(), getSessionId()),
    revertTurnReview: (checkpointId) => revertTurnReview(getCwd(), getSessionId(), checkpointId),
    revertTurnReviewFile: (file, checkpointId) => revertTurnReviewFile(getCwd(), getSessionId(), file, checkpointId),
  };
}
