use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use mixdog_term::frame::Rect;
use mixdog_term::paint::Painter;
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::palette::{PaletteProps, SlashCommand, paint_palette};
use mixdog_tui_widgets::panels::btw_panel::{BtwPanelProps, BtwPanelState, paint_btw_panel};
use mixdog_tui_widgets::panels::context_panel::{ContextPanelProps, ContextPanelState, paint_context_panel};
use mixdog_tui_widgets::panels::usage_panel::{UsagePanelProps, UsagePanelState, paint_usage_panel};
use mixdog_tui_widgets::picker::{IndexMode, PickerItem, PickerProps, paint_picker};
use mixdog_tui_widgets::question::{QuestionState, paint_question, questions_of};
use mixdog_tui_widgets::sign_in_url::{CopyStatus, sign_in_url_layout};
use mixdog_tui_widgets::text_entry::{TextEntryDraft, TextEntryProps, paint_text_entry, render_text_entry_value, text_entry_cursor, text_entry_rows};
use mixdog_tui_widgets::text_layout::text_entry_reserved_rows;
use serde_json::Value;

use super::format::tool_approval_description;
use super::labels::{provider_prompt_fields, settings_prompt_fields};
use crate::panels::ContextPanel;
use crate::surface::layout::{PANEL_MAX_VISIBLE, ShellLayout};

/// The help line of the `$name` skill palette, which reuses the command palette with its own copy.
const SKILL_PALETTE_DESCRIPTION: &str = "Type to filter \u{b7} Enter or Tab inserts the highlighted skill.";
const SKILL_PALETTE_HELP: &str = "\u{2191}/\u{2193} select \u{b7} Enter insert \u{b7} Esc cancel";
const TOOL_APPROVAL_HELP: &str = "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} a/y Approve \u{b7} d/n/Esc Deny";

/// The tool approval being asked, as the store holds it. A `question` approval is the question panel (its state is the
/// panel's own, a fresh one when the owner has none yet); any other is the Deny / Approve once picker.
#[derive(Clone, Copy)]
pub struct ToolApprovalSlot<'a> {
    pub request: &'a Value,
    /// The highlighted row of the approval picker.
    pub selected: usize,
    pub question: Option<&'a QuestionState>,
}

/// An open picker: its props, the highlighted row, the focused confirm button and what the last URL copy did. The owner
/// has fitted the props to the frame with [`fit_picker`].
#[derive(Clone, Copy)]
pub struct PickerSlot<'a> {
    pub props: &'a PickerProps,
    pub selected: usize,
    pub confirm_focus: i64,
    pub status: CopyStatus,
}

#[derive(Clone, Copy)]
pub struct ContextSlot<'a> {
    pub panel: &'a ContextPanel,
    pub state: &'a ContextPanelState,
}

#[derive(Clone, Copy)]
pub struct UsageSlot<'a> {
    pub dashboard: &'a Value,
    pub state: &'a UsagePanelState,
    /// The clock a reset time is written against, in milliseconds since the epoch.
    pub now_ms: f64,
}

/// The slash palette (`/` commands, or the `$name` skills when `skills`): open even with no match, so its height is stable.
#[derive(Clone, Copy)]
pub struct PaletteSlot<'a> {
    pub commands: &'a [SlashCommand],
    pub selected: usize,
    pub query: &'a str,
    pub skills: bool,
}

/// A provider or settings prompt: the prompt object as the store holds it (`kind`, `label`, `hint`, ...) and the editor.
#[derive(Clone, Copy)]
pub struct TextEntrySlot<'a> {
    pub prompt: &'a Value,
    pub draft: &'a TextEntryDraft,
    pub status: CopyStatus,
}

#[derive(Clone, Copy)]
pub struct BtwSlot<'a> {
    pub panel: &'a Value,
    pub state: &'a BtwPanelState,
}

/// Everything that can fill the slot; the first that is present in the order of the module comment shows.
#[derive(Clone, Copy, Default)]
pub struct PanelSlots<'a> {
    pub tool_approval: Option<ToolApprovalSlot<'a>>,
    pub picker: Option<PickerSlot<'a>>,
    pub context: Option<ContextSlot<'a>>,
    pub usage: Option<UsageSlot<'a>>,
    pub slash_palette: Option<PaletteSlot<'a>>,
    pub provider_prompt: Option<TextEntrySlot<'a>>,
    pub settings_prompt: Option<TextEntrySlot<'a>>,
    pub btw: Option<BtwSlot<'a>>,
}

/// The panel that shows, by priority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelKind {
    ToolApproval,
    Picker,
    Context,
    Usage,
    SlashPalette,
    ProviderPrompt,
    SettingsPrompt,
    Btw,
}

impl PanelSlots<'_> {
    /// `renderFloatingPanel`'s branch order.
    pub fn showing(&self) -> Option<PanelKind> {
        if self.tool_approval.is_some() {
            Some(PanelKind::ToolApproval)
        } else if self.picker.is_some() {
            Some(PanelKind::Picker)
        } else if self.context.is_some() {
            Some(PanelKind::Context)
        } else if self.usage.is_some() {
            Some(PanelKind::Usage)
        } else if self.slash_palette.is_some() {
            Some(PanelKind::SlashPalette)
        } else if self.provider_prompt.is_some() {
            Some(PanelKind::ProviderPrompt)
        } else if self.settings_prompt.is_some() {
            Some(PanelKind::SettingsPrompt)
        } else if self.btw.is_some() {
            Some(PanelKind::Btw)
        } else {
            None
        }
    }
}

/// The picker as the frame needs it: the whole width, the visible rows the layout budgeted, and the height of the reserved
/// rows when the panel expands into the prompt area (`columns`, `visibleCount` and `fillHeight` of `renderPicker`).
pub fn fit_picker(props: &mut PickerProps, frame_columns: usize, layout: &ShellLayout) {
    props.columns = frame_columns;
    props.visible_count = layout.picker_visible_rows;
    props.fill_height = fill_height(layout);
}

/// `fillHeight={expandedOptionPanel}`: the panel fills the reserved rows when it expands into the prompt area.
fn fill_height(layout: &ShellLayout) -> Option<u16> {
    layout.expanded_option_panel.then(|| u16::try_from(layout.floating_panel_rows).unwrap_or(u16::MAX))
}

/// The plain tool approval: Deny first (the safe default is highlighted), then Approve once.
fn approval_picker(request: &Value, frame_columns: usize, layout: &ShellLayout) -> PickerProps {
    let mut deny = PickerItem::new("deny", "Deny");
    deny.marker = "\u{d7}".to_owned();
    deny.marker_color = Some(theme_color(Key::Error));
    deny.description = "block this tool call".to_owned();
    let mut approve = PickerItem::new("approve", "Approve once");
    approve.marker = "\u{2713}".to_owned();
    approve.marker_color = Some(theme_color(Key::Success));
    approve.description = "run this tool call".to_owned();
    let mut props = PickerProps::new(vec![deny, approve], "Tool approval");
    props.description = tool_approval_description(request);
    props.help = Some(TOOL_APPROVAL_HELP.to_owned());
    props.columns = frame_columns;
    props.label_width = Some(18);
    props.index_mode = IndexMode::Never;
    props.visible_count = 2;
    props.fill_height = fill_height(layout);
    props
}

/// Paints a panel bottom-aligned in the reserved rows (its bottom edge is the bottom of the reserved rows) and returns the
/// rows it took and its top row.
fn place(painter: &mut Painter, columns: usize, box_top: i32, reserved: usize, paint: &dyn Fn(&mut Painter, i32) -> u16) -> (usize, i32) {
    let rows = measure(columns, paint);
    let y = box_top + reserved as i32 - rows as i32;
    paint(painter, y);
    (rows, y)
}

/// The rows a painter function reports, without painting anywhere visible: it runs over a grid one row high, which clips
/// everything it draws.
fn measure(columns: usize, paint: &dyn Fn(&mut Painter, i32) -> u16) -> usize {
    let mut grid = mixdog_term::frame::Grid::new(columns.min(usize::from(u16::MAX)) as u16, 1);
    usize::from(paint(&mut Painter::new(&mut grid), 0))
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => value_to_string(value),
    }
}

/// The text-entry props of a provider prompt.
fn provider_props(prompt: &Value, frame_columns: usize, layout: &ShellLayout) -> TextEntryProps {
    let fields = provider_prompt_fields(prompt);
    let kind = prompt.get("kind").and_then(Value::as_str).unwrap_or("");
    let mut props = TextEntryProps::new(&fields.title);
    props.hint = fields.hint;
    props.detail = text_of(prompt.get("detail"));
    props.url_max_rows = i64::try_from(layout.text_entry_url_max_rows).unwrap_or(i64::MAX);
    props.mask = kind == "api-key" || kind == "openai-usage-session";
    props.columns = frame_columns;
    props.action_label = if kind == "oauth-code" { "continue" } else { "save" }.to_owned();
    props.prompt_label = fields.prompt_label;
    props
}

/// The text-entry props of a settings prompt.
fn settings_props(prompt: &Value, frame_columns: usize) -> TextEntryProps {
    let kind = prompt.get("kind").and_then(Value::as_str).unwrap_or("");
    let fields = settings_prompt_fields(kind);
    let mut props = TextEntryProps::new(&text_of(prompt.get("label")));
    let hint = text_of(prompt.get("hint"));
    props.hint = if hint.is_empty() { "Save setting.".to_owned() } else { hint };
    props.columns = frame_columns;
    props.multiline = kind == "core-add" || kind == "core-edit";
    props.max_content_rows = PANEL_MAX_VISIBLE;
    props.action_label = fields.action_label.to_owned();
    props.prompt_label = fields.prompt_label.to_owned();
    props
}

/// `onContentRowsChange` of the settings prompt (`setTextEntryLayoutRows`): the content rows the value reserves, which the
/// shell layout reads back as `text_entry_layout_rows` on the next frame. A single-line entry reserves one row.
pub fn settings_entry_layout_rows(prompt: &Value, draft: &TextEntryDraft, frame_columns: usize) -> usize {
    let props = settings_props(prompt, frame_columns);
    if !props.multiline {
        return 1;
    }
    text_entry_reserved_rows(&draft.value, props.content_cells(), props.max_content_rows)
}

/// The cell the hardware cursor is parked at for a text entry whose panel top is row `y`: the value box starts after the
/// border and padding (and, for a multiline value, after the prompt label), on the row of the value, which is the last
/// content row above the bottom border.
fn text_entry_cursor_cell(props: &TextEntryProps, slot: &TextEntrySlot<'_>, y: i32) -> (i32, i32) {
    let content_cells = props.content_cells();
    let content_rows = render_text_entry_value(slot.draft, props.mask, props.multiline, content_cells, props.max_content_rows).content_height;
    let url_rows = sign_in_url_layout(js_trim(&props.detail), props.columns, props.url_max_rows).rows;
    let border_rows = usize::from(text_entry_rows(props, slot.draft, slot.status)).saturating_sub(url_rows);
    let value_row = y + border_rows as i32 - 1 - content_rows as i32;
    let label_width = string_width(&props.prompt_label, StringWidthOptions::default());
    let box_width = if props.multiline { content_cells } else { props.columns.saturating_sub(4).max(1) };
    let (row, col) = text_entry_cursor(slot.draft, props.mask, props.multiline, box_width, props.max_content_rows, &props.prompt_label);
    let box_x = 2 + if props.multiline { label_width as i32 } else { 0 };
    (box_x + col as i32, value_row + row as i32)
}

/// What painting the slot tells the host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PanelPaint {
    /// The rows the panel takes (it may be more than the reserved rows: the top is then clipped).
    pub rows: usize,
    /// The hardware cursor cell (column, row), when the panel is a text entry.
    pub cursor: Option<(i32, i32)>,
}

/// Paints the showing panel in the reserved rows `box_top .. box_top + layout.floating_panel_rows`, bottom-aligned and clipped
/// to them. Returns what it took, or `None` when no panel shows.
pub fn paint_floating_panel(painter: &mut Painter, slots: &PanelSlots<'_>, layout: &ShellLayout, frame_columns: usize, box_top: i32) -> Option<PanelPaint> {
    let kind = slots.showing()?;
    let reserved = layout.floating_panel_rows;
    if reserved == 0 || box_top < 0 {
        return None;
    }
    let previous = painter.push_clip(Rect::new(0, box_top as u16, frame_columns as u16, u16::try_from(reserved).unwrap_or(u16::MAX)));
    let mut cursor = None;
    let rows = match kind {
        PanelKind::ToolApproval => {
            let slot = slots.tool_approval.expect("a showing slot");
            if slot.request.get("kind").and_then(Value::as_str) == Some("question") {
                let questions = questions_of(slot.request);
                let fresh;
                let state = match slot.question {
                    Some(state) => state,
                    None => {
                        fresh = QuestionState::new(&questions);
                        &fresh
                    }
                };
                if questions.is_empty() {
                    0
                } else {
                    place(painter, frame_columns, box_top, reserved, &|p, y| paint_question(p, 0, y, &questions, state, frame_columns, Some(reserved))).0
                }
            } else {
                let props = approval_picker(slot.request, frame_columns, layout);
                place(painter, frame_columns, box_top, reserved, &|p, y| paint_picker(p, 0, y, &props, slot.selected, 0, CopyStatus::Idle)).0
            }
        }
        PanelKind::Picker => {
            let slot = slots.picker.expect("a showing slot");
            place(painter, frame_columns, box_top, reserved, &|p, y| paint_picker(p, 0, y, slot.props, slot.selected, slot.confirm_focus, slot.status)).0
        }
        PanelKind::Context => {
            let slot = slots.context.expect("a showing slot");
            let mut props = ContextPanelProps::new(&slot.panel.rows);
            props.title = slot.panel.title.clone();
            props.columns = frame_columns;
            props.fill_height = fill_height(layout);
            props.detail = Some(&slot.panel.detail);
            props.panel_rows = reserved;
            place(painter, frame_columns, box_top, reserved, &|p, y| paint_context_panel(p, 0, y, &props, slot.state)).0
        }
        PanelKind::Usage => {
            let slot = slots.usage.expect("a showing slot");
            let mut props = UsagePanelProps::new(Some(slot.dashboard));
            props.columns = frame_columns;
            props.fill_height = fill_height(layout);
            props.panel_rows = reserved;
            props.now_ms = slot.now_ms;
            place(painter, frame_columns, box_top, reserved, &|p, y| paint_usage_panel(p, 0, y, &props, slot.state)).0
        }
        PanelKind::SlashPalette => {
            let slot = slots.slash_palette.expect("a showing slot");
            let mut props = PaletteProps::new(slot.commands.to_vec());
            props.selected_index = slot.selected;
            props.title = if slot.skills { "Skills" } else { "Commands" }.to_owned();
            props.columns = frame_columns;
            props.query = slot.query.to_owned();
            if slot.skills {
                props.description = SKILL_PALETTE_DESCRIPTION.to_owned();
                props.help = SKILL_PALETTE_HELP.to_owned();
            }
            place(painter, frame_columns, box_top, reserved, &|p, y| paint_palette(p, 0, y, &props)).0
        }
        PanelKind::ProviderPrompt | PanelKind::SettingsPrompt => {
            let (slot, props) = if kind == PanelKind::ProviderPrompt {
                let slot = slots.provider_prompt.expect("a showing slot");
                let props = provider_props(slot.prompt, frame_columns, layout);
                (slot, props)
            } else {
                let slot = slots.settings_prompt.expect("a showing slot");
                let props = settings_props(slot.prompt, frame_columns);
                (slot, props)
            };
            let (rows, y) = place(painter, frame_columns, box_top, reserved, &|p, y| paint_text_entry(p, 0, y, &props, slot.draft, slot.status));
            cursor = Some(text_entry_cursor_cell(&props, &slot, y));
            rows
        }
        PanelKind::Btw => {
            let slot = slots.btw.expect("a showing slot");
            let mut props = BtwPanelProps::new(slot.panel);
            props.columns = frame_columns;
            props.panel_rows = Some(reserved);
            place(painter, frame_columns, box_top, reserved, &|p, y| paint_btw_panel(p, 0, y, &props, slot.state)).0
        }
    };
    painter.pop_clip(previous);
    Some(PanelPaint { rows, cursor })
}

/// Whether the prompt is a disabled edit target while this panel shows (`disabled={exiting || !!picker || !!contextPanel ||
/// !!toolApproval || !tuiReady}` of the prompt input).
pub fn blocks_prompt(slots: &PanelSlots<'_>) -> bool {
    slots.picker.is_some() || slots.context.is_some() || slots.tool_approval.is_some()
}

/// The answer to a tool approval, as `store.resolveToolApproval(id, decision)` takes it.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDecision {
    pub approved: bool,
    pub reason: &'static str,
    /// The answers of a question approval.
    pub answers: Option<Value>,
}

impl ToolDecision {
    /// Approve once or deny, from the picker's rows, its cancel and its keys.
    pub fn decide(approved: bool) -> Self {
        Self { approved, reason: if approved { "approved by user" } else { "denied by user" }, answers: None }
    }

    /// The question panel was submitted: the approval is approved and carries the answers.
    pub fn answered(answers: Value) -> Self {
        Self { approved: true, reason: "answered by user", answers: Some(answers) }
    }

    /// The question panel was dismissed.
    pub fn dismissed() -> Self {
        Self { approved: false, reason: "dismissed by user", answers: None }
    }

    /// The decision object of the store call.
    pub fn to_value(&self) -> Value {
        let mut decision = serde_json::json!({ "approved": self.approved, "reason": self.reason });
        if let Some(answers) = &self.answers {
            decision["answers"] = answers.clone();
        }
        decision
    }
}

/// The approval picker's own keys (`onKey`): `a` or `y` approve, `d` or `n` deny, in any case and with blanks around; any other
/// key does nothing. Enter on a row is [`ToolDecision::decide`] of whether the row is `approve`, and Escape denies.
pub fn approval_key_decision(input: &str) -> Option<ToolDecision> {
    match js_to_lowercase(js_trim(input)).as_str() {
        "a" | "y" => Some(ToolDecision::decide(true)),
        "d" | "n" => Some(ToolDecision::decide(false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rows_cancel_and_keys_resolve_into_approve_and_deny_decisions() {
        let approved = json!({ "approved": true, "reason": "approved by user" });
        let denied = json!({ "approved": false, "reason": "denied by user" });
        let decisions = [
            ToolDecision::decide(true),
            ToolDecision::decide(false),
            ToolDecision::decide(false),
            approval_key_decision(" Y ").unwrap(),
            approval_key_decision("a").unwrap(),
            approval_key_decision("n").unwrap(),
            approval_key_decision("d").unwrap(),
        ];
        let values: Vec<Value> = decisions.iter().map(ToolDecision::to_value).collect();
        assert_eq!(values, [approved.clone(), denied.clone(), denied.clone(), approved.clone(), approved, denied.clone(), denied]);
        assert_eq!(approval_key_decision("x"), None);
        assert_eq!(approval_key_decision(""), None);
    }

    #[test]
    fn a_multiline_settings_entry_reports_the_rows_its_value_reserves_and_a_single_line_one_reports_one() {
        let draft = TextEntryDraft { value: "abcdefghij".to_owned(), ..TextEntryDraft::default() };
        // 20 columns less the border and padding (4) and "Sentence > " (11) leave 5 cells for the value.
        let rows = settings_entry_layout_rows(&json!({ "kind": "core-add", "label": "Add" }), &draft, 20);
        assert_eq!(rows, text_entry_reserved_rows("abcdefghij", 5, PANEL_MAX_VISIBLE));
        assert!(rows > 1);
        assert_eq!(settings_entry_layout_rows(&json!({ "kind": "skill-use", "label": "Run" }), &draft, 20), 1);
    }

    #[test]
    fn an_answered_question_carries_its_answers_and_a_dismissed_one_denies() {
        let answered = ToolDecision::answered(json!([{ "question": "q", "answer": "a" }])).to_value();
        assert_eq!(answered["reason"], "answered by user");
        assert_eq!(answered["approved"], true);
        assert_eq!(answered["answers"][0]["answer"], "a");
        assert_eq!(ToolDecision::dismissed().to_value(), json!({ "approved": false, "reason": "dismissed by user" }));
    }
}
