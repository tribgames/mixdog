/**
 * item-patch.mjs — live store access for tool cards: resolve an item by id
 * and patch it while carrying the transcript's measured-rows cache along.
 */
import { carryTranscriptMeasuredRowsCache } from '../../app/transcript-window.mjs';

/** The live item for `id` through the id index, or null when the index is stale. */
export function indexedItem(items, itemIndexById, id) {
  const index = itemIndexById?.get(id);
  const item = Number.isInteger(index) ? items[index] : null;
  return item?.id === id ? item : null;
}

export function createItemPatcher({ getState, patchItem, itemIndexById }) {
  const itemById = (id) => indexedItem(getState().items, itemIndexById, id);
  function patchToolItem(id, patch) {
    const prev = itemById(id);
    const ok = patchItem(id, patch);
    if (!ok || !prev) return ok;
    const next = itemById(id);
    if (next && next !== prev) carryTranscriptMeasuredRowsCache(prev, next);
    return ok;
  }
  return { itemById, patchToolItem };
}

/** Mark the card done and remember its call so a late duplicate is ignored. */
export function closeCard(card, callId, done) {
  card.done = true;
  if (callId) done.add(callId);
}
