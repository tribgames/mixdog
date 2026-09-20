// The reasons finalize holds a file back, in the order they are checked, and
// the shape every hold result shares.
export function finalizeHold(context, reason, extra) {
  return {
    ok: false,
    finalized: false,
    session: context.session.id,
    reason,
    failOn: context.failOn,
    recalculation: context.recalculation,
    ...extra,
    stepMetrics: context.stepMetrics,
  };
}

// The first review-time hold: outstanding issues, formula errors, or a visual
// review that was required but not acknowledged. Null when the file may move
// on to save/validate.
export function reviewHold(context, args, stage) {
  const { review, reviewImages, blockingIssues, reviewToken, visualCritique, documentVisualReview } = stage;
  const withReview = (reason, extra) => finalizeHold(context, reason, { review, ...extra, _images: reviewImages });
  if (blockingIssues.length) {
    return finalizeHold(context, 'review_issues', {
      blockingIssues,
      review,
      nextAction: 'Fix the reported issues with one batch, then call finalize again.',
      _images: reviewImages,
    });
  }
  // Zero formula errors is a hard rule: a recalculation that found any holds
  // the workbook even when the review was skipped.
  if (Number(context.recalculation?.totalErrors || 0) > 0) {
    return withReview('formula_errors', {
      nextAction:
        'Recalculation found formula errors; recalculation.errorSummary lists the cells by error type. Trace each to its inputs, fix the formula, then finalize again.',
    });
  }
  if (context.requiresVisualReview && !stage.visualReviewAcknowledged) {
    return withReview('visual_review_required', {
      reviewToken,
      visualCritique,
      nextAction:
        'Inspect every rendered slide and submit one distinct critique per slide with verdict, hierarchy, balance, legibility, cohesion, evidence, note, and fixes. Polish any failed slide, render again if changed, then finalize with the review token.',
    });
  }
  if (documentVisualReview && args.review !== false && !documentVisualReview.acknowledged) {
    const blockers = documentVisualReview.blockers?.length
      ? `Review not accepted — ${documentVisualReview.blockers.join(' · ')}. `
      : '';
    return withReview('visual_review_required', {
      reviewToken,
      visualReview: documentVisualReview,
      nextAction: `${blockers}Inspect the actual pages for ${documentVisualReview.checks.join(', ')}. Record specific keep/fix observations, not checkbox assertions. Correct material issues and rerender. Then submit design.reviewed:true, design.reviewToken and design.critique with one {page, verdict:'pass', note} per page; unresolved fixes cannot be accepted. This records agent review, not user approval.`,
    });
  }
  return null;
}
