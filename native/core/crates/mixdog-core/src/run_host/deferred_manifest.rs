//! The deferred-pool manifest in the system prompt's second block (Node `context/deferred-tools.mjs`:
//! `applyInitialDeferredToolManifestToBp2`, `buildDeferredToolManifest`, `listedDeferredToolNames`,
//! `stripDeferredToolManifestBlock`).
//!
//! A session is its stored object (`Value`) with its `tools` and `messages`, as Node's live session
//! is. A rewritten prompt block is always a fresh message object, never edited in place.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_agent::env::Clock;
use mixdog_js::{js_trim, locale_compare, JsRegex};
use mixdog_mcp::permissions::parse_mcp_tool_name;
use mixdog_mcp::skills::compact_manifest_text;
use mixdog_services::connectors::triggers::connector_trigger;
use serde_json::{json, Map, Value};

use super::tool_exposure::{is_tool_bridge_enabled, TOOL_BRIDGE_GUIDANCE};

/// `SKILL_TRIGGER_LISTING_MAX`.
const TRIGGER_LISTING_MAX: usize = 100;

// The native deferred-pool manifest and the static bridge guidance occupy the same slot: one
// replaces the other when the exposure changes.
static DEFERRED_TOOLS_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"(\n\n---\n*)?<(available-deferred-tools|tool-bridge)>[\s\S]*?</(?:available-deferred-tools|tool-bridge)>\s*", "gi")
});
static MCP_INSTRUCTIONS_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(\n\n---\n*)?<mcp-instructions>[\s\S]*?</mcp-instructions>\s*", "gi"));
static TRAILING_RULE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\n\n---\n*$", ""));
static ACCOUNT_SENTENCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*Account: \S+?\.\s+", ""));
static SKILLS_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<available_skills>([\s\S]*?)</available_skills>", "g"));
static SKILL_ROUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^- [^:\r\n]+:\s+\S[^\r\n]* \[tools: ([^\]\r\n]+)\]$", "gm"));
static ROUTE_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z0-9_]+$", ""));
static BLOCK_PROBES: LazyLock<[JsRegex; 3]> = LazyLock::new(|| {
    [
        JsRegex::new_static(r"<available-deferred-tools>[\s\S]*?</available-deferred-tools>", "i"),
        JsRegex::new_static(r"<tool-bridge>[\s\S]*?</tool-bridge>", "i"),
        JsRegex::new_static(r"<mcp-instructions>[\s\S]*?</mcp-instructions>", "i"),
    ]
});

fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

fn is_system(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("system")
}

fn messages(session: &Value) -> &[Value] {
    session.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn messages_mut(session: &mut Value) -> &mut Vec<Value> {
    session["messages"].as_array_mut().expect("messages")
}

fn sanitize_name(name: &str) -> String {
    let text = js_trim(name);
    let safe = !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c));
    if safe { text.to_owned() } else { String::new() }
}

fn without_angle_brackets(text: &str) -> String {
    text.replace(['<', '>'], "")
}

/// `buildDeferredToolManifest`: `(name, description)` rows as skill-style lines, sorted by name.
/// An empty pool gives "".
pub fn build_deferred_tool_manifest(entries: &[(String, String)]) -> String {
    let mut list: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for (raw, description) in entries {
        let name = sanitize_name(raw);
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        list.push((name, compact_manifest_text(&without_angle_brackets(description), TRIGGER_LISTING_MAX)));
    }
    if list.is_empty() {
        return String::new();
    }
    list.sort_by(|a, b| locale_compare(&a.0, &b.0));
    let mut lines = vec!["<available-deferred-tools>".to_owned(), "Deferred tools; load_tool loads their schemas.".to_owned()];
    lines.extend(list.iter().map(|(name, description)| if description.is_empty() { format!("- {name}") } else { format!("- {name}: {description}") }));
    lines.push("</available-deferred-tools>".to_owned());
    lines.join("\n")
}

/// `stripDeferredToolManifestBlock`.
pub fn strip_deferred_tool_manifest_block(text: &str) -> String {
    let out = DEFERRED_TOOLS_BLOCK.replace_all_with(text, |_| String::new());
    let out = MCP_INSTRUCTIONS_BLOCK.replace_all_with(&out, |_| String::new());
    let out = match TRAILING_RULE.find(&out) {
        Some(range) => format!("{}{}", &out[..range.start], &out[range.end..]),
        None => out,
    };
    mixdog_js::js_trim_end(&out).to_owned()
}

/// Replaces the first previously injected block, with its leading rule, by the fresh manifest in
/// place, so no sibling block is reordered or dropped; a legacy instructions block goes first.
fn rebuild_manifest_block(text: &str, manifest: &str) -> String {
    let out = MCP_INSTRUCTIONS_BLOCK.replace_all_with(text, |_| String::new());
    let replaced = Cell::new(false);
    let out = DEFERRED_TOOLS_BLOCK.replace_all_with(&out, |caps| {
        if replaced.replace(true) {
            return String::new();
        }
        format!("{}{manifest}", caps.get(1).unwrap_or(""))
    });
    if replaced.get() {
        return out;
    }
    let base = mixdog_js::js_trim_end(&out);
    if base.is_empty() { manifest.to_owned() } else { format!("{base}\n\n---\n\n{manifest}") }
}

fn has_manifest_block(text: &str) -> bool {
    BLOCK_PROBES.iter().any(|probe| probe.is_match(text))
}

/// The tool names the prompt's skill manifest routes (`[tools: …]`), which need no description here.
fn skill_routed_tool_names(messages: &[Value]) -> HashSet<String> {
    let mut names = HashSet::new();
    for message in messages.iter().filter(|m| is_system(m)) {
        let Some(content) = message.get("content").and_then(Value::as_str) else { continue };
        for block in SKILLS_BLOCK.captures_iter(content) {
            for route in SKILL_ROUTE.captures_iter(block.get(1).unwrap_or("")) {
                for name in route.get(1).unwrap_or("").split(',').map(js_trim) {
                    // MCP dependencies name servers, not individual tools.
                    if ROUTE_NAME.is_match(name) && !name.starts_with("mcp__") {
                        names.insert(name.to_owned());
                    }
                }
            }
        }
    }
    names
}

fn catalog_by_name(session: &Value) -> HashMap<String, &Value> {
    let mut by_name = HashMap::new();
    for tool in session.get("deferredToolCatalog").and_then(Value::as_array).into_iter().flatten() {
        let name = js_trim(&text_of(tool.get("name"))).to_owned();
        if !name.is_empty() {
            by_name.entry(name).or_insert(tool);
        }
    }
    by_name
}

/// `parseMcpToolName(tool || name)?.server`: a tool definition carries its server (shortened names
/// cannot be parsed).
fn mcp_server_of(by_name: &HashMap<String, &Value>, name: &str) -> String {
    let parsed = |name: &str| parse_mcp_tool_name(name).map(|(server, _)| server);
    match by_name.get(js_trim(name)) {
        Some(tool) => {
            let server = js_trim(&text_of(tool.get("mcpServerName"))).to_owned();
            if server.is_empty() { parsed(&text_of(tool.get("name"))).unwrap_or_default() } else { server }
        }
        None => parsed(name).unwrap_or_default(),
    }
}

fn first_sentence(text: &str) -> String {
    let flat = mixdog_js::js_words(text).collect::<Vec<_>>().join(" ");
    // `split(/(?<=[.!?])\s/, 1)[0]`: up to the first whitespace that follows sentence punctuation.
    let mut previous = None;
    let mut cut = None;
    for (at, c) in flat.char_indices() {
        if mixdog_js::is_js_space(c) && previous.is_some_and(|p| ".!?".contains(p)) {
            cut = Some(at);
            break;
        }
        previous = Some(c);
    }
    let head = cut.map_or(flat.as_str(), |at| &flat[..at]);
    let head = if head.is_empty() { flat.as_str() } else { head };
    head.trim_end_matches(['.', '!', '?']).to_owned()
}

fn title_case_server(server: &str) -> String {
    let word_break = |c: char| c == '_' || c == '-' || mixdog_js::is_js_space(c);
    server
        .split(word_break)
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part == part.to_lowercase() {
                let mut chars = part.chars();
                chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

/// A catalog connector's curated trigger; else the first sentence of the server's MCP
/// instructions; else the leading description of its first described tool (name order); else its
/// name. Derived lines are cut to 98 characters.
fn mcp_server_trigger(server: &str, tools: &[Value], instructions: &Value) -> String {
    let curated = connector_trigger(server);
    if !curated.is_empty() {
        return curated.to_owned();
    }
    // The account sentence is not a use line; it reaches the model with the loaded server's instructions.
    let instruction = without_angle_brackets(&text_of(instructions.get(server)));
    let instruction = match ACCOUNT_SENTENCE.find(&instruction) {
        Some(range) => format!("{}{}", &instruction[..range.start], &instruction[range.end..]),
        None => instruction,
    };
    let mut sorted: Vec<&Value> = tools.iter().collect();
    sorted.sort_by(|a, b| locale_compare(&text_of(a.get("name")), &text_of(b.get("name"))));
    let described = sorted
        .iter()
        .map(|tool| first_sentence(&without_angle_brackets(&text_of(tool.get("description")))))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let derived = Some(first_sentence(&instruction)).filter(|s| !s.is_empty()).unwrap_or(described);
    if derived.is_empty() { format!("{} MCP server tools.", title_case_server(server)) } else { compact_manifest_text(&derived, 98) }
}

pub(super) fn server_label(server: &str) -> String {
    sanitize_name(&format!("mcp__{server}"))
}

/// One `(label, trigger)` row per server, in the order given; a server with an unsafe name gets none.
pub fn mcp_server_lines(servers: &[(String, Vec<Value>)], instructions: &Value) -> Vec<(String, String)> {
    servers
        .iter()
        .filter_map(|(server, tools)| {
            let label = server_label(server);
            if label.is_empty() {
                return None;
            }
            let trigger = compact_manifest_text(&without_angle_brackets(&mcp_server_trigger(server, tools, instructions)), TRIGGER_LISTING_MAX);
            Some((label, trigger))
        })
        .collect()
}

fn deferred_manifest_entries(session: &Value, pool: &[String]) -> Vec<(String, String)> {
    let by_name = catalog_by_name(session);
    let routed = skill_routed_tool_names(messages(session));
    let mut entries = Vec::new();
    let mut servers: Vec<(String, Vec<Value>)> = Vec::new();
    for name in pool {
        let key = js_trim(name);
        let tool = by_name.get(key);
        let server = mcp_server_of(&by_name, name);
        if !server.is_empty() {
            let tool = tool.map_or_else(|| json!({ "name": key }), |t| (*t).clone());
            match servers.iter_mut().find(|(s, _)| *s == server) {
                Some((_, tools)) => tools.push(tool),
                None => servers.push((server, vec![tool])),
            }
            continue;
        }
        // Skill-style selection trigger when the tool declares one; else its description.
        let description = if routed.contains(key) {
            String::new()
        } else {
            let trigger = text_of(tool.and_then(|t| t.get("trigger")));
            if trigger.is_empty() { text_of(tool.and_then(|t| t.get("description"))) } else { trigger }
        };
        entries.push((name.clone(), description));
    }
    let instructions = session.get("mcpServerInstructions").cloned().unwrap_or(Value::Null);
    entries.extend(mcp_server_lines(&servers, &instructions));
    entries
}

/// `listedDeferredToolNames`: the pool names `rendered` lists, by their own line or their server's.
pub fn listed_deferred_tool_names(session: &Value, pool: &[String], rendered: &str) -> Vec<String> {
    let by_name = catalog_by_name(session);
    pool.iter()
        .filter(|name| {
            let server = mcp_server_of(&by_name, name);
            rendered.contains(&if server.is_empty() { (*name).clone() } else { format!("- mcp__{server}: ") })
        })
        .cloned()
        .collect()
}

/// The manifest text for `pool`: the roster, then (a bridge session) the static bridge guidance. A
/// tool-free bridge session gets nothing.
fn compose_manifest(session: &Value, pool: &[String]) -> String {
    let bridge = is_tool_bridge_enabled(session);
    let has_call_tool = session.get("tools").and_then(Value::as_array).is_some_and(|tools| tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some("call_tool")));
    if bridge && !has_call_tool {
        return String::new();
    }
    let mut parts = Vec::new();
    let manifest = build_deferred_tool_manifest(&deferred_manifest_entries(session, pool));
    if !manifest.is_empty() {
        parts.push(manifest);
    }
    if bridge {
        parts.push(TOOL_BRIDGE_GUIDANCE.to_owned());
    }
    parts.join("\n\n")
}

fn mark_applied(session: &mut Value) {
    let map = session.as_object_mut().expect("session");
    map.insert("deferredToolBp2Applied".into(), Value::Bool(true));
    map.shift_remove("deferredToolBp1Applied");
}

/// Replace, never mutate: a stored prompt block must be a fresh object for the next save to persist it.
fn set_system_content(session: &mut Value, index: usize, content: String) {
    let message = &mut messages_mut(session)[index];
    if message.get("content").and_then(Value::as_str) != Some(content.as_str()) {
        let mut next: Map<String, Value> = message.as_object().cloned().unwrap_or_default();
        next.insert("content".into(), Value::String(content));
        *message = Value::Object(next);
    }
}

fn clear_manifest_blocks(session: &mut Value) {
    for index in 0..messages(session).len() {
        let content = messages(session)[index].get("content").and_then(Value::as_str).map(strip_deferred_tool_manifest_block);
        if let (true, Some(content)) = (is_system(&messages(session)[index]), content) {
            set_system_content(session, index, content);
        }
    }
    messages_mut(session).retain(|m| !is_system(m) || !js_trim(&text_of(m.get("content"))).is_empty());
}

/// The system message that carries the manifest and whether it was inserted just now: the second
/// system message unless that is the cached third tier; else the third tier; else a new one after the first.
fn resolve_manifest_index(session: &mut Value) -> (usize, bool) {
    let system_indexes: Vec<usize> = messages(session).iter().enumerate().filter(|(_, m)| is_system(m)).map(|(i, _)| i).collect();
    let tier3 = system_indexes.iter().copied().find(|&i| messages(session)[i].get("cacheTier").and_then(Value::as_str) == Some("tier3"));
    if system_indexes.len() >= 2 && Some(system_indexes[1]) != tier3 {
        return (system_indexes[1], false);
    }
    let index = tier3.unwrap_or(system_indexes[0] + 1);
    messages_mut(session).insert(index, json!({ "role": "system", "content": "" }));
    (index, true)
}

/// `resetBp2StableContext`: the block gets `stable_context` and no deferred manifest; the caller
/// re-applies the manifest with `rebuild`.
pub fn reset_bp2_stable_context(session: &mut Value, stable_context: &str) {
    if !session.get("messages").is_some_and(Value::is_array) || !messages(session).iter().any(is_system) {
        return;
    }
    let (index, _) = resolve_manifest_index(session);
    set_system_content(session, index, stable_context.to_owned());
}

fn write_manifest_at(session: &mut Value, index: usize, manifest: &str, rebuild: bool) {
    for i in 0..messages(session).len() {
        if i == index || !is_system(&messages(session)[i]) {
            continue;
        }
        if let Some(content) = messages(session)[i].get("content").and_then(Value::as_str).map(strip_deferred_tool_manifest_block) {
            set_system_content(session, i, content);
        }
    }
    let raw = messages(session)[index].get("content").and_then(Value::as_str).unwrap_or_default().to_owned();
    if rebuild && has_manifest_block(&raw) {
        set_system_content(session, index, rebuild_manifest_block(&raw, manifest));
        return;
    }
    let base = strip_deferred_tool_manifest_block(&raw);
    set_system_content(session, index, if base.is_empty() { manifest.to_owned() } else { format!("{base}\n\n---\n\n{manifest}") });
}

/// `applyInitialDeferredToolManifestToBp2`: injects the deferred pool (name + description) at
/// session start, normally once; `rebuild` strips an existing block and re-injects the fresh pool in
/// place, never duplicated. Answers whether the prompt was handled.
pub fn apply_initial_manifest(session: &mut Value, pool: &[String], rebuild: bool, clock: &dyn Clock) -> bool {
    if !session.get("messages").is_some_and(Value::is_array) {
        return false;
    }
    if session.get("deferredToolBp2Applied").and_then(Value::as_bool) == Some(true) && !rebuild {
        return false;
    }
    let touch = |session: &mut Value| {
        session["updatedAt"] = json!(clock.now_ms());
    };
    let manifest = compose_manifest(session, pool);
    if manifest.is_empty() {
        clear_manifest_blocks(session);
        mark_applied(session);
        touch(session);
        return true;
    }
    if !messages(session).iter().any(is_system) {
        return false;
    }
    let existing = messages(session).iter().position(|m| is_system(m) && m.get("content").and_then(Value::as_str).is_some_and(has_manifest_block));
    let (index, inserted) = resolve_manifest_index(session);
    let existing = existing.map(|e| if inserted && index <= e { e + 1 } else { e });
    if existing == Some(index) && !rebuild {
        mark_applied(session);
        return true;
    }
    write_manifest_at(session, index, &manifest, rebuild);
    mark_applied(session);
    touch(session);
    true
}
