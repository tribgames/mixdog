//! One acknowledged daemon write at a time per text-entry surface: `begin` marks the prompt submitting, `finish` closes it only
//! while the write still owns the surface, `fail` restores the typed value instead of losing it.
//!
//! The in-flight writes are the host's (`write_token`). Each token is the panel epoch its write owns, so a write stops blocking the
//! moment the user takes the surface back (Esc or close supersedes the epoch).

use crate::slash::host::{PromptSurface, SlashHost, TextPrompt, Tone};

/// `inFlight()`: a write of `surface` is running and still owns its epoch.
pub fn in_flight(host: &dyn SlashHost, surface: PromptSurface) -> bool {
    let token = host.write_token(surface);
    token > 0 && host.is_panel_epoch_current(token)
}

/// `begin(target)`: a new submit supersedes every older in-flight write of the surface; the prompt shows as submitting.
pub fn begin(host: &mut dyn SlashHost, surface: PromptSurface, target: &TextPrompt) -> u64 {
    let token = host.supersede_panel_epoch();
    host.set_write_token(surface, token);
    host.mark_prompt_submitting(surface, target);
    token
}

/// `end(token)`: the write is over.
pub fn end(host: &mut dyn SlashHost, surface: PromptSurface, token: u64) {
    if host.write_token(surface) == token {
        host.set_write_token(surface, 0);
    }
}

/// `finish(token, after)`: a stale acknowledgement (a newer submit, or the user closed the prompt) never closes or navigates
/// a surface this write no longer owns.
pub fn finish(host: &mut dyn SlashHost, surface: PromptSurface, token: u64, after: impl FnOnce(&mut dyn SlashHost)) {
    end(host, surface, token);
    if !host.is_panel_epoch_current(token) {
        return;
    }
    host.set_prompt(surface, None);
    after(host);
}

/// `fail(target, value, message, token, tone)`: a rejected write keeps the prompt open with the typed value restored (the
/// epoch remounts the editor, so an identical retry value still re-seeds it) instead of closing and losing the entry.
pub fn fail(host: &mut dyn SlashHost, surface: PromptSurface, target: &TextPrompt, value: &str, message: &str, token: u64, tone: Tone) {
    end(host, surface, token);
    host.push_notice(message, tone);
    if !host.is_panel_epoch_current(token) {
        return;
    }
    // The restored panel now owns the surface.
    host.supersede_panel_epoch();
    let mut restored = target.clone();
    restored.submitting = false;
    restored.initial_value = Some(value.to_owned());
    restored.restore_epoch = target.restore_epoch + 1;
    host.set_prompt(surface, Some(restored));
}
