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

/// A tool's server comes from the session's catalog definitions, the later list overriding the earlier.
fn server_catalog(header: &Header) -> Vec<(String, String)> {
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
    catalog
}

fn server_of(catalog: &[(String, String)], name: &str, hint: Option<&str>) -> String {
    if let Some(hint) = hint.filter(|hint| !hint.is_empty()) {
        return hint.to_owned();
    }
    if let Some((_, server)) = catalog.iter().find(|(known, _)| known == name) {
        return server.clone();
    }
    parse_mcp_tool_name(name).map(|(server, _)| server).unwrap_or_default()
}

fn sorted_lines(mut list: Vec<Item>) -> Vec<String> {
    list.sort_by(|a, b| locale_compare(&a.label, &b.label));
    list.into_iter().map(|item| item.line).collect()
}

/// The lines of the added tools: a tool of a server is listed under the server's line.
fn added_lines(header: &Header, catalog: &[(String, String)], added: &[Added]) -> Vec<String> {
    let mut items: Vec<Item> = Vec::new();
    let mut added_servers: Vec<(String, Vec<&Added>)> = Vec::new();
    for entry in added {
        let server = server_of(catalog, &entry.name, None);
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
    for (server, entries) in &added_servers {
        let label = format!("mcp__{server}");
        if server_rows.iter().any(|(listed, _)| *listed == label) {
            continue;
        }
        for entry in entries {
            items.push(Item { label: entry.name.clone(), line: format!("- {}", entry.name) });
        }
    }
    sorted_lines(items)
}

/// The lines of the removed tools: a server's tools are counted, and the server is gone once the connected set holds none of its tools.
fn removed_lines(header: &Header, catalog: &[(String, String)], removed: &[String], removed_servers: &[(String, String)]) -> Vec<String> {
    let connected: Option<Vec<String>> =
        header.get("deferredMcpToolNames").and_then(Value::as_array).map(|names| names.iter().map(|name| clean(Some(name))).collect());
    let live_servers: Vec<String> = connected.iter().flatten().map(|name| server_of(catalog, name, None)).filter(|server| !server.is_empty()).collect();
    let mut removed_by_server: Vec<(String, usize)> = Vec::new();
    let mut items: Vec<Item> = Vec::new();
    for name in removed {
        let hint = removed_servers.iter().find(|(known, _)| known == name).map(|(_, server)| server.as_str());
        let server = server_of(catalog, name, hint);
        if server.is_empty() {
            items.push(Item { label: name.clone(), line: format!("- {name}") });
            continue;
        }
        match removed_by_server.iter().position(|(known, _)| *known == server) {
            Some(at) => removed_by_server[at].1 += 1,
            None => removed_by_server.push((server, 1)),
        }
    }
    for (server, count) in &removed_by_server {
        let label = format!("mcp__{server}");
        let gone = connected.is_some() && !live_servers.contains(server);
        let plural = if *count == 1 { "" } else { "s" };
        let line = if gone { format!("- {label}") } else { format!("- {label}: {count} tool{plural} removed") };
        items.push(Item { label, line });
    }
    sorted_lines(items)
}

/// What `normalizedDelta` leaves of the pending delta: a tool added again after it was removed is not a removal; a server is kept for a removal only.
struct PendingDelta {
    revision: f64,
    added: Vec<Added>,
    removed: Vec<String>,
    removed_servers: Vec<(String, String)>,
}

fn pending_delta(header: &Header) -> PendingDelta {
    let source = header.get("pendingDeferredToolDelta").filter(|delta| delta.is_object());
    let revision = match source {
        Some(delta) => {
            let number = mixdog_js::to_number_of(delta.get("revision"));
            if number.is_nan() { 0.0 } else { number.max(0.0) }
        }
        None => 0.0,
    };
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
    removed.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    PendingDelta { revision, added, removed, removed_servers }
}

/// `snapshotPendingDeferredToolDelta(session)`: the reminder of the pending delta, `None` when it names no tool.
pub fn notice(header: &Header) -> Option<DeltaNotice> {
    let PendingDelta { revision, added, removed, removed_servers } = pending_delta(header);
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let catalog = server_catalog(header);
    let added_lines = added_lines(header, &catalog, &added);
    let removed_lines = removed_lines(header, &catalog, &removed, &removed_servers);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn header(delta: Value) -> Header {
        let mut header = Header::new();
        header.insert("pendingDeferredToolDelta".into(), delta);
        header
    }

    fn lines(notice: &DeltaNotice) -> Vec<&str> {
        notice.content.lines().collect()
    }

    #[test]
    fn a_header_with_no_pending_delta_has_no_notice() {
        assert_eq!(notice(&Header::new()), None);
        assert_eq!(notice(&header(json!({ "revision": 3, "added": [], "removed": [] }))), None);
    }

    #[test]
    fn added_tools_are_listed_sorted_with_their_compacted_description() {
        let delta = json!({ "revision": 4, "added": [{ "name": "zeta", "description": "  last   one " }, { "name": "alpha" }] });
        let notice = notice(&header(delta)).expect("a notice");
        assert_eq!(notice.revision, 4);
        assert_eq!(
            lines(&notice),
            [
                "<system-reminder>",
                "<deferred_tools_delta>",
                "Added deferred tools:",
                "- alpha",
                "- zeta: last one",
                "</deferred_tools_delta>",
                "</system-reminder>"
            ]
        );
    }

    #[test]
    fn a_tool_added_again_after_its_removal_is_not_a_removal() {
        let delta = json!({ "revision": 1, "added": [{ "name": "alpha" }], "removed": ["alpha", "beta"] });
        let notice = notice(&header(delta)).expect("a notice");
        assert_eq!(
            lines(&notice),
            [
                "<system-reminder>",
                "<deferred_tools_delta>",
                "Added deferred tools:",
                "- alpha",
                "Removed deferred tools:",
                "- beta",
                "</deferred_tools_delta>",
                "</system-reminder>"
            ]
        );
    }

    #[test]
    fn removed_tools_of_one_server_are_counted_and_the_server_is_gone_when_none_is_connected() {
        let delta = json!({ "revision": 2, "removed": ["mcp__srv__a", "mcp__srv__b"] });
        let mut still_connected = header(delta.clone());
        still_connected.insert("deferredMcpToolNames".into(), json!(["mcp__srv__c"]));
        let kept = notice(&still_connected).expect("a notice");
        assert!(lines(&kept).contains(&"- mcp__srv: 2 tools removed"), "{}", kept.content);
        let mut gone = header(delta);
        gone.insert("deferredMcpToolNames".into(), json!([]));
        let gone = notice(&gone).expect("a notice");
        assert!(lines(&gone).contains(&"- mcp__srv"), "{}", gone.content);
    }
}
