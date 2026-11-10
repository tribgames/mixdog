/**
 * src/tui/session/transcript-store/replace-items.mjs - the bulk item swap
 * (session load / clear / compact): spill reset, transcript-view refill, the
 * derived prompt-history list, and the deferred structure revision.
 */
import { buildMergedPromptHistory, loadPromptHistory } from '../../prompt-history-store.mjs';
import { recomputePromptHistory } from '../prompt-history.mjs';
import { refillTranscriptViewOverlap, replaceSessionItemsState } from '../transcript-spill.mjs';

export function createReplaceItems({
  draft,
  transcriptSpill,
  itemIndexById,
  onBulkReplace,
  markStructureChange,
  emit,
  transcriptHistoryFlags,
}) {
  return (items, { preserveStreamingTail = false, preserveSpill = false, preserveTranscriptView = false } = {}) => {
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
}
