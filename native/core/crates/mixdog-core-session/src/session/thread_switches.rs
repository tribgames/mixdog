//! What a workflow or orchestration-mode choice does to the thread's own session, and what a
//! desktop context switch does to the session it leaves: the session half of
//! `thread/setWorkflow`, `thread/setOrchestrationMode` (`switchSessionWorkflow`,
//! `switchSessionOrchestrationMode`, `settingsReachCurrentSession`, `applyPendingSessionSwitches`
//! of `session-runtime/tool-policy/session-switches.mjs`, `workflow-overlay.mjs`,
//! `mode-switch.mjs`, `pending-switches.mjs` and the notices of `session/manager/`) and of
//! `thread/switchContext` (`lifecycle/session-switch/context-switch.mjs`).
//!
//! The switch is a pure change of the session's header ([`switch_workflow`], [`switch_mode`],
//! [`apply_pending`]); [`SessionSwitchAdapter`] reads the live thread, runs it and lands the
//! change as one durable header patch, then the display-only transcript boundary on the switch
//! anchor row (an amend of that row's `meta`, like Node's replaced anchor message). The prompt
//! side (the workflow pack, its denied tools, the mode texts) is [`WorkflowSurface`], the
//! run-host's.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::truthy;
use mixdog_core_api::ThreadHandle as _;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::workflow::thread_settings::ContextSwitch;
use mixdog_core_config::workflow::thread_settings::SessionSwitches;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::model_switch_anchor_index;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::close::SessionClose;
use super::route_session::ContextStatusCache;
use super::route_session::has_user_conversation;
use super::thread_settings::has_conversation_messages;
use super::thread_state::SessionThreads;

const MODES: [&str; 4] = ["none", "focused", "balanced", "swarm"];
const CONTEXT_SWITCH_REASON: &str = "desktop-context-switch";
const DELTA_DESCRIPTION_MAX: usize = 80;

// ---- the prompt side ----------------------------------------------------------------------------

/// The workflow a switch resolves to (`activeWorkflowContext(configForSession(config, id,
/// mode), dataDir)` with `leadPartsFor(session, leadPromptParts)`).
#[derive(Clone, Debug)]
pub struct WorkflowTarget {
    /// `summary`: `{id, name, description, source, delegatesAgents}`.
    pub summary: Value,
    /// `orchestrationMode` of the resolved config.
    pub orchestration_mode: String,
    pub pack_context: String,
    /// `parts.orchestrationContext` / `parts.agentCatalogContext` for the session's mode and agent.
    pub orchestration_context: String,
    pub agent_catalog_context: String,
    /// `parts.contactCatalogContext`: the bots the Lead may hand work to (agent mode only).
    pub contact_catalog_context: String,
}

/// A surface answer that could not be given: a lane read that could not run, or a session record
/// Node's code would throw on. The switch stops with this text; nothing is switched on a guess.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceFailure(pub String);

impl std::fmt::Display for SurfaceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<SurfaceFailure> for String {
    fn from(failure: SurfaceFailure) -> Self {
        failure.0
    }
}

/// What the prompt machinery answers a switch. The workflow packs and the mode texts are files
/// and config (read on the lanes, so every method is async and typed); the tool gates are the
/// run-host's tool surface.
#[async_trait]
pub trait WorkflowSurface: Send + Sync {
    /// The workflow `workflow_id` names for `session`, with orchestration mode `mode` (`None`:
    /// the configured one). A missing id falls back to the default pack, so a different
    /// `summary.id` is a gone workflow.
    async fn target(&self, session: &Header, workflow_id: &str, mode: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure>;
    /// `liveDeniedTools(session, summary)`: the tools the workflow denies this session.
    async fn live_denied_tools(&self, session: &Header, summary: &Value) -> Result<Vec<String>, SurfaceFailure>;
    /// `modelStandaloneTools()` as the session's workflow gates them.
    async fn internal_tools(&self, session: &Header) -> Result<Vec<Value>, SurfaceFailure>;
    /// `orchestrationInstructions(mode)`: the user's file for the mode, else the shipped one.
    async fn orchestration_instructions(&self, mode: &str) -> Result<String, SurfaceFailure>;
}

// ---- JS values ----------------------------------------------------------------------------------

fn js_string(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(Some(value)) => mixdog_js::value_to_string(value),
        _ => String::new(),
    }
}

fn trimmed(value: Option<&Value>) -> String {
    mixdog_js::js_trim(&js_string(value)).to_owned()
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|list| list.iter().map(mixdog_js::value_to_string).collect()).unwrap_or_default()
}

fn array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn tool_name(tool: &Value) -> String {
    js_string(tool.get("name"))
}

/// `schemaTools(session)`: every definition the schema or the deferred catalogs hold.
fn schema_tools(session: &Header) -> Vec<Value> {
    ["tools", "deferredToolCatalog", "deferredLateToolCatalog"].iter().flat_map(|key| array(session.get(*key))).collect()
}

/// `toolNames(list)`: the names of strings and `{name}` objects.
fn tool_names(value: Option<&Value>) -> Vec<String> {
    array(value)
        .iter()
        .map(|item| match item {
            Value::String(name) => name.clone(),
            other => js_string(other.get("name")),
        })
        .filter(|name| !name.is_empty())
        .collect()
}

// ---- the session's modes ------------------------------------------------------------------------

fn normalize_mode(value: &Value) -> &'static str {
    MODES.iter().copied().find(|mode| value.as_str() == Some(mode)).unwrap_or("none")
}

/// `sessionOrchestrationMode(session)`: a legacy record derives it from its workflow.
pub fn current_mode(session: &Header) -> String {
    if let Some(mode) = session.get("orchestrationMode") {
        return normalize_mode(mode).to_owned();
    }
    let workflow = session.get("workflow").filter(|workflow| truthy(Some(workflow)));
    let field = |key: &str| workflow.and_then(|workflow| workflow.get(key));
    let no_agents = field("agentsConfigured") == Some(&json!(true)) && field("agents").and_then(Value::as_array).is_some_and(Vec::is_empty);
    if field("delegatesAgents") == Some(&json!(false)) || no_agents {
        return "none".into();
    }
    if field("delegatesAgents") == Some(&json!(true)) {
        return "swarm".into();
    }
    match workflow {
        Some(workflow) => {
            let active = js_string(workflow.get("id"));
            if !active.is_empty() && active != "solo" && active != "headless" { "swarm" } else { "none" }.into()
        }
        None => "swarm".into(),
    }
}

/// `promptOrchestrationModeOf(session) ?? currentMode(session)`: the mode the prompt was built with.
pub fn prompt_mode(session: &Header) -> String {
    let built = if truthy(session.get("workflowOverlay")) {
        session["workflowOverlay"].get("promptOrchestrationMode")
    } else if truthy(session.get("orchestrationModeOverlay")) {
        session["orchestrationModeOverlay"].get("prompt")
    } else {
        session.get("orchestrationMode")
    };
    match built {
        Some(Value::Null) | None => current_mode(session),
        Some(mode) => mixdog_js::value_to_string(mode),
    }
}

/// `promptWorkflowOf(session)`: the workflow the system prompt and tool surface were built with.
fn prompt_workflow(session: &Header) -> Value {
    let overlay = session.get("workflowOverlay").and_then(|overlay| overlay.get("prompt")).filter(|prompt| truthy(Some(prompt)));
    overlay.or_else(|| session.get("workflow").filter(|workflow| truthy(Some(workflow)))).cloned().unwrap_or(Value::Null)
}

/// `toSessionWorkflowMeta(summary)`.
pub fn workflow_meta(summary: &Value) -> Value {
    let id = trimmed(summary.get("id"));
    if !summary.is_object() || id.is_empty() {
        return Value::Null;
    }
    let name = trimmed(summary.get("name"));
    json!({
        "id": id,
        "name": if name.is_empty() { id.clone() } else { name },
        "description": trimmed(summary.get("description")),
        "source": trimmed(summary.get("source")),
        "delegatesAgents": summary.get("delegatesAgents") != Some(&json!(false)),
    })
}

fn workflow_ref(workflow: &Value) -> Value {
    let id = trimmed(workflow.get("id"));
    if id.is_empty() {
        return Value::Null;
    }
    let name = trimmed(workflow.get("name"));
    json!({ "id": id, "name": if name.is_empty() { id.clone() } else { name } })
}

fn mode_name(mode: &str) -> String {
    let mode = normalize_mode(&json!(mode));
    if mode == "none" {
        return "Solo".into();
    }
    let mut chars = mode.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn listed(names: &[String]) -> String {
    names.iter().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(", ")
}

/// `workflowOverlayContent`.
fn workflow_overlay_content(prompt_name: &str, workflow_name: &str, instructions: &str, denied: &[String], loadable: &[String], unavailable: &[String]) -> String {
    let name = workflow_name;
    let mut lines = vec![
        "<system-reminder>".to_owned(),
        "# Workflow Changed".to_owned(),
        format!("This conversation now runs the {name} workflow. The system prompt's Active Workflow, orchestration mode and available agents are still {prompt_name}'s: they no longer apply; follow {name}'s below instead. This replaces every earlier Workflow Changed reminder in this conversation."),
    ];
    if !denied.is_empty() {
        lines.push(format!("Not available in {name} (calls are refused): {}.", listed(denied)));
    }
    if !loadable.is_empty() {
        let pronoun = if loadable.len() == 1 { "it" } else { "them" };
        lines.push(format!("{name} adds {}: not among your directly defined tools yet; load {pronoun} with `load_tool` before the first call.", listed(loadable)));
    }
    if !unavailable.is_empty() {
        lines.push(format!("{name} allows {}, but this session cannot use them; a new session can.", listed(unavailable)));
    }
    lines.push(format!("Agents already started under {prompt_name} keep running with their own instructions; new delegation follows {name}."));
    lines.push(String::new());
    lines.push(instructions.to_owned());
    lines.push("</system-reminder>".to_owned());
    lines.join("\n")
}

/// `orchestrationModeNoticeContent({ mode, carried, loadableTools })` over the mode's `instructions`
/// (`orchestrationInstructions(mode)`). `carried`: the system prompt carries this mode itself.
pub fn mode_notice_text(mode: &str, carried: bool, loadable: &[String], instructions: &str) -> String {
    let name = mode_name(mode);
    let lead = if carried {
        format!("This conversation now uses the {name} orchestration mode, the one the system prompt carries.")
    } else {
        format!("This conversation now uses the {name} orchestration mode. The system prompt's Orchestration Mode no longer applies; follow {name}'s below instead.")
    };
    let mut lines = vec![
        "<system-reminder>".to_owned(),
        "# Orchestration Mode Changed".to_owned(),
        format!("{lead} This replaces every earlier Orchestration Mode Changed reminder in this conversation."),
    ];
    if !loadable.is_empty() {
        let pronoun = if loadable.len() == 1 { "it" } else { "them" };
        lines.push(format!("{}: not among your directly defined tools yet; load {pronoun} with `load_tool` before the first call.", listed(loadable)));
    }
    lines.push(format!("Agents already started keep running with their own instructions; new delegation follows {name}."));
    lines.push(String::new());
    lines.push(instructions.to_owned());
    lines.push("</system-reminder>".to_owned());
    lines.join("\n")
}

/// `orchestrationModeNoticeContent({ mode, loadableTools })` for a switch made while the prompt keeps the old mode.
async fn mode_notice_content(surface: &dyn WorkflowSurface, mode: &str, loadable: &[String]) -> Result<String, SurfaceFailure> {
    Ok(mode_notice_text(mode, false, loadable, &surface.orchestration_instructions(mode).await?))
}

// ---- the pending deferred-tool delta ------------------------------------------------------------

/// `compactDescription(value)`: a delta names a tool; its description is a hint.
pub fn compact_description(value: Option<&Value>) -> String {
    let text = js_string(value);
    let collapsed = text.split(mixdog_js::is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let text = mixdog_js::js_trim(&collapsed.replace(['<', '>'], "")).to_owned();
    if text.encode_utf16().count() > DELTA_DESCRIPTION_MAX {
        let head: Vec<u16> = text.encode_utf16().take(DELTA_DESCRIPTION_MAX - 1).collect();
        format!("{}…", mixdog_js::js_trim_end(&String::from_utf16_lossy(&head)))
    } else {
        text
    }
}

/// `localeCompare` over tool names: case-insensitive first, a lower-case letter before its capital.
fn locale_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// `mergePendingDeferredToolDelta(session, { added, removed })` with removals that name no server.
pub fn merge_deferred_delta(session: &mut Header, added: &[(String, String)], removed: &[String], now: i64) {
    let removed: Vec<(String, String)> = removed.iter().map(|name| (name.clone(), String::new())).collect();
    merge_deferred_delta_with_servers(session, added, &removed, now);
}

/// `mergePendingDeferredToolDelta(session, { added, removed })` where each removal is `(name, server)`
/// (`{ name, server }`); an empty server records none.
pub fn merge_deferred_delta_with_servers(session: &mut Header, added: &[(String, String)], removed: &[(String, String)], now: i64) {
    let source = session.get("pendingDeferredToolDelta").filter(|delta| delta.is_object()).cloned().unwrap_or(Value::Null);
    let mut by_name: Vec<(String, String)> = Vec::new();
    for entry in array(source.get("added")) {
        let name = trimmed(entry.get("name"));
        if !name.is_empty() {
            by_name.retain(|(known, _)| *known != name);
            by_name.push((name, compact_description(entry.get("description"))));
        }
    }
    let mut gone: Vec<String> = Vec::new();
    let mut servers: HashMap<String, String> =
        source.get("removedServers").and_then(Value::as_object).map(|map| map.iter().map(|(k, v)| (k.clone(), mixdog_js::value_to_string(v))).collect()).unwrap_or_default();
    for entry in array(source.get("removed")) {
        let name = trimmed(Some(match &entry {
            Value::String(_) => &entry,
            other => other.get("name").unwrap_or(&Value::Null),
        }));
        if name.is_empty() {
            continue;
        }
        if !gone.contains(&name) {
            gone.push(name.clone());
        }
        if let Some(server) = entry.get("server") {
            let server = trimmed(Some(server));
            if !server.is_empty() {
                servers.insert(name, server);
            }
        }
    }
    for (name, _) in &by_name {
        gone.retain(|g| g != name);
    }
    servers.retain(|name, _| gone.contains(name));
    let revision = source.get("revision").and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
    let next = revision.max(session.get("deferredToolDeltaRevision").and_then(Value::as_f64).unwrap_or(0.0).max(0.0)) + 1.0;
    for (name, description) in added {
        let name = mixdog_js::js_trim(name).to_owned();
        if name.is_empty() {
            continue;
        }
        if gone.contains(&name) {
            gone.retain(|g| *g != name);
            servers.remove(&name);
            continue;
        }
        by_name.retain(|(known, _)| *known != name);
        by_name.push((name, compact_description(Some(&json!(description)))));
    }
    for (name, server) in removed {
        let name = mixdog_js::js_trim(name).to_owned();
        if name.is_empty() {
            continue;
        }
        if by_name.iter().any(|(known, _)| *known == name) {
            by_name.retain(|(known, _)| *known != name);
            continue;
        }
        if !gone.contains(&name) {
            gone.push(name.clone());
        }
        let server = mixdog_js::js_trim(server);
        if !server.is_empty() {
            servers.insert(name, server.to_owned());
        }
    }
    by_name.sort_by(|a, b| locale_order(&a.0, &b.0));
    gone.sort();
    let next_value = mixdog_js::json_number(next);
    session.insert("deferredToolDeltaRevision".into(), next_value.clone());
    if by_name.is_empty() && gone.is_empty() {
        session.shift_remove("pendingDeferredToolDelta");
        return;
    }
    let mut delta = Map::new();
    delta.insert("version".into(), json!(1));
    delta.insert("type".into(), json!("deferred_tools_delta"));
    delta.insert("revision".into(), next_value);
    delta.insert("added".into(), Value::Array(by_name.iter().map(|(name, description)| json!({ "name": name, "description": description })).collect()));
    delta.insert("removed".into(), json!(gone));
    if !servers.is_empty() {
        let mut sorted: Vec<(&String, &String)> = servers.iter().collect();
        sorted.sort_by(|a, b| locale_order(a.0, b.0));
        delta.insert("removedServers".into(), Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
    }
    session.insert("pendingDeferredToolDelta".into(), Value::Object(delta));
    session.insert("updatedAt".into(), json!(now));
}

// ---- the switches -------------------------------------------------------------------------------

/// A display-only boundary for the switch anchor message (`recordTranscriptBoundary`).
#[derive(Clone, Debug, PartialEq)]
pub struct Boundary {
    pub field: &'static str,
    pub value: Value,
}

impl Boundary {
    /// The predicate that finds this boundary already recorded: the same time and direction
    /// (two switches can land in the same millisecond, A→B→A).
    pub fn same(&self) -> impl Fn(&Value) -> bool + '_ {
        move |entry: &Value| {
            let keys: &[&str] = match (self.field, self.value.get("unavailable").is_some()) {
                ("workflowSwitches", true) => &["at", "toId", "unavailable"],
                ("workflowSwitches", false) => &["at", "fromId", "toId"],
                _ => &["at", "from", "to"],
            };
            keys.iter().all(|key| entry.get(*key) == self.value.get(*key))
        }
    }
}

/// A switch's answer and the boundaries it records.
#[derive(Clone, Debug, PartialEq)]
pub struct Switched {
    pub result: Value,
    pub boundaries: Vec<Boundary>,
}

fn stage_workflow_notice(session: &mut Header, from: &Value, to: &Value) {
    let prior = session.get("workflowSwitch").filter(|prior| truthy(Some(prior))).cloned();
    let told = match &prior {
        Some(prior) => prior.get("from").cloned().unwrap_or(Value::Null),
        None => workflow_ref(from),
    };
    let next = workflow_ref(to);
    if next.is_null() || told.get("id") == next.get("id") && !told.is_null() {
        session.shift_remove("workflowSwitch");
        return;
    }
    let revision = prior.as_ref().and_then(|prior| prior.get("revision")).and_then(Value::as_f64).filter(|n| *n != 0.0).unwrap_or(0.0) + 1.0;
    session.insert("workflowSwitch".into(), json!({ "version": 1, "revision": mixdog_js::json_number(revision), "from": told, "to": next }));
}

fn stage_mode_notice(session: &mut Header, from: &str, to: &str) {
    let prior = session.get("orchestrationModeSwitch").filter(|prior| truthy(Some(prior))).cloned();
    let told = match &prior {
        Some(prior) => js_string(prior.get("from")),
        None => from.to_owned(),
    };
    if to.is_empty() || told == to {
        session.shift_remove("orchestrationModeSwitch");
        return;
    }
    let revision = prior.as_ref().and_then(|prior| prior.get("revision")).and_then(Value::as_f64).filter(|n| *n != 0.0).unwrap_or(0.0) + 1.0;
    session.insert("orchestrationModeSwitch".into(), json!({ "version": 1, "revision": mixdog_js::json_number(revision), "from": told, "to": to }));
}

/// A workflow resolved before anything changes (`resolveWorkflow`).
struct Resolved {
    target: WorkflowTarget,
}

/// What `resolveWorkflow` found: the workflow, or the sentence Node throws for a gone one.
enum Resolution {
    Found(Resolved),
    Gone(String),
}

async fn resolve_workflow(session: &Header, surface: &dyn WorkflowSurface, workflow_id: &str, mode: &str) -> Result<Resolution, SurfaceFailure> {
    let target = surface.target(session, workflow_id, Some(mode)).await?;
    if js_string(target.summary.get("id")) != workflow_id {
        return Ok(Resolution::Gone(format!("workflow \"{workflow_id}\" not found")));
    }
    Ok(Resolution::Found(Resolved { target }))
}

/// `workflowOverlay`: what the reminder tells the Lead and which calls are refused.
async fn workflow_overlay(
    session: &Header,
    surface: &dyn WorkflowSurface,
    resolved: &Resolved,
    prompt: &Value,
    prompt_orchestration_mode: &str,
) -> Result<(Value, Vec<Value>, Vec<String>), SurfaceFailure> {
    let target = &resolved.target;
    let denied: HashSet<String> = surface.live_denied_tools(session, &target.summary).await?.iter().map(|name| name.to_lowercase()).collect();
    let disallowed: HashSet<String> = strings(session.get("disallowedTools")).iter().map(|name| name.to_lowercase()).collect();
    let schema = schema_tools(session);
    let denied_tools = unique(schema.iter().map(tool_name).filter(|name| !name.is_empty() && denied.contains(&name.to_lowercase()) && !disallowed.contains(&name.to_lowercase())));
    let reopened: Vec<String> = unique(strings(session.get("disallowedTools")).into_iter().chain(strings(session.get("workflowOpenedTools")))).into_iter().filter(|name| !denied.contains(&name.to_lowercase())).collect();
    let mut known: HashSet<String> = schema.iter().map(tool_name).collect();
    let mut fresh = Vec::new();
    for tool in surface.internal_tools(session).await? {
        let name = tool_name(&tool);
        if reopened.contains(&name) && !known.contains(&name) {
            fresh.push(tool);
        }
    }
    for tool in &fresh {
        known.insert(tool_name(tool));
    }
    let loadable: Vec<String> = reopened.iter().filter(|name| known.contains(*name)).cloned().collect();
    let unavailable: Vec<String> = reopened.iter().filter(|name| !known.contains(*name)).cloned().collect();
    let id = js_string(target.summary.get("id"));
    let name = match js_string(target.summary.get("name")) {
        name if name.is_empty() => id.clone(),
        name => name,
    };
    let default_orchestration = format!("# Delegation\n\n{name} has no agents to delegate to: do the work yourself.");
    let orchestration = if target.orchestration_context.is_empty() { default_orchestration } else { target.orchestration_context.clone() };
    let instructions = [target.pack_context.as_str(), orchestration.as_str(), target.agent_catalog_context.as_str()]
        .iter()
        .map(|part| mixdog_js::js_trim(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let prompt_name = match (js_string(prompt.get("name")), js_string(prompt.get("id"))) {
        (name, _) if !name.is_empty() => name,
        (_, id) if !id.is_empty() => id,
        _ => "the previous workflow".to_owned(),
    };
    let overlay = json!({
        "prompt": prompt,
        "promptOrchestrationMode": prompt_orchestration_mode,
        "workflow": { "id": id, "name": name },
        "orchestrationMode": target.orchestration_mode,
        "deniedTools": denied_tools,
        "loadableTools": loadable,
        "unavailableTools": unavailable,
        "content": workflow_overlay_content(&prompt_name, &name, &instructions, &denied_tools, &loadable, &unavailable),
    });
    Ok((overlay, fresh, loadable))
}

/// `openLoadableTools`: their definitions join the deferred catalog, the policy stops denying
/// them and the next turn's delta names them.
fn open_loadable_tools(session: &mut Header, loadable: &[String], fresh: Vec<Value>, now: i64) {
    if loadable.is_empty() {
        return;
    }
    let opened = unique(strings(session.get("workflowOpenedTools")).into_iter().chain(loadable.iter().cloned()));
    session.insert("workflowOpenedTools".into(), json!(opened));
    if !fresh.is_empty() {
        let late: Vec<Value> = array(session.get("deferredLateToolCatalog")).into_iter().chain(fresh).collect();
        session.insert("deferredLateToolCatalog".into(), Value::Array(late));
    }
    let kept: Vec<Value> = array(session.get("disallowedTools")).into_iter().filter(|name| !loadable.contains(&mixdog_js::value_to_string(name))).collect();
    session.insert("disallowedTools".into(), Value::Array(kept));
    let described: HashMap<String, String> = schema_tools(session).iter().map(|tool| (tool_name(tool), js_string(tool.get("description")))).collect();
    let added: Vec<(String, String)> = loadable.iter().map(|name| (name.clone(), described.get(name).cloned().unwrap_or_default())).collect();
    merge_deferred_delta(session, &added, &[], now);
}

/// `closeReopenedTools`: back on the prompt's workflow, what an earlier switch opened that it
/// denies is denied again (call-time refusal; the schema stays).
async fn close_reopened_tools(session: &mut Header, surface: &dyn WorkflowSurface, resolved: &Resolved, now: i64) -> Result<(), SurfaceFailure> {
    let denied = unique(surface.live_denied_tools(session, &resolved.target.summary).await?);
    let disallowed = unique(strings(session.get("disallowedTools")));
    let known: HashSet<String> = schema_tools(session).iter().map(tool_name).collect();
    let closed: Vec<String> = denied.into_iter().filter(|name| known.contains(name) && !disallowed.contains(name)).collect();
    if closed.is_empty() {
        return Ok(());
    }
    session.insert("disallowedTools".into(), json!(disallowed.iter().chain(closed.iter()).collect::<Vec<_>>()));
    merge_deferred_delta(session, &[], &closed, now);
    Ok(())
}

/// `applyWorkflowSwitch(session, resolved)`.
async fn apply_workflow_switch(session: &mut Header, surface: &dyn WorkflowSurface, resolved: &Resolved, now: i64) -> Result<Switched, SurfaceFailure> {
    let before = session.get("workflow").cloned().unwrap_or(Value::Null);
    let from = if truthy(before.get("id")) { before } else { Value::Null };
    let prompt = prompt_workflow(session);
    let prompt_orchestration_mode = prompt_mode(session);
    let meta = workflow_meta(&resolved.target.summary);
    session.insert("workflow".into(), meta.clone());
    session.insert("orchestrationMode".into(), json!(resolved.target.orchestration_mode));
    session.shift_remove("workflowOverlay");
    if meta.get("id") == prompt.get("id") && !prompt.is_null() {
        close_reopened_tools(session, surface, resolved, now).await?;
    } else {
        let (overlay, fresh, loadable) = workflow_overlay(session, surface, resolved, &prompt, &prompt_orchestration_mode).await?;
        open_loadable_tools(session, &loadable, fresh, now);
        session.insert("workflowOverlay".into(), overlay);
    }
    session.insert("updatedAt".into(), json!(now));
    stage_workflow_notice(session, &from, &meta);
    let mut workflow_switch = Value::Null;
    let mut boundaries = Vec::new();
    if from.get("id") != meta.get("id") {
        let named = |key: &str| js_string(from.get(key));
        workflow_switch = json!({
            "fromId": named("id"),
            "from": if !named("name").is_empty() { named("name") } else { named("id") },
            "toId": meta["id"],
            "to": meta["name"],
            "at": now,
        });
        boundaries.push(Boundary { field: "workflowSwitches", value: workflow_switch.clone() });
    }
    Ok(Switched { result: json!({ "appliedToCurrentSession": true, "workflow": meta, "workflowSwitch": workflow_switch }), boundaries })
}

/// `modeLoadableTools(session, mode)`: `agent` when the mode delegates and the session can run
/// it but holds it only as a deferred tool the model has not loaded.
fn mode_loadable_tools(session: &Header, mode: &str) -> Vec<String> {
    if mode == "none" {
        return Vec::new();
    }
    let reached: HashSet<String> =
        ["tools", "deferredCallableTools", "deferredDiscoveredTools"].iter().flat_map(|key| tool_names(session.get(*key))).collect();
    let deferred: HashSet<String> = ["deferredToolCatalog", "deferredLateToolCatalog"].iter().flat_map(|key| tool_names(session.get(*key))).collect();
    let denied: HashSet<String> = strings(session.get("disallowedTools"))
        .into_iter()
        .chain(strings(session.get("workflowOverlay").and_then(|overlay| overlay.get("deniedTools"))))
        .collect();
    ["agent"].iter().filter(|name| deferred.contains(**name) && !reached.contains(**name) && !denied.contains(**name)).map(|name| (*name).to_owned()).collect()
}

/// `applyOrchestrationModeSwitch(session, mode)`.
async fn apply_mode_switch(session: &mut Header, surface: &dyn WorkflowSurface, mode: &str, now: i64) -> Result<Switched, SurfaceFailure> {
    let from = current_mode(session);
    let prompt = prompt_mode(session);
    session.insert("orchestrationMode".into(), json!(mode));
    session.shift_remove("orchestrationModeOverlay");
    if mode != prompt {
        let loadable = mode_loadable_tools(session, mode);
        let overlay = json!({ "prompt": prompt, "mode": mode, "loadableTools": loadable, "content": mode_notice_content(surface, mode, &loadable).await? });
        session.insert("orchestrationModeOverlay".into(), overlay);
    }
    session.insert("updatedAt".into(), json!(now));
    stage_mode_notice(session, &from, mode);
    let mut switch = Value::Null;
    let mut boundaries = Vec::new();
    if from != mode {
        switch = json!({ "from": from, "to": mode, "at": now });
        boundaries.push(Boundary { field: "orchestrationModeSwitches", value: switch.clone() });
    }
    Ok(Switched { result: json!({ "appliedToCurrentSession": true, "mode": mode, "orchestrationModeSwitch": switch }), boundaries })
}

/// What a switch reads of the live thread besides its header.
#[derive(Clone, Copy, Debug)]
pub struct Facts {
    pub now: i64,
    /// A turn is executing: the choice waits for the next one.
    pub in_flight: bool,
    /// The conversation holds a user, assistant or tool message (committed or live).
    pub conversation: bool,
}

/// `isAgentOwner(session)`.
fn agent_owner(session: &Header) -> bool {
    mixdog_js::js_trim(&js_string(session.get("owner"))).to_lowercase() == "agent"
}

/// `sessionModeOf(session)`.
fn session_mode_is_agent(session: &Header) -> bool {
    match session.get("sessionMode").and_then(Value::as_str) {
        Some("agent") => true,
        Some("coding") => false,
        _ => resolve_session_mode(&Value::Object(session.clone())).0 == "agent",
    }
}

/// `codingLead(session)` (`agent-profile-fold.mjs`): a Lead of the coding mode, the session whose agents ride the
/// agent list reminder of every turn.
pub fn coding_lead(session: &Header) -> bool {
    let owner = session.get("owner").map(|owner| mixdog_js::js_trim(&mixdog_js::value_to_string(owner)).to_lowercase());
    truthy(session.get("id")) && truthy(session.get("promptIdentity")) && owner.as_deref() != Some("agent") && !session_mode_is_agent(session)
}

/// `switchableConversation(session, what)`: `false` without a conversation (the caller's
/// empty-session path applies); a refusal for anything but a coding session.
fn switchable(session: &Header, facts: &Facts, what: &str) -> Result<bool, String> {
    if !facts.conversation {
        return Ok(false);
    }
    if agent_owner(session) || session_mode_is_agent(session) {
        return Err(format!("Only a coding session has a {what}."));
    }
    if !truthy(session.get("promptIdentity")) {
        return Err(format!("This session is too old to switch its {what}; start a new task."));
    }
    Ok(true)
}

/// `stagePendingSwitch`: the latest choice wins; a choice of what the session already runs
/// cancels it.
fn stage_pending(session: &mut Header, field: &str, value: &str, current: &str, now: i64) {
    if value == current {
        session.shift_remove(field);
    } else {
        session.insert(field.into(), json!(value));
    }
    session.insert("updatedAt".into(), json!(now));
}

/// `switchSessionWorkflow(workflowId)` over `session`: `None` without a conversation.
pub async fn switch_workflow(session: &mut Header, facts: &Facts, surface: &dyn WorkflowSurface, workflow_id: &str) -> Result<Option<Switched>, String> {
    if !switchable(session, facts, "workflow")? {
        return Ok(None);
    }
    if facts.in_flight {
        let current = js_string(session.get("workflow").and_then(|workflow| workflow.get("id")));
        stage_pending(session, "pendingWorkflowId", workflow_id, &current, facts.now);
        let shown = match session.get("pendingWorkflowId").filter(|id| truthy(Some(id))) {
            Some(pending) => workflow_meta(&surface.target(session, &mixdog_js::value_to_string(pending), None).await?.summary),
            None => session.get("workflow").cloned().unwrap_or(Value::Null),
        };
        let result = json!({ "appliedToCurrentSession": true, "deferred": true, "workflow": shown, "workflowSwitch": null });
        return Ok(Some(Switched { result, boundaries: Vec::new() }));
    }
    let resolved = match resolve_workflow(session, surface, workflow_id, &current_mode(session)).await? {
        Resolution::Found(resolved) => resolved,
        Resolution::Gone(reason) => return Err(reason),
    };
    session.shift_remove("pendingWorkflowId");
    Ok(Some(apply_workflow_switch(session, surface, &resolved, facts.now).await?))
}

/// `switchSessionOrchestrationMode(mode)` over `session`: `None` without a conversation.
pub async fn switch_mode(session: &mut Header, facts: &Facts, surface: &dyn WorkflowSurface, mode: &str) -> Result<Option<Switched>, String> {
    if !switchable(session, facts, "orchestration mode")? {
        return Ok(None);
    }
    if facts.in_flight {
        let current = current_mode(session);
        stage_pending(session, "pendingOrchestrationMode", mode, &current, facts.now);
        let shown = match session.get("pendingOrchestrationMode") {
            Some(pending) if !pending.is_null() => mixdog_js::value_to_string(pending),
            _ => current,
        };
        let result = json!({ "appliedToCurrentSession": true, "deferred": true, "mode": shown, "orchestrationModeSwitch": null });
        return Ok(Some(Switched { result, boundaries: Vec::new() }));
    }
    session.shift_remove("pendingOrchestrationMode");
    Ok(Some(apply_mode_switch(session, surface, mode, facts.now).await?))
}

/// `applyPendingSessionSwitches()`: the choices made while a turn ran, at the next turn start
/// (the mode first, so a workflow reminder carries it). A workflow that is gone is dropped alone
/// with a transcript note. `None` when nothing switched.
pub async fn apply_pending(session: &mut Header, surface: &dyn WorkflowSurface, now: i64) -> Result<Option<Switched>, SurfaceFailure> {
    let mode = session.get("pendingOrchestrationMode").map(mixdog_js::value_to_string);
    let workflow_id = session.get("pendingWorkflowId").map(mixdog_js::value_to_string);
    if mode.is_none() && workflow_id.is_none() {
        return Ok(None);
    }
    let mut resolved = None;
    let mut unavailable = None;
    if let Some(id) = &workflow_id {
        let at_mode = mode.clone().unwrap_or_else(|| current_mode(session));
        // A workflow that is gone is dropped alone; a surface that cannot answer stops the whole apply.
        match resolve_workflow(session, surface, id, &at_mode).await? {
            Resolution::Found(found) => resolved = Some(found),
            Resolution::Gone(reason) => {
                let current = session.get("workflow").cloned().unwrap_or(Value::Null);
                let named = |key: &str| js_string(current.get(key));
                unavailable = Some(json!({
                    "fromId": named("id"),
                    "from": if !named("name").is_empty() { named("name") } else { named("id") },
                    "toId": id,
                    "to": id,
                    "unavailable": true,
                    "reason": reason,
                    "at": now,
                }));
            }
        }
    }
    let mut boundaries = Vec::new();
    let mut switches = Map::new();
    if let Some(unavailable) = &unavailable {
        boundaries.push(Boundary { field: "workflowSwitches", value: unavailable.clone() });
    }
    if let Some(mode) = &mode {
        let applied = apply_mode_switch(session, surface, mode, now).await?;
        switches.insert("orchestrationModeSwitch".into(), applied.result["orchestrationModeSwitch"].clone());
        boundaries.extend(applied.boundaries);
    }
    if let Some(resolved) = &resolved {
        let applied = apply_workflow_switch(session, surface, resolved, now).await?;
        switches.insert("workflowSwitch".into(), applied.result["workflowSwitch"].clone());
        boundaries.extend(applied.boundaries);
    } else if let Some(unavailable) = unavailable {
        switches.insert("workflowSwitch".into(), unavailable);
    }
    session.shift_remove("pendingOrchestrationMode");
    session.shift_remove("pendingWorkflowId");
    let landed = |key: &str| truthy(switches.get(key));
    Ok((landed("orchestrationModeSwitch") || landed("workflowSwitch")).then(|| Switched { result: Value::Object(switches), boundaries }))
}

// ---- the live thread ----------------------------------------------------------------------------

/// A boundary on the switch anchor row: Node replaces the anchor message with its `meta[field]`
/// extended; the row's body is amended the same way (`thread/reactions/apply`, the amend of a
/// row body). `false` when there is no stored row to mark: no message, or the anchor is a
/// compaction's replacement entry (no history row).
pub async fn record_meta_boundary(directory: &SessionDirectory, thread: &ThreadId, boundary: &Boundary) -> Result<bool, mixdog_core_api::CoreError> {
    let context = directory.model_context(thread).read().await?;
    let messages: Vec<Value> = context.iter().map(|(_, message)| message.clone()).collect();
    let Some(index) = model_switch_anchor_index(&messages) else { return Ok(false) };
    let iid = context[index].0.as_str().to_owned();
    let Some((_, row)) = directory.history_row(thread, &iid).await? else { return Ok(false) };
    let Slot::Inline(body) = &row.body else { return Ok(false) };
    let same = boundary.same();
    let mut recorded = array(body.pointer(&format!("/meta/{}", boundary.field)));
    if recorded.iter().any(&same) {
        return Ok(true);
    }
    recorded.push(boundary.value.clone());
    let mut next = body.clone();
    let Some(message) = next.as_object_mut() else { return Ok(false) };
    let meta = message.entry("meta").or_insert_with(|| Value::Object(Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(Map::new());
    }
    meta.as_object_mut().expect("meta is an object").insert(boundary.field.to_owned(), Value::Array(recorded));
    let ctx = CallContext::internal("thread-switches");
    let handle = directory.open_handle(thread, &ctx).await?;
    let params = json!({ "iid": iid, "refs": row.refs, "body": next, "turn": row.turn.as_ref().map(|turn| turn.as_str()), "items": [] });
    handle.request(CoreRequest { method: Method("thread/reactions/apply"), params, op: None, ctx }).await?;
    Ok(true)
}

/// A header's keys changed by `after`: the patch and the values it was computed from.
fn header_patch(before: &Header, after: &Header) -> (Map<String, Value>, Vec<String>, Map<String, Value>) {
    let mut set = Map::new();
    let mut expect = Map::new();
    for (key, value) in after {
        if key != "id" && before.get(key) != Some(value) {
            set.insert(key.clone(), value.clone());
            expect.insert(key.clone(), before.get(key).cloned().unwrap_or(Value::Null));
        }
    }
    let mut unset = Vec::new();
    for (key, value) in before {
        if key != "id" && !after.contains_key(key) {
            unset.push(key.clone());
            expect.insert(key.clone(), value.clone());
        }
    }
    (set, unset, expect)
}

fn failed(error: PortError) -> String {
    format!("{error:?}")
}

/// [`SessionSwitches`] over the session directory.
/// What one switch does to the header (the adapter retries it against a fresher header).
#[derive(Clone, Copy)]
enum SwitchOp<'a> {
    Workflow(&'a str),
    Mode(&'a str),
    Pending,
}

pub struct SessionSwitchAdapter {
    directory: Arc<SessionDirectory>,
    threads: SessionThreads,
    surface: Arc<dyn WorkflowSurface>,
}

struct Loaded {
    header: Header,
    facts: Facts,
}

impl SessionSwitchAdapter {
    pub fn new(directory: Arc<SessionDirectory>, surface: Arc<dyn WorkflowSurface>) -> Self {
        Self { threads: SessionThreads::new(directory.clone()), directory, surface }
    }

    /// The thread's header (with its `id`) and what a switch reads of it; `None`: no such session.
    async fn load(&self, thread: &ThreadId) -> Result<Option<Loaded>, String> {
        let mut header = match self.threads.header(thread).await {
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(failed(error)),
        };
        header.insert("id".into(), json!(thread.as_str()));
        let handle = self.directory.handle(thread);
        let live: Vec<Value> = handle.as_ref().map(|handle| (**handle.cell.turn_messages.borrow()).clone()).unwrap_or_default();
        let committed = ThreadMessages::messages(&self.threads, thread).await.map_err(failed)?;
        let facts = Facts {
            now: self.directory.deps().clock.now_ms(),
            in_flight: handle.is_some_and(|handle| handle.cell.run.load().is_some()),
            conversation: has_conversation_messages(&committed) || has_conversation_messages(&live),
        };
        Ok(Some(Loaded { header, facts }))
    }

    /// One switch: computed against the header as it is when the patch lands, then its
    /// transcript boundaries.
    async fn switch(&self, thread: &str, op: SwitchOp<'_>) -> Result<Option<Value>, String> {
        if thread.is_empty() {
            return Ok(None);
        }
        let thread = ThreadId::from(thread);
        loop {
            let Some(loaded) = self.load(&thread).await? else { return Ok(None) };
            let mut session = loaded.header.clone();
            let switched = match op {
                SwitchOp::Workflow(id) => switch_workflow(&mut session, &loaded.facts, &*self.surface, id).await?,
                SwitchOp::Mode(mode) => switch_mode(&mut session, &loaded.facts, &*self.surface, mode).await?,
                SwitchOp::Pending => apply_pending(&mut session, &*self.surface, loaded.facts.now).await?,
            };
            let Some(switched) = switched else { return Ok(None) };
            let (set, unset, expect) = header_patch(&loaded.header, &session);
            if !set.is_empty() || !unset.is_empty() {
                match self.threads.patch_header_if(&thread, expect, set, unset).await {
                    Ok(None) => {}
                    // Another write moved the header meanwhile: computed again from what it holds now.
                    Ok(Some(_)) => continue,
                    Err(error) => return Err(failed(error)),
                }
            }
            for boundary in &switched.boundaries {
                if let Err(error) = record_meta_boundary(&self.directory, &thread, boundary).await {
                    tracing::warn!("[mixdog-session] Could not record the {} boundary of {thread}: {error:?}", boundary.field);
                }
            }
            return Ok(Some(switched.result));
        }
    }

    /// `applyPendingSessionSwitches()` at a turn start: the choices made while the last turn ran.
    pub async fn apply_pending_switches(&self, thread: &ThreadId) -> Result<Option<Value>, String> {
        self.switch(thread.as_str(), SwitchOp::Pending).await
    }
}

#[async_trait]
impl SessionSwitches for SessionSwitchAdapter {
    async fn settings_reach(&self, thread: &str) -> bool {
        if thread.is_empty() {
            return true;
        }
        match self.load(&ThreadId::from(thread)).await {
            Ok(Some(loaded)) => truthy(loaded.header.get("promptIdentity")) && !loaded.facts.conversation,
            // No session (or one that cannot be read): there is none to keep.
            _ => true,
        }
    }

    async fn switch_workflow(&self, thread: &str, workflow_id: &str) -> Result<Option<Value>, String> {
        self.switch(thread, SwitchOp::Workflow(workflow_id)).await
    }

    async fn switch_orchestration_mode(&self, thread: &str, mode: &str) -> Result<Option<Value>, String> {
        self.switch(thread, SwitchOp::Mode(mode)).await
    }
}

// ---- the context switch -------------------------------------------------------------------------

/// What a desktop context switch does to the thread it leaves, beyond closing it:
/// `invalidateContextStatusCache()` and `invalidatePreSessionToolSurface()` (the surface generation).
///
/// Divergence (decisions.md, "wp-run-host: thread/switchContext retargets no global"): Node also
/// clears its route-preparation gate and retargets its single runtime for the NEXT session
/// (`setDesktopSession`, `applyResolvedCwd`, `setRoute(resolveRoute(config, {}))` +
/// `refreshRouteEffort`). The daemon has no such state: the next thread takes its cwd and desktop
/// session from its own `thread/start`, its route cell resolves the configured Lead route on first
/// read, and no route-preparation gate exists. Those calls are not made.
pub trait ContextTarget: Send + Sync {
    fn invalidate(&self, thread: &ThreadId);
}
/// The production [`ContextTarget`]: the thread left has its context gauge re-measured at the next
/// read. The same `Arc` goes to `ConfigHosts.gauge`, the route adapter and the domain seams.
pub struct GaugeTarget(pub Arc<dyn ContextStatusCache>, pub mixdog_core_base::surface::SurfaceGeneration);

impl ContextTarget for GaugeTarget {
    fn invalidate(&self, thread: &ThreadId) {
        self.0.invalidate(thread);
        // `invalidatePreSessionToolSurface()`, right after the cache (`context-switch.mjs`).
        self.1.bump();
    }
}

/// `isScratchSession(session)`: an agent's home thread or a room's thread never is; any other
/// is while it holds no user conversation and no completed turn.
pub(crate) fn is_scratch(thread: &str, committed: &[Value], live: &[Value]) -> bool {
    if !mixdog_store::agent_mode::agent_id_of_home_session(thread).is_empty() || mixdog_core_base::rooms::ids::is_room_thread_session_id(thread) {
        return false;
    }
    let completed = |messages: &[Value]| messages.iter().any(|message| truthy(message.pointer("/meta/transcript/completion")));
    [committed, live].iter().all(|items| !has_user_conversation(items) && !completed(items))
}

/// [`ContextSwitch`] over the session directory: the open thread is closed as Node closes the
/// outgoing session, then the next context is set up.
pub struct SessionContextSwitch {
    directory: Arc<SessionDirectory>,
    threads: SessionThreads,
    close: Arc<SessionClose>,
    target: Arc<dyn ContextTarget>,
}

impl SessionContextSwitch {
    pub fn new(directory: Arc<SessionDirectory>, close: Arc<SessionClose>, target: Arc<dyn ContextTarget>) -> Self {
        Self { threads: SessionThreads::new(directory.clone()), directory, close, target }
    }

    /// Leaving the open conversation: a scratch one is tombstoned (nothing worth resuming), any
    /// other stays resumable but is detached, which moves its generation on (`closeSurfaceSession(session, reason,
    /// { tombstone: isScratchSession(session) })`); its memory is ingested without waiting; its work is released.
    async fn leave(&self, thread: &ThreadId) -> Result<(), String> {
        let committed = match ThreadMessages::messages(&self.threads, thread).await {
            Ok(messages) => messages,
            Err(PortError::NotFound { .. }) => return Ok(()),
            Err(error) => return Err(failed(error)),
        };
        let live: Vec<Value> = self.directory.handle(thread).map(|handle| (**handle.cell.turn_messages.borrow()).clone()).unwrap_or_default();
        if is_scratch(thread.as_str(), &committed, &live) {
            // A failed close throws before anything else was released.
            if !self.close.close(thread.as_str(), CONTEXT_SWITCH_REASON).await {
                return Err(format!("session close failed (reason={CONTEXT_SWITCH_REASON}); the current session is kept"));
            }
        } else if !self.close.detach(thread.as_str(), CONTEXT_SWITCH_REASON, false).await {
            return Err(format!("session close failed (reason={CONTEXT_SWITCH_REASON}); the current session is kept"));
        }
        let context = self.directory.model_context(thread);
        let memory = self.directory.deps().memory.clone();
        // An unread record is not "no cwd": the rows would be filed under the wrong project, so
        // this best-effort ingest is skipped (the switch itself has already happened).
        if let Ok(header) = self.directory.try_stored_header(thread).await {
            let cwd = header.and_then(|header| header.get("cwd").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
            tokio::spawn(async move {
                if let Ok(rows) = context.read().await {
                    memory.ingest(&context.thread, &cwd, rows.into_iter().map(|(_, body)| body).collect()).await;
                }
            });
        }
        // `releaseSessionWork(session.id, cleanupReason)` (`context-switch.mjs`): the session's own background tasks
        // are cancelled and its gateway route cleared, as a delete releases them.
        self.directory.deps().deletion.release_session_work(thread.as_str(), CONTEXT_SWITCH_REASON).await;
        Ok(())
    }
}

#[async_trait]
impl ContextSwitch for SessionContextSwitch {
    async fn switch_context(&self, thread: &str, _cwd: Option<String>, _desktop_session: Option<Value>, _for_resume: bool) -> Result<(), String> {
        // No outgoing thread: nothing is open, so there is no thread to name to the target.
        if thread.is_empty() {
            return Ok(());
        }
        let thread = ThreadId::from(thread);
        self.leave(&thread).await?;
        self.target.invalidate(&thread);
        Ok(())
    }
}

#[cfg(test)]
#[path = "thread_switches_tests.rs"]
mod tests;
