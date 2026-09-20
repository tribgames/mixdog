// Render and QA actions. QA is a pipeline: audit (+ optional auto-fix) →
// preview and baseline diff → structural design review → rendered-page review
// → the merged verdict (see office-qa/*.mjs).
import { recalculateForReview } from './office-recalculation.mjs';
import { reviewRenderedOfficePages } from '../quality/assurance.mjs';
import { isSmallWorksheetDocument } from '../quality/assurance-rendered.mjs';
import { renderOfficePreview } from './office-render-preview.mjs';
import { pptxReviewArtifacts } from '../authoring/pptx-review-artifacts.mjs';
import { persistOfficeTransaction } from './office-transactions.mjs';
import { applyBatch } from './office-actions-batch.mjs';
import { issues } from './office-actions-inspect.mjs';
import { qaFixOperations } from './office-qa/fix-operations.mjs';
import { acquireQaPreview, compareQaBaseline } from './office-qa/preview-stage.mjs';
import { reviewQaDesign } from './office-qa/design-review-stage.mjs';
import { assembleQaReview } from './office-qa/review-assembly.mjs';

export async function qa(session, args, cwd, { reuseRender = false } = {}) {
  // A portable workbook is calculated before it is read or drawn: the pixels
  // then show the values the file holds, and finalize's own recalculation
  // finds nothing to change, so the review token the caller brings back is
  // still the current one. Recalculating only at finalize made every first
  // render of a formula workbook stale by construction.
  await recalculateForReview(session, session.activeSignal || null);
  const before = await issues(session, args);
  const fixes = args.autoFix === true ? qaFixOperations(session, before.issues) : [];
  let fixed = null;
  if (fixes.length) fixed = await applyBatch(session, { operations: fixes, audit: false });
  const after = fixes.length ? await issues(session, args) : before;
  const structuralReview = session.backend === 'mixdog-tabular';
  // The measure pass of the authoring loop: fit, bounds, contrast, and the fact sheet are read from the
  // document, not from pixels, so `render: false` skips the preview and the loop costs a few seconds
  // instead of a render each turn. What only the rendered page can show is left to the pass that follows.
  const mode = { structuralReview, measureOnly: args.render === false && !structuralReview };
  const preview = await acquireQaPreview(session, args, cwd, { reuseRender, ...mode });
  const { baseline, visualDiff, diffImages } = await compareQaBaseline(session, args, cwd, preview, mode);
  const design = await reviewQaDesign(session, args);
  const renderReview = structuralReview
    ? { ok: true, format: session.format, pages: [], issues: [] }
    : await reviewRenderedOfficePages(preview._images, {
        format: session.format,
        pageRoles: design.pageRoles,
        smallWorksheet: session.format === 'xlsx' && isSmallWorksheetDocument(design.currentSnapshot?.document),
      });
  const trust = design.currentSnapshot?.trust || session.trustReview || null;
  const { review, combinedIssuesAfter } = assembleQaReview({
    session,
    args,
    preview,
    baseline,
    visualDiff,
    diffImages,
    before,
    after,
    fixes,
    design,
    renderReview,
    trust,
  });
  if (session.transaction) {
    session.transaction.review = review;
    await persistOfficeTransaction(session);
  }
  return {
    ok: after.ok && !combinedIssuesAfter.some((entry) => ['error', 'warning'].includes(String(entry?.severity || ''))),
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    autoFix: args.autoFix === true,
    fixes,
    fixResult: fixed,
    issuesBefore: before.issues,
    issuesAfter: combinedIssuesAfter,
    review,
    preview: {
      output: preview.output,
      pageCount: preview.pageCount,
      visualCoverage: preview.visualCoverage,
      images: preview.images,
      reviewToken: preview.reviewToken,
      reused: preview.reused === true,
      exportAvailable: preview.exportAvailable,
    },
    baseline: {
      available: baseline.available,
      output: baseline.output || '',
      reason: baseline.reason || '',
    },
    _images: [...preview._images, ...diffImages],
  };
}

export async function render(session, args, cwd) {
  await recalculateForReview(session, session.activeSignal || null);
  const preview = await renderOfficePreview(session, args, cwd);
  return session.format === 'pptx' ? pptxReviewArtifacts(session, preview) : preview;
}
