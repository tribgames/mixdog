//! Terminal input: the byte stream a terminal sends becomes keys, pastes, mouse reports and focus changes, exactly as the
//! Ink fork's input pipeline delivered them to the prompt. [`Decoder`] is the entry point.

mod keypress;
mod kitty;
mod mouse;
mod parser;
mod protocol;
mod termio;

pub use keypress::{KeyEventType, KeyFlags, Keypress, decode_key, is_csi_private_reply, is_discarded_control_input, parse_keypress};
pub use kitty::{flags as kitty_flags, modifiers as kitty_modifiers};
pub use mouse::{
    MOUSE_ALT_MASK, MOUSE_CTRL_MASK, MOUSE_MOTION_MASK, MOUSE_SHIFT_MASK, MOUSE_WHEEL_MASK, MouseKind, MouseReport, is_mouse_report_sequence,
    printable_from_input,
};
pub use parser::{Decoder, InputEvent, PENDING_ESCAPE_FLUSH};
pub use protocol::{
    DISABLE_MODIFY_OTHER_KEYS, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS, POP_KITTY, supports_extended_keys, supports_extended_keys_with,
};
pub use termio::{PASTE_END, PASTE_START, Token, TokenKind, Tokenizer};
