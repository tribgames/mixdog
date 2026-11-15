//! The bottom-panel surface (`src/tui/app/panel-surface.mjs`, `panel-epoch.mjs`): exactly one bottom panel is shown at a time,
//! and a claim proves who owns it. The state machine is filled by `nr-tui-surface-layout`; this declares what the app context
//! and the pickers agree on.

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
