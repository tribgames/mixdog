/**
 * src/tui/session/turn-deferred-cards.mjs - ordered deferred tool-card push
 * registry for one lead turn (createRunTurn). Extracted from turn.mjs.
 *
 * Register entries first so sibling ordering and batched result handling
 * stay intact, then flush them synchronously once every header is ready.
 * The zero-delay timer is only a safety fallback for an interrupted setup.
 * `deferredDisplayReady` makes the first visible frame real content rather
 * than ToolExecution's pending placeholder.
 */

const TOOL_CARD_PUSH_DELAY_MS = 0;

export function createDeferredCardRegistry({
  isCurrentTurn,
  flags,
  pushItem,
  appendItems,
  getState,
  set,
  itemIndexById,
}) {
  let seqCounter = 0;
  const entries = []; // creation-order list; each is pushed at most once

  // Append pre-built items (deferred cards + turndone) in ONE set(). None are
  // 'user' kind, so no promptHistory rebuild is needed.
  const appendItemsBatch = (newItems, extra = {}) => {
    if (!isCurrentTurn()) return;
    if (!newItems || !newItems.length) { set(extra); return; }
    if (appendItems) {
      appendItems(newItems, extra);
      return;
    }
    const base = getState().items.length;
    const items = [...getState().items, ...newItems];
    for (let i = 0; i < newItems.length; i++) {
      const it = newItems[i];
      if (it?.id != null) itemIndexById.set(it.id, base + i);
    }
    set({ items, structureRevision: (Number(getState().structureRevision) || 0) + 1, ...extra });
  };

  // Collect (mark pushed + cancel timers) every still-deferred entry up to
  // `entry` in creation order, returning their specs WITHOUT emitting — the
  // caller commits them (optionally alongside a trailing turndone item) in a
  // single set() so turn-close writes land as ONE visible commit.
  const collectUpTo = (entry) => {
    const specs = [];
    if (!entry) return specs;
    for (const e of entries) {
      if (e.seq > entry.seq) break;
      if (e.pushed) continue;
      e.pushed = true;
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      const spec = e.materialize?.();
      if (spec) specs.push(spec);
    }
    return specs;
  };

  // Push this entry AND every earlier-created still-deferred entry, in order,
  // so transcript order always matches call order even when a later card's
  // result/timer fires before an earlier one's. Commit the collected cards in
  // ONE state update: emitting one pushItem() per deferred card made a tool
  // batch climb into view one row/card at a time (stepwise upward row jitter).
  const flushUpTo = (entry) => {
    if (!isCurrentTurn()) return;
    if (!entry) return;
    const specs = collectUpTo(entry);
    if (!specs.length) return;
    flags.pushingFromDeferredEntry = true;
    try { appendItemsBatch(specs); } finally { flags.pushingFromDeferredEntry = false; }
  };

  // `specKey` names the field holding the pending item spec: standalone cards
  // keep `spec`, aggregates keep `pendingSpec`.
  const register = (target, specKey) => {
    const entry = {
      seq: seqCounter++,
      pushed: false,
      timer: null,
      // Mark the target visible and return its spec WITHOUT emitting, so a
      // batched turn-close flush can commit many specs in one set().
      materialize: () => {
        target.pushed = true;
        const spec = target[specKey];
        if (!spec) return null;
        spec.deferredDisplayReady = true;
        return spec;
      },
      push: () => {
        const spec = entry.materialize();
        if (!spec) return;
        flags.pushingFromDeferredEntry = true;
        try { pushItem(spec); } finally { flags.pushingFromDeferredEntry = false; }
      },
    };
    target.deferred = entry;
    target.ensureVisible = () => flushUpTo(entry);
    entries.push(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!isCurrentTurn()) return;
      flushUpTo(entry);
    }, TOOL_CARD_PUSH_DELAY_MS);
    entry.timer.unref?.();
  };

  const last = () => (entries.length ? entries[entries.length - 1] : null);

  return {
    appendItemsBatch,
    registerCard: (card) => register(card, 'spec'),
    registerAggregate: (aggregate) => register(aggregate, 'pendingSpec'),
    hasEntries: () => entries.length > 0,
    // Flush every still-deferred entry into the transcript (live-turn path).
    flushAll: () => flushUpTo(last()),
    // Collect every still-deferred spec without emitting (turn-close path).
    collectAll: () => collectUpTo(last()),
    clearTimers: () => {
      for (const e of entries) {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      }
    },
  };
}
