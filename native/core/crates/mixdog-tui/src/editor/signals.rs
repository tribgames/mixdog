//! Raw terminal byte classification for the prompt editor (`components/prompt-input/key-signals.mjs`): the arrow and
//! modifier signals the key dispatch branches on, and the byte sequences that are terminal reports rather than text.
//!
//! The fork's input pipeline does not decode the `;2` (shift) or `;6` (ctrl+shift) modifier of an arrow, so those chords
//! arrive as raw input and are matched here. The report classifiers are the decoder's own (`mixdog_term::input`).

use mixdog_term::KeyFlags;
pub use mixdog_term::input::{
    is_csi_private_reply, is_discarded_control_input, is_mouse_report_sequence, printable_from_input,
};

/// The arrow, shift and ctrl+shift signals of one `(input, key)` event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ArrowSignals {
    pub ctrl_shift_held: bool,
    pub raw_ctrl_shift_down: bool,
    pub raw_ctrl_shift_left: bool,
    pub raw_ctrl_shift_right: bool,
    pub raw_ctrl_shift_up: bool,
    pub raw_down_arrow: bool,
    /// Any raw Shift or Ctrl+Shift arrow chord (the grid-selection hand-off signal).
    pub raw_shift_arrow_for_grid: bool,
    pub raw_shift_down: bool,
    pub raw_shift_left: bool,
    pub raw_shift_right: bool,
    pub raw_shift_up: bool,
    pub raw_up_arrow: bool,
    pub shift_held: bool,
}

pub fn decode_arrow_signals(raw: &str, key: &KeyFlags) -> ArrowSignals {
    let raw_up_arrow = matches!(raw, "\x1b[A" | "\x1bOA" | "[A" | "OA");
    let raw_down_arrow = matches!(raw, "\x1b[B" | "\x1bOB" | "[B" | "OB");
    // Shift+Arrow: xterm `ESC [ 1 ; 2 <dir>` and rxvt `ESC [ <dir>` in lower case.
    let raw_shift_up = matches!(raw, "\x1b[1;2A" | "\x1b[a" | "[1;2A");
    let raw_shift_down = matches!(raw, "\x1b[1;2B" | "\x1b[b" | "[1;2B");
    let raw_shift_right = matches!(raw, "\x1b[1;2C" | "\x1b[c" | "[1;2C");
    let raw_shift_left = matches!(raw, "\x1b[1;2D" | "\x1b[d" | "[1;2D");
    // Ctrl+Shift+Arrow: modifier 6 (1 + shift 1 + ctrl 4), in the xterm form and in kitty's default arrow form.
    let raw_ctrl_shift_up = matches!(raw, "\x1b[1;6A" | "[1;6A");
    let raw_ctrl_shift_down = matches!(raw, "\x1b[1;6B" | "[1;6B");
    let raw_ctrl_shift_right = matches!(raw, "\x1b[1;6C" | "[1;6C");
    let raw_ctrl_shift_left = matches!(raw, "\x1b[1;6D" | "[1;6D");
    let any_arrow = key.left_arrow || key.right_arrow || key.up_arrow || key.down_arrow;
    let ctrl_shift_held = raw_ctrl_shift_up
        || raw_ctrl_shift_down
        || raw_ctrl_shift_left
        || raw_ctrl_shift_right
        || (key.shift && key.ctrl && any_arrow);
    let raw_shift_arrow_for_grid = raw_shift_up
        || raw_shift_down
        || raw_shift_right
        || raw_shift_left
        || raw_ctrl_shift_up
        || raw_ctrl_shift_down
        || raw_ctrl_shift_right
        || raw_ctrl_shift_left;
    ArrowSignals {
        ctrl_shift_held,
        raw_ctrl_shift_down,
        raw_ctrl_shift_left,
        raw_ctrl_shift_right,
        raw_ctrl_shift_up,
        raw_down_arrow,
        raw_shift_arrow_for_grid,
        raw_shift_down,
        raw_shift_left,
        raw_shift_right,
        raw_shift_up,
        raw_up_arrow,
        shift_held: key.shift || raw_shift_arrow_for_grid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_shift_and_ctrl_shift_arrows_fold_into_the_held_signals() {
        let none = KeyFlags::default();
        let shift_up = decode_arrow_signals("\x1b[1;2A", &none);
        assert!(shift_up.raw_shift_up && shift_up.shift_held && shift_up.raw_shift_arrow_for_grid);
        assert!(!shift_up.ctrl_shift_held);
        let ctrl_shift_left = decode_arrow_signals("[1;6D", &none);
        assert!(ctrl_shift_left.raw_ctrl_shift_left && ctrl_shift_left.ctrl_shift_held && ctrl_shift_left.shift_held);
        let plain = decode_arrow_signals("\x1bOA", &none);
        assert!(plain.raw_up_arrow && !plain.shift_held);
        let decoded = KeyFlags { shift: true, ctrl: true, left_arrow: true, ..KeyFlags::default() };
        assert!(decode_arrow_signals("", &decoded).ctrl_shift_held);
        assert!(!decode_arrow_signals("x", &none).shift_held);
    }

    #[test]
    fn terminal_reports_are_not_text() {
        assert!(is_mouse_report_sequence("\x1b[<64;55;22M"));
        assert!(is_mouse_report_sequence("[<0;1;1m"));
        assert!(!is_mouse_report_sequence("[<hello"));
        assert!(is_csi_private_reply("\x1b[?7u"));
        assert!(is_csi_private_reply("[?1;0c"));
        assert!(!is_csi_private_reply("\x1b[13;2u"));
        assert!(is_discarded_control_input("\0"));
        assert!(is_discarded_control_input("\x1b[32;5u"));
        assert_eq!(printable_from_input("a\x1b[<0;1;1Mb\r\n"), "ab");
    }
}
