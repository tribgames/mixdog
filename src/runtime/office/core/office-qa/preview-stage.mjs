// The pixels QA reads: the current preview (reused, rendered, or a structural /
// measure-only stand-in) and the visual diff against the transaction baseline.
import { renderPdfPages } from '../../pdf/pdf-render.mjs';
import { compareRenderedPages } from '../../quality/visual-diff.mjs';
import { exists } from '../office-sessions.mjs';
import { cachedOfficePreview, renderOfficePreview } from '../office-render-preview.mjs';

/** The preview stand-in when nothing is rendered: a structural read or a measure-only pass. */
function unrenderedPreview(session, measureOnly) {
  return {
    output: session.target,
    pageCount: 0,
    visualCoverage: {
      mode: measureOnly ? 'measure-only' : 'structural',
      reason: measureOnly
        ? 'render: false — fit, bounds, contrast, and facts were measured without rendering; render before the visual read.'
        : 'Delimited text has no paginated visual layout.',
      reviewedPages: [],
      reviewed: 0,
      total: 0,
      complete: true,
      remainingPages: [],
    },
    images: [],
    _images: [],
  };
}

async function renderTransactionBaseline(session, args, cwd, currentOutput) {
  const transaction = session.transaction;
  if (!transaction) return { available: false, reason: 'No active transaction baseline.' };
  if (transaction.baselinePdf && (await exists(transaction.baselinePdf))) {
    const rendered = await renderPdfPages(transaction.baselinePdf, { pages: args.pages, maxWidth: args.maxWidth });
    return { available: true, output: transaction.baselinePdf, ...rendered };
  }
  if (!transaction.checkpoint || !(await exists(transaction.checkpoint))) {
    return { available: false, reason: 'The transaction backend has no renderable checkpoint.' };
  }
  const baselineOutput = currentOutput.replace(/\.pdf$/i, '-before.pdf');
  const baselineSession = {
    ...session,
    target: transaction.checkpoint,
    mode: session.backend === 'microsoft-office-com' ? 'background' : 'portable',
    transaction: null,
    designState: structuredClone(session.designState || {}),
  };
  const rendered = await renderOfficePreview(baselineSession, { ...args, output: baselineOutput }, cwd);
  return {
    available: true,
    output: rendered.output,
    pageCount: rendered.pageCount,
    images: rendered._images,
  };
}

export async function acquireQaPreview(session, args, cwd, { reuseRender, structuralReview, measureOnly }) {
  const priorPreview =
    reuseRender && !structuralReview ? await cachedOfficePreview(session, args, cwd, { reuseLatest: true }) : null;
  if (priorPreview) return priorPreview;
  if (structuralReview || measureOnly) return unrenderedPreview(session, measureOnly);
  return renderOfficePreview(session, args, cwd);
}

export async function compareQaBaseline(session, args, cwd, preview, { structuralReview, measureOnly }) {
  let baseline = {
    available: false,
    reason: structuralReview
      ? 'Delimited text uses structural QA instead of paginated rendering.'
      : 'No active transaction baseline.',
  };
  let visualDiff = { available: false, pages: [], changedPercent: 0 };
  let diffImages = [];
  if (!structuralReview && !measureOnly) {
    try {
      baseline = await renderTransactionBaseline(session, args, cwd, preview.output);
      if (baseline.available) {
        const compared = await compareRenderedPages(baseline.images, preview._images, preview.output);
        diffImages = compared.images;
        visualDiff = {
          available: compared.available,
          pages: compared.pages,
          changedPercent: compared.changedPercent,
        };
      }
    } catch (error) {
      baseline = { available: false, reason: error?.message || String(error) };
    }
  }
  return { baseline, visualDiff, diffImages };
}
