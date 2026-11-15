//! `shell-layout/panel-transition.mjs` and `app/use-panel-transition.mjs`: one-commit handling of a bottom-cluster layout
//! change (which reclaimed rows get masked blank, which borrow a transitional guard row, and the transition record the next
//! commit reads back) and the bookkeeping after every layout commit.

use super::budgets::Budgets;
use super::surfaces::LiveHints;
use super::{ShellLayoutInput, ShellRefs, TranscriptTail};
use crate::surface::signature::{
    is_instant_panel_close_transition, panel_kind_signature, panel_signature_flags, signature_rows, token,
};

/// `panelTransitionRef.current`: what the next render diffs against.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PanelTransition {
    pub signature: String,
    /// The bottom cluster rows of the last commit.
    pub reserve: usize,
    pub clear_rows: usize,
    pub guard_rows: usize,
    pub epoch: u64,
    /// The id of the transcript tail after the last commit.
    pub tail_id: Option<String>,
}

/// What the transition of this render says.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Transition {
    pub panel_layout_changed: bool,
    pub panel_transition_clear_rows: usize,
    pub panel_transition_guard_rows: usize,
    pub panel_close_ink_mask_rows: usize,
}

/// `isCompletedTranscriptTailAppendedThisCommit(latest, previousTailId)`: the tail is a done row that was not the tail of
/// the last commit.
fn completed_tail_appended_this_commit(latest: Option<&TranscriptTail>, previous_tail_id: Option<&str>) -> bool {
    latest.is_some_and(|item| (item.kind == "turndone" || item.kind == "statusdone") && item.id.as_deref() != previous_tail_id)
}

/// Rows the same commit already backfills, so masking them blank for one commit would only bounce the transcript:
/// - Turn-end spinner meta collapse: the 2-row live-spinner band disappears in the same commit the engine appends the
///   turndone or statusdone tail. The done row must have been appended in this commit (the tail id changed): a command
///   spinner can leave a stale done row at the tail and then clear without appending statusdone (`/recall`), collapsing the
///   meta band with no backfill.
/// - Queued-band promotion: draining removes the queued band and appends the promoted user transcript row in the same
///   commit. Queue edits and removals without a tail append keep the mask.
fn same_commit_backfill_rows(prev_signature: &str, next_signature: &str, latest: Option<&TranscriptTail>, previous_tail_id: Option<&str>) -> usize {
    let spinner_meta_collapse_rows = if completed_tail_appended_this_commit(latest, previous_tail_id) {
        signature_rows(prev_signature, token::PROMPT_META).saturating_sub(signature_rows(next_signature, token::PROMPT_META))
    } else {
        0
    };
    let user_tail_appended = latest.is_some_and(|item| item.kind == "user" && item.id.as_deref() != previous_tail_id);
    let queued_promote_collapse_rows = if user_tail_appended {
        signature_rows(prev_signature, token::QUEUED).saturating_sub(signature_rows(next_signature, token::QUEUED))
    } else {
        0
    };
    spinner_meta_collapse_rows + queued_promote_collapse_rows
}

/// `resolvePanelTransition(...)`: reads and records the transition and the ink mask in `refs`.
pub(super) fn resolve_panel_transition(input: &ShellLayoutInput, budgets: &Budgets, hints: &LiveHints, refs: &mut ShellRefs) -> Transition {
    let signature = budgets.panel_layout_signature.as_str();
    let transition = &mut refs.panel_transition;
    let panel_layout_changed = !transition.signature.is_empty() && transition.signature != signature;
    let mut clear_rows = 0;
    let mut guard_rows = 0;
    if panel_layout_changed {
        let shrink_rows = transition.reserve.saturating_sub(budgets.bottom_cluster_rows);
        let initial_project_entry_close = input.state.item_count == 0;
        // Prompt-row-only churn (promptBoxRows, promptMetaRows or queuedRows shifting while no panel opened, closed or
        // changed kind and floatingPanelRows itself is unchanged) must not fall into the clearRows and timer recommit
        // path: that inserts a full extra blank row for one commit, which is the newline add and remove jolt while typing.
        // A shrink goes through the same one-commit ink mask as an instant panel close so the stale row is masked in the
        // very commit it disappears; growth needs no clearance (the shrink is 0 then).
        let prompt_rows_only_change = shrink_rows > 0 && panel_kind_signature(&transition.signature) == panel_kind_signature(signature);
        let instant_panel_close = shrink_rows > 0
            && (prompt_rows_only_change || is_instant_panel_close_transition(&transition.signature, signature, initial_project_entry_close));
        // The slash palette opening on the empty welcome screen: the reserve already grows to its final size in this same
        // commit, but the renderer can still overpaint the just-vacated transcript row for one commit. One transitional
        // guard row is borrowed for exactly one commit; it only carves a blank row out of the transcript content height.
        let slash_open_on_empty_transcript = initial_project_entry_close
            && !panel_signature_flags(&transition.signature).slash
            && panel_signature_flags(signature).slash;
        if instant_panel_close {
            // Slash palette and initial project-entry closes land on the final bottom reserve in one commit. The reclaimed
            // rows are a blank mask band below the transcript clip instead of inflating the reserve and reclaiming on the
            // next tick, minus the rows this same commit already backfills.
            let backfilled = same_commit_backfill_rows(&transition.signature, signature, hints.latest_transcript_item.as_ref(), transition.tail_id.as_deref());
            refs.panel_close_ink_mask_rows = shrink_rows.saturating_sub(backfilled);
            transition.clear_rows = 0;
            transition.guard_rows = 0;
        } else if slash_open_on_empty_transcript {
            guard_rows = 1;
            transition.clear_rows = 0;
            transition.guard_rows = 1;
        } else {
            // Tall panel closes must land on the final bottom reserve in the same commit. Inflating the reserve with
            // temporary clearance makes the transcript and prompt area move once, then snap back on the timer commit. The
            // reclaimed rows stay inside the fixed viewport as a blank one-frame mask, as in the instant close above.
            refs.panel_close_ink_mask_rows = shrink_rows;
            transition.clear_rows = 0;
            transition.guard_rows = 0;
        }
        transition.epoch = input.panel_transition_epoch;
    } else if transition.epoch == input.panel_transition_epoch {
        clear_rows = transition.clear_rows;
        guard_rows = transition.guard_rows;
    }
    if budgets.desired_floating_panel_rows > 0 {
        refs.panel_close_ink_mask_rows = 0;
    }
    Transition {
        panel_layout_changed,
        panel_transition_clear_rows: clear_rows,
        panel_transition_guard_rows: guard_rows,
        panel_close_ink_mask_rows: if budgets.desired_floating_panel_rows > 0 { 0 } else { refs.panel_close_ink_mask_rows },
    }
}

/// What the app has to do after a layout commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitFollowUp {
    /// Nothing is pending.
    None,
    /// A close mask was painted in this commit: bump the ink mask epoch so the next render clears it.
    BumpInkMaskEpoch,
    /// A transition clearance was carried by this commit: bump the transition epoch on the next tick (a zero-delay timer
    /// the caller cancels if another commit comes first) to release it.
    BumpTransitionEpochNextTick,
}

/// `usePanelTransition`'s first effect: after every layout commit, records the signature and reserve the next render diffs
/// against, then says which follow-up epoch bump releases the transition clearance (or the ink close mask).
pub fn commit_panel_transition(
    refs: &mut ShellRefs,
    panel_layout_signature: &str,
    bottom_cluster_rows: usize,
    panel_transition_clear_rows: usize,
    panel_transition_guard_rows: usize,
) -> CommitFollowUp {
    let had_transition_clearance = panel_transition_clear_rows > 0 || panel_transition_guard_rows > 0;
    let transition = &mut refs.panel_transition;
    transition.signature = panel_layout_signature.to_owned();
    transition.reserve = bottom_cluster_rows;
    transition.clear_rows = 0;
    transition.guard_rows = 0;
    if refs.panel_close_ink_mask_rows > 0 {
        refs.panel_close_ink_mask_rows = 0;
        return CommitFollowUp::BumpInkMaskEpoch;
    }
    if had_transition_clearance { CommitFollowUp::BumpTransitionEpochNextTick } else { CommitFollowUp::None }
}

/// `usePanelTransition`'s second effect, after every commit: records the transcript tail id so the next render's spinner
/// meta collapse gate can tell a freshly appended done row from a stale one that was already at the tail.
pub fn record_transcript_tail(refs: &mut ShellRefs, latest_item_id: Option<&str>) {
    refs.panel_transition.tail_id = latest_item_id.map(str::to_owned);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_commit_records_the_signature_and_the_reserve() {
        let mut refs = ShellRefs::default();
        let follow_up = commit_panel_transition(&mut refs, "||||||input-visible|0|3|0|0|0", 6, 0, 0);
        assert_eq!(follow_up, CommitFollowUp::None);
        assert_eq!(refs.panel_transition.signature, "||||||input-visible|0|3|0|0|0");
        assert_eq!(refs.panel_transition.reserve, 6);
    }

    #[test]
    fn a_pending_ink_mask_is_cleared_and_bumps_the_ink_mask_epoch() {
        let mut refs = ShellRefs { panel_close_ink_mask_rows: 4, ..ShellRefs::default() };
        refs.panel_transition.clear_rows = 2;
        assert_eq!(commit_panel_transition(&mut refs, "s", 1, 1, 0), CommitFollowUp::BumpInkMaskEpoch);
        assert_eq!(refs.panel_close_ink_mask_rows, 0);
        assert_eq!(refs.panel_transition.clear_rows, 0);
    }

    #[test]
    fn a_carried_clearance_releases_on_the_next_tick() {
        let mut refs = ShellRefs::default();
        assert_eq!(commit_panel_transition(&mut refs, "s", 1, 0, 1), CommitFollowUp::BumpTransitionEpochNextTick);
        assert_eq!(refs.panel_transition.guard_rows, 0);
        assert_eq!(commit_panel_transition(&mut refs, "s", 1, 2, 0), CommitFollowUp::BumpTransitionEpochNextTick);
    }

    #[test]
    fn the_tail_id_is_recorded_after_a_commit() {
        let mut refs = ShellRefs::default();
        record_transcript_tail(&mut refs, Some("d1"));
        assert_eq!(refs.panel_transition.tail_id.as_deref(), Some("d1"));
        record_transcript_tail(&mut refs, None);
        assert_eq!(refs.panel_transition.tail_id, None);
    }

    #[test]
    fn only_a_done_row_appended_in_this_commit_backfills() {
        let done = TranscriptTail { id: Some("d1".into()), kind: "turndone".into() };
        assert!(completed_tail_appended_this_commit(Some(&done), Some("u1")));
        assert!(completed_tail_appended_this_commit(Some(&done), None));
        assert!(!completed_tail_appended_this_commit(Some(&done), Some("d1")), "a stale done row at the tail");
        assert!(!completed_tail_appended_this_commit(Some(&TranscriptTail { id: Some("u2".into()), kind: "user".into() }), Some("u1")));
        assert!(!completed_tail_appended_this_commit(None, None));
    }

    #[test]
    fn a_promoted_user_row_backfills_the_queued_band_it_replaces() {
        let user = TranscriptTail { id: Some("u2".into()), kind: "user".into() };
        let prev = "||||||input-visible|0|3|0|2|0";
        let next = "||||||input-visible|0|3|2|0|0";
        assert_eq!(same_commit_backfill_rows(prev, next, Some(&user), Some("u1")), 2);
        assert_eq!(same_commit_backfill_rows(prev, next, Some(&user), Some("u2")), 0, "no tail append keeps the mask");
    }
}
