//! Pure prompt-editor helpers (`components/prompt-input/edit-helpers.mjs`): hint colour, insert, pasted-text
//! normalisation, the arrow-key caret targets, Backspace/Delete, and modified-Enter (kitty / modifyOtherKeys) recognition.

use std::sync::OnceLock;

use mixdog_js::JsRegex;
use mixdog_tui_style::Key;

use super::draft::Draft;
use super::editing::{
    delete_selected_text, len16, next_offset, next_word_offset, previous_offset, previous_word_offset, replace_selection, selection_range, splice16,
};

/// How a hint under the prompt is toned.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HintTone {
    #[default]
    Info,
    Error,
    Warn,
    Cancel,
    Plain,
}

impl HintTone {
    /// The tone a caller names with a word; an unknown word is `Info`.
    pub fn parse(tone: &str) -> Self {
        match tone {
            "error" => Self::Error,
            "warn" => Self::Warn,
            "cancel" => Self::Cancel,
            "plain" => Self::Plain,
            _ => Self::Info,
        }
    }
}

/// The theme colour of a hint.
pub fn hint_color(tone: HintTone) -> Key {
    match tone {
        HintTone::Error => Key::Error,
        HintTone::Warn | HintTone::Cancel => Key::Warning,
        HintTone::Plain => Key::Subtle,
        HintTone::Info => Key::Inactive,
    }
}

/// Inserts `input` over the selection or at the caret; an empty input leaves the draft as it is.
pub fn insert_text(draft: &Draft, input: &str) -> Draft {
    if input.is_empty() { draft.clone() } else { replace_selection(draft, input) }
}

/// `String(text).replace(/\r\n?/g, '\n')`
pub fn normalize_pasted_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The text before the single line break that ends `text`, or none when `text` does not end with a line break or has
/// another one inside.
pub fn single_trailing_line_break_prefix(text: &str) -> Option<String> {
    let normalized = normalize_pasted_text(text);
    let prefix = normalized.strip_suffix('\n')?;
    if prefix.contains('\n') { None } else { Some(prefix.to_owned()) }
}

/// The caret target of a Left press. A plain press collapses a live selection to its near edge; otherwise the caret steps one
/// word (`word`, the Ctrl/Meta chord) or one character. `extend` (Shift) keeps growing the selection instead.
pub fn left_arrow_offset(draft: &Draft, word: bool, extend: bool) -> usize {
    let range = if word || extend { None } else { selection_range(draft) };
    match range {
        Some(range) => range.start,
        None if word => previous_word_offset(&draft.value, draft.cursor),
        None => previous_offset(&draft.value, draft.cursor),
    }
}

pub fn right_arrow_offset(draft: &Draft, word: bool, extend: bool) -> usize {
    let range = if word || extend { None } else { selection_range(draft) };
    match range {
        Some(range) => range.end,
        None if word => next_word_offset(&draft.value, draft.cursor),
        None => next_offset(&draft.value, draft.cursor),
    }
}

/// Backspace: deletes a live selection, else the grapheme before the caret.
pub fn delete_backward_char(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return delete_selected_text(draft);
    }
    if draft.cursor == 0 {
        return draft.clone();
    }
    let start = previous_offset(&draft.value, draft.cursor);
    let value = splice16(&draft.value, start, draft.cursor, "");
    Draft { value, cursor: start, selection_anchor: None }
}

/// Delete: deletes a live selection, else the grapheme after the caret.
pub fn delete_forward_char(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return delete_selected_text(draft);
    }
    if draft.cursor >= len16(&draft.value) {
        return draft.clone();
    }
    let end = next_offset(&draft.value, draft.cursor);
    let value = splice16(&draft.value, draft.cursor, end, "");
    Draft { value, cursor: draft.cursor, selection_anchor: None }
}

/// Shift, Alt and Ctrl are the newline chords of a modified Enter (xterm modifier parameter = 1 + bitmask, shift = 1,
/// alt = 2, ctrl = 4).
const MODIFIED_ENTER_NEWLINE: i32 = 1 | 2 | 4;

/// The CSI parameter body of an Enter sequence, with or without its ESC prefix; empty for anything else.
pub fn csi_body(text: &str) -> &str {
    if let Some(body) = text.strip_prefix("\x1b[") {
        return body;
    }
    text.strip_prefix('[').unwrap_or("")
}

/// `ToInt32` of a number, as JavaScript's `&` applies it.
fn to_int32(number: f64) -> i32 {
    if !number.is_finite() {
        return 0;
    }
    let wrapped = number.trunc().rem_euclid(4_294_967_296.0);
    (wrapped as u32) as i32
}

/// The modifier bitmask (xterm parameter - 1) of an Enter sequence: kitty `ESC [ 13 ; mod u` or modifyOtherKeys
/// `ESC [ 27 ; mod ; 13 ~`; none for anything else.
fn enter_modifier_bits(input: &str) -> Option<i32> {
    static KITTY: OnceLock<JsRegex> = OnceLock::new();
    static MODIFY_OTHER_KEYS: OnceLock<JsRegex> = OnceLock::new();
    let body = csi_body(input);
    if body.is_empty() {
        return None;
    }
    let kitty = KITTY.get_or_init(|| JsRegex::new_static(r"^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$", ""));
    let modify_other_keys = MODIFY_OTHER_KEYS.get_or_init(|| JsRegex::new_static(r"^27;(\d+);13~$", ""));
    let caps = kitty.captures(body).or_else(|| modify_other_keys.captures(body))?;
    let number = mixdog_js::string_to_number(caps.get(1)?);
    Some(to_int32(number - 1.0))
}

/// Whether `input` is a Shift, Alt or Ctrl + Enter sequence.
pub fn is_modified_enter_sequence(input: &str) -> bool {
    enter_modifier_bits(input).is_some_and(|bits| bits & MODIFIED_ENTER_NEWLINE != 0)
}

/// Whether `input` is any modified Enter. Used to consume the uncommon modifier combinations so raw CSI bytes never reach
/// the draft; a plain Enter (parameter 1, bitmask 0) stays a submit.
pub fn is_any_modified_enter_sequence(input: &str) -> bool {
    enter_modifier_bits(input).is_some_and(|bits| bits != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selected() -> Draft {
        Draft::new("alpha beta gamma", 10, Some(6))
    }

    fn caret() -> Draft {
        Draft::new("alpha beta gamma", 8, None)
    }

    #[test]
    fn a_plain_arrow_press_collapses_a_live_selection_to_its_near_edge() {
        assert_eq!(left_arrow_offset(&selected(), false, false), 6);
        assert_eq!(right_arrow_offset(&selected(), false, false), 10);
    }

    #[test]
    fn shift_keeps_stepping_from_the_caret_instead_of_collapsing_the_selection() {
        assert_eq!(left_arrow_offset(&selected(), false, true), 9);
        assert_eq!(right_arrow_offset(&selected(), false, true), 11);
    }

    #[test]
    fn the_word_chord_steps_by_word_ignoring_a_live_selection() {
        assert_eq!(left_arrow_offset(&selected(), true, false), 6);
        assert_eq!(right_arrow_offset(&selected(), true, false), 16);
        assert_eq!(left_arrow_offset(&caret(), true, false), 6);
        assert_eq!(right_arrow_offset(&caret(), true, false), 10);
    }

    #[test]
    fn without_a_selection_the_caret_steps_one_character() {
        assert_eq!(left_arrow_offset(&caret(), false, false), 7);
        assert_eq!(right_arrow_offset(&caret(), false, false), 9);
    }

    #[test]
    fn backspace_and_delete_remove_a_live_selection_else_one_grapheme_around_the_caret() {
        let removed = Draft::new("alpha  gamma", 6, None);
        assert_eq!(delete_backward_char(&selected()), removed);
        assert_eq!(delete_forward_char(&selected()), removed);
        assert_eq!(delete_backward_char(&caret()), Draft::new("alpha bta gamma", 7, None));
        assert_eq!(delete_forward_char(&caret()), Draft::new("alpha bea gamma", 8, None));
        let flag = Draft::new("a\u{1F1F0}\u{1F1F7}", 5, None);
        assert_eq!(delete_backward_char(&flag), Draft::new("a", 1, None));
    }

    #[test]
    fn backspace_at_the_start_and_delete_at_the_end_leave_the_draft_unchanged() {
        let start = Draft::new("abc", 0, None);
        let end = Draft::new("abc", 3, None);
        assert_eq!(delete_backward_char(&start), start);
        assert_eq!(delete_forward_char(&end), end);
    }

    #[test]
    fn shift_alt_and_ctrl_enter_are_newline_chords_and_plain_enter_is_not() {
        for modifier in [2, 3, 5, 4, 7] {
            assert!(is_modified_enter_sequence(&format!("\x1b[13;{modifier}u")), "kitty mod {modifier}");
            assert!(is_modified_enter_sequence(&format!("\x1b[27;{modifier};13~")), "modifyOtherKeys mod {modifier}");
        }
        assert!(!is_modified_enter_sequence("\x1b[13;1u"));
        assert!(!is_modified_enter_sequence("\x1b[27;1;13~"));
        assert!(!is_modified_enter_sequence("\r"));
        assert!(is_any_modified_enter_sequence("\x1b[13;9u"));
        assert!(!is_any_modified_enter_sequence("\x1b[13;1u"));
        assert!(is_modified_enter_sequence("\x1b[13;2:1u"));
        assert!(is_modified_enter_sequence("[13;5;10:2u"));
    }

    #[test]
    fn csi_body_accepts_the_csi_body_with_or_without_its_esc_prefix() {
        assert_eq!(csi_body("\x1b[13;2u"), "13;2u");
        assert_eq!(csi_body("[27;5;13~"), "27;5;13~");
        assert_eq!(csi_body("13;2u"), "");
    }

    #[test]
    fn pasted_text_line_breaks_normalise_to_newlines() {
        assert_eq!(normalize_pasted_text("a\r\nb\rc\n"), "a\nb\nc\n");
        assert_eq!(single_trailing_line_break_prefix("abc\r"), Some("abc".to_owned()));
        assert_eq!(single_trailing_line_break_prefix("\n"), Some(String::new()));
        assert_eq!(single_trailing_line_break_prefix("a\nb\n"), None);
        assert_eq!(single_trailing_line_break_prefix("abc"), None);
    }

    #[test]
    fn hint_colours() {
        assert_eq!(hint_color(HintTone::parse("error")), Key::Error);
        assert_eq!(hint_color(HintTone::parse("cancel")), Key::Warning);
        assert_eq!(hint_color(HintTone::parse("plain")), Key::Subtle);
        assert_eq!(hint_color(HintTone::parse("anything")), Key::Inactive);
    }
}
