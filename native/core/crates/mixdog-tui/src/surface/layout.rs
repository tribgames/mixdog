//! The shell layout (`app/shell-layout.mjs` and `app/shell-layout/*.mjs`): given the terminal size and every surface that
//! reserves rows (panels, prompt box, queued band, welcome banner, hints), the transcript viewport height and the whole
//! bottom-cluster row budget.
//!
//! The transcript lives in a box with an explicit numeric height that clips off-screen rows. The rows the bottom cluster
//! needs are reserved and the transcript gets everything above them:
//!
//! ```text
//! viewportHeight = rows
//!                - welcome banner   (empty transcript only)
//!                - prompt meta      (live spinner / TurnDone band)
//!                - queued prompts   (only when queued)
//!                - input box        (2 border + wrapped content)
//!                - statusline       (reserved L1 + L2 + outer gap; 3 rows)
//! ```
//!
//! Every sibling outside the viewport is accounted for; otherwise the whole tree is taller than the terminal and the input
//! box is pushed. [`compute_shell_layout`] is the render-phase function; the few writes the Node version made to refs are the
//! fields of [`ShellRefs`].

mod budgets;
mod surfaces;
mod transition;
mod viewport;

pub use budgets::{
    LIVE_STATUS_ROWS, PANEL_BASE_ROWS, PANEL_CHROME_ROWS, PANEL_MAX_VISIBLE, PICKER_CHROME_ROWS, SCROLL_HINT_ROWS,
    SLASH_PALETTE_ROWS, STATUSLINE_ROWS, WELCOME_BANNER_ROWS, btw_panel_rows,
};
pub use transition::{CommitFollowUp, PanelTransition, commit_panel_transition, record_transcript_tail};
pub use viewport::{HintWidths, hint_widths};

use serde::Serialize;
use serde_json::Value;

use super::prompt_rows::PromptRowsCache;

/// A text-entry prompt (`providerPrompt`, `settingsPrompt`): the kind that names it and the detail block under it (the
/// manual OAuth URL).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TextEntryPrompt {
    pub kind: String,
    pub detail: String,
}

/// The picker as the layout sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PickerLayout {
    pub kind: String,
    /// The picker takes every row the terminal leaves (`fillAvailable`).
    pub fill_available: bool,
}

/// The `/btw` side-question panel as the layout sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BtwPanel {
    /// The answer has arrived (`status === 'done'`): its body is markdown. Until then it is the plain pending text.
    pub done: bool,
    pub text: String,
}

/// The last transcript item: its id and kind.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TranscriptTail {
    pub id: Option<String>,
    pub kind: String,
}

/// A queued steering command: what it shows and what it says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueuedCommand {
    pub display_text: String,
    pub text: String,
}

/// A toast or a progress hint.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct HintText {
    pub text: String,
    /// Empty when the hint has no tone of its own.
    pub tone: String,
}

/// The assistant message being streamed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamingTail {
    pub kind: String,
    pub streaming: bool,
    pub text: String,
}

/// The part of the session state the layout reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellState {
    pub item_count: usize,
    pub latest_item: Option<TranscriptTail>,
    pub queued: Vec<QueuedCommand>,
    pub spinner_active: bool,
    pub command_status_active: bool,
    pub latest_toast: Option<HintText>,
    pub progress_hint: Option<HintText>,
    pub streaming_tail: Option<StreamingTail>,
    /// The transcript view (a message selector) replaces the live transcript.
    pub transcript_view_active: bool,
}

/// What the layout is computed from.
#[derive(Clone, Debug, Default)]
pub struct ShellLayoutInput {
    pub provider_prompt: Option<TextEntryPrompt>,
    pub settings_prompt: Option<TextEntryPrompt>,
    /// The tool approval being asked, as the store holds it (a `question` approval carries its questions in `args`).
    pub tool_approval: Option<Value>,
    pub picker: Option<PickerLayout>,
    pub context_panel: bool,
    pub usage_panel: bool,
    pub btw_panel: Option<BtwPanel>,
    pub slash_palette_open: bool,
    pub tui_ready: bool,
    pub state: ShellState,
    pub rows: usize,
    pub frame_columns: usize,
    pub prompt_hint: String,
    pub prompt_hint_tone: String,
    pub text_entry_layout_rows: usize,
    pub onboarding_active: bool,
    pub conditional_welcome_prompt_hint: String,
    pub welcome_prompt_hint_dismissed: bool,
    /// `welcomePromptHintRef.current`.
    pub welcome_prompt_hint: String,
    pub panel_transition_epoch: u64,
    /// `promptLayoutValueRef.current`: the draft the prompt box reserves rows for.
    pub prompt_layout_value: String,
    pub prompt_content_columns: usize,
}

/// The measured rectangle of the prompt box (the mouse handler routes presses by it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PromptBoxRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The rows of the transcript viewport on screen (`transcriptViewportRef.current`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranscriptViewport {
    pub top: usize,
    pub bottom: usize,
}

/// The refs the layout reads and writes during a render, which the mouse and scroll handlers read afterwards.
#[derive(Clone, Debug, Default)]
pub struct ShellRefs {
    pub panel_transition: PanelTransition,
    /// `panelCloseInkMaskRowsRef.current`: the rows the next commit paints blank where a closed panel was.
    pub panel_close_ink_mask_rows: usize,
    /// `projectBootInputLatchRef.current`: the project picker was open, so the prompt does not wait for the boot.
    pub project_boot_input_latch: bool,
    pub welcome_prompt_hint_visible: bool,
    pub transcript_bottom_slack_rows: usize,
    pub transcript_viewport: Option<TranscriptViewport>,
    /// The live terminal row count for the mouse handler's region routing.
    pub frame_rows: usize,
    pub prompt_box_rect: Option<PromptBoxRect>,
    pub prompt_rows: PromptRowsCache,
}

/// Everything [`compute_shell_layout`] derives, under the names of the Node layout object.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ShellLayout {
    // Surfaces.
    pub text_entry_prompt: Option<TextEntryPrompt>,
    pub has_text_entry_prompt: bool,
    pub has_floating_panel: bool,
    pub expanded_option_panel: bool,
    pub boot_settling: bool,
    pub project_selection_active: bool,
    pub input_box_hidden: bool,
    // Live hints.
    pub live_spinner: bool,
    pub live_spinner_is_command: bool,
    pub latest_toast: Option<HintText>,
    pub toast_hint: String,
    pub progress_hint: Option<HintText>,
    pub input_hint: String,
    pub input_hint_tone: String,
    pub latest_transcript_item: Option<TranscriptTail>,
    // Row budgets.
    pub current_prompt_layout_rows: usize,
    pub prompt_input_rows: usize,
    pub prompt_box_rows: usize,
    pub text_entry_kind: String,
    pub text_entry_multiline: bool,
    pub text_entry_detail_text: String,
    pub text_entry_detail_rows: usize,
    pub text_entry_url_max_rows: usize,
    pub text_entry_content_rows: usize,
    pub text_entry_rows: usize,
    pub option_panel_extra_rows: usize,
    pub queued_visible: bool,
    pub prompt_meta_visible: bool,
    pub prompt_meta_rows: usize,
    pub overlay_hint_requested: bool,
    pub overlay_hint_rows: usize,
    pub queued_full_rows: usize,
    pub queued_row_budget: usize,
    pub queued_compact: bool,
    pub queued_rows: usize,
    pub input_box_rows: usize,
    pub slash_keeps_welcome_banner: bool,
    pub show_welcome_banner: bool,
    pub welcome_rows: usize,
    pub base_reserve: usize,
    pub max_floating_panel_rows: usize,
    pub desired_floating_panel_rows: usize,
    pub floating_panel_rows: usize,
    pub picker_visible_rows: usize,
    pub raw_bottom_reserve: usize,
    pub bottom_cluster_rows: usize,
    pub panel_layout_signature: String,
    // Panel transition.
    pub panel_layout_changed: bool,
    pub panel_transition_clear_rows: usize,
    pub panel_transition_guard_rows: usize,
    pub panel_close_ink_mask_rows: usize,
    // Viewport.
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
    // Hint widths.
    pub spinner_hint_width: usize,
    pub guard_hint_width: usize,
    pub transient_status_width: usize,
    pub prompt_spinner_columns: usize,
}

/// `computeShellLayout(input)`.
pub fn compute_shell_layout(input: &ShellLayoutInput, refs: &mut ShellRefs) -> ShellLayout {
    let surfaces = surfaces::derive_surfaces(input, refs);
    let hints = surfaces::derive_live_hints(input);
    let budgets = budgets::compute_row_budgets(input, &surfaces, &hints, &mut refs.prompt_rows);
    let transition = transition::resolve_panel_transition(input, &budgets, &hints, refs);
    let carved = viewport::carve_viewport(input, &surfaces, &hints, &budgets, &transition, refs);
    let widths = hint_widths(input.frame_columns, &hints.input_hint, hints.live_spinner);
    ShellLayout {
        text_entry_prompt: surfaces.text_entry_prompt,
        has_text_entry_prompt: surfaces.has_text_entry_prompt,
        has_floating_panel: surfaces.has_floating_panel,
        expanded_option_panel: surfaces.expanded_option_panel,
        boot_settling: surfaces.boot_settling,
        project_selection_active: surfaces.project_selection_active,
        input_box_hidden: surfaces.input_box_hidden,
        live_spinner: hints.live_spinner,
        live_spinner_is_command: hints.live_spinner_is_command,
        latest_toast: hints.latest_toast,
        toast_hint: hints.toast_hint,
        progress_hint: hints.progress_hint,
        input_hint: hints.input_hint,
        input_hint_tone: hints.input_hint_tone,
        latest_transcript_item: hints.latest_transcript_item,
        current_prompt_layout_rows: budgets.current_prompt_layout_rows,
        prompt_input_rows: budgets.prompt_input_rows,
        prompt_box_rows: budgets.prompt_box_rows,
        text_entry_kind: budgets.text_entry_kind,
        text_entry_multiline: budgets.text_entry_multiline,
        text_entry_detail_text: budgets.text_entry_detail_text,
        text_entry_detail_rows: budgets.text_entry_detail_rows,
        text_entry_url_max_rows: budgets.text_entry_url_max_rows,
        text_entry_content_rows: budgets.text_entry_content_rows,
        text_entry_rows: budgets.text_entry_rows,
        option_panel_extra_rows: budgets.option_panel_extra_rows,
        queued_visible: budgets.queued_visible,
        prompt_meta_visible: budgets.prompt_meta_visible,
        prompt_meta_rows: budgets.prompt_meta_rows,
        overlay_hint_requested: budgets.overlay_hint_requested,
        overlay_hint_rows: budgets.overlay_hint_rows,
        queued_full_rows: budgets.queued_full_rows,
        queued_row_budget: budgets.queued_row_budget,
        queued_compact: budgets.queued_compact,
        queued_rows: budgets.queued_rows,
        input_box_rows: budgets.input_box_rows,
        slash_keeps_welcome_banner: budgets.slash_keeps_welcome_banner,
        show_welcome_banner: budgets.show_welcome_banner,
        welcome_rows: budgets.welcome_rows,
        base_reserve: budgets.base_reserve,
        max_floating_panel_rows: budgets.max_floating_panel_rows,
        desired_floating_panel_rows: budgets.desired_floating_panel_rows,
        floating_panel_rows: budgets.floating_panel_rows,
        picker_visible_rows: budgets.picker_visible_rows,
        raw_bottom_reserve: budgets.raw_bottom_reserve,
        bottom_cluster_rows: budgets.bottom_cluster_rows,
        panel_layout_signature: budgets.panel_layout_signature,
        panel_layout_changed: transition.panel_layout_changed,
        panel_transition_clear_rows: transition.panel_transition_clear_rows,
        panel_transition_guard_rows: transition.panel_transition_guard_rows,
        panel_close_ink_mask_rows: transition.panel_close_ink_mask_rows,
        bottom_reserve: carved.bottom_reserve,
        viewport_height: carved.viewport_height,
        guard_capacity_rows: carved.guard_capacity_rows,
        base_guard_rows: carved.base_guard_rows,
        transcript_guard_rows: carved.transcript_guard_rows,
        welcome_prompt_hint_text: carved.welcome_prompt_hint_text,
        welcome_prompt_hint_visible: carved.welcome_prompt_hint_visible,
        welcome_prompt_hint_rows: carved.welcome_prompt_hint_rows,
        overlay_hint_band_rows: carved.overlay_hint_band_rows,
        panel_close_mask_rows: carved.panel_close_mask_rows,
        transcript_content_height: carved.transcript_content_height,
        transcript_bottom_slack_rows: carved.transcript_bottom_slack_rows,
        spinner_hint_width: widths.spinner_hint_width,
        guard_hint_width: widths.guard_hint_width,
        transient_status_width: widths.transient_status_width,
        prompt_spinner_columns: widths.prompt_spinner_columns,
    }
}
