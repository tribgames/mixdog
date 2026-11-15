//! Global key input (`app/use-global-key-input.mjs`, `use-global-key-input/{approval-shortcut, copy-first, shift-arrow}.mjs`):
//! everything the app handles before the prompt input sees a key: tool-approval y/n, copy-first Ctrl+C with region-aware
//! selection sources, Ctrl+O expand, shift-arrow grid-selection moves, panel Escapes, and PageUp/PageDown transcript paging.
//! The ordered dispatch of [`handle_global_key`] stays whole; its leaf decisions are functions beside it.

use mixdog_js::{js_to_lowercase, js_trim, utf16_len};
use mixdog_term::KeyFlags;

use crate::editor::helpers::HintTone;
use crate::slash::commands::overlay_blocks_global_transcript_scroll;
use crate::transcript::window::selection_shift::{SelectionRect, selection_rect_is_degenerate};

use super::host::GlobalKeyHost;

/// A pending tool approval: its id and kind (`question` approvals are answered only inside the question panel).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolApproval {
    pub id: String,
    pub kind: String,
}

/// What a tool approval resolves with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalDecision {
    pub approved: bool,
    pub reason: &'static str,
}

/// Esc/d/n deny, a/y approve; `None` for any other key and for a question approval or none pending.
pub fn approval_shortcut_decision(approval: Option<&ToolApproval>, input: &str, key: &KeyFlags) -> Option<ApprovalDecision> {
    let approval = approval?;
    if approval.kind == "question" {
        return None;
    }
    let value = js_to_lowercase(js_trim(input));
    if key.escape || value == "d" || value == "n" {
        return Some(ApprovalDecision { approved: false, reason: "denied by user" });
    }
    if value == "a" || value == "y" {
        return Some(ApprovalDecision { approved: true, reason: "approved by user" });
    }
    None
}

/// A grid-selection move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionMove {
    Left,
    Right,
    Up,
    Down,
    LineStart,
    LineEnd,
}

impl SelectionMove {
    /// The name the move goes by in recordings.
    pub fn as_str(self) -> &'static str {
        match self {
            SelectionMove::Left => "left",
            SelectionMove::Right => "right",
            SelectionMove::Up => "up",
            SelectionMove::Down => "down",
            SelectionMove::LineStart => "lineStart",
            SelectionMove::LineEnd => "lineEnd",
        }
    }
}

/// Terminals that do not set the shift flag deliver the chord as a raw CSI sequence instead.
const RAW_SHIFT_ARROWS: [(SelectionMove, [&str; 5]); 4] = [
    (SelectionMove::Up, ["\x1b[1;2A", "\x1b[a", "[1;2A", "\x1b[1;6A", "[1;6A"]),
    (SelectionMove::Down, ["\x1b[1;2B", "\x1b[b", "[1;2B", "\x1b[1;6B", "[1;6B"]),
    (SelectionMove::Right, ["\x1b[1;2C", "\x1b[c", "[1;2C", "\x1b[1;6C", "[1;6C"]),
    (SelectionMove::Left, ["\x1b[1;2D", "\x1b[d", "[1;2D", "\x1b[1;6D", "[1;6D"]),
];

/// `decodeSelectionMoveChord(input, key)`: whether the keypress is a grid-selection move chord at all, and the direction it
/// asks for.
pub fn decode_selection_move_chord(input: &str, key: &KeyFlags) -> (bool, Option<SelectionMove>) {
    let raw = RAW_SHIFT_ARROWS.iter().find(|(_, sequences)| sequences.contains(&input)).map(|(direction, _)| *direction);
    let is_chord = raw.is_some()
        || (key.shift && (key.left_arrow || key.right_arrow || key.up_arrow || key.down_arrow || key.home || key.end));
    let direction = if key.left_arrow || raw == Some(SelectionMove::Left) {
        Some(SelectionMove::Left)
    } else if key.right_arrow || raw == Some(SelectionMove::Right) {
        Some(SelectionMove::Right)
    } else if key.up_arrow || raw == Some(SelectionMove::Up) {
        Some(SelectionMove::Up)
    } else if key.down_arrow || raw == Some(SelectionMove::Down) {
        Some(SelectionMove::Down)
    } else if key.home {
        Some(SelectionMove::LineStart)
    } else if key.end {
        Some(SelectionMove::LineEnd)
    } else {
        None
    };
    (is_chord, direction)
}

/// What Ctrl+C does before anything else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CopyAction {
    /// Copy the prompt box's selection.
    PromptText(String),
    /// Copy the transcript or status grid selection.
    Grid,
    /// No app-owned selection: the guidance hint (never on Windows Terminal, whose own copy shortcut is the same key).
    Guidance,
    Nothing,
}

/// `copyActiveSelection`'s choice of source. A prompt selection wins when the last drag was in the prompt or no grid
/// selection exists; a degenerate grid rect selects nothing. Ctrl+C never cancels the turn: Esc interrupts.
pub fn copy_action(
    prompt_selection_text: Option<&str>,
    last_region: Option<&str>,
    ink_rect: Option<&SelectionRect>,
    is_windows: bool,
) -> CopyAction {
    let has_ink_selection = ink_rect.is_some_and(|rect| !selection_rect_is_degenerate(rect));
    if let Some(text) = prompt_selection_text.filter(|text| !text.is_empty())
        && (last_region == Some("prompt") || !has_ink_selection)
    {
        return CopyAction::PromptText(text.to_owned());
    }
    if has_ink_selection {
        return CopyAction::Grid;
    }
    if is_windows { CopyAction::Nothing } else { CopyAction::Guidance }
}

fn copy_active_selection(host: &mut dyn GlobalKeyHost) {
    let text = host.prompt_selection_text();
    let region = host.drag_region();
    let rect = host.drag_rect();
    match copy_action(text.as_deref(), region.as_deref(), rect.as_ref(), host.is_windows()) {
        CopyAction::PromptText(text) => match host.copy_to_clipboard(&text) {
            Ok(()) => {
                let count = utf16_len(&text);
                let message = format!("copied {count} char{}", if count == 1 { "" } else { "s" });
                host.show_prompt_hint(&message, HintTone::Plain, None);
            }
            Err(error) => host.show_prompt_hint(&format!("copy failed: {error}"), HintTone::Error, None),
        },
        CopyAction::Grid => host.copy_selection(),
        CopyAction::Guidance => host.show_prompt_hint("select text to copy \u{b7} Esc interrupts", HintTone::Plain, None),
        CopyAction::Nothing => {}
    }
}

/// What a keypress did, for a caller that wants to know whether the prompt input should still see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlobalKeyOutcome {
    /// The key was consumed.
    Consumed,
    /// The key goes on to the prompt input (Escape also cleared the selections).
    Pass,
}

/// The global `useInput` callback: `input` is the key's text, `key` its flags. The caller runs it only while raw mode is
/// supported (`isActive: isRawModeSupported`).
pub fn handle_global_key(host: &mut dyn GlobalKeyHost, input: &str, key: &KeyFlags) -> GlobalKeyOutcome {
    // A drag whose button release never reached the app leaves the drag stuck active: a keystroke proves the gesture is
    // over, so it is settled through the path a real release takes before any branch below reads the selection.
    host.settle_stuck_drag();
    let approval = host.tool_approval();
    if let Some(decision) = approval_shortcut_decision(approval.as_ref(), input, key) {
        if let Some(approval) = approval {
            host.resolve_tool_approval(&approval.id, decision);
        }
        return GlobalKeyOutcome::Consumed;
    }
    if key.ctrl && (input == "c" || input == "C") {
        copy_active_selection(host);
        return GlobalKeyOutcome::Consumed;
    }
    if key.ctrl && (input == "o" || input == "O") {
        host.toggle_expand();
        return GlobalKeyOutcome::Consumed;
    }
    let picker = host.picker_open();
    let (is_chord, direction) = decode_selection_move_chord(input, key);
    if !picker && is_chord {
        // The chord is consumed whenever a transcript or status grid selection is live, even if the focus clamps at an edge.
        // When none is live it falls through to the prompt input.
        if let Some(direction) = direction
            && host.grid_selection_active()
        {
            host.move_selection_focus(direction);
            return GlobalKeyOutcome::Consumed;
        }
    }
    if key.escape && host.usage_panel_open() && !picker {
        host.close_usage_panel();
        return GlobalKeyOutcome::Consumed;
    }
    if key.escape && host.context_panel_open() && !picker {
        host.clear_context_panel();
        return GlobalKeyOutcome::Consumed;
    }
    if key.page_up || key.page_down {
        if overlay_blocks_global_transcript_scroll(host.scroll_focus()) {
            return GlobalKeyOutcome::Consumed;
        }
        let rows = host.rows().unwrap_or(24);
        let page_rows = ((rows as f64 * 0.6).floor() as i64).max(3);
        host.scroll_transcript_rows(if key.page_up { page_rows } else { -page_rows });
        return GlobalKeyOutcome::Consumed;
    }
    if key.ctrl && key.end {
        host.reset_transcript_scroll();
        return GlobalKeyOutcome::Consumed;
    }
    if key.escape && !picker {
        host.reset_drag();
        // Clears whichever region's selection is active: the prompt's own Escape clears its selection only when focused and
        // enabled, so this covers the disabled case and a status or transcript grid selection in one press.
        host.clear_prompt_mouse_selection();
        host.clear_selection_rect();
    }
    GlobalKeyOutcome::Pass
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x1: i64, y1: i64, x2: i64, y2: i64) -> SelectionRect {
        SelectionRect { mode: None, x1, y1, x2, y2, clip_y1: None, clip_y2: None, capture_text: None }
    }

    #[test]
    fn approval_keys_decide_only_for_a_tool_approval_that_is_not_a_question() {
        let tool = ToolApproval { id: "a1".into(), kind: "tool".into() };
        let question = ToolApproval { id: "a2".into(), kind: "question".into() };
        let escape = KeyFlags { escape: true, ..KeyFlags::default() };
        let approved = |input: &str| approval_shortcut_decision(Some(&tool), input, &KeyFlags::default()).map(|d| d.approved);
        assert_eq!(approved(" Y "), Some(true));
        assert_eq!(approved("a"), Some(true));
        assert_eq!(approved("n"), Some(false));
        assert_eq!(approved("D"), Some(false));
        assert_eq!(approved("x"), None);
        assert_eq!(approval_shortcut_decision(Some(&tool), "", &escape).map(|d| d.reason), Some("denied by user"));
        assert_eq!(approval_shortcut_decision(Some(&question), "y", &KeyFlags::default()), None);
        assert_eq!(approval_shortcut_decision(None, "y", &KeyFlags::default()), None);
    }

    #[test]
    fn a_move_chord_is_a_raw_shift_arrow_sequence_or_a_shifted_arrow_key() {
        let none = KeyFlags::default();
        assert_eq!(decode_selection_move_chord("\x1b[1;2A", &none), (true, Some(SelectionMove::Up)));
        assert_eq!(decode_selection_move_chord("[1;6D", &none), (true, Some(SelectionMove::Left)));
        assert_eq!(decode_selection_move_chord("\x1b[c", &none), (true, Some(SelectionMove::Right)));
        let shift_down = KeyFlags { shift: true, down_arrow: true, ..KeyFlags::default() };
        assert_eq!(decode_selection_move_chord("", &shift_down), (true, Some(SelectionMove::Down)));
        let shift_home = KeyFlags { shift: true, home: true, ..KeyFlags::default() };
        assert_eq!(decode_selection_move_chord("", &shift_home), (true, Some(SelectionMove::LineStart)));
        let shift_end = KeyFlags { shift: true, end: true, ..KeyFlags::default() };
        assert_eq!(decode_selection_move_chord("", &shift_end), (true, Some(SelectionMove::LineEnd)));
        let plain_arrow = KeyFlags { left_arrow: true, ..KeyFlags::default() };
        assert_eq!(decode_selection_move_chord("", &plain_arrow), (false, Some(SelectionMove::Left)));
        assert_eq!(decode_selection_move_chord("x", &none), (false, None));
    }

    #[test]
    fn copy_prefers_the_prompt_selection_then_the_grid_and_hints_only_off_windows() {
        let live = rect(1, 1, 5, 1);
        let dead = rect(2, 2, 2, 2);
        assert_eq!(copy_action(Some("abc"), Some("prompt"), Some(&live), false), CopyAction::PromptText("abc".into()));
        assert_eq!(copy_action(Some("abc"), Some("transcript"), Some(&live), false), CopyAction::Grid);
        assert_eq!(copy_action(Some("abc"), Some("transcript"), Some(&dead), false), CopyAction::PromptText("abc".into()));
        assert_eq!(copy_action(Some(""), None, Some(&live), false), CopyAction::Grid);
        assert_eq!(copy_action(None, None, Some(&dead), false), CopyAction::Guidance);
        assert_eq!(copy_action(None, None, None, true), CopyAction::Nothing);
    }
}
