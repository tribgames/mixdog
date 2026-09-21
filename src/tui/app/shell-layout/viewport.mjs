/**
 * src/tui/app/shell-layout/viewport.mjs - carve the transcript viewport out
 * of what the bottom cluster leaves: guard rows, in-viewport hint bands, the
 * one-commit panel-close mask, and the content height; mirrors the result
 * into the refs the mouse/scroll handlers read.
 */

// Keep one physical row between the transcript clip and the bottom cluster
// even when pinned to the live tail. Windows Terminal/conhost can still
// surface one clipped/off-by-one transcript row below the statusline during
// rapid tool-card updates; a permanent guard row makes that row blank instead
// of a tool header/detail.
//
// [2026-07-06] Scroll-time extra guard DISABLED: the widened (2-row) guard
// rendered as a visibly empty band between the transcript and the prompt box
// whenever the viewport was scrolled up (user-reported "bottom rows look
// blank while scrolling"). The base 1-row guard stays; if the
// scrolled-row-over-statusline overpaint resurfaces, fix it in the renderer
// diff (clip/erase) instead of carving more blank viewport rows.
const SCROLL_GUARD_ROWS = 0;

export function carveViewport({
  budgets,
  surfaces,
  hints,
  transition,
  state,
  resizeState,
  conditionalWelcomePromptHint,
  welcomePromptHintDismissed,
  welcomePromptHintRef,
  welcomePromptHintVisibleRef,
  transcriptBottomSlackRowsRef,
  transcriptViewportRef,
  frameRowsRef,
  promptBoxRectRef,
}) {
  const { hasFloatingPanel, inputBoxHidden } = surfaces;
  const { liveSpinner, inputHint } = hints;
  const bottomReserve = budgets.rawBottomReserve + transition.panelTransitionClearRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
  const guardCapacityRows = Math.max(0, viewportHeight - 1);
  const baseGuardRows = guardCapacityRows > 0 ? 1 : 0;
  const transcriptGuardRows = Math.min(
    guardCapacityRows,
    baseGuardRows + transition.panelTransitionGuardRows + SCROLL_GUARD_ROWS
  );
  // Welcome prompt hint: a one-row band rendered INSIDE the transcript
  // viewport (as a sibling below the content clip), so it must be part of the
  // viewport row accounting. Left unaccounted, the slash palette close commit
  // on the empty welcome screen painted one extra physical row (hint reappears
  // in the same commit as the close mask), so the prompt box + statusline
  // dipped one row and snapped back on the mask-clear commit.
  const welcomePromptHintText = conditionalWelcomePromptHint || welcomePromptHintRef.current || '';
  const welcomePromptHintVisible = Boolean(
    welcomePromptHintText &&
      !welcomePromptHintDismissed &&
      state.items.length === 0 &&
      !hasFloatingPanel &&
      !inputBoxHidden &&
      !budgets.queuedVisible &&
      !liveSpinner &&
      !inputHint
  );
  // Tiny terminals: guard rows can already consume all but one viewport row
  // (guardCapacityRows = viewportHeight - 1). transcriptContentHeight clamps
  // to >= 1, so an unconditional hint row would paint viewportHeight + 1 rows
  // and push the prompt/statusline down. The hint yields unless at least one
  // content row remains beside it.
  const welcomePromptHintRows = welcomePromptHintVisible && viewportHeight - transcriptGuardRows >= 2 ? 1 : 0;
  welcomePromptHintVisibleRef.current = welcomePromptHintRows > 0;
  // Transient hint/error on the EMPTY transcript: the guard row sits directly
  // above the prompt box, so painting the hint there hugs the textbox one row
  // below where the live-spinner line renders. Carve one in-viewport row ABOVE
  // the guard row instead so the hint's baseline matches the spinner row (two
  // rows above the box, guard row stays blank as the spacer). bottomReserve is
  // untouched, so the prompt box and statusline never move. Non-empty
  // transcripts keep the attach-to-last-item / guard-row fallback placements.
  const overlayHintBandRows =
    budgets.overlayHintRequested &&
    state.items.length === 0 &&
    viewportHeight - transcriptGuardRows - welcomePromptHintRows >= 2
      ? 1
      : 0;
  // Instant panel close (slash palette): the reclaimed rows stay blank for
  // exactly one commit via panelCloseMaskRows. The mask MUST be part of this
  // frame's row accounting — subtract it from the transcript content height
  // and render it as a sibling band below the content clip (where the closed
  // panel's ink was). Rendering it inside the scrolled transcript column made
  // the painted column taller than the accounted viewport for one frame, so
  // the prompt/statusline dropped a row and snapped back on the mask-clear
  // commit (the "textbox dips when the slash palette closes" bug).
  const panelCloseMaskRows = Math.min(
    transition.panelCloseInkMaskRows,
    Math.max(0, viewportHeight - transcriptGuardRows - welcomePromptHintRows - overlayHintBandRows - 1)
  );
  const transcriptContentHeight = Math.max(
    1,
    viewportHeight - transcriptGuardRows - panelCloseMaskRows - welcomePromptHintRows - overlayHintBandRows
  );
  // Keep the keyboard-selection edge step anchored to the base guard. This is
  // not a follow threshold: any positive wheel target is a reading position;
  // only the true bottom may auto-follow a live tail.
  const transcriptBottomSlackRows = Math.max(0, baseGuardRows);
  transcriptBottomSlackRowsRef.current = transcriptBottomSlackRows;
  transcriptViewportRef.current = {
    top: budgets.WELCOME_ROWS,
    bottom: Math.max(budgets.WELCOME_ROWS, budgets.WELCOME_ROWS + transcriptContentHeight - 1),
  };
  // Keep the live terminal row count current for the mouse handler's region
  // routing + status-band selection clip (see onData).
  frameRowsRef.current = Math.max(1, Number(resizeState.rows) || 24);
  // When the prompt box is hidden (floating panel / option panel owns the
  // bottom area), drop its stale measured rect so the mouse handler does not
  // route presses to a prompt box that is not on screen.
  if (inputBoxHidden) promptBoxRectRef.current = null;
  return {
    bottomReserve,
    viewportHeight,
    guardCapacityRows,
    baseGuardRows,
    scrollGuardRows: SCROLL_GUARD_ROWS,
    transcriptGuardRows,
    welcomePromptHintText,
    welcomePromptHintVisible,
    welcomePromptHintRows,
    overlayHintBandRows,
    panelCloseMaskRows,
    transcriptContentHeight,
    transcriptBottomSlackRows,
  };
}

// Toast/error text has two mutually exclusive placements:
// - while a live status row exists (thinking/compacting/responding), attach it
//   to that row so the bottom cluster reserves exactly one status band;
// - otherwise render it into the normal one-row gap above the prompt, replacing
//   the blank spacer instead of reserving an extra row. Both use a fixed-width
//   right slot, not a full-width left box. Transient hint placement while no
//   spinner owns the band is resolved after transcript windowing.
export function hintWidths({ frameColumns, inputHint, liveSpinner }) {
  const hintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  return {
    spinnerHintWidth: hintWidth,
    guardHintWidth: hintWidth,
    transientStatusWidth: hintWidth,
    promptSpinnerColumns: liveSpinner && inputHint ? Math.max(1, frameColumns - hintWidth - 1) : frameColumns,
  };
}
