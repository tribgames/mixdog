//! The tool-name and tool-argument primitives every tool surface is built from (`shared/tool-primitives.mjs`), ported rule
//! for rule. Arguments stay `serde_json::Value`s, so a row's shape is Node's; the helpers that read them keep JavaScript's
//! coercions (`||` skips every falsy value, `??` only null, `String(value)` of an array joins it, a string's length is in
//! UTF-16 units).

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::number_to_string;
use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use crate::display::model_display::display_model_name;

/// Default cap for tool-arg summaries (header parenthetical, channel tool lines).
pub const DEFAULT_SUMMARY_MAX: usize = 80;
/// Semantic cap for collapsed tool/agent/task card one-liners.
pub const AGENT_SURFACE_BRIEF_MAX: usize = 80;
pub const STATUS_SEPARATOR: &str = " · ";

/// The self-plugin's MCP server: its tools render as their builtin names, not as external MCP calls.
const SELF_MCP_SERVER: &str = "plugin_mixdog_mixdog";
/// Shortened MCP tool names remembered per process (the oldest go first).
const MCP_TOOL_IDENTITY_MAX: usize = 4096;

// ── JavaScript value helpers ────────────────────────────────────────────────

/// `value` when it is neither undefined nor null (what `??` keeps).
pub(crate) fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// JavaScript truthiness of a parsed value (an absent one is `undefined`).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a.k` of an arguments value: only an object has fields.
pub(crate) fn field<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.as_object().and_then(|map| map.get(key))
}

/// `a.k1 || a.k2 || ...`: the first truthy field, else the last one read.
pub(crate) fn first_truthy<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        let value = field(args, key);
        if truthy(value) {
            return value;
        }
    }
    keys.last().and_then(|key| field(args, key))
}

/// `a.k1 ?? a.k2 ?? ...`: the first field that is not null, else the last one read.
pub(crate) fn coalesce<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        let value = field(args, key);
        if defined(value).is_some() {
            return value;
        }
    }
    keys.last().and_then(|key| field(args, key))
}

/// `String(value ?? '')`.
pub(crate) fn text_of(value: Option<&Value>) -> String {
    defined(value).map(value_to_string).unwrap_or_default()
}

/// `String(value || '')`.
pub(crate) fn text_or_empty(value: Option<&Value>) -> String {
    if truthy(value) { text_of(value) } else { String::new() }
}

/// `String(a.k1 || a.k2 || ... || '')`.
pub(crate) fn picked_text(args: &Value, keys: &[&str]) -> String {
    text_or_empty(first_truthy(args, keys))
}

/// `String(a.k1 || a.k2 || '').toLowerCase()`.
pub(crate) fn picked_lower(args: &Value, keys: &[&str]) -> String {
    js_to_lowercase(&picked_text(args, keys))
}

/// `Number(value)` of a field (undefined is NaN).
pub(crate) fn number_of(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// A number as JavaScript prints it.
pub(crate) fn count_text(count: f64) -> String {
    number_to_string(count)
}

/// `text.replace(/\s+/g, ' ')`.
fn collapse_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
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
    out
}

/// `text.replace(/[\s_]+/g, '-')`.
fn collapse_underscore_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if c == '_' || is_js_space(c) {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `text.split(/[_\s-]+/).filter(Boolean)`.
fn split_words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c == '_' || c == '-' || is_js_space(c)).filter(|w| !w.is_empty())
}

/// `part.charAt(0).toUpperCase() + part.slice(1)`.
fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

// ── MCP tool names ──────────────────────────────────────────────────────────

/// An MCP tool: its server and tool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpToolName {
    pub server: String,
    pub tool: String,
}

#[derive(Default)]
struct McpIdentities {
    by_name: HashMap<String, (u64, McpToolName)>,
    by_age: BTreeMap<u64, String>,
    next: u64,
}

static MCP_IDENTITIES: LazyLock<Mutex<McpIdentities>> = LazyLock::new(Mutex::default);

fn raw_tool_name(name: &str) -> &str {
    let text = if name.is_empty() { "tool" } else { name };
    text.strip_prefix("functions.").unwrap_or(text)
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The `<server>__<tool>` of `mcp__<server>__<tool>`: `(.+?)__(.+)` (`min_server` 1) or `(.*?)__(.+)` (0), over a text
/// with no line break (`.` matches none).
fn split_mcp(rest: &str, min_server: usize) -> Option<(&str, &str)> {
    if rest.chars().any(is_line_terminator) {
        return None;
    }
    let from = if min_server == 0 { 0 } else { rest.chars().next()?.len_utf8() };
    let at = from + rest[from..].find("__")?;
    let tool = &rest[at + 2..];
    (!tool.is_empty()).then_some((&rest[..at], tool))
}

/// Remembers the server and tool a shortened MCP tool name stands for (`rememberMcpToolIdentity`).
pub fn remember_mcp_tool_identity(name: &str, server: &str, tool: &str) {
    if name.is_empty() {
        return;
    }
    let Ok(mut identities) = MCP_IDENTITIES.lock() else { return };
    if let Some((age, _)) = identities.by_name.remove(name) {
        identities.by_age.remove(&age);
    }
    let age = identities.next;
    identities.next += 1;
    identities.by_age.insert(age, name.to_owned());
    identities.by_name.insert(name.to_owned(), (age, McpToolName { server: server.to_owned(), tool: tool.to_owned() }));
    if identities.by_name.len() > MCP_TOOL_IDENTITY_MAX
        && let Some((_, oldest)) = identities.by_age.pop_first()
    {
        identities.by_name.remove(&oldest);
    }
}

/// Server and tool of a shortened MCP tool name, when this process built it (`knownMcpToolIdentity`).
pub fn known_mcp_tool_identity(name: &str) -> Option<McpToolName> {
    let identities = MCP_IDENTITIES.lock().ok()?;
    identities.by_name.get(raw_tool_name(name)).map(|(_, known)| known.clone())
}

/// `parseMcpToolName(name)`: a recorded shortened name first, else the `mcp__<server>__<tool>` form.
pub fn parse_mcp_tool_name(name: &str) -> Option<McpToolName> {
    let text = raw_tool_name(name);
    if let Some(known) = known_mcp_tool_identity(text) {
        return Some(known);
    }
    let (server, tool) = split_mcp(text.strip_prefix("mcp__")?, 1)?;
    Some(McpToolName { server: server.to_owned(), tool: tool.to_owned() })
}

/// `parseMcpToolName(tool)` of a tool definition: its `mcpServerName` / `mcpToolName` metadata wins.
pub fn parse_mcp_tool_definition(definition: &Value) -> Option<McpToolName> {
    let server = js_trim(&text_or_empty(field(definition, "mcpServerName"))).to_owned();
    let parsed = parse_mcp_tool_name(&text_or_empty(field(definition, "name")));
    if server.is_empty() {
        return parsed;
    }
    let tool = text_or_empty(field(definition, "mcpToolName"));
    let tool = if tool.is_empty() { parsed.map(|p| p.tool).unwrap_or_default() } else { tool };
    Some(McpToolName { server, tool })
}

pub fn is_mcp_tool_name(name: &str) -> bool {
    parse_mcp_tool_name(name).is_some()
}

pub fn is_self_mcp_tool_name(name: &str) -> bool {
    parse_mcp_tool_name(name).is_some_and(|mcp| mcp.server == SELF_MCP_SERVER)
}

/// True only for genuine external MCP servers (excludes the self-plugin).
pub fn is_external_mcp_tool_name(name: &str) -> bool {
    parse_mcp_tool_name(name).is_some_and(|mcp| mcp.server != SELF_MCP_SERVER)
}

/// An MCP server id for display (`playwright` is `Playwright`).
pub fn title_case_mcp_server(server: &str) -> String {
    split_words(server).map(|part| if part == js_to_lowercase(part) { upper_first(part) } else { part.to_owned() }).collect::<Vec<_>>().join(" ")
}

/// The tool of an MCP name, else the name without its `functions.` prefix.
pub fn strip_tool_prefix(name: &str) -> String {
    let text = raw_tool_name(name);
    parse_mcp_tool_name(text).map_or_else(|| text.to_owned(), |mcp| mcp.tool)
}

/// The canonical tool name: prefix stripped, dashes as underscores, lower case, the legacy `tool_search` as `load_tool`.
pub fn normalize_tool_name(name: &str) -> String {
    let base = js_to_lowercase(&strip_tool_prefix(name).replace('-', "_"));
    if base == "tool_search" { "load_tool".to_owned() } else { base }
}

// ── Text clamps ─────────────────────────────────────────────────────────────

/// `truncateToolText(value, max)` over a string.
pub fn truncate_tool_text(value: &str, max: usize) -> String {
    let text = js_trim(value);
    if utf16_len(text) > max { format!("{}...", slice_utf16(text, max)) } else { text.to_owned() }
}

/// `truncateToolText(value, max)` of a value (`String(value ?? '')`).
pub(crate) fn truncate_value(value: Option<&Value>, max: usize) -> String {
    truncate_tool_text(&text_of(value), max)
}

pub fn truncate_single_line(value: &str, max: usize) -> String {
    truncate_tool_text(&collapse_space(value), max)
}

/// A command on at most two lines, whitespace collapsed, cut to `max`.
pub fn truncate_command(value: &str, max: usize) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let joined = if lines.len() > 2 { format!("{}...", lines[..2].join(" ")) } else { lines.join(" ") };
    let out = js_trim(&collapse_space(&joined)).to_owned();
    if utf16_len(&out) > max { format!("{}...", slice_utf16(&out, max.saturating_sub(3).max(1))) } else { out }
}

// ── Arguments ───────────────────────────────────────────────────────────────

/// `parseToolArgs`: the call's arguments as an object (a JSON string parsed; the `input` of an object that has one; anything
/// else `{ value }`).
pub fn parse_tool_args(args: &Value) -> Value {
    let wrap = |value: &Value| Value::Object(Map::from_iter([("value".to_owned(), value.clone())]));
    if !truthy(Some(args)) {
        return Value::Object(Map::new());
    }
    match args {
        Value::String(text) => match mixdog_js::json_parse(text) {
            Ok(parsed) if matches!(parsed, Value::Object(_) | Value::Array(_)) => parsed,
            _ => wrap(args),
        },
        Value::Object(map) => match map.get("input") {
            Some(input) if matches!(input, Value::Object(_) | Value::Array(_)) => input.clone(),
            _ => args.clone(),
        },
        Value::Array(_) => args.clone(),
        other => wrap(other),
    }
}

/// How a call is shown: a `call_tool` bridge request shows the tool it runs, with `via: "call_tool"`.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallDisplayIdentity {
    pub name: String,
    pub args: Value,
    pub via: Option<&'static str>,
}

/// `toolCallDisplayIdentity`.
pub fn tool_call_display_identity(name: &str, args: &Value) -> ToolCallDisplayIdentity {
    let unchanged = || ToolCallDisplayIdentity { name: name.to_owned(), args: args.clone(), via: None };
    if raw_tool_name(name) != "call_tool" {
        return unchanged();
    }
    let parsed = parse_tool_args(args);
    let target = match field(&parsed, "name") {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    };
    if target.is_empty() {
        return unchanged();
    }
    let target_args = match field(&parsed, "arguments") {
        Some(inner @ (Value::Object(_) | Value::Array(_))) => inner.clone(),
        _ => Value::Object(Map::new()),
    };
    ToolCallDisplayIdentity { name: target, args: target_args, via: Some("call_tool") }
}

/// The last path segment (either separator), else the text itself.
pub fn display_tool_path(path: &str) -> String {
    let swapped = path.replace('\\', "/");
    swapped.split('/').rfind(|s| !s.is_empty()).map_or_else(|| path.to_owned(), str::to_owned)
}

/// `displayToolPath(String(value ?? ''))`.
pub(crate) fn display_path_of(value: Option<&Value>) -> String {
    display_tool_path(&text_of(value))
}

/// The non-blank parts, trimmed and joined with the status separator.
pub fn compact_parts<S: AsRef<str>>(parts: &[S]) -> String {
    parts.iter().map(|part| js_trim(part.as_ref())).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(STATUS_SEPARATOR)
}

/// A quoted, truncated text, or nothing when it is empty.
pub fn quoted(value: &str, max: usize) -> String {
    let text = truncate_tool_text(value, max);
    if text.is_empty() { String::new() } else { format!("\"{text}\"") }
}

/// `quoted(value || '', max)` of a value.
pub(crate) fn quoted_value(value: Option<&Value>, max: usize) -> String {
    quoted(&text_or_empty(value), max)
}

/// The first value whose text is not blank, trimmed.
pub fn first_text(values: &[Option<&Value>]) -> String {
    for value in values {
        if let Some(v) = defined(*value) {
            let text = value_to_string(v);
            let trimmed = js_trim(&text);
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    String::new()
}

/// `firstText(a.k1, a.k2, ...)`.
pub(crate) fn first_text_of(args: &Value, keys: &[&str]) -> String {
    let values: Vec<Option<&Value>> = keys.iter().map(|key| field(args, key)).collect();
    first_text(&values)
}

/// `splitToolSearchSelection`: a list's or a comma/space separated text's trimmed, non-empty names.
pub fn split_tool_search_selection(value: Option<&Value>) -> Vec<String> {
    if let Some(Value::Array(items)) = value {
        return items.iter().map(|item| js_trim(&text_or_empty(Some(item))).to_owned()).filter(|item| !item.is_empty()).collect();
    }
    text_or_empty(value).split(|c: char| c == ',' || is_js_space(c)).map(|item| js_trim(item).to_owned()).filter(|item| !item.is_empty()).collect()
}

fn tool_search_target_kind(value: &str) -> &'static str {
    let lower = js_to_lowercase(js_trim(value));
    if lower.is_empty() {
        ""
    } else if lower.contains("mcp") {
        "MCP"
    } else if lower.contains("skill") {
        "Skills"
    } else {
        "Tools"
    }
}

fn ordered_tool_search_kinds(kinds: &[&str]) -> Vec<&'static str> {
    let out: Vec<&'static str> = ["Tools", "MCP", "Skills"].into_iter().filter(|kind| kinds.contains(kind)).collect();
    if out.is_empty() { vec!["Tools"] } else { out }
}

static MCP_QUERY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\bmcp\b|mcp__|mcp[-_\s]?server", ""));
static SKILL_QUERY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\bskills?\b|skill_|use[-_\s]?skill", ""));

fn infer_tool_search_kinds(args: &Value) -> Vec<&'static str> {
    let selected = split_tool_search_selection(field(args, "select"));
    if !selected.is_empty() {
        let kinds: Vec<&str> = selected.iter().map(|item| tool_search_target_kind(item)).filter(|kind| !kind.is_empty()).collect();
        return ordered_tool_search_kinds(&kinds);
    }
    let query = js_to_lowercase(&first_text_of(args, &["query", "q", "text"]));
    let mut kinds = Vec::new();
    if MCP_QUERY.is_match(&query) {
        kinds.push("MCP");
    }
    if SKILL_QUERY.is_match(&query) {
        kinds.push("Skills");
    }
    ordered_tool_search_kinds(&kinds)
}

/// `Load Tools/MCP/Skills` for a `load_tool` call.
pub fn tool_search_display_label(args: &Value) -> String {
    format!("Load {}", infer_tool_search_kinds(args).join("/"))
}

/// A `load_tool` target as shown: a skill by its name, an MCP tool as `server.tool`, else the tool name.
pub fn display_tool_search_target(value: &str) -> String {
    let text = js_trim(value);
    if text.len() >= 6 && text.is_char_boundary(6) && text[..6].eq_ignore_ascii_case("skill:") {
        return text[6..].to_owned();
    }
    if let Some(known) = known_mcp_tool_identity(text) {
        return format!("{}.{}", known.server, known.tool);
    }
    if let Some((server, tool)) = text.strip_prefix("mcp__").and_then(|rest| split_mcp(rest, 0)) {
        return format!("{server}.{tool}");
    }
    strip_tool_prefix(text)
}

fn title_token(part: &str) -> String {
    let lower = js_to_lowercase(part);
    match lower.as_str() {
        "ui" => "UI".to_owned(),
        "mcp" => "MCP".to_owned(),
        "id" => "ID".to_owned(),
        _ => title_word(&lower),
    }
}

/// A tool name as words (`code_graph` is `Code Graph`).
pub fn titleize_tool_name(name: &str) -> String {
    let words: Vec<String> = split_words(&strip_tool_prefix(name)).map(title_token).collect();
    if words.is_empty() { "Tool".to_owned() } else { words.join(" ") }
}

fn titleize_display_name(value: &str) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    let spaced: String = text.chars().map(|c| if c == '_' || c == '-' { ' ' } else { c }).collect();
    js_words(&spaced).map(title_token).collect::<Vec<_>>().join(" ")
}

/// An agent's name as shown (`heavy-worker` is `Heavy Worker`).
pub fn display_agent_name(value: &str) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    match collapse_underscore_space(&js_to_lowercase(text)).as_str() {
        "maintainer" => "Maintainer".to_owned(),
        "worker" => "Worker".to_owned(),
        "heavy-worker" => "Heavy Worker".to_owned(),
        "reviewer" => "Reviewer".to_owned(),
        _ => titleize_display_name(text),
    }
}

/// A model's name as shown: the id after any `vendor/`, through the shared model display.
pub fn display_model(model: &str, display_hint: &str) -> String {
    let text = js_trim(model);
    let model_id = if text.contains('/') { text.split('/').rfind(|s| !s.is_empty()).unwrap_or(text) } else { text };
    let shown = display_model_name(model_id, display_hint);
    if shown.is_empty() { model_id.to_owned() } else { shown }
}

/// `agent · model` of a `bridge` / `agent` call.
pub fn bridge_agent_model_summary(args: &Value) -> String {
    let model_id = first_text_of(args, &["model"]);
    let display_hint = first_text_of(args, &["modelDisplay", "model_display", "displayModel"]);
    compact_parts(&[display_agent_name(&first_text_of(args, &["agent", "name", "subagent_type"])), display_model(&model_id, &display_hint)])
}

/// `lines 10-29`, `from line 10` or `20 lines` of a read call's window; nothing without one.
pub fn summarize_line_window(args: &Value) -> String {
    let offset = coalesce(args, &["offset", "start_line", "startLine", "line"]);
    let limit = coalesce(args, &["limit", "line_count", "lineCount", "lines"]);
    if defined(offset).is_none() && defined(limit).is_none() {
        return String::new();
    }
    let start = number_of(offset);
    let count = number_of(limit);
    if start.is_finite() && count.is_finite() && count > 0.0 {
        return format!("lines {}-{}", count_text(start), count_text(start.max(start + count - 1.0)));
    }
    if start.is_finite() {
        return format!("from line {}", count_text(start));
    }
    if count.is_finite() {
        return format!("{} lines", count_text(count));
    }
    String::new()
}

static PATCH_FILE_HEADER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$", ""));

/// The file each `*** Update|Add|Delete File:` header of a patch names.
fn patch_header_files(patch: &str) -> impl Iterator<Item = &str> {
    patch.split('\n').filter_map(|line| PATCH_FILE_HEADER.captures(line).and_then(|caps| caps.get(1)))
}

/// `summarizePatch(patch, basePath)`: the one file, `N files`, the base path, or `patch`.
pub fn summarize_patch(patch: Option<&Value>, base_path: Option<&Value>) -> String {
    let text = text_of(patch);
    let files: Vec<String> = patch_header_files(&text).map(display_tool_path).collect();
    match files.len() {
        1 => return files.into_iter().next().unwrap_or_default(),
        n if n > 1 => return format!("{n} files"),
        _ => {}
    }
    if truthy(base_path) {
        return display_path_of(base_path);
    }
    if text.is_empty() { String::new() } else { "patch".to_owned() }
}

/// `collectionCount(...values)`: the first list's non-blank items (else its length), 1 for the first object or non-blank
/// scalar, else 0.
pub fn collection_count(values: &[Option<&Value>]) -> i64 {
    for value in values.iter().copied() {
        match value {
            Some(Value::Array(items)) => {
                let count = items.iter().filter(|item| !item.is_null() && !js_trim(&value_to_string(item)).is_empty()).count();
                return i64::try_from(if count > 0 { count } else { items.len() }).unwrap_or(i64::MAX);
            }
            Some(Value::Object(_)) => return 1,
            None | Some(Value::Null) => {}
            Some(other) => {
                if !js_trim(&value_to_string(other)).is_empty() {
                    return 1;
                }
            }
        }
    }
    0
}

/// `collectionCount(a.k1, a.k2, ...)`.
pub(crate) fn count_of(args: &Value, keys: &[&str]) -> i64 {
    let values: Vec<Option<&Value>> = keys.iter().map(|key| field(args, key)).collect();
    collection_count(&values)
}

/// `pluralize`: the singular for exactly one.
pub fn pluralize<'a>(count: f64, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1.0 { singular } else { plural }
}

/// `N unit(s)`, or nothing for a count of zero.
pub fn format_counted_unit(count: f64, singular: &str, plural: &str) -> String {
    let n = if count.is_nan() { 0.0 } else { count.max(0.0) };
    if n > 0.0 { format!("{} {}", count_text(n), pluralize(n, singular, plural)) } else { String::new() }
}

/// The files a patch call touches: the distinct headers of its patch text, else its path fields.
pub fn patch_file_count(args: &Value) -> i64 {
    let patch = text_of(field(args, "patch"));
    if !patch.is_empty() {
        let mut files: Vec<&str> = patch_header_files(&patch).map(js_trim).collect();
        files.sort_unstable();
        files.dedup();
        if !files.is_empty() {
            return i64::try_from(files.len()).unwrap_or(i64::MAX);
        }
    }
    count_of(args, &["path", "file", "file_path", "base_path"])
}

/// The aggregate category of a `code_graph` call.
pub fn code_graph_label(args: &Value) -> &'static str {
    match picked_lower(args, &["mode", "action"]).as_str() {
        "prewarm" | "index" | "build" | "refresh" => "Setup",
        "search" | "symbol_search" | "find_symbol" | "references" | "callers" | "callees" => "Search",
        _ => "Read",
    }
}

/// A scalar-or-array argument as its non-empty entries.
fn list_of(value: Option<&Value>) -> Vec<String> {
    let items: Vec<Option<&Value>> = match value {
        Some(Value::Array(items)) => items.iter().map(Some).collect(),
        other => vec![other],
    };
    items.into_iter().map(|item| js_trim(&text_of(item)).to_owned()).filter(|item| !item.is_empty()).collect()
}

/// `mode · targets` of a `code_graph` call.
pub fn code_graph_summary(args: &Value, max: usize) -> String {
    let mode = picked_text(args, &["mode", "action"]);
    let symbols = list_of(coalesce(args, &["symbols", "symbol"]));
    let files: Vec<String> = list_of(coalesce(args, &["files", "file", "path"])).iter().map(|file| display_tool_path(file)).collect();
    let targets: Vec<String> = if matches!(mode.as_str(), "overview" | "imports" | "dependents" | "related" | "impact") {
        files.into_iter().chain(symbols).collect()
    } else {
        symbols.into_iter().chain(files).collect()
    };
    let joined = targets.join(", ");
    let target = if joined.is_empty() { first_text_of(args, &["query"]) } else { joined };
    compact_parts(&[mode, truncate_tool_text(&target, max)])
}

/// The first letter upper case, the rest lower case.
pub fn title_word(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), js_to_lowercase(chars.as_str())),
        None => String::new(),
    }
}

/// A terminal status as shown (`done` is `Finished`, `killed` is `Failed`).
pub fn title_status(value: &str) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    match js_to_lowercase(text).as_str() {
        "ok" => "Ok".to_owned(),
        "done" | "success" | "completed" => "Finished".to_owned(),
        "error" | "failed" | "fail" | "killed" | "timeout" => "Failed".to_owned(),
        "cancelled" | "canceled" | "cancel" => "Cancelled".to_owned(),
        _ => title_word(text),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mcp_names_split_into_server_and_tool() {
        assert_eq!(parse_mcp_tool_name("mcp__srv__do__it"), Some(McpToolName { server: "srv".into(), tool: "do__it".into() }));
        assert_eq!(parse_mcp_tool_name("functions.mcp__a__b").map(|m| m.tool), Some("b".into()));
        assert_eq!(parse_mcp_tool_name("mcp__srv__"), None);
        assert_eq!(parse_mcp_tool_name("mcp__a\n__b"), None);
        assert!(is_external_mcp_tool_name("mcp__other__shell"));
        assert!(!is_external_mcp_tool_name("mcp__plugin_mixdog_mixdog__shell"));
        assert_eq!(normalize_tool_name("mcp__plugin_mixdog_mixdog__Tool-Search"), "load_tool");
        assert_eq!(title_case_mcp_server("play_wright-X"), "Play Wright X");
    }

    #[test]
    fn a_shortened_mcp_name_resolves_through_the_remembered_identity() {
        remember_mcp_tool_identity("short_name_for_test", "my_server", "long_tool");
        assert_eq!(parse_mcp_tool_name("short_name_for_test"), Some(McpToolName { server: "my_server".into(), tool: "long_tool".into() }));
        assert_eq!(display_tool_search_target("short_name_for_test"), "my_server.long_tool");
        assert_eq!(strip_tool_prefix("functions.short_name_for_test"), "long_tool");
    }

    #[test]
    fn tool_args_parse_as_node_parses_them() {
        assert_eq!(parse_tool_args(&json!(null)), json!({}));
        assert_eq!(parse_tool_args(&json!("")), json!({}));
        assert_eq!(parse_tool_args(&json!("{\"a\":1}")), json!({ "a": 1 }));
        assert_eq!(parse_tool_args(&json!("[1]")), json!([1]));
        assert_eq!(parse_tool_args(&json!("nope")), json!({ "value": "nope" }));
        assert_eq!(parse_tool_args(&json!("5")), json!({ "value": "5" }));
        assert_eq!(parse_tool_args(&json!({ "input": { "x": 1 }, "y": 2 })), json!({ "x": 1 }));
        assert_eq!(parse_tool_args(&json!({ "input": "s", "y": 2 })), json!({ "input": "s", "y": 2 }));
        assert_eq!(parse_tool_args(&json!(7)), json!({ "value": 7 }));
        assert_eq!(parse_tool_args(&json!([1, 2])), json!([1, 2]));
    }

    #[test]
    fn text_is_clamped_in_utf16_units() {
        assert_eq!(truncate_tool_text("  abcdef ", 4), "abcd...");
        assert_eq!(truncate_tool_text("abc", 3), "abc");
        assert_eq!(truncate_single_line("a \n\t b", 10), "a b");
        assert_eq!(truncate_command("one\ntwo\nthree", 80), "one two...");
        assert_eq!(truncate_command("  echo    hi  ", 80), "echo hi");
        assert_eq!(truncate_command("abcdefghij", 6), "abc...");
        assert_eq!(display_tool_path("C:\\a\\b\\c.rs"), "c.rs");
        assert_eq!(display_tool_path("///"), "///");
    }

    #[test]
    fn selections_and_labels() {
        assert_eq!(split_tool_search_selection(Some(&json!("a, b  c"))), ["a", "b", "c"]);
        assert_eq!(split_tool_search_selection(Some(&json!([" x ", "", null]))), ["x"]);
        assert_eq!(tool_search_display_label(&json!({ "query": "find an mcp server" })), "Load MCP");
        assert_eq!(tool_search_display_label(&json!({ "query": "use skill x and mcp__y" })), "Load MCP/Skills");
        assert_eq!(tool_search_display_label(&json!({ "select": ["skill:a", "b"] })), "Load Tools/Skills");
        assert_eq!(display_tool_search_target("skill:deploy"), "deploy");
        assert_eq!(display_tool_search_target("mcp__srv__t"), "srv.t");
        assert_eq!(titleize_tool_name("mcp__srv__code_graph-ui"), "Code Graph UI");
        assert_eq!(titleize_tool_name(""), "Tool");
        assert_eq!(display_agent_name("heavy_worker"), "Heavy Worker");
        assert_eq!(display_agent_name("my-custom agent"), "My Custom Agent");
    }

    #[test]
    fn counts_windows_and_patches() {
        assert_eq!(collection_count(&[Some(&json!(["a", " ", null]))]), 1);
        assert_eq!(collection_count(&[Some(&json!([" "]))]), 1);
        assert_eq!(collection_count(&[Some(&json!([]))]), 0);
        assert_eq!(collection_count(&[None, Some(&json!({ "a": 1 }))]), 1);
        assert_eq!(collection_count(&[Some(&json!(false))]), 1);
        assert_eq!(format_counted_unit(2.0, "file", "files"), "2 files");
        assert_eq!(format_counted_unit(0.0, "file", "files"), "");
        assert_eq!(summarize_line_window(&json!({ "offset": 10, "limit": 20 })), "lines 10-29");
        assert_eq!(summarize_line_window(&json!({ "offset": 10 })), "from line 10");
        assert_eq!(summarize_line_window(&json!({ "limit": 5 })), "5 lines");
        assert_eq!(summarize_line_window(&json!({})), "");
        let patch = json!("*** Update File: src/a.rs\n@@\n*** Add File: b.txt\n");
        assert_eq!(summarize_patch(Some(&patch), None), "2 files");
        assert_eq!(patch_file_count(&json!({ "patch": "*** Update File: src/a.rs\n*** Update File: src/a.rs\n" })), 1);
        assert_eq!(summarize_patch(Some(&json!("")), Some(&json!("x/y.rs"))), "y.rs");
        assert_eq!(summarize_patch(Some(&json!("zzz")), None), "patch");
    }

    #[test]
    fn code_graph_calls_are_labelled_and_summarised() {
        assert_eq!(code_graph_label(&json!({ "mode": "Callers" })), "Search");
        assert_eq!(code_graph_label(&json!({ "action": "prewarm" })), "Setup");
        assert_eq!(code_graph_label(&json!({})), "Read");
        assert_eq!(code_graph_summary(&json!({ "mode": "overview", "files": ["a/b.rs"], "symbols": "S" }), 80), "overview · b.rs, S");
        assert_eq!(code_graph_summary(&json!({ "mode": "search", "symbol": "S", "path": "a/b.rs" }), 80), "search · S, b.rs");
    }

    #[test]
    fn statuses_and_words() {
        assert_eq!(title_status("DONE"), "Finished");
        assert_eq!(title_status("killed"), "Failed");
        assert_eq!(title_status("weird"), "Weird");
        assert_eq!(title_word("hELLO"), "Hello");
        assert_eq!(quoted("  ", 10), "");
        assert_eq!(quoted("abc", 10), "\"abc\"");
        assert_eq!(compact_parts(&["a", " ", "b "]), "a · b");
    }

    #[test]
    fn a_call_tool_request_shows_the_tool_it_runs() {
        let id = tool_call_display_identity("call_tool", &json!({ "name": " read ", "arguments": { "path": "x" } }));
        assert_eq!((id.name.as_str(), id.via), ("read", Some("call_tool")));
        assert_eq!(id.args, json!({ "path": "x" }));
        let plain = tool_call_display_identity("shell", &json!({ "a": 1 }));
        assert_eq!((plain.name.as_str(), plain.via), ("shell", None));
        assert_eq!(tool_call_display_identity("call_tool", &json!({ "name": "" })).via, None);
    }
}
