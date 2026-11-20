//! The terminal layer of the native `mixdog` binary: the input decoder (the Ink fork's keypress pipeline and the
//! extended-keys gate), then the terminal modes, console, reader, guard, cell grid, painter, selection, clipboard,
//! paste and OS helpers that the other terminal tasks fill in.

pub mod clipboard;
pub mod console;
pub mod frame;
pub mod guard;
pub mod input;
pub mod modes;
pub mod os;
pub mod paint;
pub mod paste;
pub mod reader;
pub mod selection;
pub mod testing;

pub use input::{Decoder, InputEvent, KeyEventType, KeyFlags, MouseKind, MouseReport, supports_extended_keys};
