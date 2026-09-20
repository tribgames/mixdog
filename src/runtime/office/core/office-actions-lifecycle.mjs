// Session lifecycle actions: save, close, and finalize — the gated pipeline
// recalculate → review → hold checks → save → validate → close (see
// office-finalize/*.mjs for each stage).
import { recalculateForReview } from './office-recalculation.mjs';
import { reviewForFinalize } from './office-finalize/review-stage.mjs';
import { finalizeHold, reviewHold } from './office-finalize/holds.mjs';
import { closeForFinalize, saveForFinalize, validateForFinalize } from './office-finalize/commit-stage.mjs';

export { closeSession, save } from './office-finalize/session-save.mjs';

function createStepTimer(stepMetrics) {
  return async (name, operation) => {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      stepMetrics[`${name}Ms`] = Math.max(0, Number((performance.now() - startedAt).toFixed(2)));
    }
  };
}

export async function finalize(session, args, cwd, signal) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before finalizing');
  const stepMetrics = {};
  const timedStep = createStepTimer(stepMetrics);
  const authored = session.authored === true || session.design?.authoring === 'native';
  const failOn = String(args.failOn || (session.created && !authored ? 'warning' : 'error')).toLowerCase();
  const context = {
    session,
    failOn,
    stepMetrics,
    requiresVisualReview: session.format === 'pptx' && session.designState?.requiresVisualReview === true,
    recalculation: await timedStep('recalculation', () => recalculateForReview(session, signal)),
  };
  const { recalculation } = context;
  if (recalculation?.needed && !recalculation.recalculated) {
    return finalizeHold(context, 'recalculation_failed', {
      nextAction: recalculation.reason || 'Open the workbook in Microsoft Office background mode and finalize again.',
    });
  }
  const stage = await reviewForFinalize(session, args, cwd, { timedStep, failOn, authored });
  const { review, reviewImages } = stage;
  const hold = reviewHold(context, args, stage);
  if (hold) return hold;

  const saved = await timedStep('save', async () => saveForFinalize(session, args, stage.reviewed));
  const validation = await timedStep('validation', async () => await validateForFinalize(session, args));
  if (!validation.ok) {
    return finalizeHold(context, 'validation_failed', {
      review,
      validation,
      design: session.design,
      nextAction: 'Fix the validation failure, then call finalize again.',
      _images: reviewImages,
    });
  }
  const { composition, closed, compositionHistory, compositionHistoryWarning } = await closeForFinalize(
    session,
    signal,
    { timedStep }
  );
  return {
    ok: true,
    finalized: true,
    session: session.id,
    path: session.target,
    failOn,
    saved: saved.saved === true,
    saveSkipped: saved.skipped === true,
    closed: closed.closed === true,
    ...(closed.cleanup ? { cleanup: closed.cleanup } : {}),
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
