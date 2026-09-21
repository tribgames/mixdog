/**
 * src/tui/app/shell-layout/row-budgets.mjs - rows every bottom-cluster
 * surface reserves this render: prompt box, live meta band, queued band,
 * welcome banner, floating panel, and the layout signature that names them.
 */
import { isLiveSpinnerMetaVisible } from '../live-spinner-visibility.mjs';
import { promptContentRows, wrappedDetailRows, queuedBandRows } from '../text-layout.mjs';

const SCROLL_HINT_ROWS = 0;
const LIVE_STATUS_ROWS = 0;
// Statusline: reserved L1 + L2 + outer gap.
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
const WELCOME_BANNER_ROWS = 11;
const SLASH_PALETTE_ROWS = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
// Toast/error text without a live spinner uses the existing transcript guard
// row directly above the prompt. Do NOT reserve another row here: that made a
// transient hint add a visible newline/prompt jump whenever no spinner was
// active.
const OVERLAY_HINT_ROWS = 0;

// The standalone prompt box is 2 border rows + the wrapped PromptInput body.
// The one-row scroll baseline gap ABOVE the prompt is owned by
// transcriptGuardRows, not the prompt box itself. That keeps the scroll
// reference at "textbox + 1" while the prompt/statusline bottom stays fixed.
//
// This must track the prompt draft's REAL wrapped height. Reserving a constant
// one-line prompt lets long/multiline input grow the bottom cluster after the
// transcript viewport has already claimed those rows, which makes transcript
// body text overprint the textbox or slash command window.
function promptBoxBudget(inputBoxHidden, promptLayoutValueRef, promptContentColumns) {
  const currentPromptLayoutRows = promptContentRows(promptLayoutValueRef.current, promptContentColumns);
  const promptInputRows = inputBoxHidden ? 0 : currentPromptLayoutRows;
  return { currentPromptLayoutRows, promptInputRows, promptBoxRows: inputBoxHidden ? 0 : 2 + promptInputRows };
}

// TextEntryPanel content is one prompt line (chrome + 1) for single-line
// prompts, or up to PANEL_MAX_VISIBLE wrapped rows for core memory add/edit.
// PLUS an optional wrapped detail block (blank spacer + N wrapped rows — e.g.
// the manual OAuth URL). The floating container clips from the TOP (flex-end +
// overflow hidden), so under-reserving here pushed the bordered title off
// the top of the panel. Width matches the panel interior: frame − 2 border
// − 2 paddingX, same wrap-ansi math ink uses for wrap="wrap".
function textEntryBudget(textEntryPrompt, textEntryLayoutRows, frameColumns, CORE_MULTILINE_TEXT_ENTRY_KINDS) {
  const textEntryKind = String(textEntryPrompt?.kind || '');
  const textEntryMultiline = CORE_MULTILINE_TEXT_ENTRY_KINDS.has(textEntryKind);
  const textEntryDetailText = String(textEntryPrompt?.detail || '').trim();
  const textEntryDetailRows = textEntryDetailText
    ? 1 + wrappedDetailRows(textEntryDetailText, Math.max(1, frameColumns - 4))
    : 0;
  const textEntryContentRows = textEntryMultiline ? textEntryLayoutRows : 1;
  return {
    textEntryKind,
    textEntryMultiline,
    textEntryDetailText,
    textEntryDetailRows,
    textEntryContentRows,
    TEXT_ENTRY_ROWS: PANEL_CHROME_ROWS + textEntryContentRows + textEntryDetailRows,
  };
}

// QueuedCommands renders each queued command at its FULL wrapped height
// (same content width the promoted transcript user row wraps at), pinned
// above the prompt box with no extra top-margin row. Reserving the true
// height keeps promotion from re-expanding the text mid-flight ("row jump").
// If the whole queue would eat too much of the frame, fall back to the old
// compact 1-row-per-entry truncation so the input box never leaves screen.
function queuedBudget(queuedVisible, state, resizeState, frameColumns) {
  const queuedFullRows = queuedVisible
    ? state.queued.reduce(
        (sum, item) => sum + queuedBandRows(String(item.displayText || item.text || ''), Math.max(1, frameColumns - 4)),
        0
      )
    : 0;
  const queuedRowBudget = Math.max(3, Math.floor(resizeState.rows / 3));
  const queuedCompact = queuedFullRows > queuedRowBudget;
  let queuedRows = 0;
  if (queuedVisible) queuedRows = queuedCompact ? state.queued.length : queuedFullRows;
  return { queuedFullRows, queuedRowBudget, queuedCompact, queuedRows };
}

// Welcome banner visibility (computed after the prompt/panel row math it
// depends on). The slash palette must NOT unmount the banner on the empty
// transcript: dropping the 11-row banner the moment '/' opened the palette
// (and remounting it on Esc) read as the whole top of the screen jumping on
// command-palette entry. Keep the banner mounted through a slash session
// whenever the terminal is tall enough to hold banner + palette + prompt +
// statusline at once; short terminals still yield the banner so the palette
// chrome never clips (the floating container clips from the top).
function welcomeBudget({ slashPaletteOpen, resizeState, INPUT_BOX_ROWS, state, surfaces, onboardingActive }) {
  const slashKeepsWelcomeBanner =
    slashPaletteOpen &&
    resizeState.rows >= WELCOME_BANNER_ROWS + SLASH_PALETTE_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + 1;
  const showWelcomeBanner =
    (state.items.length === 0 && (!surfaces.hasFloatingPanel || slashKeepsWelcomeBanner)) ||
    surfaces.projectSelectionActive ||
    onboardingActive;
  return { slashKeepsWelcomeBanner, showWelcomeBanner, WELCOME_ROWS: showWelcomeBanner ? WELCOME_BANNER_ROWS : 0 };
}

function floatingPanelBudget({
  toolApproval,
  picker,
  contextPanel,
  usagePanel,
  slashPaletteOpen,
  hasTextEntryPrompt,
  TEXT_ENTRY_ROWS,
  OPTION_PANEL_EXTRA_ROWS,
  maxFloatingPanelRows,
}) {
  let desiredFloatingPanelRows = 0;
  if (toolApproval) desiredFloatingPanelRows = PANEL_CHROME_ROWS + 2 + OPTION_PANEL_EXTRA_ROWS;
  else if (picker?.fillAvailable) desiredFloatingPanelRows = maxFloatingPanelRows;
  else if (picker) desiredFloatingPanelRows = PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS;
  else if (contextPanel) desiredFloatingPanelRows = PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS + 3;
  else if (usagePanel) desiredFloatingPanelRows = PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS;
  else if (slashPaletteOpen) desiredFloatingPanelRows = SLASH_PALETTE_ROWS;
  else if (hasTextEntryPrompt) desiredFloatingPanelRows = TEXT_ENTRY_ROWS;
  const floatingPanelRows = desiredFloatingPanelRows > 0 ? Math.min(desiredFloatingPanelRows, maxFloatingPanelRows) : 0;
  // Give the list every content row the panel exposes. The panel already grew
  // by OPTION_PANEL_EXTRA_ROWS; previously that growth was subtracted back out
  // here, so the rows leaked into an empty flexGrow gap instead of the list.
  // Reserving only PICKER_CHROME_ROWS lets the list occupy the full interior
  // (the footer's own reservation is handled inside Picker).
  const pickerVisibleRows = picker ? Math.max(1, floatingPanelRows - PICKER_CHROME_ROWS) : PANEL_MAX_VISIBLE;
  return { desiredFloatingPanelRows, floatingPanelRows, pickerVisibleRows };
}

// Token order: [tool, picker, context, usage, slash, text, inputBoxHidden,
// floatingPanelRows, promptBoxRows, promptMetaRows, queuedRows, WELCOME_ROWS]
// — see PANEL_LAYOUT_SIG / panelKindSignature in App.jsx.
function layoutSignature({ toolApproval, picker, contextPanel, usagePanel, slashPaletteOpen, surfaces, rows }) {
  const pickerFit = picker?.fillAvailable ? 'fill' : 'fit';
  const pickerSignature = picker ? `picker:${picker.kind || ''}:${pickerFit}` : '';
  return [
    toolApproval ? 'tool' : '',
    pickerSignature,
    contextPanel ? 'context' : '',
    usagePanel ? 'usage' : '',
    slashPaletteOpen ? 'slash' : '',
    surfaces.hasTextEntryPrompt ? `text:${surfaces.textEntryPrompt?.kind || ''}` : '',
    surfaces.inputBoxHidden ? 'input-hidden' : 'input-visible',
    rows.floatingPanelRows,
    rows.promptBoxRows,
    rows.promptMetaRows,
    rows.queuedRows,
    rows.WELCOME_ROWS,
  ].join('|');
}

export function computeRowBudgets({
  surfaces,
  hints,
  state,
  resizeState,
  frameColumns,
  textEntryLayoutRows,
  onboardingActive,
  promptLayoutValueRef,
  promptContentColumns,
  CORE_MULTILINE_TEXT_ENTRY_KINDS,
  toolApproval,
  picker,
  contextPanel,
  usagePanel,
  slashPaletteOpen,
}) {
  const { textEntryPrompt, hasTextEntryPrompt, hasFloatingPanel, expandedOptionPanel, inputBoxHidden } = surfaces;
  const { liveSpinner, liveSpinnerIsCommand, latestTranscriptItem, inputHint } = hints;
  const prompt = promptBoxBudget(inputBoxHidden, promptLayoutValueRef, promptContentColumns);
  const textEntry = textEntryBudget(
    textEntryPrompt,
    textEntryLayoutRows,
    frameColumns,
    CORE_MULTILINE_TEXT_ENTRY_KINDS
  );
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
  const overlayHintRequested = !inputBoxHidden && !hasFloatingPanel && !liveSpinner && !!inputHint && !queuedVisible;
  const queued = queuedBudget(queuedVisible, state, resizeState, frameColumns);
  const INPUT_BOX_ROWS = prompt.promptBoxRows + promptMetaRows + OVERLAY_HINT_ROWS;
  const welcome = welcomeBudget({ slashPaletteOpen, resizeState, INPUT_BOX_ROWS, state, surfaces, onboardingActive });
  const baseReserve =
    welcome.WELCOME_ROWS + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queued.queuedRows;
  const maxFloatingPanelRows = Math.max(0, resizeState.rows - baseReserve - 1);
  const panel = floatingPanelBudget({
    toolApproval,
    picker,
    contextPanel,
    usagePanel,
    slashPaletteOpen,
    hasTextEntryPrompt,
    TEXT_ENTRY_ROWS: textEntry.TEXT_ENTRY_ROWS,
    OPTION_PANEL_EXTRA_ROWS,
    maxFloatingPanelRows,
  });
  const rows = {
    floatingPanelRows: panel.floatingPanelRows,
    promptBoxRows: prompt.promptBoxRows,
    promptMetaRows,
    queuedRows: queued.queuedRows,
    WELCOME_ROWS: welcome.WELCOME_ROWS,
  };
  return {
    SCROLL_HINT_ROWS,
    LIVE_STATUS_ROWS,
    STATUSLINE_ROWS,
    PANEL_MAX_VISIBLE,
    PANEL_CHROME_ROWS,
    PANEL_BASE_ROWS,
    PICKER_CHROME_ROWS,
    WELCOME_BANNER_ROWS,
    SLASH_PALETTE_ROWS,
    ...prompt,
    ...textEntry,
    OPTION_PANEL_EXTRA_ROWS,
    queuedVisible,
    promptMetaVisible,
    promptMetaRows,
    overlayHintRequested,
    overlayHintRows: OVERLAY_HINT_ROWS,
    ...queued,
    INPUT_BOX_ROWS,
    ...welcome,
    baseReserve,
    maxFloatingPanelRows,
    ...panel,
    rawBottomReserve: baseReserve + panel.floatingPanelRows,
    bottomClusterRows: INPUT_BOX_ROWS + STATUSLINE_ROWS + queued.queuedRows + panel.floatingPanelRows,
    panelLayoutSignature: layoutSignature({
      toolApproval,
      picker,
      contextPanel,
      usagePanel,
      slashPaletteOpen,
      surfaces,
      rows,
    }),
  };
}
