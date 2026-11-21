use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::gate::connector_policy_agent;
use mixdog_core_session::session::thread_switches::merge_deferred_delta;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::ConnectorPermissions;
use serde_json::Value;
use serde_json::json;

use super::route_surface::is_agent_owner;
use super::tool_surface::clean;
use super::workflow_surface::denials::reaction_disabled;

/// `FEATURE_GATED_TOOL_NAMES`: every tool a settings gate of `featureDisallowedToolsFor` can deny.
pub const FEATURE_GATED_TOOL_NAMES: [&str; 16] = [
    "web_search",
    "web_fetch",
    "memory",
    "recall",
    "git",
    "github",
    "browser",
    "browser_devtools",
    "computer",
    "terminal",
    "office",
    "media",
    "tidy",
    "visualize",
    "explore",
    "react",
];

/// What moved: the tools a gate opened and the ones it closed, among those the thread can show.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Moved {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

struct Gates {
    /// The live gate list restricted to gated tools, each once, in order.
    live: Vec<String>,
    disallowed: Vec<String>,
    closed: Vec<String>,
    opened: Vec<String>,
}

/// `(list || []).map(String)`.
fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().map(mixdog_js::value_to_string).collect()).unwrap_or_default()
}

fn gates(session: &Header, feature_denied: &[String]) -> Gates {
    let mut live: Vec<String> = Vec::new();
    for name in feature_denied {
        if FEATURE_GATED_TOOL_NAMES.contains(&name.as_str()) && !live.contains(name) {
            live.push(name.clone());
        }
    }
    let disallowed = strings(session.get("disallowedTools"));
    // Denials that are not settings: the caller's, and `react` outside a bot chat.
    let mut fixed: HashSet<String> = strings(session.get("callerDisallowedTools")).into_iter().collect();
    if reaction_disabled(session, is_agent_owner(&Value::Object(session.clone()))) {
        fixed.insert("react".to_owned());
    }
    let closed = live.iter().filter(|name| !disallowed.contains(name)).cloned().collect();
    let opened =
        disallowed.iter().filter(|name| FEATURE_GATED_TOOL_NAMES.contains(&name.as_str()) && !live.contains(name) && !fixed.contains(*name)).cloned().collect();
    Gates { live, disallowed, closed, opened }
}

/// `knownTools(session)`: the first definition of each name in the schema and both catalogs.
fn known_tools(session: &Header) -> HashMap<String, Value> {
    let mut known = HashMap::new();
    for key in ["tools", "deferredToolCatalog", "deferredLateToolCatalog"] {
        for tool in session.get(key).and_then(Value::as_array).into_iter().flatten() {
            let name = clean(tool.get("name"));
            if !name.is_empty() {
                known.entry(name).or_insert_with(|| tool.clone());
            }
        }
    }
    known
}

/// The opened tools the thread never held: the ones whose definitions `stage_tool_availability`
/// will need (`definitionsFor(missing)`). Empty when no gate moved.
pub fn missing_definitions(session: &Header, feature_denied: &[String]) -> Vec<String> {
    if !session.get("tools").is_some_and(Value::is_array) {
        return Vec::new();
    }
    let gates = gates(session, feature_denied);
    let known = known_tools(session);
    gates.opened.into_iter().filter(|name| !known.contains_key(name)).collect()
}

/// `sessionAllowlistExcludes(session, name)`: the persisted schema allowlist leaves `name` out.
fn allowlist_excludes(session: &Header, name: &str) -> bool {
    let Some(allowed) = session.get("schemaAllowedTools").and_then(Value::as_array) else { return false };
    let wanted = name.to_lowercase();
    !allowed.iter().any(|entry| mixdog_js::value_to_string(entry).to_lowercase() == wanted)
}

pub fn stage_tool_availability(session: &mut Header, feature_denied: &[String], definitions: &[Value], now: i64) -> Option<Moved> {
    if !session.get("tools").is_some_and(Value::is_array) {
        return None;
    }
    let gates = gates(session, feature_denied);
    let mut sorted = gates.live.clone();
    sorted.sort();
    session.insert("featureDeniedTools".to_owned(), json!(sorted));
    if gates.closed.is_empty() && gates.opened.is_empty() {
        return None;
    }
    let mut known = known_tools(session);
    let missing: Vec<&String> = gates.opened.iter().filter(|name| !known.contains_key(*name)).collect();
    let fresh: Vec<Value> = if missing.is_empty() {
        Vec::new()
    } else {
        definitions.iter().filter(|tool| missing.iter().any(|name| **name == clean(tool.get("name")))).cloned().collect()
    };
    for tool in &fresh {
        known.entry(clean(tool.get("name"))).or_insert_with(|| tool.clone());
    }
    if !fresh.is_empty() {
        let mut late = session.get("deferredLateToolCatalog").and_then(Value::as_array).cloned().unwrap_or_default();
        late.extend(fresh);
        session.insert("deferredLateToolCatalog".to_owned(), Value::Array(late));
    }
    let opened_set: HashSet<&String> = gates.opened.iter().collect();
    let mut next: Vec<String> = gates.disallowed.iter().filter(|name| !opened_set.contains(name)).cloned().collect();
    next.extend(gates.closed.iter().cloned());
    session.insert("disallowedTools".to_owned(), json!(next));
    let visible = |name: &&String| known.contains_key(*name) && !allowlist_excludes(session, name);
    let added: Vec<String> = gates.opened.iter().filter(visible).cloned().collect();
    let removed: Vec<String> = gates.closed.iter().filter(visible).cloned().collect();
    let described: Vec<(String, String)> = added
        .iter()
        .map(|name| {
            let description = known.get(name).and_then(|tool| tool.get("description")).and_then(Value::as_str).unwrap_or_default();
            (name.clone(), description.to_owned())
        })
        .collect();
    merge_deferred_delta(session, &described, &removed, now);
    session.insert("promptFoldPending".to_owned(), Value::Bool(true));
    session.insert("updatedAt".to_owned(), json!(now));
    Some(Moved { added, removed })
}

pub fn stage_connector_availability(session: &mut Header, thread: &ThreadId, permissions: &dyn ConnectorPermissions, now: i64) -> Option<Moved> {
    if !session.get("tools").is_some_and(Value::is_array) {
        return None;
    }
    let known = known_tools(session);
    let agent = connector_policy_agent(session);
    let mut permitted: Vec<String> = known
        .keys()
        .filter(|name| name.starts_with("mcp__") && !permissions.disabled(&agent, name) && !permissions.project_disabled(thread, name))
        .cloned()
        .collect();
    // JavaScript's default sort: by UTF-16 code unit.
    permitted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let previous: Option<Vec<String>> =
        session.get("agentConnectorTools").and_then(Value::as_array).map(|items| items.iter().map(mixdog_js::value_to_string).collect());
    session.insert("agentConnectorTools".to_owned(), json!(permitted));
    let previous = previous?;
    let added: Vec<String> = permitted.iter().filter(|name| !previous.contains(name)).cloned().collect();
    let removed: Vec<String> = previous.iter().filter(|name| !permitted.contains(name)).cloned().collect();
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let described: Vec<(String, String)> = added
        .iter()
        .map(|name| (name.clone(), known.get(name).and_then(|tool| tool.get("description")).and_then(Value::as_str).unwrap_or_default().to_owned()))
        .collect();
    merge_deferred_delta(session, &described, &removed, now);
    session.insert("updatedAt".to_owned(), json!(now));
    Some(Moved { added, removed })
}

#[cfg(test)]
mod tests {}
