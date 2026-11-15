//! The pickers (`src/tui/app/create-app-pickers.mjs` and the picker factories), filled in wave 6.

pub mod common;
pub mod extensions;
pub mod model;
pub mod provider;
pub mod settings;

/// Which picker is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerKind {
    Model,
    Provider,
    Settings,
    Extensions,
}
