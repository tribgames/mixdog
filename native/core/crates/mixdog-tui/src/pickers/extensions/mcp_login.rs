//! `/mcp login <name>` and `/mcp logout <name>` (`extension-pickers/mcp-login.mjs`). The sign-in URL is always printed (and
//! kept in the live prompt); the runtime may open the browser. The flow is polled while a paste prompt (the shared
//! `oauth-code` provider prompt) accepts the final redirect address. Pasted text is never echoed.
//!
//! The prompt the flow shows carries the flow's id in the field [`FLOW_FIELD`]. The shared prompt handler answers its
//! callbacks through this module: [`McpLogin::complete_code`] for the pasted address, [`McpLogin::failure_return`] after a
//! rejected paste (the prompt comes back), [`McpLogin::cancel`] when the prompt is dismissed; its success return does
//! nothing (the notice is pushed here and no provider picker follows).

use serde_json::{Value, json};

use super::panel::ExtensionsHost;
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{first_truthy_text, truthy, value_text};

/// How often an active flow is asked for its state.
pub const POLL_MS: u64 = 1500;

/// The field of the `oauth-code` prompt that names the flow it belongs to.
pub const FLOW_FIELD: &str = "mcpFlowId";

#[derive(Clone, Debug, PartialEq)]
struct Flow {
    id: String,
    name: String,
    url: String,
    prompt: Option<TextPrompt>,
    /// When the next poll is due.
    due_ms: u64,
}

/// The one active MCP sign-in.
#[derive(Debug, Default)]
pub struct McpLogin {
    active: Option<Flow>,
}

/// Whether `prompt` is the paste prompt of an MCP sign-in.
pub fn is_login_prompt(prompt: &TextPrompt) -> bool {
    prompt.kind == "oauth-code" && prompt.fields.contains_key(FLOW_FIELD)
}

fn close_prompt(host: &mut dyn ExtensionsHost, flow: &Flow) {
    if flow.prompt.is_some() && host.provider_prompt() == flow.prompt {
        host.set_prompt(PromptSurface::Provider, None);
    }
}

impl McpLogin {
    /// When the next poll of the active flow is due.
    pub fn poll_due_at(&self) -> Option<u64> {
        self.active.as_ref().map(|flow| flow.due_ms)
    }

    fn show_prompt(&mut self, host: &mut dyn ExtensionsHost) {
        let Some(flow) = self.active.as_mut() else { return };
        let mut prompt = TextPrompt::new("oauth-code");
        prompt.label = format!("MCP sign-in \u{b7} {}", flow.name);
        prompt.hint = "If the browser page fails to load, paste its address here.".to_owned();
        prompt.fields.insert("providerName".to_owned(), Value::String(format!("MCP {}", flow.name)));
        prompt.fields.insert("detail".to_owned(), Value::String(flow.url.clone()));
        prompt.fields.insert(FLOW_FIELD.to_owned(), Value::String(flow.id.clone()));
        flow.prompt = Some(prompt.clone());
        host.set_prompt(PromptSurface::Provider, Some(prompt));
    }

    /// `loginMcpServer(name)`: starts the flow (cancelling a previous one), prints the URL and shows the paste prompt.
    pub fn login(&mut self, host: &mut dyn ExtensionsHost, name: &str) {
        if let Some(previous) = self.active.take() {
            close_prompt(host, &previous);
            // Best effort: a failed cancel is not reported.
            let _ = host.store_call("cancelMcpOAuthLogin", json!([previous.id]));
        }
        let started = match host.store_call("beginMcpOAuthLogin", json!([name, {"openBrowser": true}])) {
            Ok(started) => started,
            Err(error) => {
                host.push_notice(&format!("MCP sign-in failed for {name}: {error}"), Tone::Error);
                return;
            }
        };
        if started.is_null() {
            let error = "Cannot read properties of null (reading 'flowId')";
            host.push_notice(&format!("MCP sign-in failed for {name}: {error}"), Tone::Error);
            return;
        }
        if started.get("state").and_then(Value::as_str) == Some("complete") {
            host.push_notice(&format!("MCP sign-in complete for {name}"), Tone::Info);
            return;
        }
        let url = started.get("url").filter(|url| truthy(url)).map(value_text).unwrap_or_default();
        let id = started.get("flowId").map_or_else(|| "undefined".to_owned(), value_text);
        self.active = Some(Flow { id, name: name.to_owned(), url: url.clone(), prompt: None, due_ms: host.now_ms() + POLL_MS });
        if !url.is_empty() {
            host.push_notice(&format!("Sign in to {name}: {url}"), Tone::Info);
        }
        self.show_prompt(host);
    }

    /// The paste prompt's `completeCode(text)`: `Err` carries what the prompt reports (the redirect address was rejected, or
    /// the sign-in did not complete).
    pub fn complete_code(&mut self, host: &mut dyn ExtensionsHost, text: &str) -> Result<(), String> {
        let Some(flow) = self.active.as_ref() else { return Err("MCP sign-in is no longer active".to_owned()) };
        let result = host.store_call("completeMcpOAuthLogin", json!([flow.id, text]))?;
        if result.get("state").and_then(Value::as_str) != Some("complete") {
            return Err(first_truthy_text(&result, &["error"]).unwrap_or_else(|| "sign-in did not complete".to_owned()));
        }
        self.active = None;
        Ok(())
    }

    /// The prompt's `failureReturn`: a rejected paste shows the prompt again.
    pub fn failure_return(&mut self, host: &mut dyn ExtensionsHost) {
        self.show_prompt(host);
    }

    /// The prompt's `cancel`: the user dismissed it.
    pub fn cancel(&mut self, host: &mut dyn ExtensionsHost) {
        let Some(flow) = self.active.take() else { return };
        let _ = host.store_call("cancelMcpOAuthLogin", json!([flow.id]));
        host.push_notice(&format!("MCP sign-in cancelled for {}", flow.name), Tone::Info);
    }

    /// The poll timer fired: asks the flow's state; a pending flow is polled again, any other end closes the prompt and says
    /// how it ended. Does nothing before the poll is due.
    pub fn poll(&mut self, host: &mut dyn ExtensionsHost) {
        let Some(flow) = self.active.as_ref() else { return };
        if host.now_ms() < flow.due_ms {
            return;
        }
        let status = host.store_call("getMcpOAuthLoginStatus", json!([flow.id]));
        let Some(flow) = self.active.take() else { return };
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                close_prompt(host, &flow);
                host.push_notice(&format!("MCP sign-in failed for {}: {error}", flow.name), Tone::Error);
                return;
            }
        };
        let state = status.get("state").and_then(Value::as_str).unwrap_or_default();
        if state == "pending" {
            let due_ms = host.now_ms() + POLL_MS;
            self.active = Some(Flow { due_ms, ..flow });
            return;
        }
        close_prompt(host, &flow);
        let name = &flow.name;
        match state {
            "complete" => host.push_notice(&format!("MCP sign-in complete for {name}"), Tone::Info),
            "cancelled" => host.push_notice(&format!("MCP sign-in cancelled for {name}"), Tone::Info),
            _ => {
                let error = first_truthy_text(&status, &["error"]).map(|error| format!(": {error}")).unwrap_or_default();
                host.push_notice(&format!("MCP sign-in failed for {name}{error}"), Tone::Error);
            }
        }
    }

    /// `logoutMcpServer(name)`.
    pub fn logout(&mut self, host: &mut dyn ExtensionsHost, name: &str) {
        match host.store_call("signOutMcpServer", json!([name])) {
            Ok(_) => host.push_notice(&format!("MCP signed out of {name}"), Tone::Info),
            Err(error) => host.push_notice(&format!("MCP sign-out failed for {name}: {error}"), Tone::Error),
        }
    }
}
