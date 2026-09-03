import {
  getSessionReviewDiff,
  getTurnReviewDiff,
  revertTurnReview,
  revertTurnReviewFile,
} from '../runtime/shared/turn-snapshot.mjs';

export function createRuntimeReviewApi({ getCwd, getSessionId }) {
  return {
    getTurnReviewDiff: (options = {}) =>
      getTurnReviewDiff(getCwd(), getSessionId(), options),
    getSessionReviewDiff: () =>
      getSessionReviewDiff(getCwd(), getSessionId()),
    revertTurnReview: (checkpointId) =>
      revertTurnReview(getCwd(), getSessionId(), checkpointId),
    revertTurnReviewFile: (file, checkpointId) =>
      revertTurnReviewFile(getCwd(), getSessionId(), file, checkpointId),
  };
}
