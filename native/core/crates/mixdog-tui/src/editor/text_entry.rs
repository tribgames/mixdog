//! The inline editor of the text-entry panel (`components/TextEntryPanel.jsx`): a single-line field, or a multi-line one, that
//! can be masked. It shares the edit chords and the helpers of the prompt editor but has no undo, no history, no palette and
//! no queue. Its panel frame, its single-line layout and its masked value are the widget's.

use mixdog_js::{JsRegex, js_to_lowercase, js_trim};
use mixdog_term::KeyFlags;
use std::sync::OnceLock;

use super::chords::apply_edit_chord;
use super::draft::Draft;
use super::editing::{
    clear_selection, line_end, line_start, move_cursor, replace_selection, selection_range, vertical_offset,
};
use super::helpers::{
    insert_text, is_any_modified_enter_sequence, is_modified_enter_sequence, left_arrow_offset, normalize_pasted_text,
    right_arrow_offset, single_trailing_line_break_prefix,
};
use super::signals::is_csi_private_reply;

/// What the panel hosting the field answers to.
pub trait TextEntryCallbacks {
    /// The value was submitted; false keeps it in the field.
    fn on_submit(&mut self, _value: &str) -> bool {
        true
    }
    /// Escape with no selection to collapse.
    fn on_cancel(&mut self) {}
    /// The sign-in URL copy key (only asked while the panel shows a URL); true when it was one.
    fn on_copy_key(&mut self, _input: &str, _key: &KeyFlags) -> bool {
        false
    }
}

/// The props of the panel the key dispatch reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextEntryProps {
    /// A blank submit is the documented reset/clear action of some prompt kinds; off, every prompt needs a value.
    pub allow_empty: bool,
    pub multiline: bool,
    /// Whether the panel shows a sign-in URL, which makes its copy key live.
    pub has_detail: bool,
}

/// `canSubmitTextEntry`: a blank value submits only where blank means reset.
pub fn can_submit_text_entry(value: &str, allow_empty: bool) -> bool {
    allow_empty || !js_trim(value).is_empty()
}

fn mouse_report_inside(text: &str) -> bool {
    static MOUSE: OnceLock<JsRegex> = OnceLock::new();
    MOUSE.get_or_init(|| JsRegex::new_static(r"(?:\x1b)?\[<\d+;\d+;\d+[Mm]", "")).is_match(text)
}

#[derive(Debug)]
pub struct TextEntryEditor {
    draft: Draft,
    submit_gate: bool,
    content_width: usize,
    preferred_column: Option<usize>,
    dirty: bool,
}

impl TextEntryEditor {
    /// A field holding `initial_value`, the caret after it.
    pub fn new(initial_value: &str) -> Self {
        Self {
            draft: Draft::at_end(initial_value),
            submit_gate: false,
            content_width: 80,
            preferred_column: None,
            dirty: false,
        }
    }

    /// The prompt changed (its title or initial value): the field starts over.
    pub fn reset(&mut self, initial_value: &str) {
        self.commit(Draft::at_end(initial_value), false);
    }

    pub fn draft(&self) -> &Draft {
        &self.draft
    }

    /// The width of the value box in columns, measured by the layout; vertical moves use it.
    pub fn set_content_width(&mut self, width: usize) {
        self.content_width = width.max(1);
    }

    /// Whether the field changed since the last call (the widget redraws).
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// The input events of one read are done: the submit gate opens again.
    pub fn end_input_batch(&mut self) {
        self.submit_gate = false;
    }

    fn commit(&mut self, next: Draft, keep_preferred_column: bool) {
        if !keep_preferred_column {
            self.preferred_column = None;
        }
        self.draft = next;
        self.dirty = true;
    }

    fn update(&mut self, edit: impl FnOnce(&Draft) -> Draft) {
        let next = edit(&self.draft);
        self.commit(next, false);
    }

    fn move_vertically(&mut self, direction: i32, extend: bool) {
        let current = self.draft.clone();
        let moved = vertical_offset(&current.value, current.cursor, self.content_width, direction, self.preferred_column);
        self.preferred_column = Some(moved.preferred_column);
        if moved.cursor != current.cursor {
            self.commit(move_cursor(&current, moved.cursor, extend), true);
        }
    }

    fn submit_enter_chunk(&mut self, prefix: &str, props: &TextEntryProps, cb: &mut dyn TextEntryCallbacks) {
        if self.submit_gate {
            return;
        }
        let next = if prefix.is_empty() { self.draft.clone() } else { insert_text(&self.draft, prefix) };
        if !can_submit_text_entry(&next.value, props.allow_empty) {
            return;
        }
        self.submit_gate = true;
        if cb.on_submit(&next.value) {
            self.commit(Draft::empty(), false);
            // The gate stays shut until the input batch drains.
        } else {
            self.submit_gate = false;
            if !prefix.is_empty() {
                self.commit(next, false);
            }
        }
    }

    /// A bracketed paste: inserted as text with line breaks normalised.
    pub fn handle_paste(&mut self, text: &str) {
        let pasted = normalize_pasted_text(text);
        if pasted.is_empty() {
            return;
        }
        self.update(|d| insert_text(d, &pasted));
    }

    /// One `(input, key)` event of the decoder.
    pub fn handle_key(&mut self, input: &str, key: &KeyFlags, props: &TextEntryProps, cb: &mut dyn TextEntryCallbacks) {
        let raw_source = input;
        let raw_input = normalize_pasted_text(input);
        if mouse_report_inside(raw_source) {
            return;
        }
        // A volunteered CSI-private report must never type into the field.
        if is_csi_private_reply(raw_source) {
            return;
        }

        if key.escape {
            if selection_range(&self.draft).is_some() {
                let cleared = clear_selection(&self.draft);
                self.commit(cleared, false);
                return;
            }
            cb.on_cancel();
            return;
        }
        let trailing_enter_prefix = single_trailing_line_break_prefix(&raw_input);
        let raw_ctrl_enter = is_modified_enter_sequence(raw_source) || is_modified_enter_sequence(&raw_input);
        // Newline chords are meaningless, and dangerous (hidden newlines in API keys and URLs), outside multiline mode.
        let modified_line_break = props.multiline && (key.shift || key.meta || key.ctrl || raw_ctrl_enter);
        let input_key = js_to_lowercase(input);

        // Ctrl+J, the protocol-independent newline: a lone `\n` (a real Enter is CR) or `j` with ctrl under kitty. It
        // precedes the trailing-newline paths, which would take a bare `\n` for a submit.
        if props.multiline && ((raw_source == "\n" && !key.return_key) || (key.ctrl && input_key == "j")) {
            self.update(|d| replace_selection(d, "\n"));
            return;
        }

        // A modified Enter that is not a newline chord is consumed so its raw CSI bytes do not type into the field.
        if !raw_ctrl_enter && (is_any_modified_enter_sequence(raw_source) || is_any_modified_enter_sequence(&raw_input)) {
            return;
        }

        let paste_fallback = raw_input.contains('\n')
            && trailing_enter_prefix.is_none()
            && (mixdog_js::utf16_len(&raw_input) > 1 || !key.return_key);
        if paste_fallback {
            self.update(|d| insert_text(d, &raw_input));
            return;
        }
        if let Some(prefix) = trailing_enter_prefix {
            if modified_line_break {
                self.update(|d| insert_text(d, &format!("{prefix}\n")));
                return;
            }
            self.submit_enter_chunk(&prefix, props, cb);
            return;
        }
        if props.multiline && raw_ctrl_enter {
            self.update(|d| replace_selection(d, "\n"));
            return;
        }
        if key.return_key {
            if modified_line_break {
                self.update(|d| replace_selection(d, "\n"));
                return;
            }
            self.submit_enter_chunk("", props, cb);
            return;
        }
        if key.left_arrow {
            let word = key.ctrl || key.meta;
            let extend = key.shift;
            self.update(|d| move_cursor(d, left_arrow_offset(d, word, extend), extend));
            return;
        }
        if key.right_arrow {
            let word = key.ctrl || key.meta;
            let extend = key.shift;
            self.update(|d| move_cursor(d, right_arrow_offset(d, word, extend), extend));
            return;
        }
        if key.up_arrow {
            self.move_vertically(-1, key.shift);
            return;
        }
        if key.down_arrow {
            self.move_vertically(1, key.shift);
            return;
        }
        let ctrl_a = key.ctrl && input_key == "a";
        if key.home || ctrl_a {
            let extend = key.shift;
            self.update(|d| {
                if ctrl_a && !d.value.is_empty() {
                    Draft { value: d.value.clone(), cursor: d.len16(), selection_anchor: Some(0) }
                } else {
                    move_cursor(d, line_start(&d.value, d.cursor), extend)
                }
            });
            return;
        }
        if key.end || (key.ctrl && input_key == "e") {
            let extend = key.shift;
            self.update(|d| move_cursor(d, line_end(&d.value, d.cursor), extend));
            return;
        }
        if props.has_detail && cb.on_copy_key(input, key) {
            return;
        }
        if let Some(next) = apply_edit_chord(key, &input_key, &self.draft) {
            self.commit(next, false);
            return;
        }
        if !raw_input.is_empty() && !key.ctrl && !key.meta {
            self.update(|d| insert_text(d, &raw_input));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Panel {
        submits: Vec<String>,
        refuse: bool,
        cancels: usize,
        copies: usize,
    }

    impl TextEntryCallbacks for Panel {
        fn on_submit(&mut self, value: &str) -> bool {
            self.submits.push(value.to_owned());
            !self.refuse
        }
        fn on_cancel(&mut self) {
            self.cancels += 1;
        }
        fn on_copy_key(&mut self, input: &str, key: &KeyFlags) -> bool {
            let copy = key.ctrl && input == "c";
            self.copies += usize::from(copy);
            copy
        }
    }

    fn enter() -> KeyFlags {
        KeyFlags { return_key: true, ..KeyFlags::default() }
    }

    #[test]
    fn typing_enter_submits_and_blank_is_refused_unless_it_means_reset() {
        let mut field = TextEntryEditor::new("");
        let mut panel = Panel::default();
        let props = TextEntryProps::default();
        field.handle_key("a", &KeyFlags::default(), &props, &mut panel);
        field.handle_key("b", &KeyFlags::default(), &props, &mut panel);
        field.handle_key("", &enter(), &props, &mut panel);
        assert_eq!(panel.submits, ["ab"]);
        assert_eq!(field.draft().value, "");
        field.end_input_batch();
        field.handle_key("", &enter(), &props, &mut panel);
        assert_eq!(panel.submits.len(), 1, "a blank value is not submitted");
        let reset = TextEntryProps { allow_empty: true, ..props };
        field.handle_key("", &enter(), &reset, &mut panel);
        assert_eq!(panel.submits, ["ab", ""]);
    }

    #[test]
    fn a_refused_submit_keeps_the_value_and_opens_the_gate() {
        let mut field = TextEntryEditor::new("secret");
        let mut panel = Panel { refuse: true, ..Panel::default() };
        let props = TextEntryProps::default();
        field.handle_key("", &enter(), &props, &mut panel);
        field.handle_key("", &enter(), &props, &mut panel);
        assert_eq!(panel.submits.len(), 2);
        assert_eq!(field.draft().value, "secret");
    }

    #[test]
    fn newline_chords_work_only_in_multiline_mode() {
        let props = TextEntryProps { multiline: true, ..TextEntryProps::default() };
        let mut panel = Panel::default();
        let mut field = TextEntryEditor::new("a");
        field.handle_key("\n", &KeyFlags::default(), &props, &mut panel);
        field.handle_key("", &KeyFlags { return_key: true, shift: true, ..KeyFlags::default() }, &props, &mut panel);
        field.handle_key("\x1b[13;5u", &KeyFlags::default(), &props, &mut panel);
        assert_eq!(field.draft().value, "a\n\n\n");
        assert!(panel.submits.is_empty());

        let single = TextEntryProps::default();
        let mut field = TextEntryEditor::new("key");
        field.handle_key("", &KeyFlags { return_key: true, shift: true, ..KeyFlags::default() }, &single, &mut panel);
        assert_eq!(panel.submits, ["key"], "Shift+Enter submits a single-line field");
        let mut field = TextEntryEditor::new("k");
        field.handle_key("j", &KeyFlags { ctrl: true, ..KeyFlags::default() }, &single, &mut panel);
        assert_eq!(field.draft().value, "k", "Ctrl+J is no newline in a single-line field and Ctrl keys do not type");
    }

    #[test]
    fn escape_collapses_a_selection_first_then_cancels() {
        let mut field = TextEntryEditor::new("abc");
        let mut panel = Panel::default();
        let props = TextEntryProps::default();
        let ctrl = KeyFlags { ctrl: true, ..KeyFlags::default() };
        field.handle_key("a", &ctrl, &props, &mut panel);
        assert_eq!(field.draft().selection_anchor, Some(0));
        let escape = KeyFlags { escape: true, ..KeyFlags::default() };
        field.handle_key("", &escape, &props, &mut panel);
        assert_eq!((field.draft().selection_anchor, panel.cancels), (None, 0));
        field.handle_key("", &escape, &props, &mut panel);
        assert_eq!(panel.cancels, 1);
    }

    #[test]
    fn pasted_text_and_multi_line_chunks_insert_and_reports_never_type() {
        let mut field = TextEntryEditor::new("");
        let mut panel = Panel::default();
        let props = TextEntryProps::default();
        field.handle_paste("one\r\ntwo");
        assert_eq!(field.draft().value, "one\ntwo");
        field.handle_key("x\ny", &KeyFlags::default(), &props, &mut panel);
        assert_eq!(field.draft().value, "one\ntwox\ny");
        field.handle_key("\x1b[<0;1;1M", &KeyFlags::default(), &props, &mut panel);
        field.handle_key("[?1;0c", &KeyFlags::default(), &props, &mut panel);
        field.handle_key("\x1b[13;9u", &KeyFlags::default(), &props, &mut panel);
        assert_eq!(field.draft().value, "one\ntwox\ny");
    }

    #[test]
    fn editing_chords_arrows_and_the_copy_key() {
        let mut field = TextEntryEditor::new("alpha beta");
        let mut panel = Panel::default();
        let props = TextEntryProps { has_detail: true, ..TextEntryProps::default() };
        field.handle_key("", &KeyFlags { left_arrow: true, shift: true, ..KeyFlags::default() }, &props, &mut panel);
        assert_eq!(*field.draft(), Draft::new("alpha beta", 9, Some(10)));
        field.handle_key("", &KeyFlags { home: true, ..KeyFlags::default() }, &props, &mut panel);
        assert_eq!(*field.draft(), Draft::new("alpha beta", 0, None));
        field.handle_key("", &KeyFlags { end: true, ..KeyFlags::default() }, &props, &mut panel);
        assert_eq!(field.draft().cursor, 10);
        field.handle_key("w", &KeyFlags { ctrl: true, ..KeyFlags::default() }, &props, &mut panel);
        assert_eq!(field.draft().value, "alpha ");
        field.handle_key("c", &KeyFlags { ctrl: true, ..KeyFlags::default() }, &props, &mut panel);
        assert_eq!(panel.copies, 1);
        assert!(field.take_dirty());
        assert!(!field.take_dirty());
        field.reset("fresh");
        assert_eq!(*field.draft(), Draft::new("fresh", 5, None));
    }

    #[test]
    fn up_and_down_move_by_visual_line_with_the_remembered_column() {
        let props = TextEntryProps { multiline: true, ..TextEntryProps::default() };
        let mut panel = Panel::default();
        let mut field = TextEntryEditor::new("abcdef\nab\nabcdef");
        field.set_content_width(20);
        let up = KeyFlags { up_arrow: true, ..KeyFlags::default() };
        field.handle_key("", &up, &props, &mut panel);
        assert_eq!(field.draft().cursor, 9);
        field.handle_key("", &up, &props, &mut panel);
        assert_eq!(field.draft().cursor, 6);
        field.handle_key("", &up, &props, &mut panel);
        assert_eq!(field.draft().cursor, 6, "no line above: the caret stays");
    }
}
