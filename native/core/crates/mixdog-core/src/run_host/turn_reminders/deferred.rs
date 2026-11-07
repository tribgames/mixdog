//! The deferred-tool delta reminder (`runtime-core/deferred-tool-delta.mjs` `snapshotPendingDeferredToolDelta`): the
//! tools added to or removed from the deferred catalog since the conversation was last told, one line per tool or,
//! for an MCP server, one line per server. The staging (`pendingDeferredToolDelta`) is `thread_switches`'
//! `merge_deferred_delta`; the acknowledgement is `session::reminders`.

use mixdog_core_session::session::thread_switches::compact_description;
use mixdog_js::locale_compare;
use mixdog_mcp::permissions::parse_mcp_tool_name;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use crate::run_host::deferred_manifest::mcp_server_lines;

/// The pending delta a turn carries.
#[derive(Clone, Debug, PartialEq)]
pub struct DeltaNotice {
    /// The revision its acknowledgement names (`normalizedDelta(...).revision`).
    pub revision: i64,
    pub content: String,
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

/// An added tool: its name and the description a delta shows.
struct Added {
    name: String,
    description: String,
}

/// A line of the reminder, sorted by its label.
struct Item {
    label: String,
    line: String,
}

/// `parseMcpToolName(tool)?.server` of a definition: the server it names, else the one its tool name parses to.
fn definition_server(tool: &Value) -> String {
    let named = clean(tool.get("mcpServerName"));
    if !named.is_empty() {
        return named;
    }
    parse_mcp_tool_name(tool.get("name").and_then(Value::as_str).unwrap_or_default()).map(|(server, _)| server).unwrap_or_default()
}

/// `deltaLines(session, added, removed, removedServers)`: the lines of the added and of the removed tools.
fn delta_lines(header: &Header, added: &[Added], removed: &[String], removed_servers: &[(String, String)]) -> (Vec<String>, Vec<String>) {
    // A tool's server comes from the session's catalog definitions, the later list overriding the earlier.
    let mut catalog: Vec<(String, String)> = Vec::new();
    for key in ["deferredToolCatalog", "deferredLateToolCatalog", "tools"] {
        for tool in header.get(key).and_then(Value::as_array).into_iter().flatten() {
            let name = clean(tool.get("name"));
            let server = definition_server(tool);
            if name.is_empty() || server.is_empty() {
                continue;
            }
            match catalog.iter().position(|(known, _)| *known == name) {
                Some(at) => catalog[at].1 = server,
                None => catalog.push((name, server)),
            }
        }
    }
    let server_of = |name: &str, hint: Option<&str>| -> String {
        if let Some(hint) = hint.filter(|hint| !hint.is_empty()) {
            return hint.to_owned();
        }
        if let Some((_, server)) = catalog.iter().find(|(known, _)| known == name) {
            return server.clone();
        }
        parse_mcp_tool_name(name).map(|(server, _)| server).unwrap_or_default()
    };

    let mut items: Vec<Item> = Vec::new();
    let mut added_servers: Vec<(String, Vec<&Added>)> = Vec::new();
    for entry in added {
        let server = server_of(&entry.name, None);
        if server.is_empty() {
            let line = if entry.description.is_empty() { format!("- {}", entry.name) } else { format!("- {}: {}", entry.name, entry.description) };
            items.push(Item { label: entry.name.clone(), line });
            continue;
        }
        match added_servers.iter().position(|(known, _)| *known == server) {
            Some(at) => added_servers[at].1.push(entry),
            None => added_servers.push((server, vec![entry])),
        }
    }
    let servers: Vec<(String, Vec<Value>)> = added_servers
        .iter()
        .map(|(server, entries)| (server.clone(), entries.iter().map(|entry| json!({ "name": entry.name, "description": entry.description })).collect()))
        .collect();
    let instructions = header.get("mcpServerInstructions").cloned().unwrap_or(Value::Null);
    let server_rows = mcp_server_lines(&servers, &instructions);
    for (label, trigger) in &server_rows {
        items.push(Item { label: label.clone(), line: format!("- {label}: {trigger}") });
    }
    // A server whose name cannot be listed safely is listed by its tools.
    for (server, entries) in &added_servers {
        let label = format!("mcp__{server}");
        if server_rows.iter().any(|(listed, _)| *listed == label) {
            continue;
        }
        for entry in entries {
            items.push(Item { label: entry.name.clone(), line: format!("- {}", entry.name) });
        }
    }

    let connected: Option<Vec<String>> = header.get("deferredMcpToolNames").and_then(Value::as_array).map(|names| names.iter().map(|name| clean(Some(name))).collect());
    let live_servers: Vec<String> = connected.iter().flatten().map(|name| server_of(name, None)).filter(|server| !server.is_empty()).collect();
    let mut removed_by_server: Vec<(String, usize)> = Vec::new();
    let mut removed_items: Vec<Item> = Vec::new();
    for name in removed {
        let hint = removed_servers.iter().find(|(known, _)| known == name).map(|(_, server)| server.as_str());
        let server = server_of(name, hint);
        if server.is_empty() {
            removed_items.push(Item { label: name.clone(), line: format!("- {name}") });
            continue;
        }
        match removed_by_server.iter().position(|(known, _)| *known == server) {
            Some(at) => removed_by_server[at].1 += 1,
            None => removed_by_server.push((server, 1)),
        }
    }
    // Gone only when the connected set is known and none of its tools is left.
    for (server, count) in &removed_by_server {
        let label = format!("mcp__{server}");
        let gone = connected.is_some() && !live_servers.contains(server);
        let plural = if *count == 1 { "" } else { "s" };
        let line = if gone { format!("- {label}") } else { format!("- {label}: {count} tool{plural} removed") };
        removed_items.push(Item { label, line });
    }

    let render = |mut list: Vec<Item>| -> Vec<String> {
        list.sort_by(|a, b| locale_compare(&a.label, &b.label));
        list.into_iter().map(|item| item.line).collect()
    };
    (render(items), render(removed_items))
}

/// `snapshotPendingDeferredToolDelta(session)`: the reminder of the pending delta, `None` when it names no tool.
pub fn notice(header: &Header) -> Option<DeltaNotice> {
    let source = header.get("pendingDeferredToolDelta").filter(|delta| delta.is_object());
    let revision = match source {
        Some(delta) => {
            let number = mixdog_js::to_number_of(delta.get("revision"));
            if number.is_nan() { 0.0 } else { number.max(0.0) }
        }
        None => 0.0,
    };

    // `normalizedDelta`: a tool added again after it was removed is not a removal; a server is kept for a removal only.
    let mut added: Vec<Added> = Vec::new();
    for entry in source.and_then(|delta| delta.get("added")).and_then(Value::as_array).into_iter().flatten() {
        let name = clean(entry.get("name"));
        if name.is_empty() {
            continue;
        }
        let description = compact_description(entry.get("description"));
        match added.iter().position(|known| known.name == name) {
            Some(at) => added[at].description = description,
            None => added.push(Added { name, description }),
        }
    }
    let mut removed: Vec<String> = Vec::new();
    let mut removed_servers: Vec<(String, String)> = Vec::new();
    let mut set_server = |name: &str, server: String| match removed_servers.iter().position(|(known, _)| known == name) {
        Some(at) => removed_servers[at].1 = server,
        None => removed_servers.push((name.to_owned(), server)),
    };
    for (name, server) in source.and_then(|delta| delta.get("removedServers")).and_then(Value::as_object).into_iter().flatten() {
        set_server(name, mixdog_js::value_to_string(server));
    }
    for entry in source.and_then(|delta| delta.get("removed")).and_then(Value::as_array).into_iter().flatten() {
        let name = clean(match entry {
            Value::String(_) => Some(entry),
            other => other.get("name"),
        });
        if name.is_empty() {
            continue;
        }
        if !removed.contains(&name) {
            removed.push(name.clone());
        }
        if entry.is_object() {
            let server = clean(entry.get("server"));
            if !server.is_empty() {
                set_server(&name, server);
            }
        }
    }
    removed.retain(|name| !added.iter().any(|entry| entry.name == *name));
    removed_servers.retain(|(name, _)| removed.contains(name));

    added.sort_by(|a, b| locale_compare(&a.name, &b.name));
    // JS's default `sort()` compares UTF-16 code units.
    removed.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let (added_lines, removed_lines) = delta_lines(header, &added, &removed, &removed_servers);
    let mut lines = vec!["<system-reminder>".to_owned(), "<deferred_tools_delta>".to_owned()];
    if !added_lines.is_empty() {
        lines.push("Added deferred tools:".to_owned());
        lines.extend(added_lines);
    }
    if !removed_lines.is_empty() {
        lines.push("Removed deferred tools:".to_owned());
        lines.extend(removed_lines);
    }
    lines.push("</deferred_tools_delta>".to_owned());
    lines.push("</system-reminder>".to_owned());
    Some(DeltaNotice { revision: revision as i64, content: lines.join("\n") })
}
