/**
 * src/tui/session/transcript-store.mjs - live transcript item mutations.
 *
 * Owns the live item window (spill cap + id index), transcript-view history
 * paging, the incrementally maintained prompt-history list, and the streaming
 * tail. Every mutation goes through the draft store's set() so React sees one
 * frame-coalesced publication per change.
 */
import { buildMergedPromptHistory, loadPromptHistory } from '../prompt-history-store.mjs';
import { recomputePromptHistory } from './prompt-history.mjs';
import {
  createSessionItemMutators,
  refillTranscriptViewOverlap,
  replaceSessionItemsState,
} from './transcript-spill.mjs';

// Non-enumerable so the marker never enters persisted transcript items,
// live-share JSON, or renderer snapshots. The desktop host reads the shared
// Symbol.for key before cloning and uses it to prove that a growing text is
// an append, avoiding an O(total text) startsWith check on every frame.
const streamingTailTextEpochKey = Symbol.for('mixdog.streaming-tail-text-epoch');

export function createTranscriptStore({ draft, store, flags, transcriptSpill, itemIndexById, onBulkReplace }) {
  const { set, emit, flushEmitImmediate, markStructureChange } = store;
  const reindexLiveItems = (items) => {
    itemIndexById.clear();
    for (let i = 0; i < items.length; i++) {
      const id = items[i]?.id;
      if (id != null) itemIndexById.set(id, i);
    }
  };
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
  const replaceItems = (
    items,
    { preserveStreamingTail = false, preserveSpill = false, preserveTranscriptView = false } = {}
  ) => {
    const state = draft.state;
    const nextItems = Array.isArray(items) ? items : [];
    if (!preserveSpill) transcriptSpill.reset();
    const liveItems = transcriptSpill.capLive(nextItems);
    const previousTranscriptView = state.transcriptViewItems;
    const nextTranscriptView =
      preserveTranscriptView && previousTranscriptView
        ? refillTranscriptViewOverlap(previousTranscriptView, state.items, liveItems)
        : null;
    const transcriptViewChanged = nextTranscriptView !== previousTranscriptView;
    // Bulk item swap (session load / clear / compact). Derive the prompt-history
    // list from the NEW items and stage it onto state here so App never rescans;
    // the callers that invoke replaceItems always follow with a set({items:...,
    // ...}) that carries fresh references, so this pre-stage does not defeat any
    // emit (the accompanying set() diffs the full patch). A bulk swap also
    // discards the old transcript, so drop any tracked active tool calls.
    onBulkReplace();
    const structureRevision = state.structureRevision;
    const replaced = replaceSessionItemsState({
      state,
      items: liveItems,
      itemIndexById,
      preserveStreamingTail,
      extra: {
        promptHistoryList: preserveSpill
          ? state.promptHistoryList
          : buildMergedPromptHistory(recomputePromptHistory(nextItems), loadPromptHistory(state.cwd)),
        activeToolSummary: null,
        activeTools: null,
        transcriptViewItems: nextTranscriptView,
        transcriptViewRevision:
          state.transcriptViewRevision + (preserveTranscriptView && !transcriptViewChanged ? 0 : 1),
        ...transcriptHistoryFlags(),
      },
    });
    // replaceSessionItemsState retains its standalone/test contract. In the live
    // store, defer its revision increment to the frame publication boundary.
    draft.state = { ...replaced, structureRevision };
    markStructureChange();
    // replaceItems stages the bulk state before its callers compose their
    // accompanying patch. Emit here as well so an items-only replacement
    // (for example removeNotice) cannot be hidden by the outer set seeing the
    // already-installed array identity.
    emit();
    return liveItems;
  };
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
  let streamingTailTextEpoch = 0;
  const updateStreamingTail = (id, patch = {}, extra = {}, { resetText = false } = {}) => {
    if (id == null) return false;
    const state = draft.state;
    const current =
      state.streamingTail?.id === id ? state.streamingTail : { kind: 'assistant', id, text: '', streaming: true };
    const next = { ...current, ...patch, kind: 'assistant', id, streaming: true };
    const currentTextEpoch = current[streamingTailTextEpochKey];
    const textEpoch =
      !resetText && Number.isSafeInteger(currentTextEpoch) ? currentTextEpoch : ++streamingTailTextEpoch;
    Object.defineProperty(next, streamingTailTextEpochKey, {
      value: textEpoch,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    let changed = state.streamingTail !== current;
    if (!changed) {
      for (const [key, value] of Object.entries(next)) {
        if (!Object.is(current[key], value)) {
          changed = true;
          break;
        }
      }
    }
    return set(changed ? { streamingTail: next, ...extra } : extra);
  };
  const clearStreamingTail = (id = null, extra = {}) => {
    const tail = draft.state.streamingTail;
    if (!tail || (id != null && tail.id !== id)) {
      return set(extra);
    }
    return set({ streamingTail: null, ...extra });
  };
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
