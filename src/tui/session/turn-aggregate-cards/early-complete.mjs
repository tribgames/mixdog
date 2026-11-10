/**
 * turn-aggregate-cards/early-complete.mjs - the __earlyNotify path: show the
 * 1-line summary + completedCount immediately for a call inside an aggregate
 * card; rawResult/expand and resultsDone wait for the history flush.
 */
import { toolResultText } from '../tool-result-text.mjs';
import { aggregateResultPatch, applyAggregateCallFields, toolResultDisplay } from '../tool-result-status.mjs';
import { indexedItem } from '../tool-card-results/item-patch.mjs';

export function createAggregateEarlyComplete({ cardByCallId, getState, patchItem, itemIndexById, markToolCallDone }) {
  return (callId, message) => {
    const card = cardByCallId.get(callId);
    if (!card) return;
    // Early completion also clears the active-summary entry.
    markToolCallDone(card.callId);
    const aggregate = card.aggregate;
    // Non-aggregate eager tools are rare; flipping completedCount without
    // result changes pending/detail rendering and risks row jitter — wait for
    // the real history flush.
    if (!aggregate || card.itemId !== aggregate.itemId) return;
    const callRec = aggregate.calls.get(callId);
    if (!callRec || callRec.resolved || callRec.completedEarly) return;
    aggregate.ensureVisible?.();
    const rawText = toolResultText(message?.content);
    const outcome = toolResultDisplay(message, rawText, callRec.name);
    applyAggregateCallFields(callRec, aggregate, { ...outcome, rawText, message });
    callRec.completedEarly = true;
    const allCalls = [...aggregate.calls.values()];
    const completedCount = allCalls.filter((r) => r.resolved || r.completedEarly).length;
    const currentItem = indexedItem(getState().items, itemIndexById, card.itemId);
    const visualCompleted = Math.max(
      completedCount,
      Math.min(allCalls.length, Number(currentItem?.completedCount || 0))
    );
    // Collapsed detail carries the merged per-call count summary even on
    // the early-notify path; patching '' here flipped the detail row back
    // to the 'Running' placeholder between count updates (the visible
    // jitter). Failures keep 'N Failed'.
    const patch = {
      ...aggregateResultPatch(aggregate, allCalls, completedCount),
      completedCount: visualCompleted,
    };
    if (visualCompleted >= allCalls.length) {
      patch.completedAt = Number(currentItem?.completedAt) || Date.now();
    }
    patchItem(card.itemId, patch);
  };
}
