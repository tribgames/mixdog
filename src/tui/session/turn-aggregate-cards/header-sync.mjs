/**
 * turn-aggregate-cards/header-sync.mjs - how an aggregate card's header
 * reaches the transcript: the live patch (or pending spec while the deferred
 * push is still armed) and the seal that finalizes every tool header at a
 * block boundary.
 */
import { aggregateLoadingTargets, aggregateToolMembers } from '../tool-result-status.mjs';

export function createAggregateHeaderSync({ toolCards, aggregateCards, getState, set, patchItem }) {
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
      if (aggregate && aggregate.pushed === false && aggregate.pendingSpec)
        aggregate.pendingSpec.headerFinalized = true;
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

  return { finalizeToolHeaders, syncAggregateHeader };
}
