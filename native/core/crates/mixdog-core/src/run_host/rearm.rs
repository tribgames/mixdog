//! What a compaction re-arms for the model (`session-ops.mjs` `compact`, after the compaction):
//! the late MCP tool announcements and the prompt-settings notice older turns carried, which the
//! compaction stripped. Each works on the session's stored header, as Node's works on the live
//! session; the caller writes the changed header back.

use std::collections::HashSet;

use mixdog_core_session::session::thread_switches::merge_deferred_delta;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::route_surface::is_agent_owner;
use super::tool_surface::{clean, fixed_surface_session, parse_tool_selection, permitted_by_session_policy, roster_permits, tool_name, truthy};

/// `rearmLateDeferredTools`: forgets which servers' instruction text was delivered (the compaction
/// dropped the load results that carried it), and re-announces, by name, every connected late tool
/// the boot manifest never listed and the session has not loaded or discovered. Only a session
/// whose prompt is never rebuilt at a cold point (a delegated worker, or a prompt without a
/// recorded identity) is re-armed. Returns the re-armed names.
pub fn rearm_late_deferred_tools(header: &mut Header, now: i64) -> Option<Vec<String>> {
    header.shift_remove("mcpInstructionsAnnounced");
    header.shift_remove("mcpInstructionHashes");
    let session = Value::Object(header.clone());
    if !header.get("tools").is_some_and(Value::is_array) || fixed_surface_session(&session) {
        return None;
    }
    if truthy(header.get("promptIdentity")) && !is_agent_owner(&session) {
        return None;
    }
    let announced = header.get("deferredAnnouncedTools")?.as_array()?;
    // Listed in the boot manifest, or already loaded/discovered: still visible.
    let mut listed: HashSet<String> = announced.iter().filter_map(|name| name.as_str().map(str::to_owned)).collect();
    listed.extend(session["tools"].as_array().into_iter().flatten().map(|tool| clean(tool.get("name"))).filter(|name| !name.is_empty()));
    listed.extend(parse_tool_selection(header.get("deferredCallableTools")));
    listed.extend(parse_tool_selection(header.get("deferredDiscoveredTools")));
    let connected: HashSet<&str> = header.get("deferredMcpToolNames").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let mut added = Vec::new();
    for tool in header.get("deferredLateToolCatalog").and_then(Value::as_array).into_iter().flatten() {
        let name = tool_name(tool);
        if name.is_empty() || listed.contains(&name) || !roster_permits(&session, tool) {
            continue;
        }
        // MCP tools while connected; a built-in a settings gate opened while permitted.
        let available = if name.starts_with("mcp__") { connected.contains(name.as_str()) } else { permitted_by_session_policy(&session, &name) };
        if available {
            // Names only: the model was told the description before.
            added.push((name, String::new()));
        }
    }
    if added.is_empty() {
        return None;
    }
    merge_deferred_delta(header, &added, &[], now);
    Some(added.into_iter().map(|(name, _)| name).collect())
}

/// `rearmPromptSettingsNotice`: the compaction dropped the notices the model was told, so a
/// delegated worker (a lead thread folds its settings into the rebuilt prompt) is told the
/// difference again at the next reconcile, in compact form.
pub fn rearm_prompt_settings_notice(header: &mut Header) -> bool {
    if truthy(header.get("promptIdentity")) && !is_agent_owner(&Value::Object(header.clone())) {
        return false;
    }
    if !truthy(header.get("promptSettingsTold")) && !truthy(header.get("promptSettingsNotice")) {
        return false;
    }
    header.shift_remove("promptSettingsTold");
    header.shift_remove("promptSettingsNotice");
    header.insert("promptSettingsRecheck".into(), Value::String("compact".into()));
    true
}

#[cfg(test)]
mod tests;
