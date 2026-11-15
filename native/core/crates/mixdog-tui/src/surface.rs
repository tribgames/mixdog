//! The bottom-panel surface (`src/tui/app/panel-surface.mjs`, `panel-epoch.mjs`): exactly one bottom panel is shown at a time
//! (picker, context, usage, question, text entry, slash palette, approval), and a claim proves who owns it.
//!
//! * [`epoch`]: the supersession counter and the handover rule (a late async picker result never replaces a newer panel).
//! * [`owner`]: the panel owner and its claims (`createPanelSurface`, `usePanelOwnership`), the usage generation.
//! * [`latch`]: the Enter latch and the index-mode carry-over of every picker state update.
//! * [`signature`]: the grammar of the `|`-joined layout signature.
//! * [`layout`]: the shell layout, its row budgets, the viewport carve and the panel transition of a commit.
//! * [`prompt_rows`]: the row counts the prompt box and the text entry reserve.
//!
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
