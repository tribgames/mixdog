//! Text-entry prompts that write provider credentials: API key, OpenAI usage session key, OAuth code. Every write is a daemon call: the prompt may only close once the write is
//! acknowledged; a rejection keeps the panel open with the entered value restored, so a transport hiccup never silently eats a
//! credential.

use serde_json::{Value, json};

use super::open_panel;
use super::panel_write::{begin, fail, finish, in_flight};
use crate::slash::host::{Opener, PromptSurface, SlashHost, TextPrompt, Tone};
use crate::slash::notices::truthy;
use crate::slash::store_service_call::service_call;

fn after_provider_save(host: &mut dyn SlashHost, target: &TextPrompt) {
    if !host.provider_after_save(target) {
        open_panel(host, Opener::ProviderSetup, json!({}));
    }
}

/// One credential write: the required-value and one-at-a-time guards, then `method(...args)`.
struct ProviderSave<'a> {
    required_notice: String,
    busy_notice: &'static str,
    method: &'static str,
    args: Vec<Value>,
    clear_caches: bool,
    failure_prefix: &'a str,
}

fn provider_save(host: &mut dyn SlashHost, target: &TextPrompt, value: &str, save: ProviderSave<'_>) -> bool {
    if value.is_empty() {
        host.push_notice(&save.required_notice, Tone::Warn);
        return false;
    }
    if in_flight(host, PromptSurface::Provider) {
        host.push_notice(save.busy_notice, Tone::Warn);
        return false;
    }
    let token = begin(host, PromptSurface::Provider, target);
    match service_call(host, save.method, save.args) {
        Ok(_) => {
            if save.clear_caches {
                host.clear_model_caches("all");
            }
            finish(host, PromptSurface::Provider, token, |host| after_provider_save(host, target));
        }
        Err(error) => {
            let message = format!("{}: {error}", save.failure_prefix);
            fail(host, PromptSurface::Provider, target, value, &message, token, Tone::Error);
        }
    }
    true
}

fn save_api_key(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    let provider_id = target.text("providerId");
    let auth_mode = target.fields.get("authMode").filter(|mode| truthy(mode));
    let args = match auth_mode {
        Some(mode) => vec![json!(provider_id), json!(command_text), json!({"authMode": mode})],
        None => vec![json!(provider_id), json!(command_text)],
    };
    provider_save(
        host,
        target,
        command_text,
        ProviderSave {
            required_notice: format!("API key is required for {provider_id}"),
            busy_notice: "API key is already being saved",
            method: "saveProviderApiKey",
            args,
            clear_caches: true,
            failure_prefix: "api key save failed",
        },
    )
}

fn save_usage_session_key(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    provider_save(
        host,
        target,
        command_text,
        ProviderSave {
            required_notice: "OpenAI usage session key is required for credit lookup".to_owned(),
            busy_notice: "OpenAI usage session key is already being saved",
            method: "saveOpenAIUsageSessionKey",
            args: vec![json!(command_text)],
            clear_caches: false,
            failure_prefix: "OpenAI usage auth save failed",
        },
    )
}

fn complete_oauth_code(host: &mut dyn SlashHost, target: &TextPrompt, command_text: &str) -> bool {
    if command_text.is_empty() {
        host.push_notice("OAuth code is required", Tone::Warn);
        return false;
    }
    if host.oauth_submitting() || target.submitting {
        host.push_notice("OAuth code is already being submitted", Tone::Warn);
        return false;
    }
    host.set_oauth_submitting(true);
    host.mark_prompt_submitting(PromptSurface::Provider, target);
    // Every exit below drops the in-flight flag: a missing login or a throw in the completion lands on the same failure path
    // as a rejected completion.
    match host.oauth_complete_code(target, command_text) {
        Ok(()) => {
            host.set_oauth_submitting(false);
            host.clear_model_caches("all");
            host.set_prompt(PromptSurface::Provider, None);
            let name = Some(target.text("providerName")).filter(|name| !name.is_empty()).unwrap_or_else(|| "OAuth".to_owned());
            host.push_notice(&format!("{name} login complete"), Tone::Info);
            if !host.oauth_success_return(target) {
                after_provider_save(host, target);
            }
        }
        Err(error) => {
            host.set_oauth_submitting(false);
            host.push_notice(&format!("oauth code failed: {error}"), Tone::Error);
            host.set_prompt(PromptSurface::Provider, None);
            host.oauth_failure_return(target, &error);
        }
    }
    true
}

/// `submitProviderPrompt(ctx, providerPrompt, commandText)`: `Some(handled)` when the prompt consumed the submit, `None` for
/// an unknown kind.
pub fn submit_provider_prompt(host: &mut dyn SlashHost, prompt: &TextPrompt, command_text: &str) -> Option<bool> {
    if host.state().command_busy {
        host.push_notice("wait for the current command to finish", Tone::Warn);
        return Some(false);
    }
    let handler: fn(&mut dyn SlashHost, &TextPrompt, &str) -> bool = match prompt.kind.as_str() {
        "api-key" => save_api_key,
        "openai-usage-session" => save_usage_session_key,
        "oauth-code" => complete_oauth_code,
        _ => return None,
    };
    Some(handler(host, prompt, command_text))
}
