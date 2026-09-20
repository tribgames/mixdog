// The review stage of finalize: the QA pass, the visual-review acceptance for
// decks and documents, and which of the remaining issues hold the file back.
import { pptxVisualReviewAcknowledged, reviewPptxVisualCritique } from '../../quality/design-review-critique.mjs';
import { assessPresentationAcceptance } from '../../quality/presentation-acceptance.mjs';
import { assessDocumentAcceptance, reviewDocumentPages } from '../../quality/document-acceptance.mjs';
import { qa } from '../office-actions-render.mjs';

// A script-authored deck is judged by the model looking at rendered slides;
// the heuristic design reviews still report, but only file integrity and
// missing review coverage can hold the deck back.
const AUTHORED_ADVISORY_SOURCES = new Set([
  'design-review',
  'aesthetic-review',
  'frontier-design-review',
  'text-metrics',
]);

function blocksFinalize(issue, { failOn, authored }) {
  if (authored && AUTHORED_ADVISORY_SOURCES.has(String(issue?.source || ''))) return false;
  return issue?.severity === 'error' || (failOn === 'warning' && issue?.severity === 'warning');
}

function applyPptxAcceptance(session, args, review) {
  const visualCritique = reviewPptxVisualCritique({
    critique: args.design?.critique,
    pageCount: Number(review?.preview?.pageCount || session.designState?.renderedPageCount || 0),
    requireChecks: session.authoredBrief?.present === true,
  });
  if (review && visualCritique) review.visualCritique = visualCritique;
  const acknowledged = pptxVisualReviewAcknowledged({
    reviewed: args.design?.reviewed === true,
    providedToken: args.design?.reviewToken,
    expectedToken: session.designState?.reviewToken || '',
    renderedVersion: session.designState?.renderedVersion,
    snapshotVersion: session.snapshotVersion,
    coverageComplete: session.designState?.renderedCoverage?.complete === true,
    critiqueOk: visualCritique?.ok === true,
  });
  if (review?.review?.quality) {
    const quality = review.review.quality;
    Object.assign(quality, assessPresentationAcceptance(quality.evidence, { acknowledged, critique: visualCritique }));
  }
  return { visualCritique, acknowledged };
}

function applyDocumentAcceptance(session, args, review) {
  const documentVisualReview = reviewDocumentPages(session.format, args.design, {
    ...session.designState,
    snapshotVersion: session.snapshotVersion,
  });
  if (documentVisualReview && review) {
    review.visualReview = documentVisualReview;
    if (review.review?.quality) {
      Object.assign(
        review.review.quality,
        assessDocumentAcceptance(review.review.quality.evidence, documentVisualReview)
      );
    }
  }
  return documentVisualReview;
}

export async function reviewForFinalize(session, args, cwd, { timedStep, failOn, authored }) {
  const reviewed =
    args.review === false
      ? null
      : await timedStep('review', async () => await qa(session, args, cwd, { reuseRender: true }));
  const reviewImages = Array.isArray(reviewed?._images) ? reviewed._images : [];
  const review = reviewed ? { ...reviewed } : null;
  const pptx = session.format === 'pptx' ? applyPptxAcceptance(session, args, review) : null;
  const documentVisualReview = applyDocumentAcceptance(session, args, review);
  if (review) delete review._images;
  const issuesAfter = review?.issuesAfter || [];
  const blockingIssues = issuesAfter.filter((issue) => blocksFinalize(issue, { failOn, authored }));
  if (review && authored) {
    review.advisoryIssues = issuesAfter.filter(
      (issue) => !blockingIssues.includes(issue) && ['error', 'warning'].includes(String(issue?.severity || ''))
    );
  }
  return {
    reviewed,
    review,
    reviewImages,
    reviewToken: session.designState?.reviewToken || '',
    visualCritique: pptx?.visualCritique ?? null,
    visualReviewAcknowledged: pptx?.acknowledged === true,
    documentVisualReview,
    blockingIssues,
  };
}
