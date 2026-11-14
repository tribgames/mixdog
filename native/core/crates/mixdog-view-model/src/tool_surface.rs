//! The tool surface (`shared/tool-surface.mjs`): a call's label and argument summary, the headers of a tool card and of an
//! aggregate of cards, and the per-category tallies behind them. Arguments stay `serde_json::Value`s, so a row's shape is
//! Node's. The merge of per-call result summaries (`formatAggregateDetail`) reads the update-summary parsers of the result
//! projections and is ported with them (`results::summary`).

use std::collections::HashSet;

use mixdog_js::js_object_keys;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use crate::tool_primitives::DEFAULT_SUMMARY_MAX;
use crate::tool_primitives::bridge_agent_model_summary;
use crate::tool_primitives::coalesce;
use crate::tool_primitives::code_graph_summary;
use crate::tool_primitives::collection_count;
use crate::tool_primitives::compact_parts;
use crate::tool_primitives::count_text;
use crate::tool_primitives::defined;
use crate::tool_primitives::display_path_of;
use crate::tool_primitives::display_tool_path;
use crate::tool_primitives::display_tool_search_target;
use crate::tool_primitives::field;
use crate::tool_primitives::first_text_of;
use crate::tool_primitives::first_truthy;
use crate::tool_primitives::format_counted_unit;
use crate::tool_primitives::is_external_mcp_tool_name;
use crate::tool_primitives::normalize_tool_name;
use crate::tool_primitives::number_of;
use crate::tool_primitives::parse_mcp_tool_name;
use crate::tool_primitives::parse_tool_args;
use crate::tool_primitives::picked_text;
use crate::tool_primitives::pluralize;
use crate::tool_primitives::quoted;
use crate::tool_primitives::quoted_value;
use crate::tool_primitives::split_tool_search_selection;
use crate::tool_primitives::summarize_line_window;
use crate::tool_primitives::summarize_patch;
use crate::tool_primitives::text_of;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::title_case_mcp_server;
use crate::tool_primitives::title_word;
use crate::tool_primitives::titleize_tool_name;
use crate::tool_primitives::tool_search_display_label;
use crate::tool_primitives::truncate_command;
use crate::tool_primitives::truncate_tool_text;
use crate::tool_primitives::truncate_value;
use crate::tool_primitives::truthy;
use crate::tool_work_units::CATEGORY_ORDER;
use crate::tool_work_units::WorkUnit;
use crate::tool_work_units::category_copy;
use crate::tool_work_units::classify_tool_category;
use crate::tool_work_units::github_action_parts;
use crate::tool_work_units::patch_mutation_units;
use crate::tool_work_units::patch_operation_profile;
use crate::tool_work_units::tool_work_unit;

/// The members every aggregate pass handles between two yields.
pub const STEP: usize = 16;

/// `isTaskWaitToolCall`: a `task` call whose action is `wait`.
pub fn is_task_wait_tool_call(name: &str, args: &Value) -> bool {
    if normalize_tool_name(name) != "task" {
        return false;
    }
    let parsed = parse_tool_args(args);
    js_to_lowercase(js_trim(&picked_text(&parsed, &["action"]))) == "wait"
}

// ── Labels ──────────────────────────────────────────────────────────────────

/// `displayToolName`: the label a call's card opens with.
fn display_tool_name(name: &str, args: &Value) -> String {
    if is_external_mcp_tool_name(name) {
        let server = parse_mcp_tool_name(name).map(|mcp| mcp.server).unwrap_or_default();
        return format!("MCP {}", title_case_mcp_server(&server));
    }
    let normalized = normalize_tool_name(name);
    let label = match normalized.as_str() {
        "read" | "view_image" | "read_mcp_resource" => "Read",
        "apply_patch" => {
            let parsed = parse_tool_args(args);
            if matches!(field(&parsed, "dry_run"), Some(Value::Bool(true))) {
                return "Check".to_owned();
            }
            let operations = patch_operation_profile(&parsed);
            let has = |kind: &str| operations.iter().any(|(known, _)| known == kind);
            let label = if operations.len() > 1 {
                "Change"
            } else if has("add") {
                "Create"
            } else if has("delete") {
                "Delete"
            } else {
                "Update"
            };
            return label.to_owned();
        }
        "shell" | "bash" | "bash_session" | "shell_command" | "job_wait" => "Run",
        "task" => "Task",
        "grep" | "find" | "glob" | "list" | "ls" => "Search",
        "load_tool" => return tool_search_display_label(&parse_tool_args(args)),
        "search_query" | "image_query" | "web_search" | "web_search_call" => "Web Search",
        "web_fetch" | "fetch" => "Fetch",
        "explore" => "Explore",
        "browser" | "browser_devtools" => "Browser",
        "computer" => "Computer",
        "terminal" => "Terminal",
        "office" => "Office",
        "media" => "Media",
        "tidy" => "Tidy",
        "visualize" => "Visualize",
        // `cwd` is legacy: old transcripts.
        "list_mcp_resources" | "list_mcp_resource_templates" | "cwd" | "session" | "setup" => "Setup",
        "request_user_input" => "Ask User",
        "ask_user" | "handoff_user" => "Question",
        "update_plan" => "Plan",
        "memory" | "remember" | "save_memory" | "update_memory" | "recall_memory" | "recall" | "search_memories" => "Memory",
        "skill" | "skill_execute" | "skill_view" | "skills_list" | "use_skill" => "Skill",
        "bridge" | "agent" => "Agent",
        "code_graph" => return crate::tool_primitives::code_graph_label(&parse_tool_args(args)).to_owned(),
        _ => return titleize_tool_name(name),
    };
    label.to_owned()
}

/// The bridge tools (`browser`, `computer`) carry their fields in a nested `input` object, so the tool-level action stays at
/// the argument root while `parse_tool_args` hands back the unwrapped input. Both halves are read straight from the raw
/// arguments, which may still arrive as a JSON string.
fn bridge_tool_call(args: &Value) -> (String, Value) {
    let root = match args {
        Value::String(text) => mixdog_js::json_parse(text).unwrap_or(Value::Null),
        other => other.clone(),
    };
    let Value::Object(map) = &root else {
        return (String::new(), Value::Object(Map::new()));
    };
    let input = match map.get("input") {
        Some(inner @ Value::Object(_)) => inner.clone(),
        _ => root.clone(),
    };
    let action = if truthy(map.get("action")) { text_of(map.get("action")) } else { picked_text(&input, &["action"]) };
    (action, input)
}

/// `pathOrId`: a truncated path when one is given, else the bare identifier, else nothing.
fn path_or_id(path: Option<&Value>, id: Option<&Value>, max: usize) -> String {
    if truthy(path) {
        return truncate_value(path, max);
    }
    if truthy(id) { text_of(id) } else { String::new() }
}

/// The value when JavaScript reads it as true (`value || ''` keeps nothing else).
fn when_truthy(value: Option<&Value>) -> Option<&Value> {
    if truthy(value) { value } else { None }
}

/// `[...].join(sep)` of values (`null` reads as empty, like an array's join).
fn join_values(items: &[Value], separator: &str) -> String {
    items.iter().map(|item| if item.is_null() { String::new() } else { value_to_string(item) }).collect::<Vec<_>>().join(separator)
}

fn count_unit(args: &Value, keys: &[&str], singular: &str, plural: &str) -> String {
    let values: Vec<Option<&Value>> = keys.iter().map(|key| field(args, key)).collect();
    format_counted_unit(collection_count(&values) as f64, singular, plural)
}

fn any_array(args: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| matches!(field(args, key), Some(Value::Array(_))))
}

/// `summarizeToolArgs(name, args, { max })`: the one-line argument summary of a call.
pub fn summarize_tool_args(name: &str, args: &Value, max: usize) -> String {
    let a = parse_tool_args(args);
    if is_external_mcp_tool_name(name) {
        let tool = parse_mcp_tool_name(name).map(|mcp| mcp.tool).unwrap_or_default();
        return compact_parts(&[
            truncate_tool_text(&tool, max),
            truncate_tool_text(&first_text_of(&a, &["query", "q", "text", "prompt", "path", "uri", "name", "id", "action"]), max.min(80)),
        ]);
    }
    let normalized = normalize_tool_name(name);
    match normalized.as_str() {
        "read" | "view_image" | "apply_patch" | "list" | "ls" | "grep" | "glob" | "find" => summarize_file_tool_args(&normalized, &a, max),
        "shell" | "bash" | "bash_session" | "shell_command" | "job_wait" => truncate_command(&picked_text(&a, &["description", "command", "cmd"]), max),
        "task" => {
            compact_parts(&[or_text(&a, &["action", "type"], "task"), text_or_empty(field(&a, "task_id"))])
        }
        "git" => {
            if matches!(field(&a, "action"), Some(Value::String(action)) if action == "stage") {
                return count_unit(&a, &["change_ids", "change_id"], "change", "changes");
            }
            generic_args_summary(&a, max)
        }
        "github" => summarize_github(&a, max),
        "goal" => compact_parts(&[picked_text(&a, &["action"]), truncate_value(field(&a, "objective"), max)]),
        "handoff_user" => String::new(),
        "ask_user" => {
            let questions: &[Value] = match field(&a, "questions") {
                Some(Value::Array(items)) => items,
                _ => &[],
            };
            let headers: Vec<String> = questions
                .iter()
                .map(|question| js_trim(&picked_text(question, &["header", "question"])).to_owned())
                .filter(|text| !text.is_empty())
                .collect();
            truncate_tool_text(&headers.join(", "), max)
        }
        "search_query" | "image_query" | "web_search" | "web_search_call" | "load_tool" | "web_fetch" | "fetch" => summarize_web_tool_args(&normalized, &a, max),
        "browser" | "browser_devtools" | "computer" | "terminal" | "visualize" | "office" | "media" | "tidy" => {
            summarize_interface_tool_args(&normalized, &a, args, max)
        }
        "explore" => {
            if matches!(field(&a, "query"), Some(Value::Array(_))) {
                return count_unit(&a, &["query"], "query", "queries");
            }
            truncate_tool_text(&picked_text(&a, &["query"]), max.min(80))
        }
        "read_mcp_resource" => truncate_tool_text(&picked_text(&a, &["uri"]), max),
        "list_mcp_resources" | "list_mcp_resource_templates" => {
            if truthy(field(&a, "server")) { format!("server \"{}\"", truncate_value(field(&a, "server"), max)) } else { "all servers".to_owned() }
        }
        "cwd" | "session" | "setup" | "memory" | "remember" | "save_memory" | "update_memory" | "recall_memory" | "recall" | "search_memories" => {
            summarize_state_tool_args(&normalized, &a, max)
        }
        "bridge" | "agent" => {
            let agent_model = bridge_agent_model_summary(&a);
            if !agent_model.is_empty() {
                return agent_model;
            }
            let action = picked_text(&a, &["type", "action", "mode"]);
            let show_target = !(action.eq_ignore_ascii_case("status") || action.eq_ignore_ascii_case("read"));
            let target = if show_target { picked_text(&a, &["tag", "sessionId", "task_id"]) } else { String::new() };
            compact_parts(&[action, target])
        }
        "code_graph" => code_graph_summary(&a, max),
        "skill" | "skill_execute" | "skill_view" | "skills_list" | "use_skill" => {
            let named = first_text_of(&a, &["name", "skill", "skill_name", "query", "q"]);
            let shown = if named.is_empty() && normalized == "skills_list" { "all skills".to_owned() } else { named };
            truncate_tool_text(&shown, max)
        }
        _ => generic_args_summary(&a, max),
    }
}

/// Files, directories and patches.
fn summarize_file_tool_args(normalized: &str, a: &Value, max: usize) -> String {
    let path_of = |key: &str| if truthy(field(a, key)) { format!("path: {}", display_path_of(field(a, key))) } else { String::new() };
    match normalized {
        "read" => {
            if !truthy(field(a, "path")) && !truthy(field(a, "file_path")) {
                return String::new();
            }
            if any_array(a, &["path", "file_path"]) {
                return count_unit(a, &["path", "file_path"], "file", "files");
            }
            let window = if truthy(field(a, "pages")) { format!("pages {}", text_of(field(a, "pages"))) } else { summarize_line_window(a) };
            compact_parts(&[display_path_of(coalesce(a, &["path", "file_path"])), window])
        }
        "view_image" => display_tool_path(&picked_text(a, &["path", "file_path"])),
        "apply_patch" => summarize_patch(field(a, "patch"), field(a, "base_path")),
        "list" | "ls" => {
            if any_array(a, &["path", "dir", "cwd"]) {
                return count_unit(a, &["path", "dir", "cwd"], "directory", "directories");
            }
            let limit = if truthy(field(a, "head_limit")) || truthy(field(a, "limit")) {
                format!("{} entries", text_of(coalesce(a, &["head_limit", "limit"])))
            } else {
                String::new()
            };
            compact_parts(&[display_path_of(coalesce(a, &["path", "dir", "cwd"])), limit])
        }
        "grep" => {
            if !truthy(field(a, "pattern")) && !truthy(field(a, "query")) {
                return String::new();
            }
            if any_array(a, &["pattern", "query"]) {
                return count_unit(a, &["pattern", "query"], "pattern", "patterns");
            }
            let glob = if truthy(field(a, "glob")) { format!("glob {}", text_of(field(a, "glob"))) } else { String::new() };
            compact_parts(&[format!("pattern: {}", quoted_value(coalesce(a, &["pattern", "query"]), max)), path_of("path"), glob])
        }
        "glob" => {
            if !truthy(field(a, "pattern")) && !truthy(field(a, "glob")) {
                return String::new();
            }
            if any_array(a, &["pattern", "glob"]) {
                return count_unit(a, &["pattern", "glob"], "glob", "globs");
            }
            compact_parts(&[format!("pattern: {}", quoted_value(coalesce(a, &["pattern", "glob"]), max)), path_of("path")])
        }
        "find" => {
            if !truthy(field(a, "query")) && !truthy(field(a, "fuzzy")) {
                return String::new();
            }
            if any_array(a, &["query", "fuzzy"]) {
                return count_unit(a, &["query", "fuzzy"], "query", "queries");
            }
            compact_parts(&[quoted_value(coalesce(a, &["query", "fuzzy"]), max), path_of("path")])
        }
        _ => String::new(),
    }
}

/// Search, fetch and tool-search loading.
fn summarize_web_tool_args(normalized: &str, a: &Value, max: usize) -> String {
    match normalized {
        "search_query" | "image_query" | "web_search" | "web_search_call" => {
            if any_array(a, &["query", "keywords"]) {
                return count_unit(a, &["query", "keywords"], "query", "queries");
            }
            quoted_value(first_truthy(a, &["query", "keywords"]), max)
        }
        "load_tool" => {
            let selected: Vec<String> =
                split_tool_search_selection(field(a, "names")).into_iter().chain(split_tool_search_selection(field(a, "select"))).collect();
            if !selected.is_empty() {
                let targets: Vec<String> = selected.iter().map(|item| display_tool_search_target(item)).collect();
                return truncate_tool_text(&targets.join(", "), max);
            }
            quoted(&first_text_of(a, &["query", "q", "text"]), max)
        }
        "web_fetch" | "fetch" => {
            if any_array(a, &["url", "uri"]) {
                return count_unit(a, &["url", "uri"], "URL", "URLs");
            }
            truncate_value(when_truthy(first_truthy(a, &["url", "uri"])), max)
        }
        _ => String::new(),
    }
}

/// Bridge and interface tools: browser, computer, terminal, visualize, office, media, tidy.
fn summarize_interface_tool_args(normalized: &str, a: &Value, args: &Value, max: usize) -> String {
    match normalized {
        "browser" | "browser_devtools" => {
            let (call_action, input) = bridge_tool_call(args);
            // Devtools actions carry a sub-operation (cookies clear, storage get).
            let action = if truthy(field(&input, "operation")) {
                [call_action, text_of(field(&input, "operation"))].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
            } else {
                call_action
            };
            let tab = match defined(field(&input, "tab")) {
                Some(tab) if !js_trim(&value_to_string(tab)).is_empty() => format!(" (tab {})", js_trim(&value_to_string(tab))),
                _ => String::new(),
            };
            let target = path_or_id(field(&input, "url"), coalesce(&input, &["ref", "selector"]), max);
            js_trim(&format!("{}{tab}", compact_parts(&[action, target]))).to_owned()
        }
        "computer" => {
            let (action, input) = bridge_tool_call(args);
            // One target per action: window/clipboard name their operation, list its kind, and input actions their semantic
            // ref, exact window, or app.
            compact_parts(&[action, truncate_tool_text(&first_text_of(&input, &["operation", "kind", "ref", "window_id", "app"]), max)])
        }
        "terminal" => {
            let tab = if truthy(field(a, "tab")) { format!("tab {}", text_of(field(a, "tab"))) } else { String::new() };
            compact_parts(&[picked_text(a, &["action"]), tab])
        }
        "visualize" => {
            let empty = Value::Object(Map::new());
            let input = match field(a, "input") {
                Some(inner @ (Value::Object(_) | Value::Array(_))) => inner,
                _ => &empty,
            };
            let targets = match field(input, "targets") {
                Some(Value::Array(items)) => join_values(&items.iter().map(|item| Value::String(value_to_string(item))).collect::<Vec<_>>(), ", "),
                _ => String::new(),
            };
            let shown = if targets.is_empty() { picked_text(input, &["tab"]) } else { targets };
            compact_parts(&[picked_text(a, &["action"]), shown])
        }
        "office" => compact_parts(&[picked_text(a, &["action"]), path_or_id(field(a, "path"), field(a, "session"), max)]),
        "media" => compact_parts(&[picked_text(a, &["action"]), picked_text(a, &["kind"]), path_or_id(field(a, "path"), field(a, "job"), max)]),
        "tidy" => {
            let engines = match field(a, "engines") {
                Some(Value::Array(items)) if !items.is_empty() => join_values(items, ", "),
                _ => String::new(),
            };
            let paths = match field(a, "paths") {
                Some(Value::Array(items)) if !items.is_empty() => truncate_tool_text(&join_values(items, " "), max),
                _ => String::new(),
            };
            let apply = if matches!(field(a, "apply"), Some(Value::Bool(true))) { "apply" } else { "" };
            compact_parts(&[picked_text(a, &["action"]), engines, paths, apply.to_owned()])
        }
        _ => String::new(),
    }
}

/// `a.k1 || a.k2 || ... || fallback` as text.
fn or_text(a: &Value, keys: &[&str], fallback: &str) -> String {
    keys.iter().find_map(|key| when_truthy(field(a, key))).map_or_else(|| fallback.to_owned(), |value| text_of(Some(value)))
}

/// Sessions, setup and memory.
fn summarize_state_tool_args(normalized: &str, a: &Value, max: usize) -> String {
    match normalized {
        "cwd" | "session" => {
            compact_parts(&[picked_text(a, &["action", "type"]), truncate_tool_text(&first_text_of(a, &["title", "path", "cwd", "dir"]), max)])
        }
        "setup" => {
            let server_name = field(a, "server").and_then(|server| field(server, "name"));
            let values: Vec<Option<&Value>> = vec![
                field(a, "domain"),
                field(a, "target"),
                field(a, "name"),
                server_name,
                field(a, "modelId"),
                field(a, "workflow"),
                field(a, "style"),
                field(a, "profile"),
                field(a, "source"),
                field(a, "query"),
                field(a, "repository"),
                field(a, "jobId"),
                field(a, "agent"),
            ];
            compact_parts(&[picked_text(a, &["action"]), truncate_tool_text(&crate::tool_primitives::first_text(&values), max)])
        }
        "memory" | "remember" | "save_memory" | "update_memory" | "recall_memory" => compact_parts(&[
            or_text(a, &["action", "type", "operation", "op"], "memory"),
            truncate_tool_text(&first_text_of(a, &["query", "summary", "element", "key", "name", "text", "value"]), max.min(80)),
        ]),
        "recall" | "search_memories" => {
            let ids: Vec<String> = match field(a, "id") {
                Some(Value::Array(items)) => items.iter().collect::<Vec<_>>(),
                other => vec![other.unwrap_or(&Value::Null)],
            }
            .into_iter()
            .filter(|id| !id.is_null() && !matches!(id, Value::String(text) if text.is_empty()))
            .map(|id| format!("#{}", value_to_string(id)))
            .collect();
            let queries: Vec<&Value> = match field(a, "query") {
                Some(Value::Array(items)) => items.iter().collect::<Vec<&Value>>(),
                _ => vec![coalesce(a, &["query", "text", "input"]).unwrap_or(&Value::Null)],
            }
            .into_iter()
            .filter(|query| !query.is_null() && !js_trim(&value_to_string(query)).is_empty())
            .collect();
            let shown = if queries.len() > 1 {
                format_counted_unit(queries.len() as f64, "query", "queries")
            } else {
                quoted_value(queries.first().copied(), max)
            };
            let top = if truthy(field(a, "limit")) || truthy(field(a, "topK")) {
                format!("top {}", text_of(coalesce(a, &["limit", "topK"])))
            } else {
                String::new()
            };
            compact_parts(&[ids.join(", "), shown, top])
        }
        _ => String::new(),
    }
}

/// The first two own keys of an arguments value as `key=value` (an array's keys are its indexes).
fn generic_args_summary(a: &Value, max: usize) -> String {
    let primary = first_text_of(a, &["name", "skill", "query", "title", "path", "file", "target", "id", "action"]);
    if !primary.is_empty() {
        return truncate_tool_text(&primary, max.min(80));
    }
    // Last resort: compact key=value of at most the first 2 own keys. Never JSON.stringify the whole object.
    let entries: Vec<(String, &Value)> = match a {
        Value::Object(map) => js_object_keys(map).into_iter().take(2).map(|key| (key.clone(), &map[key])).collect(),
        Value::Array(items) => items.iter().take(2).enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
        _ => Vec::new(),
    };
    let pairs: Vec<String> = entries
        .into_iter()
        .filter_map(|(key, value)| {
            if matches!(value, Value::Null | Value::Object(_) | Value::Array(_)) {
                return None;
            }
            let text = truncate_tool_text(&value_to_string(value), 40);
            (!text.is_empty()).then(|| format!("{key}={text}"))
        })
        .collect();
    compact_parts(&pairs)
}

/// The phrase a GitHub action reads as: "Create issue", "Read PR comments", "Mark issue read".
fn github_phrase(verb: &str, object: &str) -> String {
    match verb {
        "comments" => format!("Read {object} comments"),
        "logs" => format!("Read {object} logs"),
        "comment" => format!("Comment on {object}"),
        "read" => format!("Mark {object} read"),
        _ => format!("{} {object}", title_word(verb)),
    }
}

/// "Create issue owner/repo · Bug", "Cancel run 42 · owner/repo": the action's verb and object, then the repo and the title
/// that identify the target.
fn summarize_github(a: &Value, max: usize) -> String {
    let (noun, verb) = github_action_parts(field(a, "action"));
    if noun.is_empty() || verb.is_empty() {
        return truncate_tool_text(&first_text_of(a, &["action", "repo"]), max);
    }
    let object = if noun == "pr" { "PR" } else { noun.as_str() };
    let phrase = github_phrase(&verb, object);
    let repo = first_text_of(a, &["repo"]);
    let id = coalesce(a, &["number", "id"]).filter(|value| !value.is_null());
    let id_text = id.map(|value| js_trim(&value_to_string(value)).to_owned()).unwrap_or_default();
    let title = truncate_tool_text(&first_text_of(a, &["title", "workflow", "tag"]), max.min(60));
    if !id_text.is_empty() {
        return compact_parts(&[format!("{phrase} {id_text}"), repo, title]);
    }
    compact_parts(&[if repo.is_empty() { phrase } else { format!("{phrase} {repo}") }, title])
}

/// What `formatToolSurface` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSurface {
    pub label: String,
    pub summary: String,
    pub normalized_name: String,
    pub args: Value,
}

impl ToolSurface {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("label".to_owned(), Value::from(self.label.clone()));
        map.insert("summary".to_owned(), Value::from(self.summary.clone()));
        map.insert("normalizedName".to_owned(), Value::from(self.normalized_name.clone()));
        map.insert("args".to_owned(), self.args.clone());
        Value::Object(map)
    }
}

/// `formatToolSurface(name, args, { max })`.
pub fn format_tool_surface(name: &str, args: &Value, max: usize) -> ToolSurface {
    let parsed = parse_tool_args(args);
    ToolSurface {
        label: display_tool_name(name, &parsed),
        // The raw args: bridge tools keep their action beside the nested `input`.
        summary: summarize_tool_args(name, args, max),
        normalized_name: normalize_tool_name(name),
        args: parsed,
    }
}

/// The surface at the default width.
pub fn format_tool_surface_default(name: &str, args: &Value) -> ToolSurface {
    format_tool_surface(name, args, DEFAULT_SUMMARY_MAX)
}

/// `toolLoadingTargets`: the tools or skills a `load_tool` or skill call loads, each once.
pub fn tool_loading_targets(name: &str, args: &Value) -> Vec<String> {
    let normalized = normalize_tool_name(name);
    let parsed = parse_tool_args(args);
    let selected: Vec<String> = if normalized == "load_tool" {
        split_tool_search_selection(field(&parsed, "names"))
            .into_iter()
            .chain(split_tool_search_selection(field(&parsed, "select")))
            .map(|target| display_tool_search_target(&target))
            .collect()
    } else if matches!(normalized.as_str(), "skill" | "skill_execute" | "skill_view" | "use_skill") {
        ["names", "name", "skills", "skill", "skill_name"].iter().flat_map(|key| split_tool_search_selection(field(&parsed, key))).collect()
    } else {
        Vec::new()
    };
    let mut seen = HashSet::new();
    selected.into_iter().map(|value| js_trim(&value).to_owned()).filter(|value| !value.is_empty() && seen.insert(value.clone())).collect()
}

// ── Aggregate tool-card formatting (classification lives in tool_work_units) ─

/// `lifecycleVerb`: the active verb while pending, else the done one (padded to the wider when the width is held).
fn lifecycle_verb(active: &str, done: &str, pending: bool, stable_verb_width: bool) -> String {
    let verb = if pending { active } else { done };
    if !stable_verb_width {
        return verb.to_owned();
    }
    let width = utf16_len(active).max(utf16_len(done));
    format!("{verb}{}", " ".repeat(width.saturating_sub(utf16_len(verb))))
}

/// The options of a header.
#[derive(Clone, Copy, Debug, Default)]
pub struct HeaderOptions<'a> {
    pub pending: bool,
    /// The category already decided for the call; empty classifies it.
    pub category: &'a str,
    pub stable_verb_width: bool,
    pub failed: bool,
}

/// `formatToolActionHeader`: "Read 2 files", "Loading foo", "Failed while editing 1 file".
pub fn format_tool_action_header(name: &str, args: &Value, options: &HeaderOptions) -> String {
    let loading_targets = tool_loading_targets(name, args);
    if !loading_targets.is_empty() {
        if options.failed && !options.pending {
            return format!("Failed while loading {}", loading_targets.join(", "));
        }
        return format!("{} {}", if options.pending { "Loading" } else { "Loaded" }, loading_targets.join(", "));
    }
    let unit = tool_work_unit(name, args, options.category);
    let n = unit.count.max(1.0);
    let object = format!("{} {}", count_text(n), pluralize(n, &unit.noun, &unit.plural_noun));
    // A failed effect never claims its done verb: it only attempted the work.
    if options.failed && !options.pending && unit.effect {
        return format!("Failed while {} {object}", js_to_lowercase(&unit.active));
    }
    format!("{} {object}", lifecycle_verb(&unit.active, &unit.done, options.pending, options.stable_verb_width))
}

/// One aggregate entry per work unit. The key folds the whole verb/noun pair so two units only merge when they render
/// identically.
#[derive(Clone, Debug, PartialEq)]
pub struct AggregateEntry {
    pub key: String,
    pub category: String,
    pub active: String,
    pub done: String,
    pub noun: String,
    pub plural_noun: String,
    pub effect: bool,
    pub count: f64,
}

impl AggregateEntry {
    fn from_unit(category: &str, unit: &WorkUnit) -> Self {
        Self {
            key: [category, unit.active.as_str(), unit.done.as_str(), unit.noun.as_str(), unit.plural_noun.as_str()].join("|"),
            category: category.to_owned(),
            active: unit.active.clone(),
            done: unit.done.clone(),
            noun: unit.noun.clone(),
            plural_noun: unit.plural_noun.clone(),
            effect: unit.effect,
            count: unit.count.max(1.0),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("key".to_owned(), Value::from(self.key.clone()));
        map.insert("category".to_owned(), Value::from(self.category.clone()));
        map.insert("active".to_owned(), Value::from(self.active.clone()));
        map.insert("done".to_owned(), Value::from(self.done.clone()));
        map.insert("noun".to_owned(), Value::from(self.noun.clone()));
        map.insert("pluralNoun".to_owned(), Value::from(self.plural_noun.clone()));
        map.insert("effect".to_owned(), Value::Bool(self.effect));
        map.insert("count".to_owned(), json_number(self.count));
        Value::Object(map)
    }
}

/// `aggregateToolCategoryEntry`: the call's first entry.
pub fn aggregate_tool_category_entry(name: &str, args: &Value, category: &str) -> AggregateEntry {
    let cat = if category.is_empty() { classify_tool_category(name, args) } else { category.to_owned() };
    AggregateEntry::from_unit(&cat, &tool_work_unit(name, args, &cat))
}

/// `aggregateToolCategoryEntries`: a patch gives one entry per kind of change, any other call one.
pub fn aggregate_tool_category_entries(name: &str, args: &Value, category: &str) -> Vec<AggregateEntry> {
    let cat = if category.is_empty() { classify_tool_category(name, args) } else { category.to_owned() };
    let units = if normalize_tool_name(name) == "apply_patch" { patch_mutation_units(args) } else { vec![tool_work_unit(name, args, &cat)] };
    units.iter().map(|unit| AggregateEntry::from_unit(&cat, unit)).collect()
}

/// `aggregateDoneCategories`: the per-category tallies of the DONE state, in the order each entry first appeared. Counts
/// ATTEMPTS (failed calls included) so the collapsed header total always agrees with the "N Ok, N Failed" breakdown beside it.
pub fn aggregate_done_categories(calls: &[Value]) -> Vec<AggregateEntry> {
    aggregate_done_categories_steps(calls, || {})
}

/// `aggregateDoneCategoriesSteps`: the same pass, calling `yield_point` after every `STEP` calls so a caller can hand control
/// back between them.
pub fn aggregate_done_categories_steps(calls: &[Value], mut yield_point: impl FnMut()) -> Vec<AggregateEntry> {
    let mut tallies: Vec<AggregateEntry> = Vec::new();
    for (index, rec) in calls.iter().enumerate() {
        if (index + 1) % STEP == 0 {
            yield_point();
        }
        if !truthy(Some(rec)) {
            continue;
        }
        let name = text_or_empty(field(rec, "name"));
        let category = text_or_empty(field(rec, "category"));
        let args = field(rec, "args").cloned().unwrap_or(Value::Null);
        for entry in aggregate_tool_category_entries(&name, &args, &category) {
            match tallies.iter_mut().find(|known| known.key == entry.key) {
                Some(known) => known.count += if entry.count == 0.0 { 1.0 } else { entry.count },
                None => tallies.push(entry),
            }
        }
    }
    tallies
}

/// `aggregateCount`: a tally's count (the value itself when it is a bare number).
fn aggregate_count(value: Option<&Value>) -> f64 {
    let source = match value {
        Some(inner @ (Value::Object(_) | Value::Array(_))) => field(inner, "count"),
        other => other,
    };
    let number = if truthy(source) { number_of(source) } else { 0.0 };
    if number.is_nan() { number } else { number.max(0.0) }
}

/// A tally as `aggregateDescriptor` reads it.
struct AggregateItem {
    active: String,
    done: String,
    noun: String,
    plural_noun: String,
    count: f64,
    effect: bool,
}

fn aggregate_descriptor(key: &str, value: Option<&Value>) -> AggregateItem {
    let text = |source: Option<&Value>| truthy(source).then(|| text_of(source));
    if let Some(entry @ (Value::Object(_) | Value::Array(_))) = value {
        let category = text(field(entry, "category")).unwrap_or_else(|| {
            let head = key.split('|').next().unwrap_or_default();
            if head.is_empty() { "Other".to_owned() } else { head.to_owned() }
        });
        let base = category_copy(&category);
        let noun = text(field(entry, "noun")).unwrap_or_else(|| if base.noun.is_empty() { "item".to_owned() } else { base.noun.to_owned() });
        return AggregateItem {
            active: text(field(entry, "active")).unwrap_or_else(|| base.active.to_owned()),
            done: text(field(entry, "done")).unwrap_or_else(|| base.done.to_owned()),
            plural_noun: text(field(entry, "pluralNoun")).or_else(|| base.plural_noun.map(str::to_owned)).unwrap_or_else(|| format!("{noun}s")),
            noun,
            count: aggregate_count(value),
            effect: matches!(field(entry, "effect"), Some(Value::Bool(true))),
        };
    }
    let base = category_copy(key);
    let noun = base.noun.to_owned();
    AggregateItem {
        active: base.active.to_owned(),
        done: base.done.to_owned(),
        plural_noun: base.plural_noun.map_or_else(|| format!("{noun}s"), str::to_owned),
        noun,
        count: aggregate_count(value),
        effect: false,
    }
}

/// The options of an aggregate header.
#[derive(Clone, Copy, Debug, Default)]
pub struct AggregateHeaderOptions<'a> {
    pub pending: bool,
    /// The categories to read first, in this order.
    pub order: Option<&'a [&'a str]>,
    pub stable_verb_width: bool,
    pub failed: bool,
}

/// `formatAggregateHeader`: a comma-separated header from per-category counts, e.g. "Read 6 files, Searched 5 files, Called
/// 1 agent". `categories` is the object `aggregate_done_categories` builds in Node (key to entry, or key to a bare count).
pub fn format_aggregate_header(categories: &Value, options: &AggregateHeaderOptions) -> String {
    let empty = Map::new();
    let map = categories.as_object().unwrap_or(&empty);
    let category_keys: Vec<&str> = js_object_keys(map).into_iter().map(String::as_str).collect();
    let preferred: Vec<&str> = match options.order {
        Some(order) if !order.is_empty() => order.to_vec(),
        _ => category_keys.clone(),
    };
    let mut seen: HashSet<&str> = HashSet::new();
    let mut ordered: Vec<&str> = Vec::new();
    for category in preferred.iter().copied().chain(CATEGORY_ORDER).chain(category_keys.iter().copied()) {
        if category.is_empty() || seen.contains(category) || aggregate_count(map.get(category)) <= 0.0 {
            continue;
        }
        seen.insert(category);
        ordered.push(category);
    }
    ordered
        .into_iter()
        .map(|category| {
            let item = aggregate_descriptor(category, map.get(category));
            let object = format!("{} {}", count_text(item.count), pluralize(item.count, &item.noun, &item.plural_noun));
            // Every call failed: an effect only attempted its work.
            if options.failed && !options.pending && item.effect {
                return format!("Failed while {} {object}", js_to_lowercase(&item.active));
            }
            format!("{} {object}", lifecycle_verb(&item.active, &item.done, options.pending, options.stable_verb_width))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn surface(name: &str, args: Value) -> (String, String) {
        let found = format_tool_surface_default(name, &args);
        (found.label, found.summary)
    }

    #[test]
    fn file_tools_summarise_their_targets() {
        assert_eq!(surface("read", json!({ "path": "a/b.rs", "offset": 10, "limit": 20 })), ("Read".into(), "b.rs · lines 10-29".into()));
        assert_eq!(surface("read", json!({ "path": ["a", "b"] })).1, "2 files");
        assert_eq!(surface("grep", json!({ "pattern": "x", "path": "src/a", "glob": "*.rs" })).1, "pattern: \"x\" · path: a · glob *.rs");
        assert_eq!(surface("list", json!({ "dir": "d", "limit": 5 })).1, "d · 5 entries");
        assert_eq!(surface("apply_patch", json!({ "patch": "*** Add File: a.txt" })).0, "Create");
        assert_eq!(surface("apply_patch", json!({ "dry_run": true })).0, "Check");
        assert_eq!(surface("bash", json!({ "description": "list files", "command": "ls" })).1, "list files");
    }

    #[test]
    fn bridge_and_state_tools() {
        assert_eq!(surface("browser", json!({ "action": "click", "input": { "ref": "e4", "tab": 2 } })).1, "click · e4 (tab 2)");
        assert_eq!(surface("browser", json!("{\"action\":\"open\",\"input\":{\"url\":\"https://x.y\"}}")).1, "open · https://x.y");
        assert_eq!(surface("computer", json!({ "action": "window", "input": { "operation": "list" } })).1, "window · list");
        assert_eq!(surface("memory", json!({ "query": "tea" })).1, "memory · tea");
        assert_eq!(surface("recall", json!({ "id": [3, 4], "query": ["a", "b"], "limit": 2 })).1, "#3, #4 · 2 queries · top 2");
        assert_eq!(surface("github", json!({ "action": "pr.merge", "repo": "o/r", "number": 7 })).1, "Merge PR 7 · o/r");
        assert_eq!(surface("github", json!({ "action": "run.logs", "repo": "o/r" })).1, "Read run logs o/r");
        assert_eq!(surface("session", json!({ "action": "rename", "title": "T" })), ("Setup".into(), "rename · T".into()));
        assert_eq!(surface("mcp__srv__do", json!({ "query": "q" })), ("MCP Srv".into(), "do · q".into()));
        assert_eq!(surface("unknown_tool", json!({ "a": 1, "b": [1], "c": "z" })).1, "a=1");
        assert_eq!(surface("agent", json!({ "type": "status", "tag": "t" })).1, "status");
    }

    #[test]
    fn task_wait_is_recognised() {
        assert!(is_task_wait_tool_call("task", &json!({ "action": " Wait " })));
        assert!(!is_task_wait_tool_call("task", &json!({ "action": "read" })));
        assert!(!is_task_wait_tool_call("shell", &json!({ "action": "wait" })));
    }

    #[test]
    fn headers_read_the_work_unit() {
        let header = |name: &str, args: Value, options: HeaderOptions| format_tool_action_header(name, &args, &options);
        assert_eq!(header("read", json!({ "paths": ["a", "b"] }), HeaderOptions::default()), "Read 2 files");
        assert_eq!(header("bash", json!({ "command": "ls" }), HeaderOptions { pending: true, ..HeaderOptions::default() }), "Running 1 command");
        assert_eq!(header("apply_patch", json!({ "patch": "*** Update File: a" }), HeaderOptions { failed: true, ..HeaderOptions::default() }), "Failed while editing 1 file");
        assert_eq!(header("load_tool", json!({ "select": "x" }), HeaderOptions { pending: true, ..HeaderOptions::default() }), "Loading x");
        assert_eq!(header("read", json!({}), HeaderOptions { stable_verb_width: true, ..HeaderOptions::default() }), "Read    1 file");
    }

    #[test]
    fn done_categories_merge_by_key() {
        let calls = vec![
            json!({ "name": "read", "args": { "path": "a" } }),
            json!(null),
            json!({ "name": "read", "args": { "paths": ["b", "c"] } }),
            json!({ "name": "bash", "args": { "command": "ls" } }),
        ];
        let tallies = aggregate_done_categories(&calls);
        assert_eq!(tallies.iter().map(|t| (t.category.as_str(), t.count)).collect::<Vec<_>>(), vec![("Read", 3.0), ("Shell", 1.0)]);
        let map: Map<String, Value> = tallies.iter().map(|t| (t.key.clone(), t.to_value())).collect();
        assert_eq!(format_aggregate_header(&Value::Object(map), &AggregateHeaderOptions::default()), "Read 3 files, Ran 1 command");
        assert_eq!(format_aggregate_header(&json!({ "Setup": 2, "Read": { "count": 1 } }), &AggregateHeaderOptions { pending: true, ..AggregateHeaderOptions::default() }), "Setting up 2 items, Reading 1 file");
        let mut yields = 0;
        let many = vec![json!({ "name": "read", "args": {} }); 40];
        aggregate_done_categories_steps(&many, || yields += 1);
        assert_eq!(yields, 2);
    }
}
