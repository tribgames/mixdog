//! The prompt submit dispatcher (`src/tui/app/prompt-submit.mjs`): one entry point for everything the prompt box accepts, the
//! provider and settings text-entry prompts, slash commands, and the normal chat submit with pasted image and text token
//! expansion.

pub mod chat;
pub mod panel_write;
pub mod provider;
pub mod settings;

use mixdog_js::js_trim;
use mixdog_term::paste::PromptContent;
use serde_json::Value;

use super::host::{Opener, SlashHost, SubmitOptions, Tone};
use super::notices::truthy;

/// `openPanel(open, ...args)`: opens a picker; a failure to open is reported instead of escaping (an unhandled rejection
/// terminated the Node TUI).
pub(crate) fn open_panel(host: &mut dyn SlashHost, opener: Opener, options: Value) {
    if let Err(error) = host.open(opener, options) {
        host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
    }
}

/// `submitPrompt(prompt, options)`: hands the prompt to the session service. Input clearing stays synchronous; the service's
/// acknowledgement is responsible for durable intake while provider execution continues independently.
pub(crate) fn submit_prompt(host: &mut dyn SlashHost, content: &PromptContent, options: &SubmitOptions) -> bool {
    if !host.has_store_method("submitAsync") {
        return match host.store_submit("submit", content, options) {
            Ok(accepted) => truthy(&accepted),
            Err(error) => {
                host.push_notice(&format!("prompt submit failed: {error}"), Tone::Error);
                false
            }
        };
    }
    match host.store_submit("submitAsync", content, options) {
        Ok(Value::Bool(false)) => host.push_notice("prompt was not accepted by the session service", Tone::Error),
        Ok(_) => {}
        Err(error) => host.push_notice(&format!("prompt submit failed: {error}"), Tone::Error),
    }
    true
}

/// `createPromptSubmit(deps).onSubmit(raw)`: answers whether the prompt was consumed (`false` keeps the draft).
pub fn on_submit(host: &mut dyn SlashHost, raw: &str) -> bool {
    let command_text = js_trim(raw);
    if let Some(prompt) = host.provider_prompt() {
        if let Some(handled) = provider::submit_provider_prompt(host, &prompt, command_text) {
            return handled;
        }
    }
    // Channel token/target and hook-rule text prompts are retired (channels moved to the PWA, hooks lost their user-facing
    // surface), so no opener sets those prompts.
    if let Some(prompt) = host.settings_prompt() {
        if let Some(handled) = settings::submit_settings_prompt(host, &prompt, command_text) {
            return handled;
        }
    }
    if command_text.is_empty() {
        return false;
    }
    if command_text.starts_with('/') {
        return chat::submit_slash_command(host, command_text);
    }
    chat::submit_chat(host, raw)
}
