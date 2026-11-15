//! Slash commands (`src/tui/app/slash-commands.mjs`, `slash-dispatch.mjs`, the palette and the prompt submit paths), filled by
//! `nr-tui-slash` as functions over [`AppCtx`].

use crate::app::AppCtx;

/// What the dispatch did with a submitted line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashOutcome {
    /// The line is a slash command and was handled.
    Handled,
    /// The line is not a slash command: it is a chat message.
    NotACommand,
}

/// Runs a submitted line as a slash command when it is one.
pub fn dispatch_slash(_line: &str, _ctx: &mut dyn AppCtx) -> SlashOutcome {
    SlashOutcome::NotACommand
}
