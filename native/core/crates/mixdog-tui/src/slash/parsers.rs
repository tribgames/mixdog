//! Text-to-structure parsers for slash-command inputs: MCP servers, skills, memory commands and the memory row table
//! (`src/tui/app/input-parsers.mjs`).

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, js_words, json_number, string_to_number};
use serde_json::{Map, Value, json};

fn split_pipe_fields(text: &str) -> Vec<&str> {
    text.split('|').map(js_trim).collect()
}

const MCP_USAGE: &str = "usage: name | command-or-url | args(optional) | cwd(optional)";
const SKILL_USAGE: &str = "usage: name | description(optional) | trigger(optional)";

static NETWORK_URL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:https?|wss?):\/\/", "i"));

/// `parseMcpServerInput(text)`: the server object of `name | command-or-url | args | cwd`, or the usage text.
pub fn parse_mcp_server_input(text: &str) -> Result<Value, String> {
    let parts = split_pipe_fields(text);
    let name = parts.first().copied().unwrap_or("");
    let command_or_url = parts.get(1).copied().unwrap_or("");
    let args_text = parts.get(2).copied().unwrap_or("");
    let cwd = parts.get(3).copied().unwrap_or("");
    if name.is_empty() || command_or_url.is_empty() {
        return Err(MCP_USAGE.to_owned());
    }
    if NETWORK_URL.is_match(command_or_url) {
        return Ok(json!({"name": name, "url": command_or_url}));
    }
    let args: Vec<&str> = js_words(args_text).collect();
    Ok(json!({"name": name, "command": command_or_url, "args": args, "cwd": cwd}))
}

/// `parseSkillInput(text)`: the skill object of `name | description | trigger`, or the usage text. An omitted description
/// defaults to `Project skill.`; an explicit blank stays blank.
pub fn parse_skill_input(text: &str) -> Result<Value, String> {
    let parts = split_pipe_fields(text);
    let name = parts.first().copied().unwrap_or("");
    if name.is_empty() {
        return Err(SKILL_USAGE.to_owned());
    }
    let description = parts.get(1).copied().unwrap_or("Project skill.");
    let when_to_use = parts.get(2).copied().unwrap_or("");
    let mut skill = Map::new();
    skill.insert("name".into(), name.into());
    skill.insert("description".into(), description.into());
    if !when_to_use.is_empty() {
        skill.insert("whenToUse".into(), when_to_use.into());
    }
    Ok(Value::Object(skill))
}

/// `parseMemoryCommand(text)`: `{ action, key: value ... }` from `action key=value ...`; a numeric value becomes a number.
pub fn parse_memory_command(text: &str) -> Value {
    let parts: Vec<&str> = js_words(text).collect();
    let action = parts.first().copied().unwrap_or("status");
    let mut out = Map::new();
    out.insert("action".into(), action.into());
    for part in parts.iter().skip(1) {
        let mut pieces = part.split('=');
        let key = pieces.next().unwrap_or("");
        let rest: Vec<&str> = pieces.collect();
        if key.is_empty() || rest.is_empty() {
            continue;
        }
        let raw = rest.join("=");
        let number = string_to_number(&raw);
        let value = if number.is_finite() && !js_trim(&raw).is_empty() { json_number(number) } else { Value::String(raw) };
        out.insert(key.to_owned(), value);
    }
    Value::Object(out)
}

static METADATA: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^id=\d+\s+source=curated project=(\S+) status=\S+ injection=\S+(?: index_revision=(\S+))?\s+", ""));
static METADATA_STRIP: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\s+source=curated project=\S+ status=\S+ injection=\S+(?: index_revision=\S+)?", ""));
static ENTRY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$", ""));

fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `parseMemoryCoreRows(text)`: the selectable rows of a core-memory listing. Group headers (`COMMON`, a project slug) are
/// scope markers, not rows: they carry the scope onto the entries that follow.
pub fn parse_memory_core_rows(text: &str) -> Vec<Value> {
    let mut current_project_id: Option<String> = None;
    let mut rows = Vec::new();
    for (index, line) in text.split('\n').filter(|line| !js_trim(line).is_empty()).enumerate() {
        let raw = js_trim(line);
        if raw.ends_with(':') && !raw.contains("id=") {
            let label = &raw[..raw.len() - 1];
            current_project_id = if label == "COMMON" { None } else { Some(label.to_owned()) };
            continue;
        }
        let metadata = METADATA.captures(raw);
        if let Some(metadata) = &metadata {
            let project = metadata.get(1).unwrap_or("");
            current_project_id = if project == "COMMON" { None } else { Some(project.to_owned()) };
        }
        let normalized = match (&metadata, METADATA_STRIP.find(raw)) {
            (Some(_), Some(range)) => format!("{}{}", &raw[..range.start], &raw[range.end..]),
            _ => raw.to_owned(),
        };
        let Some(entry) = ENTRY.captures(&normalized) else {
            rows.push(json!({"value": format!("core-{index}"), "label": raw, "description": "", "_line": raw}));
            continue;
        };
        let id = entry.get(1).unwrap_or("");
        let element = entry.get(2).unwrap_or("");
        let summary = entry.get(3).unwrap_or("");
        let mut row = Map::new();
        row.insert("value".into(), format!("core-{}-{id}", encode_uri_component(current_project_id.as_deref().unwrap_or("common"))).into());
        row.insert("label".into(), format!("#{id}").into());
        row.insert("meta".into(), current_project_id.clone().unwrap_or_default().into());
        row.insert("description".into(), if summary.is_empty() { element } else { summary }.into());
        row.insert("_line".into(), raw.into());
        row.insert("_action".into(), "core-entry".into());
        row.insert("_id".into(), json_number(string_to_number(id)));
        if let Some(revision) = metadata.as_ref().and_then(|metadata| metadata.get(2)) {
            row.insert("_indexRevision".into(), revision.into());
        }
        row.insert("_element".into(), element.into());
        row.insert("_summary".into(), if summary.is_empty() { element } else { summary }.into());
        row.insert("_projectId".into(), current_project_id.clone().map_or(Value::Null, Value::String));
        // The raw pre-edit values, distinct from the (possibly later-mutated) `_element`/`_summary`: an edit reads these to
        // decide whether the row's element duplicated its summary.
        row.insert("_origElement".into(), element.into());
        row.insert("_origSummary".into(), summary.into());
        rows.push(Value::Object(row));
    }
    rows
}

/// `memoryCoreResultErrorText(text)`: a core-memory service reply that is a failure, recovered from its shape (the store
/// flattens `isError` away), else `None`.
pub fn memory_core_result_error_text(text: &str) -> Option<String> {
    static OP_FAILURE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^core (add|edit|delete)(:| failed)", "i"));
    static CORE_FAILURE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^core:.*(not initialized|failed|error)", "i"));
    static LEAD_IN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(error|failed)\b", "i"));
    let value = js_trim(text);
    (OP_FAILURE.is_match(value) || CORE_FAILURE.is_match(value) || LEAD_IN.is_match(value)).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_command_fields_trim_boundaries_preserve_positions_and_retain_defaults() {
        assert_eq!(
            parse_mcp_server_input(" graph | node | --stdio   --safe | C:/project | ignored "),
            Ok(json!({"name": "graph", "command": "node", "args": ["--stdio", "--safe"], "cwd": "C:/project"}))
        );
        assert_eq!(parse_mcp_server_input("graph | node"), Ok(json!({"name": "graph", "command": "node", "args": [], "cwd": ""})));
        assert_eq!(parse_mcp_server_input("graph | node | | C:/project"), Ok(json!({"name": "graph", "command": "node", "args": [], "cwd": "C:/project"})));
        let missing = Err(MCP_USAGE.to_owned());
        assert_eq!(parse_mcp_server_input(""), missing);
        assert_eq!(parse_mcp_server_input(" | node"), missing);
        assert_eq!(parse_mcp_server_input("graph | "), missing);
    }

    #[test]
    fn mcp_network_urls_retain_their_spelling_and_ignore_command_only_fields() {
        assert_eq!(
            parse_mcp_server_input(" web | WSS://example.test/socket | ignored | ignored "),
            Ok(json!({"name": "web", "url": "WSS://example.test/socket"}))
        );
    }

    #[test]
    fn mcp_input_with_a_non_network_scheme_is_a_command() {
        assert_eq!(parse_mcp_server_input("web | ftp://example.test"), Ok(json!({"name": "web", "command": "ftp://example.test", "args": [], "cwd": ""})));
    }

    #[test]
    fn skill_parsing_distinguishes_omitted_descriptions_from_explicit_blanks_and_keeps_trigger_text() {
        assert_eq!(parse_skill_input("pdf"), Ok(json!({"name": "pdf", "description": "Project skill."})));
        assert_eq!(parse_skill_input("pdf | | "), Ok(json!({"name": "pdf", "description": ""})));
        assert_eq!(
            parse_skill_input(" pdf | PDF documents | when   needed | ignored "),
            Ok(json!({"name": "pdf", "description": "PDF documents", "whenToUse": "when   needed"}))
        );
        assert_eq!(parse_skill_input(" | description"), Err(SKILL_USAGE.to_owned()));
    }

    #[test]
    fn memory_commands_read_key_value_pairs_and_numbers() {
        assert_eq!(parse_memory_command(""), json!({"action": "status"}));
        assert_eq!(
            parse_memory_command("search q=x limit=5 ratio=0.5 empty= eq=a=b skip"),
            json!({"action": "search", "q": "x", "limit": 5, "ratio": 0.5, "empty": "", "eq": "a=b"})
        );
    }

    #[test]
    fn core_rows_carry_the_scope_of_their_group_and_split_element_from_summary() {
        let text = "COMMON:\nid=3 prefers tabs \u{2014} Use tabs\nproj-a:\nid=4 only element\nid=5 source=curated project=proj-b status=ok injection=on index_revision=r9 elem \u{2014} sum\nnot a row";
        let rows = parse_memory_core_rows(text);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["value"], "core-common-3");
        assert_eq!(rows[0]["description"], "Use tabs");
        assert_eq!(rows[0]["_projectId"], Value::Null);
        assert_eq!(rows[1]["value"], "core-proj-a-4");
        assert_eq!(rows[1]["description"], "only element");
        assert_eq!(rows[1]["_origSummary"], "");
        assert_eq!(rows[2]["value"], "core-proj-b-5");
        assert_eq!(rows[2]["_indexRevision"], "r9");
        assert_eq!(rows[2]["_element"], "elem");
        assert_eq!(rows[3]["value"], "core-5");
        assert_eq!(rows[3]["label"], "not a row");
    }

    #[test]
    fn core_result_errors_are_recognised_by_their_shape() {
        assert_eq!(memory_core_result_error_text("core add: project_id required").as_deref(), Some("core add: project_id required"));
        assert_eq!(memory_core_result_error_text("core edit failed: no entry").as_deref(), Some("core edit failed: no entry"));
        assert!(memory_core_result_error_text("core: memory data dir is not initialized").is_some());
        assert!(memory_core_result_error_text("Error: x").is_some());
        assert_eq!(memory_core_result_error_text("core added"), None);
    }
}
