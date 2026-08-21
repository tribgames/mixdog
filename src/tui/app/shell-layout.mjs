// Shell layout derivation, extracted from App.jsx. Pure render-phase math:
// given the terminal size and every surface that reserves rows (panels,
// prompt box, queued band, welcome banner, hints), compute the transcript
// viewport height and the whole bottom-cluster row budget. Runs once per
// render; the few ref writes mirror the previous inline behavior.
import { isLiveSpinnerMetaVisible } from './live-spinner-visibility.mjs';
import { isCompletedTranscriptTailAppendedThisCommit } from './live-spinner-visibility.mjs';
import { promptContentRows, wrappedDetailRows, queuedBandRows } from './text-layout.mjs';

export function computeShellLayout({
  providerPrompt,
  channelPrompt,
  hookPrompt,
  settingsPrompt,
  panelTransitionEpoch,
  panelInkMaskEpoch,
  toolApproval,
  picker,
  contextPanel,
  usagePanel,
  slashPaletteOpen,
  tuiReady,
  state,
  resizeState,
  frameColumns,
  promptHint,
  promptHintTone,
  textEntryLayoutRows,
  onboardingActive,
  conditionalWelcomePromptHint,
  welcomePromptHintDismissed,
  welcomePromptHintRef,
  welcomePromptHintVisibleRef,
  panelTransitionRef,
  projectBootInputLatchRef,
  promptLayoutValueRef,
  promptContentColumns,
  transcriptBottomSlackRowsRef,
  transcriptViewportRef,
  frameRowsRef,
  promptBoxRectRef,
  panelCloseInkMaskRowsRef,
  CORE_MULTILINE_TEXT_ENTRY_KINDS,
  panelSignatureFlags,
  panelKindSignature,
  isInstantPanelCloseTransition,
  PANEL_LAYOUT_SIG,
}) {
  // ── Transcript viewport height ──────────────────────────────────────────
  // ROOT-CAUSE FIX: the transcript must live in a box with an EXPLICIT numeric
  // height + overflow:hidden so ink's renderer actually clips off-screen rows
  // (render-node-to-output.js → output.clip uses the box's computed height). An
  // unbounded negative-margin column inside a flexGrow box let stale rows
  // overprint newer ones across incremental redraws. We reserve the rows the
  // bottom cluster needs and give the transcript everything above it.
  //
  //   viewportHeight = rows
  //                  − welcome header  (empty transcript only)
  //                  − live status     (thinking / spinner / TurnDone)
  //                  − queued prompts  (marginTop 1 + N rows, only when queued)
  //                  − prompt meta     (spinner / transient message / queued)
  //                  − input box       (2 border + wrapped content)
  //                  − statusline      (reserved L1 + L2 + outer gap; total 3 rows)
  //
  // Every sibling outside the viewport must be accounted for here; otherwise
  // the total tree height exceeds the terminal and the input box gets pushed.
  const textEntryPrompt = providerPrompt || channelPrompt || hookPrompt || settingsPrompt;
  const hasTextEntryPrompt = !!textEntryPrompt;
  const hasFloatingPanel = !!(toolApproval || picker || contextPanel || usagePanel || slashPaletteOpen || hasTextEntryPrompt);
  const expandedOptionPanel = !!(toolApproval || picker || contextPanel || usagePanel || hasTextEntryPrompt);
  const panelTransitionForBoot = panelTransitionRef.current;
  if (panelTransitionForBoot.signature.includes('picker:project') && !picker) {
    projectBootInputLatchRef.current = true;
  }
  const bootSettling = !tuiReady && state.items.length === 0 && !hasFloatingPanel && !projectBootInputLatchRef.current;
  // Project selection (initial-entry experience) keeps the welcome banner
  // visible above the picker / path-entry prompt, unlike other floating panels.
  const projectSelectionActive = picker?.kind === 'project'
    || settingsPrompt?.kind === 'project-new'
    || settingsPrompt?.kind === 'project-create-confirm'
    || settingsPrompt?.kind === 'project-rename';
  // Slash search floats above the normal prompt. Actual option panels own the
  // prompt/status area, so they hide those rows and expand into that space.
  const inputBoxHidden = expandedOptionPanel || bootSettling;
  const liveSpinner = state.spinner?.active ? state.spinner : (state.commandStatus?.active ? state.commandStatus : null);
  // Command-status spinner (auto-clear/compact/etc.) is NOT part of the
  // spinner → TurnDone handoff: it typically starts while the transcript tail
  // is already a done row (idle session), so the done-at-tail suppression
  // below must never hide it — that read as a frozen UI during auto-clear.
  const liveSpinnerIsCommand = !state.spinner?.active && !!state.commandStatus?.active;
  const latestToast = state.toasts?.length ? state.toasts[state.toasts.length - 1] : null;
  const toastHint = latestToast ? latestToast.text : '';
  const progressHint = state.progressHint || null;
  const inputHint = promptHint || toastHint || (progressHint?.text || '');
  const inputHintTone = promptHint
    ? promptHintTone
    : (latestToast?.tone || progressHint?.tone || 'info');
  const latestTranscriptItem = state.items[state.items.length - 1] || null;
  // Bottom meta band ownership is LIVE-SPINNER ONLY. A finished turn's done row
  // (turndone/statusdone) is a normal transcript item and flows into scrollback
  // like anything else, so the area directly above the prompt is CLEAR when the
  // user is idle. Earlier this row was pinned in the meta band until the next
  // transcript item was appended (to dodge an autowrap overprint/bleed), which
  // left the completed status row stuck above the prompt while the user typed or
  // sat idle. That bleed is now fixed at the source by the tool-output width
  // clamp, so the pin is no longer needed. Kept as a named null const so the
  // downstream meta-band/hint logic collapses cleanly to the spinner-only path.
  const latestDoneItem = null;
  const SCROLL_HINT_ROWS = 0;
  const LIVE_STATUS_ROWS = 0;
  // The standalone prompt box is 2 border rows + the wrapped PromptInput body.
  // The one-row scroll baseline gap ABOVE the prompt is owned by
  // transcriptGuardRows, not the prompt box itself. That keeps the scroll
  // reference at "textbox + 1" while the prompt/statusline bottom stays fixed.
  //
  // This must track the prompt draft's REAL wrapped height. Reserving a constant
  // one-line prompt lets long/multiline input grow the bottom cluster after the
  // transcript viewport has already claimed those rows, which makes transcript
  // body text overprint the textbox or slash command window.
  const currentPromptLayoutRows = promptContentRows(promptLayoutValueRef.current, promptContentColumns);
  const promptInputRows = inputBoxHidden ? 0 : currentPromptLayoutRows;
  const promptBoxRows = inputBoxHidden ? 0 : 2 + promptInputRows;
  const STATUSLINE_ROWS = 3;
  // Shared panel chrome math. Every floating panel follows the same vertical
  // rhythm INSIDE its round border: title row, blank, description/hint row,
  // blank, then content. That is 4 non-content rows; the round border adds 2
  // more, so chrome reserves 6 rows total. Reserving the full chrome here (even
  // for panels that omit the description) guarantees the bordered title can
  // never be clipped off the top — content rows shrink first when the terminal
  // is short, because the floating container clips from the top (flex-end).
  const PANEL_MAX_VISIBLE = 8;
  const PANEL_CHROME_ROWS = 6;
  const PANEL_BASE_ROWS = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
  const PICKER_CHROME_ROWS = PANEL_CHROME_ROWS;
  // TextEntryPanel content is one prompt line (chrome + 1) for single-line
  // prompts, or up to PANEL_MAX_VISIBLE wrapped rows for core memory add/edit.
  // PLUS an optional wrapped detail block (blank spacer + N wrapped rows — e.g.
  // the manual OAuth URL). The floating container clips from the TOP (flex-end +
  // overflow hidden), so under-reserving here pushed the bordered title off
  // the top of the panel. Width matches the panel interior: frame − 2 border
  // − 2 paddingX, same wrap-ansi math ink uses for wrap="wrap".
  const textEntryKind = String(textEntryPrompt?.kind || '');
  const textEntryMultiline = CORE_MULTILINE_TEXT_ENTRY_KINDS.has(textEntryKind);
  const textEntryDetailText = String(textEntryPrompt?.detail || '').trim();
  const textEntryDetailRows = textEntryDetailText
    ? 1 + wrappedDetailRows(textEntryDetailText, Math.max(1, frameColumns - 4))
    : 0;
  const textEntryContentRows = textEntryMultiline ? textEntryLayoutRows : 1;
  const TEXT_ENTRY_ROWS = PANEL_CHROME_ROWS + textEntryContentRows + textEntryDetailRows;
  const OPTION_PANEL_EXTRA_ROWS = expandedOptionPanel ? 3 : 0;
  const queuedVisible = !hasFloatingPanel && !inputBoxHidden && state.queued?.length > 0;
  // While the slash palette is open it owns the area above the prompt, so the
  // live spinner/meta row is suppressed entirely — no reservation and no render.
  // Normalize the spinner → TurnDone handoff by making them occupy the SAME
  // two-row slot. Completion appends turndone and clears spinner in one commit,
  // so a completed row replaces the spinner slot with no transient jump. A
  // statusdone can be emitted mid-turn (for example after compaction), so it
  // must not suppress the still-active spinner.
  const promptMetaVisible = isLiveSpinnerMetaVisible({
    inputBoxHidden,
    slashPaletteOpen,
    liveSpinner,
    liveSpinnerIsCommand,
    latestTranscriptItem,
    streamingTail: state.streamingTail,
    transcriptViewActive: Boolean(state.transcriptViewItems),
  });
  const promptMetaRows = promptMetaVisible ? 2 : 0;
  // Toast/error text without a live spinner uses the existing transcript guard
  // row directly above the prompt. Do NOT reserve another row here: that made a
  // transient hint add a visible newline/prompt jump whenever no spinner was
  // active.
  const overlayHintRequested = !inputBoxHidden && !hasFloatingPanel && !liveSpinner && !!inputHint && !queuedVisible;
  const overlayHintRows = 0;
  // QueuedCommands renders each queued command at its FULL wrapped height
  // (same content width the promoted transcript user row wraps at), pinned
  // above the prompt box with no extra top-margin row. Reserving the true
  // height keeps promotion from re-expanding the text mid-flight ("row jump").
  // If the whole queue would eat too much of the frame, fall back to the old
  // compact 1-row-per-entry truncation so the input box never leaves screen.
  const queuedFullRows = queuedVisible
    ? state.queued.reduce(
      (sum, item) => sum + queuedBandRows(String(item.displayText || item.text || ''), Math.max(1, frameColumns - 4)),
      0,
    )
    : 0;
  const queuedRowBudget = Math.max(3, Math.floor(resizeState.rows / 3));
  const queuedCompact = queuedFullRows > queuedRowBudget;
  const queuedRows = queuedVisible ? (queuedCompact ? state.queued.length : queuedFullRows) : 0;
  const INPUT_BOX_ROWS = promptBoxRows + promptMetaRows + overlayHintRows;
  // Welcome banner visibility (computed here, after the prompt/panel row math
  // it depends on). The slash palette must NOT unmount the banner on the empty
  // transcript: dropping the 11-row banner the moment '/' opened the palette
  // (and remounting it on Esc) read as the whole top of the screen jumping on
  // command-palette entry. Keep the banner mounted through a slash session
  // whenever the terminal is tall enough to hold banner + palette + prompt +
  // statusline at once; short terminals still yield the banner so the palette
  // chrome never clips (the floating container clips from the top).
  const WELCOME_BANNER_ROWS = 11;
  const SLASH_PALETTE_ROWS = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
  const slashKeepsWelcomeBanner = slashPaletteOpen
    && resizeState.rows >= WELCOME_BANNER_ROWS + SLASH_PALETTE_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + 1;
  const showWelcomeBanner = (state.items.length === 0 && (!hasFloatingPanel || slashKeepsWelcomeBanner))
    || projectSelectionActive || onboardingActive;
  const WELCOME_ROWS = showWelcomeBanner ? WELCOME_BANNER_ROWS : 0;
  const baseReserve = WELCOME_ROWS + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
  const maxFloatingPanelRows = Math.max(0, resizeState.rows - baseReserve - 1);
  const desiredFloatingPanelRows = toolApproval
    ? PANEL_CHROME_ROWS + 2 + OPTION_PANEL_EXTRA_ROWS
    : picker
      ? (picker.fillAvailable ? maxFloatingPanelRows : PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS)
      : contextPanel
      ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS + 3
      : usagePanel
        ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS
        : slashPaletteOpen
          ? PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS
          : hasTextEntryPrompt
            ? TEXT_ENTRY_ROWS
            : 0;
  const floatingPanelRows = desiredFloatingPanelRows > 0
    ? Math.min(desiredFloatingPanelRows, maxFloatingPanelRows)
    : 0;
  // Give the list every content row the panel exposes. The panel already grew
  // by OPTION_PANEL_EXTRA_ROWS; previously that growth was subtracted back out
  // here, so the rows leaked into an empty flexGrow gap instead of the list.
  // Reserving only PICKER_CHROME_ROWS lets the list occupy the full interior
  // (the footer's own reservation is handled inside Picker).
  const pickerVisibleRows = picker
    ? Math.max(1, floatingPanelRows - PICKER_CHROME_ROWS)
    : PANEL_MAX_VISIBLE;
  const rawBottomReserve = baseReserve + floatingPanelRows;
  const bottomClusterRows = INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows + floatingPanelRows;
  const panelLayoutSignature = [
    toolApproval ? 'tool' : '',
    picker ? `picker:${picker.kind || ''}:${picker.fillAvailable ? 'fill' : 'fit'}` : '',
    contextPanel ? 'context' : '',
    usagePanel ? 'usage' : '',
    slashPaletteOpen ? 'slash' : '',
    hasTextEntryPrompt ? `text:${textEntryPrompt?.kind || ''}` : '',
    inputBoxHidden ? 'input-hidden' : 'input-visible',
    floatingPanelRows,
    promptBoxRows,
    promptMetaRows,
    queuedRows,
    WELCOME_ROWS,
  ].join('|');
  const panelTransition = panelTransitionRef.current;
  const panelLayoutChanged = Boolean(panelTransition.signature && panelTransition.signature !== panelLayoutSignature);
  let panelTransitionClearRows = 0;
  let panelTransitionGuardRows = 0;
  if (panelLayoutChanged) {
    const panelShrinkRows = Math.max(0, panelTransition.reserve - bottomClusterRows);
    const initialProjectEntryClose = state.items.length === 0;
    // Prompt-row-only churn (promptBoxRows/promptMetaRows/queuedRows shifting
    // while no panel opened/closed/changed kind and floatingPanelRows itself is
    // unchanged — see PANEL_KIND_TOKEN_COUNT) must not fall into the clearRows
    // + setTimeout recommit path below: that inserts a full extra blank row for
    // one commit, which IS the newline-add/remove jolt while typing. Route a
    // shrink here through the same one-commit ink-mask path as an instant panel
    // close so the stale row is masked in the very commit it disappears; growth
    // already needs no clearance (panelShrinkRows is 0 in that case).
    const promptRowsOnlyChange = panelShrinkRows > 0
      && panelKindSignature(panelTransition.signature) === panelKindSignature(panelLayoutSignature);
    // Turn-end spinner meta collapse: the 2-row live-spinner band disappears in
    // the SAME commit the engine appends the turndone/statusdone tail (see
    // engine.mjs runTurn — turndone + spinner:null land in one set()). That new
    // done row already replaces the vacated height, so masking those rows blank
    // for one commit only to clear them on the next commit IS the visible
    // transcript bounce. Exempt exactly the meta-collapse rows from the ink mask
    // when the done row is the transcript tail. Every other prompt-row-only
    // shrink (typing newline removal, queued-row churn) AND the reclaimed/no-op
    // path (engine.mjs skips turndone, so the completed-tail check stays false and no
    // row replaces the height) keep the mask so they still reclaim smoothly.
    const prevMetaRows = Number(String(panelTransition.signature).split('|')[PANEL_LAYOUT_SIG.PROMPT_META]) || 0;
    const nextMetaRows = Number(String(panelLayoutSignature).split('|')[PANEL_LAYOUT_SIG.PROMPT_META]) || 0;
    // Require the done row to have been appended in THIS commit (tail id changed
    // since the last commit). A command spinner can leave a STALE done row at the
    // tail and then clear without appending statusdone (e.g. /recall — see
    // engine.mjs), collapsing the meta band with NO same-commit backfill; masking
    // must stay on for that path or the vacated rows overpaint the stale row.
    const doneTailAppendedThisCommit = isCompletedTranscriptTailAppendedThisCommit(
      latestTranscriptItem,
      panelTransition.tailId,
    );
    const spinnerMetaCollapseRows = doneTailAppendedThisCommit
      ? Math.max(0, prevMetaRows - nextMetaRows)
      : 0;
    // Queued-band promotion: drain() removes the queued band and appends the
    // promoted user transcript row in the SAME commit (session-flow.mjs drain
    // → pushUserOrSyntheticItem → runTurn spinner, one microtask flush). The
    // new user row (full wrapped height + margin) already backfills the
    // vacated band rows, so masking them blank for one commit only to drop
    // the mask on the next commit made the whole transcript bounce down.
    // Exempt exactly the vacated queued rows when a user row landed at the
    // tail in this commit; queue edits/removals without a tail append (tail
    // id unchanged, or non-user tail) keep the mask.
    const prevQueuedSigRows = Number(String(panelTransition.signature).split('|')[PANEL_LAYOUT_SIG.QUEUED]) || 0;
    const nextQueuedSigRows = Number(String(panelLayoutSignature).split('|')[PANEL_LAYOUT_SIG.QUEUED]) || 0;
    const userTailAppendedThisCommit = latestTranscriptItem?.kind === 'user'
      && (latestTranscriptItem?.id ?? null) !== panelTransition.tailId;
    const queuedPromoteCollapseRows = userTailAppendedThisCommit
      ? Math.max(0, prevQueuedSigRows - nextQueuedSigRows)
      : 0;
    const instantPanelClose = panelShrinkRows > 0
      && (promptRowsOnlyChange
        || isInstantPanelCloseTransition(panelTransition.signature, panelLayoutSignature, initialProjectEntryClose));
    // Slash palette opening on the empty welcome screen: bottomReserve already
    // grows to its final size in this same commit (floatingPanelRows reflects
    // slashPaletteOpen immediately, no clearRows needed), but the renderer can
    // still overpaint the just-vacated transcript row for one commit. Borrow
    // the transitional guard-row mechanism (normally used for tall panel
    // closes below) for exactly one commit on the open transition itself —
    // this only carves an extra blank row out of transcriptContentHeight, it
    // does not touch bottomReserve/floatingPanelRows/palette height.
    const slashOpenOnEmptyTranscript = initialProjectEntryClose
      && !panelSignatureFlags(panelTransition.signature).slash
      && panelSignatureFlags(panelLayoutSignature).slash;
    if (instantPanelClose) {
      // Slash palette and initial project-entry closes land on the final bottom
      // reserve in one commit. Paint reclaimed rows as a blank mask band below
      // the transcript clip instead of inflating bottomReserve + reclaiming on
      // the next tick. Subtract any turn-end spinner-meta rows that the same-
      // commit done tail already backfills (spinnerMetaCollapseRows) so that
      // transition masks nothing and does not bounce; same for queued-band
      // rows backfilled by a just-promoted user row (queuedPromoteCollapseRows).
      panelCloseInkMaskRowsRef.current = Math.max(0, panelShrinkRows - spinnerMetaCollapseRows - queuedPromoteCollapseRows);
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
      panelTransition.epoch = panelTransitionEpoch;
    } else if (slashOpenOnEmptyTranscript) {
      panelTransitionClearRows = 0;
      panelTransitionGuardRows = 1;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 1;
      panelTransition.epoch = panelTransitionEpoch;
    } else {
      // Tall panel closes must land on the final bottom reserve in the same
      // commit. Inflating bottomReserve with temporary clearance makes the
      // transcript/prompt area move once, then snap back on the timer commit.
      // Instead, keep the reclaimed rows inside the fixed viewport as a blank
      // one-frame mask, matching the instant-close path above.
      panelCloseInkMaskRowsRef.current = panelShrinkRows;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
      panelTransition.epoch = panelTransitionEpoch;
    }
  } else if (panelTransition.epoch === panelTransitionEpoch) {
    panelTransitionClearRows = panelTransition.clearRows || 0;
    panelTransitionGuardRows = panelTransition.guardRows || 0;
  }
  if (desiredFloatingPanelRows > 0) {
    panelCloseInkMaskRowsRef.current = 0;
  }
  void panelInkMaskEpoch;
  const panelCloseInkMaskRows = desiredFloatingPanelRows > 0 ? 0 : panelCloseInkMaskRowsRef.current;
  const bottomReserve = rawBottomReserve + panelTransitionClearRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
  // Keep one physical row between the transcript clip and the bottom cluster
  // even when pinned to the live tail. Windows Terminal/conhost can still
  // surface one clipped/off-by-one transcript row below the statusline during
  // rapid tool-card updates; a permanent guard row makes that row blank instead
  // of a tool header/detail.
  const guardCapacityRows = Math.max(0, viewportHeight - 1);
  const baseGuardRows = guardCapacityRows > 0 ? 1 : 0;
  // ── Scroll-time overprint guard ───────────────────────────────────────────
  // Wheel/manual scroll pushes the transcript column DOWN via a negative
  // marginBottom (see the viewport render). Under conhost/Windows Terminal the
  // incremental redraw can leave the row that slid past the clip edge painted
  // OVER the bottom cluster (input box / statusline) for a frame — the reported
  // "scrolled text shows on the statusline row" bug. One guard row is enough
  // while pinned to the live tail, but during an active scroll the slid row can
  // still bleed one line further, so widen the guard to TWO rows whenever the
  // viewport is genuinely scrolled up. The extra blank row absorbs the stray
  // paint instead of the statusline. Requires a viewport tall enough to spare
  // the row, and never shrinks below the base guard.
  // Gate on the same follow-aware basis the transcript window uses for
  // renderScrollOffset (see use-transcript-window.mjs targetNearBottom): the
  // live `scrollOffset` state can still read >0 for one frame after a wheel
  // turn re-arms bottom-follow, while this same frame already renders with
  // renderScrollOffset=0. Without this, the stale offset shrinks
  // transcriptContentHeight by one row that never actually gets rendered,
  // producing a one-row bounce that snaps back once state catches up.
  // [2026-07-06] Scroll-time extra guard DISABLED: the widened (2-row) guard
  // rendered as a visibly empty band between the transcript and the prompt box
  // whenever the viewport was scrolled up (user-reported "bottom rows look
  // blank while scrolling"). The base 1-row guard below stays; if the
  // scrolled-row-over-statusline overpaint resurfaces, fix it in the renderer
  // diff (clip/erase) instead of carving more blank viewport rows.
  const scrollGuardRows = 0;
  const transcriptGuardRows = Math.min(guardCapacityRows, baseGuardRows + panelTransitionGuardRows + scrollGuardRows);
  // Welcome prompt hint: a one-row band rendered INSIDE the transcript
  // viewport (as a sibling below the content clip), so it must be part of the
  // viewport row accounting computed right below. Left unaccounted, the slash
  // palette close commit on the empty welcome screen painted one extra
  // physical row (hint reappears in the same commit as the close mask), so
  // the prompt box + statusline dipped one row and snapped back on the
  // mask-clear commit.
  const welcomePromptHintText = conditionalWelcomePromptHint || welcomePromptHintRef.current || '';
  const welcomePromptHintVisible = Boolean(
    welcomePromptHintText
    && !welcomePromptHintDismissed
    && state.items.length === 0
    && !hasFloatingPanel
    && !inputBoxHidden
    && !queuedVisible
    && !liveSpinner
    && !inputHint
  );
  // Tiny terminals: guard rows can already consume all but one viewport row
  // (guardCapacityRows = viewportHeight - 1). transcriptContentHeight clamps
  // to >= 1, so an unconditional hint row would paint viewportHeight + 1 rows
  // and push the prompt/statusline down. The hint yields unless at least one
  // content row remains beside it.
  const welcomePromptHintRows = welcomePromptHintVisible
    && (viewportHeight - transcriptGuardRows) >= 2 ? 1 : 0;
  welcomePromptHintVisibleRef.current = welcomePromptHintRows > 0;
  // Transient hint/error on the EMPTY transcript: the guard row sits directly
  // above the prompt box, so painting the hint there hugs the textbox one row
  // below where the live-spinner line renders. Carve one in-viewport row ABOVE
  // the guard row instead so the hint's baseline matches the spinner row (two
  // rows above the box, guard row stays blank as the spacer). This is an
  // in-viewport carve like welcomePromptHintRows — bottomReserve is untouched,
  // so the prompt box and statusline never move. Non-empty transcripts keep the
  // existing attach-to-last-item / guard-row fallback placements.
  const overlayHintBandRows = overlayHintRequested
    && state.items.length === 0
    && (viewportHeight - transcriptGuardRows - welcomePromptHintRows) >= 2 ? 1 : 0;
  // Instant panel close (slash palette): the reclaimed rows stay blank for
  // exactly one commit via panelCloseMaskRows. The mask MUST be part of this
  // frame's row accounting — subtract it from the transcript content height
  // and render it as a sibling band below the content clip (where the closed
  // panel's ink was). Rendering it inside the scrolled transcript column made
  // the painted column taller than the accounted viewport for one frame, so
  // the prompt/statusline dropped a row and snapped back on the mask-clear
  // commit (the "textbox dips when the slash palette closes" bug).
  const panelCloseMaskRows = Math.min(
    panelCloseInkMaskRows,
    Math.max(0, viewportHeight - transcriptGuardRows - welcomePromptHintRows - overlayHintBandRows - 1),
  );
  const transcriptContentHeight = Math.max(
    1,
    viewportHeight - transcriptGuardRows - panelCloseMaskRows - welcomePromptHintRows - overlayHintBandRows,
  );
  // Keep the keyboard-selection edge step anchored to the base guard. This is
  // not a follow threshold: any positive wheel target is a reading position;
  // only the true bottom may auto-follow a live tail.
  const transcriptBottomSlackRows = Math.max(0, baseGuardRows);
  transcriptBottomSlackRowsRef.current = transcriptBottomSlackRows;
  transcriptViewportRef.current = {
    top: WELCOME_ROWS,
    bottom: Math.max(WELCOME_ROWS, WELCOME_ROWS + transcriptContentHeight - 1),
  };
  // [mixdog] Keep the live terminal row count current for the mouse handler's
  // region routing + status-band selection clip (see onData).
  frameRowsRef.current = Math.max(1, Number(resizeState.rows) || 24);
  // When the prompt box is hidden (floating panel / option panel owns the
  // bottom area), drop its stale measured rect so the mouse handler does not
  // route presses to a prompt box that is not on screen.
  if (inputBoxHidden) promptBoxRectRef.current = null;
  // Toast/error text has two mutually exclusive placements:
  // - while a live status row exists (thinking/compacting/responding), attach it
  //   to that row so the bottom cluster reserves exactly one status band;
  // - otherwise render it into the normal one-row gap above the prompt, replacing
  //   the blank spacer instead of reserving an extra row. This keeps late errors
  //   from pushing the prompt/statusline upward, and when thinking starts the
  //   hint moves into the live row on the same render instead of double-painting.
  // Transient hint placement while no spinner owns the band is resolved after
  // transcript windowing (see overlayHintOnLastItem / overlayHintFallbackRow).
  const spinnerHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  // When no live spinner owns a status band, the transient hint/error is drawn
  // into the existing transcript guard row directly above the prompt. Mirror the
  // spinner-row placement: a fixed-width right slot, not a full-width left box.
  const guardHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  const transientStatusWidth = liveSpinner ? spinnerHintWidth : guardHintWidth;
  const promptSpinnerColumns = liveSpinner && inputHint
    ? Math.max(1, frameColumns - spinnerHintWidth - 1)
    : frameColumns;

  return {
    textEntryPrompt,
    hasTextEntryPrompt,
    hasFloatingPanel,
    expandedOptionPanel,
    panelTransitionForBoot,
    bootSettling,
    projectSelectionActive,
    inputBoxHidden,
    liveSpinner,
    liveSpinnerIsCommand,
    latestToast,
    toastHint,
    progressHint,
    inputHint,
    inputHintTone,
    latestTranscriptItem,
    latestDoneItem,
    SCROLL_HINT_ROWS,
    LIVE_STATUS_ROWS,
    currentPromptLayoutRows,
    promptInputRows,
    promptBoxRows,
    STATUSLINE_ROWS,
    PANEL_MAX_VISIBLE,
    PANEL_CHROME_ROWS,
    PANEL_BASE_ROWS,
    PICKER_CHROME_ROWS,
    textEntryKind,
    textEntryMultiline,
    textEntryDetailText,
    textEntryDetailRows,
    textEntryContentRows,
    TEXT_ENTRY_ROWS,
    OPTION_PANEL_EXTRA_ROWS,
    queuedVisible,
    promptMetaVisible,
    promptMetaRows,
    overlayHintRequested,
    overlayHintRows,
    queuedFullRows,
    queuedRowBudget,
    queuedCompact,
    queuedRows,
    INPUT_BOX_ROWS,
    WELCOME_BANNER_ROWS,
    SLASH_PALETTE_ROWS,
    slashKeepsWelcomeBanner,
    showWelcomeBanner,
    WELCOME_ROWS,
    baseReserve,
    maxFloatingPanelRows,
    desiredFloatingPanelRows,
    floatingPanelRows,
    pickerVisibleRows,
    rawBottomReserve,
    bottomClusterRows,
    panelLayoutSignature,
    panelTransition,
    panelLayoutChanged,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    panelCloseInkMaskRows,
    bottomReserve,
    viewportHeight,
    guardCapacityRows,
    baseGuardRows,
    scrollGuardRows,
    transcriptGuardRows,
    welcomePromptHintText,
    welcomePromptHintVisible,
    welcomePromptHintRows,
    overlayHintBandRows,
    panelCloseMaskRows,
    transcriptContentHeight,
    transcriptBottomSlackRows,
    spinnerHintWidth,
    guardHintWidth,
    transientStatusWidth,
    promptSpinnerColumns,
  };
}
