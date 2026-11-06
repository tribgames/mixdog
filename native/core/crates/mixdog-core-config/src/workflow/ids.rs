//! Workflow identity and the orchestration mode (`runtime-core/workflow-ids.mjs`,
//! `runtime-core/workflow.mjs` id helpers, `shared/orchestration.mjs`), and the text helpers the
//! whole port shares (`shared/clean.mjs`).

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

pub(crate) type Doc = Map<String, Value>;

pub(crate) const DEFAULT_WORKFLOW_ID: &str = "default";
pub(crate) const ORCHESTRATION_MODES: [&str; 4] = ["none", "focused", "balanced", "swarm"];
const DEFAULT_ORCHESTRATION_MODE: &str = "balanced";

/// `String(value)` of a value that is present (null is the text `null`).
pub fn js_string(value: &Value) -> String {
    value_to_string(value)
}

/// `clean(value)`: `String(value ?? '').trim()`.
pub fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// `oneLine(value)`: every white-space run becomes one space, then trim.
pub fn one_line(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    };
    let mut out = String::new();
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    js_trim(&out).to_owned()
}

/// JavaScript truthiness (`value || …`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Object.hasOwn(value, key)` for a parsed value: an object has its keys, an array its indices.
pub fn has_own(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(map) => map.contains_key(key),
        Value::Array(items) => key.parse::<usize>().is_ok_and(|index| index < items.len()) || key == "length",
        Value::String(text) => key.parse::<usize>().is_ok_and(|index| index < mixdog_js::utf16_len(text)) || key == "length",
        _ => false,
    }
}

/// `normalizeWorkflowId(value, '')`: lower-cased, runs of white space and `_` become `-`; only
/// `[a-z0-9][a-z0-9_.-]*` is an id, anything else is `None`.
pub fn workflow_id(text: &str) -> Option<String> {
    let lowered = js_trim(text).to_lowercase();
    let mut id = String::new();
    let mut in_separator = false;
    for c in lowered.chars() {
        if c == '_' || is_js_space(c) {
            if !in_separator {
                id.push('-');
            }
            in_separator = true;
        } else {
            id.push(c);
            in_separator = false;
        }
    }
    let first = id.chars().next()?;
    let valid = (first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    valid.then_some(id)
}

/// `normalizeWorkflowId(value, '')` of a parsed value.
pub(crate) fn workflow_id_of(value: Option<&Value>) -> Option<String> {
    workflow_id(&clean(value))
}

/// `workflowIdFromName`: the readable slug of the name, else `workflow-<10 hex of sha256>`.
pub(crate) fn workflow_id_from_name(value: &str) -> String {
    internal_id_from_name(value, "workflow")
}

/// `agentIdFromName`: the same slug, `agent-<10 hex>` when nothing readable is left.
pub fn agent_id_from_name(value: &str) -> String {
    internal_id_from_name(value, "agent")
}

/// `internalIdFromName(value, fallbackPrefix)`.
fn internal_id_from_name(value: &str, fallback_prefix: &str) -> String {
    let name = js_trim(value);
    let decomposed: String = name.nfkd().collect();
    let marks = JsRegex::new_static(r"\p{M}+", "gu");
    let unmarked = marks.replace_all_with(&decomposed, |_| String::new()).to_lowercase();
    let mut readable = String::new();
    let mut in_run = false;
    for c in unmarked.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-') {
            if c == '-' {
                if in_run {
                    continue;
                }
                in_run = true;
            } else {
                in_run = false;
            }
            readable.push(c);
        } else {
            if !in_run {
                readable.push('-');
            }
            in_run = true;
        }
    }
    let readable = readable.trim_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()));
    if let Some(id) = workflow_id(readable) {
        return id;
    }
    let digest = Sha256::digest(name.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{fallback_prefix}-{}", &hex[..10])
}

/// `availableWorkflowId(baseId, isTaken)`: `base`, else `base-2`, `base-3`, …; empty for a
/// base that is no id.
pub fn available_workflow_id(base: &str, mut is_taken: impl FnMut(&str) -> bool) -> String {
    let Some(id) = workflow_id(base) else { return String::new() };
    if !is_taken(&id) {
        return id;
    }
    let mut suffix = 2;
    while is_taken(&format!("{id}-{suffix}")) {
        suffix += 1;
    }
    format!("{id}-{suffix}")
}

/// `wantedWorkflowId(id)`: the id to load; `solo` is the default pack.
pub(crate) fn wanted_workflow_id(id: &str) -> String {
    let normalized = workflow_id(id).unwrap_or_else(|| DEFAULT_WORKFLOW_ID.to_owned());
    if normalized == "solo" { DEFAULT_WORKFLOW_ID.to_owned() } else { normalized }
}

/// `activeWorkflowId(config)`.
pub(crate) fn active_workflow_id(config: &Doc) -> String {
    let active = config.get("workflow").and_then(|workflow| workflow.get("active"));
    wanted_workflow_id(&match active {
        Some(value) if truthy(Some(value)) => value_to_string(value),
        _ => DEFAULT_WORKFLOW_ID.to_owned(),
    })
}

/// `normalizeOrchestrationMode(value, fallback)`.
fn normalize_mode(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(mode) if ORCHESTRATION_MODES.contains(&mode) => mode.to_owned(),
        _ => fallback.to_owned(),
    }
}

/// `configuredOrchestrationMode(config)`: the stored mode, `balanced` when there is none.
pub(crate) fn configured_orchestration_mode(config: &Doc) -> String {
    match config.get("orchestrationMode") {
        Some(value) => normalize_mode(Some(value), DEFAULT_ORCHESTRATION_MODE),
        None => DEFAULT_ORCHESTRATION_MODE.to_owned(),
    }
}

/// `legacyWorkflowOrchestrationMode(active)`.
fn legacy_workflow_mode(active: Option<&Value>) -> &'static str {
    match active {
        Some(value) if truthy(Some(value)) && value.as_str() != Some("solo") && value.as_str() != Some("headless") => "swarm",
        _ => "none",
    }
}

/// `pendingOrchestrationMode ?? sessionOrchestrationMode(session)` over the facts a thread
/// holds: `orchestrationMode`, `pendingOrchestrationMode` and its `workflow` summary.
pub(crate) fn thread_orchestration_mode(facts: &Value) -> String {
    if let Some(pending) = facts.get("pendingOrchestrationMode").filter(|value| !value.is_null()) {
        return value_to_string(pending);
    }
    if let Some(mode) = facts.get("orchestrationMode") {
        return normalize_mode(Some(mode), "none");
    }
    let workflow = facts.get("workflow").filter(|workflow| truthy(Some(workflow)));
    let delegates = workflow.and_then(|workflow| workflow.get("delegatesAgents"));
    let no_agents = workflow.is_some_and(|workflow| {
        workflow.get("agentsConfigured") == Some(&Value::Bool(true))
            && workflow.get("agents").and_then(Value::as_array).is_some_and(|agents| agents.is_empty())
    });
    if delegates == Some(&Value::Bool(false)) || no_agents {
        return "none".to_owned();
    }
    if delegates == Some(&Value::Bool(true)) {
        return "swarm".to_owned();
    }
    match workflow {
        Some(workflow) => legacy_workflow_mode(workflow.get("id")).to_owned(),
        None => "swarm".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn ids_follow_the_node_normalisation() {
        assert_eq!(workflow_id(" My_Flow x ").as_deref(), Some("my-flow-x"));
        assert_eq!(workflow_id("-a"), None);
        assert_eq!(workflow_id("a b.c"), Some("a-b.c".into()));
        assert_eq!(workflow_id_from_name("Café  Déjà vu!"), "cafe-deja-vu");
        assert_eq!(workflow_id_from_name("한국어"), "workflow-ea3252281b");
        assert_eq!(available_workflow_id("a", |id| id == "a" || id == "a-2"), "a-3");
    }

    #[test]
    fn thread_modes() {
        assert_eq!(thread_orchestration_mode(&json!({ "orchestrationMode": "focused" })), "focused");
        assert_eq!(thread_orchestration_mode(&json!({ "workflow": { "id": "solo" } })), "none");
        assert_eq!(thread_orchestration_mode(&json!({})), "swarm");
    }
}
