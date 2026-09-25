/**
 * src/tui/session/transcript-store.mjs - live transcript item mutations.
 *
 * Owns the live item window (spill cap + id index), transcript-view history
 * paging, the incrementally maintained prompt-history list, and the streaming
 * tail. Every mutation goes through the draft store's set() so React sees one
 * frame-coalesced publication per change.
 *
 * The bulk swap lives in transcript-store/replace-items.mjs and the streaming
 * tail in transcript-store/streaming-tail.mjs.
 */
import { buildMergedPromptHistory, loadPromptHistory } from '../prompt-history-store.mjs';
import { recomputePromptHistory } from './prompt-history.mjs';
import { createSessionItemMutators, reindexItems } from './transcript-spill.mjs';
import { createReplaceItems } from './transcript-store/replace-items.mjs';
import { createStreamingTailMutators } from './transcript-store/streaming-tail.mjs';

export function createTranscriptStore({ draft, store, flags, transcriptSpill, itemIndexById, onBulkReplace }) {
  const { set, emit, flushEmitImmediate, markStructureChange } = store;
  const reindexLiveItems = (items) => reindexItems(itemIndexById, items);
  const transcriptHistoryFlags = () => ({
    transcriptHistoryBefore: transcriptSpill.hasOlder,
    transcriptHistoryAfter: transcriptSpill.hasNewer,
  });
  const restoreOlderTranscript = () => {
    const transcriptViewItems = transcriptSpill.restoreOlder(draft.state.items);
    if (!transcriptViewItems) return false;
    set({
      transcriptViewItems,
      transcriptViewRevision: draft.state.transcriptViewRevision + 1,
      ...transcriptHistoryFlags(),
    });
    flushEmitImmediate();
    return true;
  };
  const restoreNewerTranscript = () => {
    const restored = transcriptSpill.restoreNewer(draft.state.items);
    if (!restored) return false;
    set({
      transcriptViewItems: restored.atLive ? null : restored,
      transcriptViewRevision: draft.state.transcriptViewRevision + 1,
      ...transcriptHistoryFlags(),
    });
    flushEmitImmediate();
    return true;
  };
  const replaceItems = createReplaceItems({
    draft,
    transcriptSpill,
    itemIndexById,
    onBulkReplace,
    markStructureChange,
    emit,
    transcriptHistoryFlags,
  });
  const pushItem = (item) => {
    if (!flags.pushingFromDeferredEntry && flags.flushDeferredBeforeImmediatePush) {
      flags.flushDeferredBeforeImmediatePush();
    }
    const state = draft.state;
    const uncappedItems = [...state.items, item];
    const items = transcriptSpill.capLive(uncappedItems);
    if (items !== uncappedItems) reindexLiveItems(items);
    const index = items.length - 1;
    if (item?.id != null) itemIndexById.set(item.id, index);
    if (item?.kind === 'user') {
      // Rebuild the derived history against the NEW list (not yet in state) and
      // publish items + the fresh list in ONE set(). Do NOT pre-assign to state
      // first — set() diffs against the current state, so a pre-assign would make
      // the references identical and skip emit().
      const promptHistoryList = buildMergedPromptHistory(recomputePromptHistory(items), loadPromptHistory(state.cwd));
      set({ items, structureRevision: state.structureRevision + 1, promptHistoryList, ...transcriptHistoryFlags() });
      flushEmitImmediate();
    } else {
      set({ items, structureRevision: state.structureRevision + 1, ...transcriptHistoryFlags() });
    }
  };
  const appendItems = (newItems, extra = {}) => {
    if (!Array.isArray(newItems) || newItems.length === 0) return set(extra);
    const items = transcriptSpill.capLive([...draft.state.items, ...newItems]);
    reindexLiveItems(items);
    return set({
      items,
      structureRevision: draft.state.structureRevision + 1,
      ...transcriptHistoryFlags(),
      ...extra,
    });
  };
  const { updateStreamingTail, clearStreamingTail } = createStreamingTailMutators({ draft, set });
  const { patchItem, settleStreamingTail } = createSessionItemMutators({
    getState: () => draft.state,
    set,
    itemIndexById,
    normalizeItems: (items) => transcriptSpill.capLive(items),
    itemStateExtra: transcriptHistoryFlags,
  });
  return {
    restoreOlderTranscript,
    restoreNewerTranscript,
    replaceItems,
    pushItem,
    appendItems,
    patchItem,
    updateStreamingTail,
    settleStreamingTail,
    clearStreamingTail,
  };
}
