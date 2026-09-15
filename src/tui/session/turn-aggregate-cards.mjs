/**
 * src/tui/session/turn-aggregate-cards.mjs - aggregate tool-card tracking for
 * one lead turn (createRunTurn). Consecutive same-bucket tool calls merge into
 * one transcript card whose header, counts, and merged result summary stay
 * current; assistant text and turn boundaries seal the block. Extracted from
 * turn.mjs.
 */
import { aggregateDoneCategories } from '../../runtime/shared/tool-surface.mjs';
import { toolResultText } from './tool-result-text.mjs';
import {
  aggregateLoadingTargets,
  aggregateRawResult,
  aggregateResultPatch,
  aggregateToolMembers,
  applyAggregateCallFields,
  toolResultDisplay,
} from './tool-result-status.mjs';

export function createAggregateCardTracker({
  toolCards,
  cardByCallId,
  nextId,
  getState,
  set,
  patchItem,
  itemIndexById,
  markToolCallDone,
  registerDeferredAggregate,
}) {
  const aggregateCards = []; // active aggregate cards in the current consecutive tool block
  let tailAggregate = null; // most recently touched aggregate card; only the tail may absorb the next same-bucket call

  const finalizeToolHeaders = () => {
    const ids = new Set();
    for (const card of toolCards || []) {
      if (card?.itemId) ids.add(card.itemId);
      // Seal not-yet-pushed specs too, so a card that pushes later (timer)
      // enters already-finalized instead of flashing the active header form.
      if (card && card.pushed === false && card.spec) card.spec.headerFinalized = true;
    }
    for (const aggregate of aggregateCards) {
      if (aggregate?.itemId) ids.add(aggregate.itemId);
      if (aggregate && aggregate.pushed === false && aggregate.pendingSpec) aggregate.pendingSpec.headerFinalized = true;
    }
    if (ids.size === 0) return false;
    let changed = false;
    const items = getState().items.map((item) => {
      if (!ids.has(item?.id) || item.kind !== 'tool' || item.headerFinalized !== false) return item;
      changed = true;
      return { ...item, headerFinalized: true };
    });
    if (changed) set({ items, structureRevision: (Number(getState().structureRevision) || 0) + 1 });
    return changed;
  };

  const completeAggregateVisual = () => {
    for (const aggregate of aggregateCards) {
      const allCalls = [...aggregate.calls.values()];
      if (allCalls.length === 0) continue;
      aggregate.ensureVisible?.();
      const completed = allCalls.filter((r) => r.resolved).length;
      patchItem(aggregate.itemId, {
        ...aggregateResultPatch(aggregate, allCalls, completed),
        // Raw preserved for ctrl+o expansion.
        rawResult: aggregateRawResult(allCalls) || null,
        completedCount: allCalls.length,
        doneCategories: aggregateDoneCategories(allCalls),
        completedAt: Date.now(),
      });
    }
  };

  const clearAggregateContinuation = () => {
    completeAggregateVisual();
    finalizeToolHeaders();
    aggregateCards.length = 0;
    // Seal the block: same-bucket calls after this point must open a fresh
    // card, never continue one from before the seal (assistant text/turn
    // end boundary).
    tailAggregate = null;
  };

  const rememberActiveAggregate = (aggregate) => {
    if (!aggregate) return;
    if (!aggregateCards.includes(aggregate)) aggregateCards.push(aggregate);
    tailAggregate = aggregate;
  };

  const ensureAggregateCard = (bucket) => {
    // Only the TAIL aggregate (most recent card) may absorb the next call,
    // and only when the bucket matches. Any different-bucket aggregate or
    // standalone card in between breaks the run, so Search, Memory, Search
    // renders as three cards in call order — a new call never merges into
    // an earlier card above the current tail (which read as out-of-order
    // count changes in the transcript). clearAggregateContinuation seals
    // the block at assistant-text/turn boundaries.
    const cached = tailAggregate && tailAggregate.bucket === bucket ? tailAggregate : null;
    if (cached) {
      rememberActiveAggregate(cached);
      return cached;
    }
    const itemId = nextId();
    const aggregate = {
      itemId,
      bucket,
      categories: new Map(),
      categoryOrder: [],
      calls: new Map(),
      nextSummarySeq: 0,
      pushed: false,
      startedAt: Date.now(),
    };
    // Arm the deferred push once at creation; syncAggregateHeader only keeps
    // pendingSpec current until the timer/result flushes it in call order.
    registerDeferredAggregate(aggregate);
    rememberActiveAggregate(aggregate);
    return aggregate;
  };

  const syncAggregateHeader = (aggregate) => {
    if (!aggregate?.itemId) return;
    const loadingTargets = aggregateLoadingTargets(aggregate.calls);
    const patch = {
      args: {
        categoryOrder: aggregate.categoryOrder.slice(),
        ...(loadingTargets.length > 0 ? { loadingTargets } : {}),
        ...(aggregate.verifyShell ? { verifyShell: true } : {}),
      },
      count: aggregate.calls.size,
      completedCount: [...aggregate.calls.values()].filter((r) => r.resolved || r.completedEarly).length,
      categories: Object.fromEntries(aggregate.categories),
      toolMembers: aggregateToolMembers(aggregate.calls),
    };
    if (aggregate.pushed) {
      patchItem(aggregate.itemId, patch);
      return;
    }
    // Not yet visible: keep the latest header spec current. The deferred entry
    // (armed at creation) pushes pendingSpec when its timer fires or a result
    // forces it visible, preserving call order via the deferred registry.
    aggregate.pendingSpec = {
      kind: 'tool',
      id: aggregate.itemId,
      name: '__aggregate__',
      ...patch,
      aggregate: true,
      result: null,
      rawResult: null,
      isError: false,
      expanded: false,
      headerFinalized: false,
      startedAt: aggregate.startedAt || Date.now(),
    };
  };

  // __earlyNotify: show 1-line summary + completedCount immediately; defer
  // rawResult/expand and resultsDone to the history flush.
  const markToolCardCompletedState = (callId, message) => {
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
    const { exitCode, isExitError, isCallError, isError, text } = toolResultDisplay(
      message,
      rawText,
      callRec.name,
    );
    applyAggregateCallFields(callRec, aggregate, {
      isError, isCallError, isExitError, exitCode, text, rawText, message,
    });
    callRec.completedEarly = true;
    const allCalls = [...aggregate.calls.values()];
    const completedCount = allCalls.filter((r) => r.resolved || r.completedEarly).length;
    const currentIndex = itemIndexById.get(card.itemId);
    const currentItem = Number.isInteger(currentIndex) && getState().items[currentIndex]?.id === card.itemId
      ? getState().items[currentIndex]
      : null;
    const visualCompleted = Math.max(
      completedCount,
      Math.min(allCalls.length, Number(currentItem?.completedCount || 0)),
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

  return {
    finalizeToolHeaders,
    clearAggregateContinuation,
    ensureAggregateCard,
    syncAggregateHeader,
    markToolCardCompletedState,
    // A standalone card breaks the consecutive run: a later same-bucket call
    // must open a fresh card below it, never merge into an aggregate above.
    sealTail: () => { tailAggregate = null; },
  };
}
