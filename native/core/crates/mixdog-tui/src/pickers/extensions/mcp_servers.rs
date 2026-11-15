//! The MCP servers list (`extension-pickers/mcp-servers-picker.mjs`): enable and disable toggles reopen the list
//! optimistically, and a settle repaints only while it is still the newest toggle and the MCP picker is still on screen.

use serde_json::{Value, json};

use super::Extensions;
use super::panel::{
    Action, ExtItem, ExtPanel, ExtensionsHost, Handler, MarkerTone, claim, or_text, read_status, status_list, with_scope,
};
use crate::slash::host::{PromptSurface, Tone};
use crate::slash::notices::truthy;

/// A toggle the list has painted optimistically and the store call it waits for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToggleCall {
    token: u64,
    pub name: String,
    pub target: bool,
}

fn server_description(server: &Value, pending: Option<bool>) -> String {
    let transport = or_text(server, "transport", "unknown");
    if let Some(enabled) = pending {
        return format!("{}\u{2026} \u{b7} {transport}", if enabled { "enabling" } else { "disabling" });
    }
    let error = server.get("error").filter(|error| truthy(error)).map_or_else(String::new, |error| format!(" \u{b7} {}", crate::slash::notices::value_text(error)));
    let name = or_text(server, "name", "");
    let sign_in = if server.get("authRequired").is_some_and(truthy) {
        format!(" \u{b7} sign-in required: /mcp login {name}")
    } else {
        String::new()
    };
    let tools = or_text(server, "toolCount", "0");
    with_scope(
        &format!(
            "{} \u{b7} {} \u{b7} {transport} \u{b7} {tools} tools{error}{sign_in}",
            or_text(server, "source", "config"),
            or_text(server, "status", "unknown"),
        ),
        server,
    )
}

fn server_items(servers: &[Value], optimistic: Option<&(String, bool)>) -> Vec<ExtItem> {
    let mut items = Vec::new();
    if servers.is_empty() {
        items.push(ExtItem::new("empty", "No MCP servers", "no configured MCP servers", Action::Noop));
    }
    for server in servers {
        let name = or_text(server, "name", "");
        let pending = optimistic.filter(|(pending, _)| *pending == name).map(|(_, enabled)| *enabled);
        let enabled = pending.unwrap_or_else(|| server.get("enabled") != Some(&Value::Bool(false)));
        let mut item = ExtItem::new(&format!("server:{name}"), &name, &server_description(server, pending), Action::Server { name: name.clone(), enabled });
        item.marker = if enabled { "\u{25cf}" } else { "\u{25cb}" }.to_owned();
        item.marker_tone = Some(if enabled { MarkerTone::Success } else { MarkerTone::Inactive });
        items.push(item);
    }
    items
}

impl Extensions {
    /// `openMcpServersPicker({ highlightValue, optimistic })`.
    pub fn open_mcp_servers(&mut self, host: &mut dyn ExtensionsHost, highlight: Option<&str>, optimistic: Option<(String, bool)>) {
        // Surface claim: the status read below is a daemon round-trip, so Esc can land before this panel ever paints.
        let mut own = claim(host);
        let Some(status) = read_status(host, "mcpStatus", "servers", "mcp status") else { return };
        let items = server_items(&status_list(&status, "servers"), optimistic.as_ref());
        if !host.owns(own) {
            return;
        }
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        let mut panel = ExtPanel::new("MCP servers", "Enable or disable configured MCP servers.", items, Handler::McpServers).with_kind("mcp-servers");
        panel.initial_index = highlight.and_then(|value| panel.items.iter().position(|item| item.value == value)).unwrap_or(0);
        host.paint(&mut own, Some(panel));
        self.mcp_active = true;
    }

    /// The first half of a toggle: bumps the settle token and reopens the list with the row flipped and its status pending.
    /// The caller issues `setMcpServerEnabled(name, target)` and hands the answer to [`finish_toggle`](Self::finish_toggle).
    pub fn begin_toggle(&mut self, host: &mut dyn ExtensionsHost, item: &ExtItem) -> Option<ToggleCall> {
        let Action::Server { name, enabled } = &item.action else { return None };
        if name.is_empty() {
            return None;
        }
        self.mcp_epoch += 1;
        let call = ToggleCall { token: self.mcp_epoch, name: name.clone(), target: !enabled };
        self.open_mcp_servers(host, Some(&format!("server:{name}")), Some((call.name.clone(), call.target)));
        Some(call)
    }

    /// The second half: the store answered. A rejection is reported; either way the row is refreshed, but only while this is
    /// still the newest toggle and the MCP picker is still on screen. (Per-server serialization in the runtime already
    /// converged rapid re-toggles to the last requested state.)
    pub fn finish_toggle(&mut self, host: &mut dyn ExtensionsHost, call: ToggleCall, result: Result<Value, String>) {
        if let Err(error) = result {
            host.push_notice(&format!("mcp toggle failed: {error}"), Tone::Error);
        }
        if call.token != self.mcp_epoch || !self.mcp_active || host.picker_kind().as_deref() != Some("mcp-servers") {
            return;
        }
        self.open_mcp_servers(host, Some(&format!("server:{}", call.name)), None);
    }

    /// A toggle run to its end by a host that answers store calls in line.
    pub(super) fn toggle_server(&mut self, host: &mut dyn ExtensionsHost, item: &ExtItem) {
        let Some(call) = self.begin_toggle(host, item) else { return };
        let result = host.store_call("setMcpServerEnabled", json!([call.name, call.target]));
        self.finish_toggle(host, call, result);
    }
}
