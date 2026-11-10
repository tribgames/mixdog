/**
 * src/tui/session/turn-aggregate-cards.mjs - aggregate tool-card tracking for
 * one lead turn (createRunTurn). Consecutive same-bucket tool calls merge into
 * one transcript card whose header, counts, and merged result summary stay
 * current; assistant text and turn boundaries seal the block. Header rendering
 * and the early-notify path live in turn-aggregate-cards/*.mjs.
 */
import { aggregateDoneCategories } from '../../runtime/shared/tool-surface.mjs';
import { aggregateRawResult, aggregateResultPatch } from './tool-result-status.mjs';
import { createAggregateHeaderSync } from './turn-aggregate-cards/header-sync.mjs';
import { createAggregateEarlyComplete } from './turn-aggregate-cards/early-complete.mjs';

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
  const { finalizeToolHeaders, syncAggregateHeader } = createAggregateHeaderSync({
    toolCards,
    aggregateCards,
    getState,
    set,
    patchItem,
  });
  const markToolCardCompletedState = createAggregateEarlyComplete({
    cardByCallId,
    getState,
    patchItem,
    itemIndexById,
    markToolCallDone,
  });

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

  return {
    finalizeToolHeaders,
    clearAggregateContinuation,
    ensureAggregateCard,
    syncAggregateHeader,
    markToolCardCompletedState,
    // A standalone card breaks the consecutive run: a later same-bucket call
    // must open a fresh card below it, never merge into an aggregate above.
    sealTail: () => {
      tailAggregate = null;
    },
  };
}
