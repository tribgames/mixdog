/**
 * src/tui/app/shell-layout/panel-transition.mjs - one-commit handling of a
 * bottom-cluster layout change: which reclaimed rows get masked blank, which
 * borrow a transitional guard row, and the transition record the next commit
 * reads back.
 */
import { isCompletedTranscriptTailAppendedThisCommit } from '../live-spinner-visibility.mjs';

function signatureRows(signature, index) {
  return Number(String(signature).split('|')[index]) || 0;
}

// Rows the same commit already backfills, so masking them blank for one
// commit would only bounce the transcript:
// - Turn-end spinner meta collapse: the 2-row live-spinner band disappears in
//   the SAME commit the engine appends the turndone/statusdone tail (engine.mjs
//   runTurn — turndone + spinner:null land in one set()). Require the done row
//   to have been appended in THIS commit (tail id changed): a command spinner
//   can leave a STALE done row at the tail and then clear without appending
//   statusdone (e.g. /recall), collapsing the meta band with NO backfill.
// - Queued-band promotion: drain() removes the queued band and appends the
//   promoted user transcript row in the SAME commit (session-flow drain →
//   pushUserOrSyntheticItem → runTurn spinner, one microtask flush). Queue
//   edits/removals without a tail append keep the mask.
function sameCommitBackfillRows({
  prevSignature,
  nextSignature,
  latestTranscriptItem,
  previousTailId,
  PANEL_LAYOUT_SIG,
}) {
  const doneTailAppendedThisCommit = isCompletedTranscriptTailAppendedThisCommit(latestTranscriptItem, previousTailId);
  const spinnerMetaCollapseRows = doneTailAppendedThisCommit
    ? Math.max(
        0,
        signatureRows(prevSignature, PANEL_LAYOUT_SIG.PROMPT_META) -
          signatureRows(nextSignature, PANEL_LAYOUT_SIG.PROMPT_META)
      )
    : 0;
  const userTailAppendedThisCommit =
    latestTranscriptItem?.kind === 'user' && (latestTranscriptItem?.id ?? null) !== previousTailId;
  const queuedPromoteCollapseRows = userTailAppendedThisCommit
    ? Math.max(
        0,
        signatureRows(prevSignature, PANEL_LAYOUT_SIG.QUEUED) - signatureRows(nextSignature, PANEL_LAYOUT_SIG.QUEUED)
      )
    : 0;
  return spinnerMetaCollapseRows + queuedPromoteCollapseRows;
}

export function resolvePanelTransition({
  budgets,
  hints,
  state,
  panelTransitionEpoch,
  panelTransitionRef,
  panelCloseInkMaskRowsRef,
  panelSignatureFlags,
  panelKindSignature,
  isInstantPanelCloseTransition,
  PANEL_LAYOUT_SIG,
}) {
  const { panelLayoutSignature, bottomClusterRows, desiredFloatingPanelRows } = budgets;
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
    // + setTimeout recommit path: that inserts a full extra blank row for one
    // commit, which IS the newline-add/remove jolt while typing. Route a shrink
    // through the same one-commit ink-mask path as an instant panel close so
    // the stale row is masked in the very commit it disappears; growth needs
    // no clearance (panelShrinkRows is 0 in that case).
    const promptRowsOnlyChange =
      panelShrinkRows > 0 && panelKindSignature(panelTransition.signature) === panelKindSignature(panelLayoutSignature);
    const instantPanelClose =
      panelShrinkRows > 0 &&
      (promptRowsOnlyChange ||
        isInstantPanelCloseTransition(panelTransition.signature, panelLayoutSignature, initialProjectEntryClose));
    // Slash palette opening on the empty welcome screen: bottomReserve already
    // grows to its final size in this same commit (floatingPanelRows reflects
    // slashPaletteOpen immediately, no clearRows needed), but the renderer can
    // still overpaint the just-vacated transcript row for one commit. Borrow
    // the transitional guard-row mechanism for exactly one commit on the open
    // transition itself — this only carves an extra blank row out of
    // transcriptContentHeight, it does not touch bottomReserve/floatingPanelRows.
    const slashOpenOnEmptyTranscript =
      initialProjectEntryClose &&
      !panelSignatureFlags(panelTransition.signature).slash &&
      panelSignatureFlags(panelLayoutSignature).slash;
    if (instantPanelClose) {
      // Slash palette and initial project-entry closes land on the final bottom
      // reserve in one commit. Paint reclaimed rows as a blank mask band below
      // the transcript clip instead of inflating bottomReserve + reclaiming on
      // the next tick, minus the rows this same commit already backfills.
      const backfilled = sameCommitBackfillRows({
        prevSignature: panelTransition.signature,
        nextSignature: panelLayoutSignature,
        latestTranscriptItem: hints.latestTranscriptItem,
        previousTailId: panelTransition.tailId,
        PANEL_LAYOUT_SIG,
      });
      panelCloseInkMaskRowsRef.current = Math.max(0, panelShrinkRows - backfilled);
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
    } else if (slashOpenOnEmptyTranscript) {
      panelTransitionGuardRows = 1;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 1;
    } else {
      // Tall panel closes must land on the final bottom reserve in the same
      // commit. Inflating bottomReserve with temporary clearance makes the
      // transcript/prompt area move once, then snap back on the timer commit.
      // Instead, keep the reclaimed rows inside the fixed viewport as a blank
      // one-frame mask, matching the instant-close path above.
      panelCloseInkMaskRowsRef.current = panelShrinkRows;
      panelTransition.clearRows = 0;
      panelTransition.guardRows = 0;
    }
    panelTransition.epoch = panelTransitionEpoch;
  } else if (panelTransition.epoch === panelTransitionEpoch) {
    panelTransitionClearRows = panelTransition.clearRows || 0;
    panelTransitionGuardRows = panelTransition.guardRows || 0;
  }
  if (desiredFloatingPanelRows > 0) {
    panelCloseInkMaskRowsRef.current = 0;
  }
  return {
    panelTransition,
    panelLayoutChanged,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    panelCloseInkMaskRows: desiredFloatingPanelRows > 0 ? 0 : panelCloseInkMaskRowsRef.current,
  };
}
