//! The MCP half of the deferred tool surface (Node `runtime-core/tool-catalog.mjs`:
//! `refreshInitialDeferredMcpSurface` and `reconcileDeferredMcpToolCatalog`), run at a turn start by
//! `surface_host.rs` the way Node's `foldMcpSurface` (`session-runtime/turn/turn-run/turn-prepare.mjs`)
//! and the request boundary (`session/loop/request-boundary.mjs`) run them.
//!
//! * The FIRST turn of a fresh thread (`deferredInitialRefreshPending`) re-folds the live MCP registry into
//!   the initial provider-visible surface: the boot catalog, the prompt's deferred-tool block (rebuilt in
//!   place) and the announced set, before anything was sent.
//! * Every turn then reconciles the late pool (`deferredLateToolCatalog`), the connected names
//!   (`deferredMcpToolNames`) and the pending deferred-tools delta with the live registry.
//!
//! A session is its stored object (`Value`) with its `tools` and `messages`, changed in place as
//! Node's live session is; the caller turns the result into a header change.

use std::collections::{HashMap, HashSet};

use mixdog_agent::env::Clock;
use mixdog_core_session::session::thread_switches::merge_deferred_delta_with_servers;
use mixdog_js::{js_trim, js_words};
use mixdog_mcp::permissions::parse_mcp_tool_name;
use serde_json::{json, Value};

use super::deferred_manifest::{apply_initial_manifest, listed_deferred_tool_names};
use super::tool_surface::{
    clean, clean_list, filter_disallowed_tools, fixed_surface_session, map_mut, names_value, parse_tool_selection, rendered_manifest, roster_permits,
    sorted_catalog_by_measured_usage, tool_name, tools_of, unique, ToolSurface,
};

/// `isMcpToolName` of `tool-catalog.mjs`.
fn is_mcp(name: &str) -> bool {
    name.starts_with("mcp__")
}

/// A JavaScript `Map` of tools by name: setting a known name replaces the value where it stands.
#[derive(Default)]
struct ByName {
    order: Vec<(String, Value)>,
    at: HashMap<String, usize>,
}

impl ByName {
    fn has(&self, name: &str) -> bool {
        self.at.contains_key(name)
    }

    fn get(&self, name: &str) -> Option<&Value> {
        self.at.get(name).map(|&index| &self.order[index].1)
    }

    fn set(&mut self, name: String, tool: Value) {
        match self.at.get(&name) {
            Some(&index) => self.order[index].1 = tool,
            None => {
                self.at.insert(name.clone(), self.order.len());
                self.order.push((name, tool));
            }
        }
    }

    fn into_catalog(self) -> Vec<Value> {
        self.order.into_iter().map(|(_, tool)| tool).collect()
    }
}

fn list<'a>(session: &'a Value, key: &str) -> &'a [Value] {
    session.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

/// `lateAnnouncementDescription`: the first sentence, cut to 80 UTF-16 units.
fn late_announcement_description(value: Option<&Value>) -> String {
    let flat = js_words(&clean(value)).collect::<Vec<_>>().join(" ");
    let cut = flat.match_indices(' ').map(|(at, _)| at).find(|&at| flat[..at].ends_with(['.', '!', '?']));
    let sentence = cut.map_or(flat.as_str(), |at| &flat[..at]);
    let units: Vec<u16> = sentence.encode_utf16().collect();
    if units.len() > 80 { format!("{}…", String::from_utf16_lossy(&units[..79])) } else { sentence.to_owned() }
}

/// `parseMcpToolName(tool)?.server || ''`: the definition's own server wins over the name's.
fn tool_server(tool: &Value) -> String {
    let server = clean(tool.get("mcpServerName"));
    if server.is_empty() { name_server(&tool_name(tool)) } else { server }
}

/// `parseMcpToolName(name)?.server || ''`.
fn name_server(name: &str) -> String {
    parse_mcp_tool_name(js_trim(name)).map(|(server, _)| server).unwrap_or_default()
}

impl ToolSurface<'_> {
    /// `refreshInitialDeferredMcpSurface(session, liveMcpTools)`: folds the LIVE MCP tools into the boot
    /// catalog and the first-turn surface. A server gone since creation leaves the initial surface (nothing was
    /// sent yet); the prompt's deferred-tool block is rebuilt in place and only the names that landed in it are
    /// marked announced. Idempotent: no MCP name added or gone is no change. Whether the session changed.
    pub fn refresh_initial_mcp_surface(&self, session: &mut Value, live_mcp: &[Value]) -> bool {
        if !session.get("messages").is_some_and(Value::is_array) || session.get("deferredProviderMode").and_then(Value::as_str) == Some("full") {
            return false;
        }
        let live = filter_disallowed_tools(live_mcp, &clean_list(session, "disallowedTools"));
        let live_names: HashSet<String> = live.iter().map(tool_name).filter(|name| is_mcp(name)).collect();
        let mut by_name = ByName::default();
        let mut changed = false;
        for tool in list(session, "deferredToolCatalog") {
            let name = tool_name(tool);
            if is_mcp(&name) && !live_names.contains(&name) {
                changed = true;
                continue;
            }
            if !name.is_empty() && !by_name.has(&name) {
                by_name.set(name, tool.clone());
            }
        }
        for tool in &live {
            let name = tool_name(tool);
            if name.is_empty() || !is_mcp(&name) || by_name.has(&name) {
                continue;
            }
            by_name.set(name, tool.clone());
            changed = true;
        }
        if !changed {
            return false;
        }
        let clock: &dyn Clock = self.clock;
        let now = clock.now_ms();
        map_mut(session).insert("deferredToolCatalog".into(), Value::Array(sorted_catalog_by_measured_usage(by_name.into_catalog())));
        if fixed_surface_session(session) {
            map_mut(session).insert("updatedAt".into(), json!(now));
            return true;
        }
        // A newly connected server's block belongs in the prompt block rebuilt below.
        let scope = session.get("mcpScopeId").and_then(Value::as_str).map(str::to_owned);
        session["mcpServerInstructions"] = self.host.mcp_server_instructions(scope.as_deref());
        let pool = self.pool_tool_names(session);
        if !apply_initial_manifest(session, &pool, true, self.clock) {
            return false;
        }
        let announced = listed_deferred_tool_names(session, &pool, &rendered_manifest(session));
        session["deferredAnnouncedTools"] = names_value(&announced);
        map_mut(session).insert("updatedAt".into(), json!(now));
        true
    }

    /// `reconcileDeferredMcpToolCatalog(session, liveMcpTools)` (the part after its unchanged-input
    /// cache): the late pool, the connected names and the pending deferred-tools delta follow the live
    /// registry. The names announced or removed, or `None` when nothing was.
    pub fn reconcile_mcp_catalog(&self, session: &mut Value, live_mcp: &[Value]) -> Option<Vec<String>> {
        if !session.get("tools").is_some_and(Value::is_array) {
            return None;
        }
        let clock: &dyn Clock = self.clock;
        let now = clock.now_ms();
        let live = filter_disallowed_tools(live_mcp, &clean_list(session, "disallowedTools"));
        let snapshot: Option<Vec<String>> = session.get("deferredMcpToolNames").and_then(Value::as_array).map(|names| names.iter().filter_map(Value::as_str).map(str::to_owned).collect());
        let had_snapshot = snapshot.is_some();
        let previous = unique(snapshot.unwrap_or_else(|| {
            list(session, "deferredToolCatalog").iter().chain(list(session, "deferredLateToolCatalog")).map(tool_name).filter(|name| is_mcp(name)).collect()
        }));
        let connected = unique(live.iter().map(tool_name).filter(|name| is_mcp(name)));
        map_mut(session).insert("deferredMcpToolNames".into(), names_value(&connected));
        if fixed_surface_session(session) {
            // A fixed surface not yet on the bridge: connect, reconnect and removal update the scoped catalog
            // only (availability follows the connected names); nothing is announced.
            let mut by_name = ByName::default();
            for tool in list(session, "deferredToolCatalog") {
                let name = tool_name(tool);
                if !name.is_empty() && !is_mcp(&name) {
                    by_name.set(name, tool.clone());
                }
            }
            for tool in &live {
                let name = tool_name(tool);
                if !name.is_empty() && is_mcp(&name) {
                    by_name.set(name, tool.clone());
                }
            }
            let catalog = sorted_catalog_by_measured_usage(by_name.into_catalog());
            let moved = list(session, "deferredToolCatalog") != catalog.as_slice();
            map_mut(session).insert("deferredToolCatalog".into(), Value::Array(catalog));
            if moved {
                map_mut(session).insert("updatedAt".into(), json!(now));
            }
            return None;
        }
        let late = list(session, "deferredLateToolCatalog").to_vec();
        // A removal is judged by the definition the session had before this reconciliation.
        let catalog_before: HashMap<String, Value> = self.catalog_union(session).into_iter().map(|tool| (tool_name(&tool), tool)).collect();
        // The tools the session itself keeps exposed: the active surface and the callable and discovered names.
        let active: HashSet<String> = tools_of(session)
            .iter()
            .map(tool_name)
            .filter(|name| !name.is_empty())
            .chain(parse_tool_selection(session.get("deferredCallableTools")))
            .chain(parse_tool_selection(session.get("deferredDiscoveredTools")))
            .collect();
        let mut live_by_name = ByName::default();
        for tool in &live {
            let name = tool_name(tool);
            if name.is_empty() || !is_mcp(&name) || live_by_name.has(&name) {
                continue;
            }
            live_by_name.set(name, tool.clone());
        }
        // The late pool alone is rebuilt (the boot catalog stays frozen): it keeps an MCP tool while its server is
        // connected or the tool is loaded, and every non-MCP entry (a built-in a settings gate opened).
        let mut next = ByName::default();
        for tool in &late {
            let name = tool_name(tool);
            if name.is_empty() || next.has(&name) || (is_mcp(&name) && !live_by_name.has(&name) && !active.contains(&name)) {
                continue;
            }
            next.set(name, tool.clone());
        }
        for (name, tool) in &live_by_name.order {
            next.set(name.clone(), tool.clone());
        }
        map_mut(session).insert("deferredLateToolCatalog".into(), Value::Array(sorted_catalog_by_measured_usage(next.into_catalog())));
        // A promoted MCP tool re-links to the fresh server tool only when the serialized surface changed.
        if let Some(tools) = session.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools.iter_mut() {
                let name = tool_name(tool);
                if name.is_empty() || !is_mcp(&name) {
                    continue;
                }
                if let Some(fresh) = live_by_name.get(&name).filter(|fresh| fresh.to_string() != tool.to_string()) {
                    *tool = fresh.clone();
                }
            }
        }
        let connected: HashSet<&String> = connected.iter().collect();
        let startup: HashSet<String> = clean_list(session, "deferredAnnouncedTools").into_iter().collect();
        let mut added: Vec<(String, String)> = Vec::new();
        for (name, tool) in &live_by_name.order {
            if previous.contains(name) || (!had_snapshot && (active.contains(name) || startup.contains(name))) || !roster_permits(session, tool) {
                continue;
            }
            added.push((name.clone(), late_announcement_description(tool.get("description"))));
        }
        let mut removed: Vec<(String, String)> = Vec::new();
        for name in &previous {
            if connected.contains(name) {
                continue;
            }
            let known = catalog_before.get(name);
            if !roster_permits(session, known.unwrap_or(&json!({ "name": name }))) {
                continue;
            }
            // The server comes from the definition the session had, so a shortened name never has to be parsed.
            removed.push((name.clone(), known.map_or_else(|| name_server(name), tool_server)));
        }
        if added.is_empty() && removed.is_empty() {
            return None;
        }
        merge_deferred_delta_with_servers(map_mut(session), &added, &removed, now);
        map_mut(session).insert("updatedAt".into(), json!(now));
        Some(added.into_iter().map(|(name, _)| name).chain(removed.into_iter().map(|(name, _)| name)).collect())
    }
}
