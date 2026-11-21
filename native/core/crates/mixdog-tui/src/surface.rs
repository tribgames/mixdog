//! The bottom-panel surface: exactly one bottom panel is shown at a time (picker, context, usage, question, text entry, slash palette, approval), and a claim proves who owns it.
//! This file declares what the app context and the pickers agree on.

pub mod epoch;
pub mod latch;
pub mod layout;
pub mod owner;
pub mod prompt_rows;
pub mod signature;

/// What can occupy the bottom of the screen above the prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    Picker,
    Context,
    Usage,
    Question,
    TextEntry,
    SlashPalette,
    Approval,
}

/// Proof that a panel owns the surface. A later claim supersedes an earlier one: a late async picker result carrying an old
/// epoch never replaces a newer panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SurfaceClaim {
    pub kind: SurfaceKind,
    pub epoch: u64,
}
