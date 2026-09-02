import { callMicrosoftOffice, closeMicrosoftOfficeSession } from '../com/com-adapter.mjs';
import { recalculateLibreOfficeWorkbook } from '../portable/portable-ooxml.mjs';
import { summarizeOfficeCompositions } from '../design/composition-system.mjs';
import { recordOfficeCompositionHistory } from '../design/library/design-library.mjs';
import { documentSessionKey, documentSessions, isMicrosoftOfficeSession, sessions } from './office-core.mjs';
import { pptxVisualReviewAcknowledged, reviewPptxVisualCritique } from '../quality/design-review.mjs';
import { validate } from './office-actions-inspect.mjs';
import { qa } from './office-actions-render.mjs';

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

export async function save(session) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before saving');
  if (isMicrosoftOfficeSession(session)) {
    const result = await callMicrosoftOffice({
      action: 'save',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
    }, { signal: session.activeSignal || null });
    if (!result.ok) throw new Error(result.error || 'Microsoft Office save failed');
  }
  return { ok: true, session: session.id, saved: true, path: session.target };
}

export async function closeSession(session, {
  save: shouldSave = false,
  signal = null,
} = {}) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before closing');
  if (isMicrosoftOfficeSession(session)) {
    const closed = await closeMicrosoftOfficeSession(session.id, { save: shouldSave, signal });
    if (!closed.ok) throw new Error(closed.error || 'Microsoft Office session close failed');
  } else if (shouldSave) {
    await save(session);
  }
  sessions.delete(session.id);
  if (documentSessions.get(documentSessionKey(session.target)) === session.id) {
    documentSessions.delete(documentSessionKey(session.target));
  }
  return {
    ok: true,
    session: session.id,
    closed: true,
    path: session.target,
    ownership: session.ownership,
  };
}

export async function finalize(session, args, cwd, signal) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before finalizing');
  const stepMetrics = {};
  const timedStep = async (name, operation) => {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      stepMetrics[`${name}Ms`] = Math.max(0, Number((performance.now() - startedAt).toFixed(2)));
    }
  };
  const authored = session.authored === true;
  const failOn = String(args.failOn || (session.created && !authored ? 'warning' : 'error')).toLowerCase();
  const requiresVisualReview = session.format === 'pptx'
    && session.designState?.requiresVisualReview === true;
  const requiresFreeformCompile = session.format === 'pptx'
    && session.designRequest?.freeform?.required === true;
  if (requiresFreeformCompile && !session.designState?.freeformSelection) {
    return {
      ok: false,
      finalized: false,
      session: session.id,
      reason: 'freeform_compile_required',
      failOn,
      stepMetrics,
      nextAction: 'Preview at least three reference-assisted free-form candidate boards, visually compare them, and compile one selected candidate before finalizing.',
    };
  }
  const recalculation = session.backend === 'mixdog-ooxml' && session.format === 'xlsx'
    ? await timedStep('recalculation', async () => await recalculateLibreOfficeWorkbook(session.target, {
        force: Number(session.snapshotVersion || 0) > 0,
        signal,
      }))
    : null;
  if (recalculation?.needed && !recalculation.recalculated) {
    return {
      ok: false,
      finalized: false,
      session: session.id,
      reason: 'recalculation_failed',
      failOn,
      recalculation,
      stepMetrics,
      nextAction: recalculation.reason || 'Open the workbook in Microsoft Office background mode and finalize again.',
    };
  }
  const reviewed = args.review === false ? null : await timedStep('review', async () => await qa(session, args, cwd));
  const reviewImages = Array.isArray(reviewed?._images) ? reviewed._images : [];
  const review = reviewed ? { ...reviewed } : null;
  const visualCritique = session.format === 'pptx'
    ? reviewPptxVisualCritique({
        critique: args.design?.critique,
        pageCount: Number(review?.preview?.pageCount || 0),
      })
    : null;
  if (review && visualCritique) review.visualCritique = visualCritique;
  const reviewToken = `${session.id}:${session.designState?.renderedVersion ?? session.snapshotVersion}`;
  const visualReviewAcknowledged = pptxVisualReviewAcknowledged({
    reviewed: args.design?.reviewed === true,
    providedToken: args.design?.reviewToken,
    expectedToken: reviewToken,
    renderedVersion: session.designState?.renderedVersion,
    snapshotVersion: session.snapshotVersion,
    critiqueOk: visualCritique?.ok === true,
  });
  if (review) delete review._images;
  const issuesAfter = review?.issuesAfter || [];
  const blockingIssues = issuesAfter.filter((issue) => blocksFinalize(issue, { failOn, authored }));
  const advisoryIssues = authored
    ? issuesAfter.filter((issue) => !blockingIssues.includes(issue) && ['error', 'warning'].includes(String(issue?.severity || '')))
    : [];
  if (review && authored) review.advisoryIssues = advisoryIssues;
  if (blockingIssues.length) {
    return {
      ok: false,
      finalized: false,
      session: session.id,
      reason: 'review_issues',
      failOn,
      blockingIssues,
      recalculation,
      review,
      stepMetrics,
      nextAction: 'Fix the reported issues with one batch, then call finalize again.',
      _images: reviewImages,
    };
  }
  if (requiresVisualReview && !visualReviewAcknowledged) {
    return {
      ok: false,
      finalized: false,
      session: session.id,
      reason: 'visual_review_required',
      failOn,
      recalculation,
      review,
      stepMetrics,
      reviewToken,
      visualCritique,
      nextAction: 'Inspect every rendered slide and submit one distinct critique per slide with verdict, hierarchy, balance, legibility, cohesion, evidence, note, and fixes. Polish any failed slide, render again if changed, then finalize with the review token.',
      _images: reviewImages,
    };
  }
  const saved = await timedStep('save', async () => {
    const reuseSavedBatch = args.__alreadySaved === true
      && Number(reviewed?.fixesApplied || 0) === 0;
    if (reuseSavedBatch) {
      return {
        ok: true,
        session: session.id,
        saved: true,
        skipped: true,
        path: session.target,
      };
    }
    return save(session);
  });
  const validation = await timedStep('validation', async () => await validate(session, {
    ...args,
    __postSave: isMicrosoftOfficeSession(session) && session.mode === 'background',
    __skipNative: false,
    __skipNativeIssues: false,
  }));
  if (!validation.ok) {
    return {
      ok: false,
      finalized: false,
      session: session.id,
      reason: 'validation_failed',
      failOn,
      recalculation,
      review,
      validation,
      design: session.design,
      stepMetrics,
      nextAction: 'Fix the validation failure, then call finalize again.',
      _images: reviewImages,
    };
  }
  const composition = summarizeOfficeCompositions(
    session.format,
    session.designState?.compositions || [],
  );
  const closed = await timedStep('close', async () => await closeSession(session, { save: false, signal }));
  let compositionHistory = null;
  let compositionHistoryWarning = '';
  if (session.created && composition.fingerprint) {
    try {
      compositionHistory = await recordOfficeCompositionHistory(session.dataDir, {
        documentPath: session.target,
        format: session.format,
        profile: session.design?.profile,
        purpose: session.design?.purpose,
        expressionMode: session.design?.expressionMode,
        fingerprint: composition.fingerprint,
        compositionIds: composition.compositionIds,
      });
    } catch (error) {
      compositionHistoryWarning = error?.message || String(error);
    }
  }
  return {
    ok: true,
    finalized: true,
    session: session.id,
    path: session.target,
    failOn,
    saved: saved.saved === true,
    saveSkipped: saved.skipped === true,
    closed: closed.closed === true,
    recalculation,
    review,
    validation,
    design: session.design,
    composition,
    compositionHistory,
    ...(compositionHistoryWarning ? { compositionHistoryWarning } : {}),
    stepMetrics,
    _images: reviewImages,
  };
}
