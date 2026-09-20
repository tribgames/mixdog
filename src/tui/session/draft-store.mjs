/**
 * src/tui/session/draft-store.mjs - synchronous session draft + frame publication.
 *
 * The session runtime mutates `draft.state` synchronously through set();
 * React/useSyncExternalStore only ever reads the immutable published snapshot
 * that the frame publisher swaps in. `draft` is the single holder object every
 * session-local collaborator reads through, so there is exactly one draft.
 */
import { createFrameBatchedStorePublisher } from './frame-batched-store.mjs';
import { TUI_FRAME_MS, cancelRenderAlignedStoreFlush, scheduleRenderAlignedStoreFlush } from './render-timing.mjs';

const freezeSnapshot = (state) => (process.env.NODE_ENV === 'production' ? state : Object.freeze(state));

export function createSessionDraftStore({ draft, listeners, isDisposed, onBusyReleased }) {
  // React reads only this immutable published snapshot. `draft.state` remains
  // the session runtime's synchronous draft until a frame flush swaps the
  // complete draft (including its single revision bump) into this slot.
  let publishedState = freezeSnapshot(draft.state);
  // The mutable session runtime draft must never be the object exposed to React.
  draft.state = { ...draft.state, stats: { ...draft.state.stats } };
  // Mutations stay synchronous, but React publications are frame-coalesced.
  // structureRevision is committed by the publisher exactly once immediately
  // before listeners observe the terminal snapshot for that frame.
  const publisher = createFrameBatchedStorePublisher({
    getState: () => draft.state,
    publishState: (next) => {
      publishedState = freezeSnapshot(next);
      // Detach the next draft, including the only intentionally mutable nested
      // record, so internal draft writes cannot mutate the publication.
      draft.state = { ...next, stats: { ...next.stats } };
    },
    listeners,
    isDisposed,
    frameMs: TUI_FRAME_MS,
    scheduleFrame: scheduleRenderAlignedStoreFlush,
    cancelFrame: cancelRenderAlignedStoreFlush,
  });
  const set = (patch) => {
    if (!patch || typeof patch !== 'object') return false;
    const state = draft.state;
    const requestsStructureChange =
      Object.hasOwn(patch, 'structureRevision') && !Object.is(patch.structureRevision, state.structureRevision);
    const effectivePatch = requestsStructureChange
      ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'structureRevision'))
      : patch;
    let changed = false;
    for (const [key, value] of Object.entries(effectivePatch)) {
      if (!Object.is(state[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed && !requestsStructureChange) return false;
    // Detect commandBusy releasing (true -> false). Submits that arrived while a
    // session command was in flight were queued and drain bailed on commandBusy;
    // re-kick drain here — one central point covers every command releaser
    // (setModel/newSession/resume/clear/...) so queued prompts are never stranded.
    const commandBusyReleased =
      state.commandBusy === true && Object.hasOwn(patch, 'commandBusy') && patch.commandBusy === false;
    // Some recovery and externally-driven settlement paths release busy
    // without returning through drain's own finally. Re-kick centrally so a
    // prompt accepted during the old turn cannot remain queued indefinitely.
    const busyReleased = state.busy === true && Object.hasOwn(patch, 'busy') && patch.busy === false;
    draft.state = { ...state, ...effectivePatch };
    if (requestsStructureChange) publisher.markStructureChange();
    publisher.emit();
    // Preserve the old microtask-latency behavior for interaction gates and
    // long command spinners that intentionally yield before doing heavy work.
    if (effectivePatch.commandStatus || effectivePatch.toolApproval) {
      publisher.flushImmediate();
    }
    if (commandBusyReleased || busyReleased) queueMicrotask(onBusyReleased);
    return true;
  };
  return {
    getState: () => draft.state,
    getPublishedState: () => publishedState,
    set,
    emit: publisher.emit,
    flushEmit: publisher.flush,
    flushEmitImmediate: publisher.flushImmediate,
    markStructureChange: publisher.markStructureChange,
    disposeEmit: publisher.dispose,
  };
}
