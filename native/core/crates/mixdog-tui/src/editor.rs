//! The prompt editor.
//!
//! A draft is `{value, cursor, selectionAnchor}` with offsets in UTF-16 units, the unit Node indexes strings by, so a
//! recorded session of the Node editor replays offset for offset. [`editing`] holds the pure text operations of
//! `input-editing.mjs`; [`prompt`] is the stateful editor (`PromptInput.jsx` with `key-handler.mjs`); [`text_entry`] is the
//! single-line, masked-capable editor of the text-entry panel.

pub mod chords;
pub mod draft;
pub mod editing;
pub mod escape;
pub mod helpers;
pub mod interrupt;
pub mod mouse_selection;
pub mod prompt;
pub mod render;
pub mod restore;
pub mod signals;
pub mod text_entry;
pub mod undo;

pub use draft::Draft;
pub use prompt::{PromptCallbacks, PromptEditor, PromptProps};
