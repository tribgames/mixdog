//! Draft edits shared verbatim by the prompt and the text-entry editor (`components/prompt-input/edit-chords.mjs`).

use mixdog_term::KeyFlags;

use super::draft::Draft;
use super::editing::{
    delete_backward_word, delete_forward_word, delete_to_line_end, delete_to_line_start, move_cursor, next_offset, next_word_offset, previous_offset,
    previous_word_offset,
};
use super::helpers::{delete_backward_char, delete_forward_char};

/// Character and word motion and deletion chords. Returns the edited draft when the key was one of them, or none to let
/// the caller keep dispatching. `input_key` is the lower-cased input.
pub fn apply_edit_chord(key: &KeyFlags, input_key: &str, draft: &Draft) -> Option<Draft> {
    let extend = key.shift;
    // Ctrl+B / Ctrl+F: character left / right.
    if key.ctrl && input_key == "b" {
        return Some(move_cursor(draft, previous_offset(&draft.value, draft.cursor), extend));
    }
    if key.ctrl && input_key == "f" {
        return Some(move_cursor(draft, next_offset(&draft.value, draft.cursor), extend));
    }
    // Alt/Option+B / +F: word left / right.
    if key.meta && input_key == "b" {
        return Some(move_cursor(draft, previous_word_offset(&draft.value, draft.cursor), extend));
    }
    if key.meta && input_key == "f" {
        return Some(move_cursor(draft, next_word_offset(&draft.value, draft.cursor), extend));
    }
    // Ctrl+U / Ctrl+K: delete to line start / end.
    if key.ctrl && input_key == "u" {
        return Some(delete_to_line_start(draft));
    }
    if key.ctrl && input_key == "k" {
        return Some(delete_to_line_end(draft));
    }
    // Ctrl+W / Alt+Backspace: delete the previous word.
    if (key.ctrl && input_key == "w") || ((key.ctrl || key.meta) && key.backspace) {
        return Some(delete_backward_word(draft));
    }
    // Alt+D / Ctrl+Delete: delete the next word.
    if (key.meta && input_key == "d") || (key.ctrl && key.delete) {
        return Some(delete_forward_word(draft));
    }
    if key.backspace {
        return Some(delete_backward_char(draft));
    }
    if key.delete {
        return Some(delete_forward_char(draft));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(f: impl FnOnce(&mut KeyFlags)) -> KeyFlags {
        let mut flags = KeyFlags::default();
        f(&mut flags);
        flags
    }

    #[test]
    fn chords_move_and_delete() {
        let draft = Draft::new("alpha beta", 10, None);
        let ctrl_b = key(|k| k.ctrl = true);
        assert_eq!(apply_edit_chord(&ctrl_b, "b", &draft), Some(Draft::new("alpha beta", 9, None)));
        let alt_b_shift = key(|k| {
            k.meta = true;
            k.shift = true;
        });
        assert_eq!(apply_edit_chord(&alt_b_shift, "b", &draft), Some(Draft::new("alpha beta", 6, Some(10))));
        assert_eq!(apply_edit_chord(&key(|k| k.ctrl = true), "w", &draft), Some(Draft::new("alpha ", 6, None)));
        let alt = key(|k| k.meta = true);
        assert_eq!(apply_edit_chord(&alt, "d", &Draft::new("ab cd", 0, None)), Some(Draft::new(" cd", 0, None)));
        let backspace = key(|k| k.backspace = true);
        assert_eq!(apply_edit_chord(&backspace, "", &draft), Some(Draft::new("alpha bet", 9, None)));
        assert_eq!(apply_edit_chord(&key(|k| k.ctrl = true), "x", &draft), None);
        assert_eq!(apply_edit_chord(&KeyFlags::default(), "b", &draft), None);
    }
}
