//! `shell-layout/viewport.mjs`: carves the transcript viewport out of what the bottom cluster leaves (guard rows,
//! in-viewport hint bands, the one-commit panel-close mask, the content height) and mirrors the result into the refs the mouse
//! and scroll handlers read.

use super::budgets::Budgets;
use super::surfaces::{LiveHints, Surfaces};
use super::transition::Transition;
use super::{ShellLayoutInput, ShellRefs, TranscriptViewport};

/// A scroll-time extra guard row stays disabled: the widened (2-row) guard rendered as a visibly empty band between the
/// transcript and the prompt box whenever the viewport was scrolled up. The base 1-row guard stays; if the
/// scrolled-row-over-statusline overpaint resurfaces, the fix belongs in the renderer diff, not in more blank viewport rows.
const SCROLL_GUARD_ROWS: usize = 0;

/// What the carving derives.
#[derive(Clone, Debug, Default)]
pub(super) struct Carved {
    pub bottom_reserve: usize,
    pub viewport_height: usize,
    pub guard_capacity_rows: usize,
    pub base_guard_rows: usize,
    pub transcript_guard_rows: usize,
    pub welcome_prompt_hint_text: String,
    pub welcome_prompt_hint_visible: bool,
    pub welcome_prompt_hint_rows: usize,
    pub overlay_hint_band_rows: usize,
    pub panel_close_mask_rows: usize,
    pub transcript_content_height: usize,
    pub transcript_bottom_slack_rows: usize,
}

/// `carveViewport(...)`: writes the viewport refs.
pub(super) fn carve_viewport(
    input: &ShellLayoutInput,
    surfaces: &Surfaces,
    hints: &LiveHints,
    budgets: &Budgets,
    transition: &Transition,
    refs: &mut ShellRefs,
) -> Carved {
    let bottom_reserve = budgets.raw_bottom_reserve + transition.panel_transition_clear_rows;
    let viewport_height = input.rows.saturating_sub(bottom_reserve).max(1);
    // One physical row stays between the transcript clip and the bottom cluster even when pinned to the live tail: Windows
    // Terminal and conhost can still surface one clipped, off-by-one transcript row below the statusline during rapid
    // tool-card updates; a permanent guard row makes that row blank instead of a tool header or detail.
    let guard_capacity_rows = viewport_height - 1;
    let base_guard_rows = usize::from(guard_capacity_rows > 0);
    let transcript_guard_rows = guard_capacity_rows.min(base_guard_rows + transition.panel_transition_guard_rows + SCROLL_GUARD_ROWS);
    // The welcome prompt hint: a one-row band rendered inside the transcript viewport (a sibling below the content clip), so
    // it is part of the viewport row accounting. Left unaccounted, the slash palette close commit on the empty welcome
    // screen painted one extra physical row and the prompt box and statusline dipped one row and snapped back.
    let welcome_prompt_hint_text =
        if input.conditional_welcome_prompt_hint.is_empty() { input.welcome_prompt_hint.clone() } else { input.conditional_welcome_prompt_hint.clone() };
    let welcome_prompt_hint_visible = !welcome_prompt_hint_text.is_empty()
        && !input.welcome_prompt_hint_dismissed
        && input.state.item_count == 0
        && !surfaces.has_floating_panel
        && !surfaces.input_box_hidden
        && !budgets.queued_visible
        && !hints.live_spinner
        && hints.input_hint.is_empty();
    // Tiny terminals: the guard rows can already consume all but one viewport row, and the content height clamps to at least
    // one, so an unconditional hint row would paint one row too many and push the prompt and statusline down. The hint yields
    // unless at least one content row remains beside it.
    let welcome_prompt_hint_rows = usize::from(welcome_prompt_hint_visible && viewport_height - transcript_guard_rows >= 2);
    refs.welcome_prompt_hint_visible = welcome_prompt_hint_rows > 0;
    // A transient hint or error on the empty transcript: the guard row sits directly above the prompt box, so painting the
    // hint there hugs the textbox one row below where the live spinner line renders. One in-viewport row above the guard row
    // is carved instead so the hint's baseline matches the spinner row (the guard row stays blank as the spacer). The reserve
    // is untouched, so the prompt box and statusline never move. Non-empty transcripts keep the attach-to-last-item and
    // guard-row placements.
    let overlay_hint_band_rows =
        usize::from(budgets.overlay_hint_requested && input.state.item_count == 0 && viewport_height - transcript_guard_rows - welcome_prompt_hint_rows >= 2);
    // Instant panel close (slash palette): the reclaimed rows stay blank for exactly one commit. The mask is part of this
    // frame's row accounting: subtracted from the content height and rendered as a sibling band below the content clip
    // (where the closed panel's ink was). Rendering it inside the scrolled transcript column made the painted column taller
    // than the accounted viewport for one frame, so the prompt and statusline dropped a row and snapped back on the
    // mask-clear commit.
    let panel_close_mask_rows = transition
        .panel_close_ink_mask_rows
        .min((viewport_height - transcript_guard_rows).saturating_sub(welcome_prompt_hint_rows + overlay_hint_band_rows + 1));
    let transcript_content_height =
        (viewport_height - transcript_guard_rows).saturating_sub(panel_close_mask_rows + welcome_prompt_hint_rows + overlay_hint_band_rows).max(1);
    // The keyboard-selection edge step stays anchored to the base guard. It is not a follow threshold: any positive wheel
    // target is a reading position; only the true bottom may auto-follow a live tail.
    let transcript_bottom_slack_rows = base_guard_rows;
    refs.transcript_bottom_slack_rows = transcript_bottom_slack_rows;
    refs.transcript_viewport =
        Some(TranscriptViewport { top: budgets.welcome_rows, bottom: budgets.welcome_rows.max(budgets.welcome_rows + transcript_content_height - 1) });
    // The live terminal row count for the mouse handler's region routing and status-band selection clip.
    refs.frame_rows = if input.rows == 0 { 24 } else { input.rows };
    // When the prompt box is hidden (a floating or option panel owns the bottom area), its stale measured rect is dropped so
    // the mouse handler does not route presses to a prompt box that is not on screen.
    if surfaces.input_box_hidden {
        refs.prompt_box_rect = None;
    }
    Carved {
        bottom_reserve,
        viewport_height,
        guard_capacity_rows,
        base_guard_rows,
        transcript_guard_rows,
        welcome_prompt_hint_text,
        welcome_prompt_hint_visible,
        welcome_prompt_hint_rows,
        overlay_hint_band_rows,
        panel_close_mask_rows,
        transcript_content_height,
        transcript_bottom_slack_rows,
    }
}

/// The widths of the transient hint slot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HintWidths {
    pub spinner_hint_width: usize,
    pub guard_hint_width: usize,
    pub transient_status_width: usize,
    pub prompt_spinner_columns: usize,
}

/// `hintWidths(...)`: a toast or error has two mutually exclusive placements. While a live status row exists (thinking,
/// compacting, responding) it attaches to that row so the bottom cluster reserves exactly one status band; otherwise it renders
/// into the one-row gap above the prompt, replacing the blank spacer instead of reserving an extra row. Both use a fixed-width
/// right slot, not a full-width left box.
pub fn hint_widths(frame_columns: usize, input_hint: &str, live_spinner: bool) -> HintWidths {
    let hint_width = if input_hint.is_empty() {
        0
    } else {
        let share = (frame_columns as f64 * 0.42).floor() as usize;
        frame_columns.saturating_sub(4).max(1).min(share.max(12))
    };
    HintWidths {
        spinner_hint_width: hint_width,
        guard_hint_width: hint_width,
        transient_status_width: hint_width,
        prompt_spinner_columns: if live_spinner && !input_hint.is_empty() { frame_columns.saturating_sub(hint_width + 1).max(1) } else { frame_columns },
    }
}
