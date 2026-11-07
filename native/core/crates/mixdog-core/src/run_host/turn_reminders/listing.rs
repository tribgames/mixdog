//! The agent list reminder (`session/manager/agent-listing-notice.mjs`): the agents a coding Lead may delegate to,
//! told by the turn that finds them changed. What the conversation was told is read back from the conversation
//! itself every turn: the `# Available Agents` slice its prompt carries, then every earlier user turn's
//! `meta.agentListing` (`prompt-utils.mjs` `presentedAgentCatalogSlice` / `agentListEntries`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

const AGENT_CATALOG_HEADING: &str = "# Available Agents";
const BP3_PART_SEPARATOR: &str = "\n\n---\n\n";

/// One generated catalog line, `- <name> (<id>)` with an optional `: <description>` (`agentCatalog`).
static ENTRY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^- (.+?) \(([^()\s]+)\)(?:: .*)?$", ""));

/// An agent of a generated list: its id, its name and the line the list prints.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentEntry {
    pub id: String,
    pub name: String,
    pub line: String,
}

/// `{ id, name }`: what a reminder records of an agent.
#[derive(Clone, Debug, PartialEq)]
struct AgentRef {
    id: String,
    name: String,
}

impl AgentRef {
    fn json(&self) -> Value {
        json!({ "id": self.id, "name": self.name })
    }
}

/// `agentListEntries(slice)`: the entries of a generated agent list slice, `None` when `slice` is not one (only the
/// exact generated format is evidence).
pub fn agent_list_entries(slice: &str) -> Option<Vec<AgentEntry>> {
    let text = mixdog_js::js_trim(slice);
    let head = format!("{AGENT_CATALOG_HEADING}\n\n");
    let body = text.strip_prefix(head.as_str())?;
    let mut entries = Vec::new();
    for line in body.split('\n') {
        let captures = ENTRY.captures(line)?;
        entries.push(AgentEntry { id: captures.get(2)?.to_owned(), name: captures.get(1)?.to_owned(), line: line.to_owned() });
    }
    Some(entries)
}

/// The agent list the system prompt carries: one complete generated slice of the BP3 core, none when it carries
/// none (or none valid).
fn prompt_agent_list(header: &Header) -> Vec<AgentEntry> {
    let core = header.get("bp3CoreContext").and_then(Value::as_str).unwrap_or_default();
    let continued = format!("{AGENT_CATALOG_HEADING}\n");
    let slices: Vec<&str> = core.split(BP3_PART_SEPARATOR).filter(|slice| *slice == AGENT_CATALOG_HEADING || slice.starts_with(continued.as_str())).collect();
    match slices.as_slice() {
        [only] => agent_list_entries(only).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

/// `String(value)` of a record's field.
fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

/// `told.set(id, ref(entry))`: a key set again keeps its place.
fn set(told: &mut Vec<AgentRef>, agent: AgentRef) {
    match told.iter_mut().find(|known| known.id == agent.id) {
        Some(known) => known.name = agent.name,
        None => told.push(agent),
    }
}

/// `announcedAgents(session)`: the agents the conversation was told about: the prompt's list, then every agent list
/// reminder the conversation still holds, in order.
fn announced_agents(header: &Header, prior: &[Value]) -> Vec<AgentRef> {
    let mut told: Vec<AgentRef> = Vec::new();
    for entry in prompt_agent_list(header) {
        set(&mut told, AgentRef { id: entry.id, name: entry.name });
    }
    for message in prior {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(change) = message.pointer("/meta/agentListing").filter(|change| truthy(change)) else { continue };
        for entry in change.get("removed").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                told.retain(|known| known.id != id);
            }
        }
        for entry in change.get("added").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = entry.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                set(&mut told, AgentRef { id: id.to_owned(), name: template(entry.get("name")) });
            }
        }
    }
    told
}

/// The agent list reminder a turn carries and what it records on the turn's message.
#[derive(Clone, Debug, PartialEq)]
pub struct ListingNotice {
    pub content: String,
    /// `meta.agentListing`: `{ added, removed }`.
    pub meta: Value,
}

/// `buildAgentListingNotice(session, current)`: `None` when the conversation already knows `current`, the agents
/// enabled at this turn's start (absent for a session that gets no reminder).
pub fn notice(header: &Header, prior: &[Value], current: Option<&[AgentEntry]>) -> Option<ListingNotice> {
    let current = current?;
    let announced = announced_agents(header, prior);
    let added: Vec<AgentRef> = current.iter().filter(|entry| !announced.iter().any(|known| known.id == entry.id)).map(|entry| AgentRef { id: entry.id.clone(), name: entry.name.clone() }).collect();
    let removed: Vec<AgentRef> = announced.iter().filter(|known| !current.iter().any(|entry| entry.id == known.id)).cloned().collect();
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let mut lines = vec![
        "<system-reminder>".to_owned(),
        "# Available Agents Changed".to_owned(),
        "This updates the Available Agents list in the system prompt and every earlier Available Agents Changed reminder.".to_owned(),
    ];
    if !added.is_empty() {
        lines.push("New agents are now available to delegate to with `agent`:".to_owned());
        lines.extend(current.iter().filter(|entry| !announced.iter().any(|known| known.id == entry.id)).map(|entry| entry.line.clone()));
    }
    if !removed.is_empty() {
        lines.push("These agents are no longer available; an `agent` call naming one is refused:".to_owned());
        lines.extend(removed.iter().map(|agent| format!("- {} ({})", agent.name, agent.id)));
    }
    if current.is_empty() {
        lines.push("No agents are enabled now: do the work yourself until one is enabled.".to_owned());
    }
    lines.push("</system-reminder>".to_owned());
    let meta = json!({
        "added": added.iter().map(AgentRef::json).collect::<Vec<Value>>(),
        "removed": removed.iter().map(AgentRef::json).collect::<Vec<Value>>(),
    });
    Some(ListingNotice { content: lines.join("\n"), meta })
}
