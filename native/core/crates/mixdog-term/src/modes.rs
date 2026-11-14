//! Terminal modes: the byte sequences that enter and restore the screen, mouse, paste and keyboard modes.
//! The sequences themselves come with the console task; this file carries the agreed signatures.

use crate::input::{DISABLE_MODIFY_OTHER_KEYS, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS, POP_KITTY};

/// What the environment decides about the modes (which of them the terminal gets).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModeEnv {
    /// Whether the extended-keys gate ([`crate::supports_extended_keys`]) is open.
    pub extended_keys: bool,
}

/// The set of modes a session turns on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalModes;

/// The bytes written when the session starts.
pub fn enter_sequence(env: &ModeEnv) -> String {
    if env.extended_keys {
        format!("{ENABLE_KITTY_KEYBOARD}{ENABLE_MODIFY_OTHER_KEYS}")
    } else {
        String::new()
    }
}

/// The bytes written when the session ends or the terminal is handed to another program.
pub fn restore_sequence(env: &ModeEnv) -> String {
    if env.extended_keys {
        format!("{POP_KITTY}{DISABLE_MODIFY_OTHER_KEYS}")
    } else {
        String::new()
    }
}
