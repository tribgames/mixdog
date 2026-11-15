//! `shell-layout/row-budgets.mjs`: the rows every bottom-cluster surface reserves this render (prompt box, live meta band,
//! queued band, welcome banner, floating panel) and the layout signature that names them. Also the two predicates the
//! budgets need from other modules of the Node app: the live spinner meta visibility (`live-spinner-visibility.mjs`) and the
//! `/btw` panel height (`btw-controller.mjs`).

use mixdog_js::js_trim;
use mixdog_markdown_ansi::measure::measure_markdown_rendered_rows;
use mixdog_tui_widgets::question::{question_panel_rows, questions_of};
use mixdog_tui_widgets::sign_in_url::sign_in_url_layout;
use mixdog_tui_widgets::spinner::{SpinnerVisibility, is_live_spinner_meta_visible};

use super::surfaces::{LiveHints, Surfaces};
use super::{BtwPanel, ShellLayoutInput};
use crate::surface::prompt_rows::{PromptRowsCache, queued_band_rows};
use crate::surface::signature::CORE_MULTILINE_TEXT_ENTRY_KINDS;

pub const SCROLL_HINT_ROWS: usize = 0;
pub const LIVE_STATUS_ROWS: usize = 0;
/// The statusline: reserved L1 + L2 + outer gap.
pub const STATUSLINE_ROWS: usize = 3;
/// Every floating panel follows the same vertical rhythm inside its round border: title row, blank, description or hint row,
/// blank, then content. That is 4 non-content rows; the border adds 2 more, so the chrome reserves 6 rows (even for panels
/// that omit the description), which guarantees the bordered title is never clipped off the top: content rows shrink first
/// when the terminal is short, because the floating container clips from the top.
pub const PANEL_MAX_VISIBLE: usize = 8;
pub const PANEL_CHROME_ROWS: usize = 6;
pub const PANEL_BASE_ROWS: usize = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
pub const PICKER_CHROME_ROWS: usize = PANEL_CHROME_ROWS;
pub const WELCOME_BANNER_ROWS: usize = 11;
pub const SLASH_PALETTE_ROWS: usize = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
/// Toast or error text without a live spinner uses the transcript guard row directly above the prompt. Another row is not
/// reserved: that made a transient hint add a visible newline and prompt jump whenever no spinner was active.
const OVERLAY_HINT_ROWS: usize = 0;
/// The `/btw` panel: border (2) + header (1) + footer (1), and at most this many rows of body.
const BTW_CHROME_ROWS: usize = 4;
const BTW_MAX_BODY_ROWS: usize = 10;

/// `btwContentRows(panel, columns)`: the rows of the answer body (the scrollable content height).
fn btw_content_rows(panel: &BtwPanel, columns: usize) -> usize {
    let body = if panel.done {
        measure_markdown_rendered_rows(&panel.text, columns.saturating_sub(4).max(1), false)
    } else {
        panel.text.split('\n').count()
    };
    body.max(1)
}

/// `btwPanelRows(panel, columns)`: the floating rows of the `/btw` panel.
pub fn btw_panel_rows(panel: &BtwPanel, columns: usize) -> usize {
    BTW_CHROME_ROWS + BTW_MAX_BODY_ROWS.min(btw_content_rows(panel, columns))
}

/// The row budgets of one render, under the names of the Node object.
#[derive(Clone, Debug, Default)]
pub(super) struct Budgets {
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
}

/// The standalone prompt box is 2 border rows plus the wrapped prompt body. It tracks the draft's real wrapped height:
/// reserving a constant one-line prompt lets long or multiline input grow the bottom cluster after the transcript viewport
/// claimed those rows, and transcript text would overprint the textbox or the slash window.
struct PromptBudget {
    current_prompt_layout_rows: usize,
    prompt_input_rows: usize,
    prompt_box_rows: usize,
}

fn prompt_box_budget(input_box_hidden: bool, value: &str, columns: usize, cache: &mut PromptRowsCache) -> PromptBudget {
    let current_prompt_layout_rows = cache.content_rows(value, columns);
    let prompt_input_rows = if input_box_hidden { 0 } else { current_prompt_layout_rows };
    PromptBudget { current_prompt_layout_rows, prompt_input_rows, prompt_box_rows: if input_box_hidden { 0 } else { 2 + prompt_input_rows } }
}

/// The text-entry panel's content is one prompt line (chrome + 1) for single-line prompts, or up to `PANEL_MAX_VISIBLE`
/// wrapped rows for core memory add and edit, plus an optional borderless sign-in URL block under the panel (the manual
/// OAuth URL). The floating container clips from the top, so under-reserving pushed the bordered title off the panel. The
/// block gets only the rows the terminal leaves.
struct TextEntryBudget {
    kind: String,
    multiline: bool,
    detail_text: String,
    detail_rows: usize,
    url_max_rows: usize,
    content_rows: usize,
    rows: usize,
}

fn text_entry_budget(input: &ShellLayoutInput, surfaces: &Surfaces, max_floating_panel_rows: usize) -> TextEntryBudget {
    let prompt = surfaces.text_entry_prompt.as_ref();
    let kind = prompt.map(|prompt| prompt.kind.clone()).unwrap_or_default();
    let multiline = CORE_MULTILINE_TEXT_ENTRY_KINDS.contains(&kind.as_str());
    let detail_text = prompt.map(|prompt| js_trim(&prompt.detail).to_owned()).unwrap_or_default();
    let content_rows = if multiline { input.text_entry_layout_rows } else { 1 };
    let url_max_rows = max_floating_panel_rows.saturating_sub(PANEL_CHROME_ROWS + content_rows);
    let detail_rows = sign_in_url_layout(&detail_text, input.frame_columns, url_max_rows as i64).rows;
    TextEntryBudget { kind, multiline, detail_text, detail_rows, url_max_rows, content_rows, rows: PANEL_CHROME_ROWS + content_rows + detail_rows }
}

/// Every queued command renders at its full wrapped height (the content width the promoted transcript user row wraps at),
/// pinned above the prompt box with no extra top margin. Reserving the true height keeps a promotion from re-expanding the
/// text mid-flight. If the whole queue would eat too much of the frame, it falls back to one compact row per entry so the
/// input box never leaves the screen.
struct QueuedBudget {
    full_rows: usize,
    row_budget: usize,
    compact: bool,
    rows: usize,
}

fn queued_budget(visible: bool, input: &ShellLayoutInput) -> QueuedBudget {
    let queued = &input.state.queued;
    let width = input.frame_columns.saturating_sub(4).max(1);
    let full_rows = if visible {
        queued
            .iter()
            .map(|item| {
                let text = if item.display_text.is_empty() { &item.text } else { &item.display_text };
                queued_band_rows(text, width)
            })
            .sum()
    } else {
        0
    };
    let row_budget = (input.rows / 3).max(3);
    let compact = full_rows > row_budget;
    let rows = if !visible {
        0
    } else if compact {
        queued.len()
    } else {
        full_rows
    };
    QueuedBudget { full_rows, row_budget, compact, rows }
}

/// Welcome banner visibility, computed after the prompt and panel row math it depends on. The slash palette must not unmount
/// the banner on the empty transcript: dropping the 11-row banner the moment `/` opened the palette (and remounting it on
/// Esc) read as the whole top of the screen jumping on command-palette entry. The banner stays mounted through a slash
/// session whenever the terminal is tall enough to hold banner, palette, prompt and statusline at once; short terminals yield
/// the banner so the palette chrome never clips.
struct WelcomeBudget {
    slash_keeps_banner: bool,
    show_banner: bool,
    rows: usize,
}

fn welcome_budget(input: &ShellLayoutInput, input_box_rows: usize, surfaces: &Surfaces) -> WelcomeBudget {
    let slash_keeps_banner =
        input.slash_palette_open && input.rows >= WELCOME_BANNER_ROWS + SLASH_PALETTE_ROWS + input_box_rows + STATUSLINE_ROWS + 1;
    let show_banner = (input.state.item_count == 0 && (!surfaces.has_floating_panel || slash_keeps_banner))
        || surfaces.project_selection_active
        || input.onboarding_active;
    WelcomeBudget { slash_keeps_banner, show_banner, rows: if show_banner { WELCOME_BANNER_ROWS } else { 0 } }
}

struct PanelBudget {
    desired: usize,
    floating: usize,
    picker_visible_rows: usize,
}

fn floating_panel_budget(input: &ShellLayoutInput, text_entry_rows: usize, option_panel_extra_rows: usize, max_floating_panel_rows: usize) -> PanelBudget {
    let questions = input
        .tool_approval
        .as_ref()
        .filter(|approval| approval.get("kind").and_then(|kind| kind.as_str()) == Some("question"))
        .map(questions_of)
        .filter(|questions| !questions.is_empty());
    let desired = if let Some(questions) = questions {
        question_panel_rows(&questions, input.frame_columns)
    } else if input.tool_approval.is_some() {
        PANEL_CHROME_ROWS + 2 + option_panel_extra_rows
    } else if input.picker.as_ref().is_some_and(|picker| picker.fill_available) {
        max_floating_panel_rows
    } else if input.picker.is_some() {
        PANEL_BASE_ROWS + option_panel_extra_rows
    } else if input.context_panel {
        PANEL_BASE_ROWS + option_panel_extra_rows + 3
    } else if input.usage_panel {
        PANEL_BASE_ROWS + option_panel_extra_rows
    } else if input.slash_palette_open {
        SLASH_PALETTE_ROWS
    } else if input.provider_prompt.is_some() || input.settings_prompt.is_some() {
        text_entry_rows
    } else if let Some(btw) = &input.btw_panel {
        btw_panel_rows(btw, input.frame_columns)
    } else {
        0
    };
    let floating = if desired > 0 { desired.min(max_floating_panel_rows) } else { 0 };
    // The list gets every content row the panel exposes. The panel already grew by the option panel extra rows; subtracting
    // that growth back out would leak the rows into an empty gap instead of the list. Reserving only the picker chrome lets
    // the list occupy the full interior (the footer's own reservation is handled inside the picker).
    let picker_visible_rows = if input.picker.is_some() { floating.saturating_sub(PICKER_CHROME_ROWS).max(1) } else { PANEL_MAX_VISIBLE };
    PanelBudget { desired, floating, picker_visible_rows }
}

/// The signature token order: `[tool, picker, context, usage, slash, text, inputBoxHidden, floatingPanelRows,
/// promptBoxRows, promptMetaRows, queuedRows, WELCOME_ROWS]`, read by `signature.rs`.
fn layout_signature(input: &ShellLayoutInput, surfaces: &Surfaces, rows: [usize; 5]) -> String {
    let picker = input
        .picker
        .as_ref()
        .map(|picker| format!("picker:{}:{}", picker.kind, if picker.fill_available { "fill" } else { "fit" }))
        .unwrap_or_default();
    let text = surfaces.text_entry_prompt.as_ref().map(|prompt| format!("text:{}", prompt.kind)).unwrap_or_default();
    let tokens = [
        if input.tool_approval.is_some() { "tool".to_owned() } else { String::new() },
        picker,
        if input.context_panel { "context".to_owned() } else { String::new() },
        if input.usage_panel { "usage".to_owned() } else { String::new() },
        if input.slash_palette_open { "slash".to_owned() } else { String::new() },
        text,
        (if surfaces.input_box_hidden { "input-hidden" } else { "input-visible" }).to_owned(),
    ];
    let mut parts: Vec<String> = tokens.into_iter().collect();
    parts.extend(rows.iter().map(usize::to_string));
    parts.join("|")
}

/// `computeRowBudgets(...)`.
pub(super) fn compute_row_budgets(input: &ShellLayoutInput, surfaces: &Surfaces, hints: &LiveHints, cache: &mut PromptRowsCache) -> Budgets {
    let state = &input.state;
    let prompt = prompt_box_budget(surfaces.input_box_hidden, &input.prompt_layout_value, input.prompt_content_columns, cache);
    let option_panel_extra_rows = if surfaces.expanded_option_panel { 3 } else { 0 };
    let queued_visible = !surfaces.has_floating_panel && !surfaces.input_box_hidden && !state.queued.is_empty();
    // While the slash palette is open it owns the area above the prompt, so the live spinner and meta row are suppressed
    // entirely: no reservation and no render.
    let prompt_meta_visible = is_live_spinner_meta_visible(&SpinnerVisibility {
        input_box_hidden: surfaces.input_box_hidden,
        slash_palette_open: input.slash_palette_open,
        live_spinner: hints.live_spinner,
        live_spinner_is_command: hints.live_spinner_is_command,
        latest_transcript_item: hints
            .latest_transcript_item
            .as_ref()
            .map(|item| mixdog_tui_widgets::spinner::TranscriptTail { kind: &item.kind, id: item.id.as_deref() }),
        streaming_tail: state
            .streaming_tail
            .as_ref()
            .map(|tail| mixdog_tui_widgets::spinner::StreamingTail { kind: &tail.kind, streaming: tail.streaming, text: &tail.text }),
        transcript_view_active: state.transcript_view_active,
    });
    let prompt_meta_rows = if prompt_meta_visible { 2 } else { 0 };
    let overlay_hint_requested =
        !surfaces.input_box_hidden && !surfaces.has_floating_panel && !hints.live_spinner && !hints.input_hint.is_empty() && !queued_visible;
    let queued = queued_budget(queued_visible, input);
    let input_box_rows = prompt.prompt_box_rows + prompt_meta_rows + OVERLAY_HINT_ROWS;
    let welcome = welcome_budget(input, input_box_rows, surfaces);
    let base_reserve = welcome.rows + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + input_box_rows + STATUSLINE_ROWS + queued.rows;
    let max_floating_panel_rows = input.rows.saturating_sub(base_reserve + 1);
    let text_entry = text_entry_budget(input, surfaces, max_floating_panel_rows);
    let panel = floating_panel_budget(input, text_entry.rows, option_panel_extra_rows, max_floating_panel_rows);
    let panel_layout_signature =
        layout_signature(input, surfaces, [panel.floating, prompt.prompt_box_rows, prompt_meta_rows, queued.rows, welcome.rows]);
    Budgets {
        current_prompt_layout_rows: prompt.current_prompt_layout_rows,
        prompt_input_rows: prompt.prompt_input_rows,
        prompt_box_rows: prompt.prompt_box_rows,
        text_entry_kind: text_entry.kind,
        text_entry_multiline: text_entry.multiline,
        text_entry_detail_text: text_entry.detail_text,
        text_entry_detail_rows: text_entry.detail_rows,
        text_entry_url_max_rows: text_entry.url_max_rows,
        text_entry_content_rows: text_entry.content_rows,
        text_entry_rows: text_entry.rows,
        option_panel_extra_rows,
        queued_visible,
        prompt_meta_visible,
        prompt_meta_rows,
        overlay_hint_requested,
        overlay_hint_rows: OVERLAY_HINT_ROWS,
        queued_full_rows: queued.full_rows,
        queued_row_budget: queued.row_budget,
        queued_compact: queued.compact,
        queued_rows: queued.rows,
        input_box_rows,
        slash_keeps_welcome_banner: welcome.slash_keeps_banner,
        show_welcome_banner: welcome.show_banner,
        welcome_rows: welcome.rows,
        base_reserve,
        max_floating_panel_rows,
        desired_floating_panel_rows: panel.desired,
        floating_panel_rows: panel.floating,
        picker_visible_rows: panel.picker_visible_rows,
        raw_bottom_reserve: base_reserve + panel.floating,
        bottom_cluster_rows: input_box_rows + STATUSLINE_ROWS + queued.rows + panel.floating,
        panel_layout_signature,
    }
}
