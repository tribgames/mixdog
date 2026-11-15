//! `runSlashCommand` (`src/tui/app/slash-dispatch.mjs`): the slash-command dispatcher.
//!
//! Commands are a table keyed by the normalized name ([`route`], [`session`], [`panel`]); every handler gets the host and the
//! raw argument. The Node dispatcher was a factory closing over live state and injected openers; here the host is the
//! [`SlashHost`] the caller passes.

pub mod panel;
pub mod route;
pub mod session;
pub mod slash_panel;

use super::commands::normalize_slash_command_name;
use super::host::{SlashHost, Tone};

/// A command handler: the host, the argument and the name as typed (lowercased); answers whether the command ran.
type Handler = fn(&mut dyn SlashHost, &str, &str) -> bool;

fn handler_for(name: &str) -> Option<Handler> {
    route::handler(name).or_else(|| session::handler(name)).or_else(|| panel::handler(name))
}

/// `runSlashCommand(cmd, arg)`: runs the command and answers whether it ran (`false` when a busy guard refused it).
/// An unknown command is reported and counts as handled.
pub fn run_slash_command(host: &mut dyn SlashHost, cmd: &str, arg: &str) -> bool {
    let raw_name = mixdog_js::js_to_lowercase(cmd);
    let cmd = normalize_slash_command_name(cmd);
    // Synchronous dispatch of the command the user just submitted: this action owns the surface it clears.
    if cmd != "context" {
        host.clear_context_panel();
    }
    if cmd != "usage" {
        host.close_usage_panel();
    }
    match handler_for(&cmd) {
        Some(handler) => handler(host, arg, &raw_name),
        None => {
            host.push_notice(&format!("unknown command: /{cmd}"), Tone::Warn);
            true
        }
    }
}

/// Reports a failed call as `<prefix>: <error>`.
pub(crate) fn report_failure(host: &mut dyn SlashHost, prefix: &str, error: &str) {
    host.push_notice(&format!("{prefix}: {error}"), Tone::Error);
}
