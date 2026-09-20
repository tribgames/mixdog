/**
 * aggregate-result.mjs — reflect tool results into an AGGREGATE card: one
 * resolving call at a time, and the finalize sweep that settles the calls
 * that never came back.
 */
import { aggregateDoneCategories } from '../../../runtime/shared/tool-surface.mjs';
import {
  aggregateRawResult,
  aggregateResultPatch,
  applyAggregateCallFields,
  uiDiffPatchFromMessage,
  withCancelledResultMarker,
} from '../tool-result-status.mjs';
import { closeCard } from './item-patch.mjs';

export function isAggregateCard(card) {
  return Boolean(card.aggregate) && card.itemId === card.aggregate.itemId;
}

/** True when the result was applied to the card's aggregate. */
export function applyAggregateResult(ctx, card, callId, outcome, message, rawText, done) {
  const { aggregate } = card;
  const callRec = callId ? aggregate.calls.get(callId) : null;
  if (!callRec) return false;
  if (callRec.resolved) {
    closeCard(card, callId, done);
    return false;
  }
  applyAggregateCallFields(callRec, aggregate, { ...outcome, rawText, message });
  callRec.resolved = true;
  const allCalls = [...aggregate.calls.values()];
  const completed = allCalls.filter((r) => r.resolved).length;
  const currentItem = ctx.itemById(card.itemId);
  const earlyCompleted = allCalls.filter((r) => r.resolved || r.completedEarly).length;
  const visualCompleted = Math.max(
    completed,
    earlyCompleted,
    Math.min(allCalls.length, Number(currentItem?.completedCount || 0))
  );
  ctx.patchToolItem(card.itemId, {
    ...aggregateResultPatch(aggregate, allCalls, completed),
    rawResult: aggregateRawResult(allCalls) || null,
    ...uiDiffPatchFromMessage(message),
    completedCount: visualCompleted,
    doneCategories: aggregateDoneCategories(allCalls),
    completedAt: Number(currentItem?.completedAt) || Date.now(),
  });
  closeCard(card, callId, done);
  return true;
}

/**
 * Never let a call that truly never resolved be presented as a real
 * completion. Stamp it resolved so completedCount reflects an honest (if
 * degenerate) accounting instead of manufacturing success out of a call that
 * never came back. A record already marked completedEarly (via __earlyNotify)
 * already carries a real isError/resultText/summary from its actual result —
 * preserve those; only blank-fill for calls truly never heard from.
 */
function settleUnresolvedCalls(allCalls) {
  for (const rec of allCalls) {
    if (rec.resolved) continue;
    rec.resolved = true;
    rec.completedAt = rec.completedAt || Date.now();
    if (!rec.completedEarly) {
      rec.isError = false;
      rec.resultText = rec.resultText || '';
      rec.rawResultText = rec.rawResultText ?? rec.resultText;
    }
  }
}

export function finalizeAggregateCard(ctx, card, toolCards, done, { cancelled }) {
  const { aggregate } = card;
  const allCalls = [...aggregate.calls.values()];
  settleUnresolvedCalls(allCalls);
  const completed = allCalls.filter((r) => r.resolved).length;
  const outcomePatch = aggregateResultPatch(aggregate, allCalls, completed);
  let displayDetail = outcomePatch.result;
  if (cancelled) {
    // Cancelled aggregates MUST keep the [status: cancelled] marker on the
    // result so terminalStatus parsing resolves to 'cancelled'. Only normal
    // completions drop the summary; cancelled ones prepend the marker.
    displayDetail = withCancelledResultMarker(displayDetail, ctx.itemById(card.itemId));
  }
  ctx.patchToolItem(card.itemId, {
    ...outcomePatch,
    result: displayDetail,
    text: displayDetail,
    rawResult: aggregateRawResult(allCalls) || null,
    completedCount: completed,
    doneCategories: aggregateDoneCategories(allCalls),
    completedAt: Date.now(),
  });
  for (const sibling of toolCards || []) {
    if (sibling.itemId === card.itemId) closeCard(sibling, sibling.callId, done);
  }
}
