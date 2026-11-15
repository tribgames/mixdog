//! The loading frame a bare slash command paints while its picker opens, and its release when the opener finished without
//! painting anything (`slash-dispatch/slash-panel.mjs`).

use serde_json::Value;

use super::report_failure;
use crate::slash::host::{Opener, SlashHost};

/// `openSlashPanel(command, title, open)`: claims the surface with a `Loading <title>...` frame, runs the opener, and removes
/// the frame when it is still the owner of the surface afterwards (a real picker, context or usage surface supersedes it; an
/// opener that painted nothing, an empty result or a failure, leaves the normal prompt). A failure is reported.
pub fn open_slash_panel(host: &mut dyn SlashHost, command: &str, title: &str, opener: Opener, options: Value) {
    let Some(claim) = host.paint_loading_frame(command, title) else { return };
    let opened = host.open(opener, options);
    if host.owns_surface(claim) {
        host.close_surface(claim);
    }
    if let Err(error) = opened {
        report_failure(host, &format!("{title} panel failed"), &error);
    }
}
