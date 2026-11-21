//! The terminal UI of the native `mixdog` binary.
//!
//! [`editor`] is the prompt editor and the inline text-entry editor (ported from `src/tui/input-editing.mjs`,
//! `components/PromptInput.jsx`, `components/prompt-input/*` and the editor of `components/TextEntryPanel.jsx`). The other
//! modules are the panel surface, slash dispatch, pickers, panels, footer, transcript, mouse, handlers, history, view,
//! application state and the run loop.

pub mod app;
pub mod editor;
pub mod footer;
pub mod handlers;
pub mod history;
pub mod mouse;
pub mod panels;
pub mod pickers;
pub mod run;
pub mod slash;
pub mod surface;
pub mod transcript;
pub mod view;
