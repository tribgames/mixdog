//! Which tool calls Node's transcript shows (`shared/tool-execution-contract.mjs`
//! `isTranscriptHiddenControlToolName` / `isTranscriptSkillToolName` /
//! `isTranscriptHiddenToolItem`, and `shared/tool-surface.mjs` `isTaskWaitToolCall`), ported
//! rule for rule. The one copy for every consumer: the thread projection and the compaction
//! check of what a dropped row would show. The protocol client's `rowOf` carries the same
//! rules from the same Node file.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use serde_json::Value;

/// Control tools whose calls never show as cards.
const HIDDEN_CONTROL_TOOLS: [&str; 9] =
    ["goal", "create_goal", "get_goal", "set_goal_tasks", "update_goal", "todo", "load_tool", "tool_search", "react"];

static SKILL_TOOL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:skill|skill_view|use_skill|skill_execute)$", ""));
static BUILTIN_SKILL_RESULT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Loaded built-in skill:", "i"));

/// `clean(name).toLowerCase().replace(/^functions\./, '')`.
fn transcript_tool_name(name: &str) -> String {
    let lower = js_trim(name).to_lowercase();
    lower.strip_prefix("functions.").map_or_else(|| lower.clone(), str::to_owned)
}

pub fn is_hidden_control_tool_name(name: &str) -> bool {
    HIDDEN_CONTROL_TOOLS.contains(&transcript_tool_name(name).as_str())
}

pub fn is_skill_tool_name(name: &str) -> bool {
    SKILL_TOOL.is_match(&transcript_tool_name(name))
}

/// A settled tool item (its name and result text) that the transcript must not show. A
/// built-in skill load is known by its result stub.
pub fn is_hidden_tool_item(name: &str, result: &str) -> bool {
    is_hidden_control_tool_name(name) || (is_skill_tool_name(name) && BUILTIN_SKILL_RESULT.is_match(js_trim(result)))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `isTaskWaitToolCall`: a wait on a background task is no card of its own. The name is
/// `normalizeToolName`d (`functions.` prefix and the `mcp__<server>__` form stripped).
pub fn is_task_wait(name: &str, args: Option<&Value>) -> bool {
    let raw = name.strip_prefix("functions.").unwrap_or(name);
    let tool = raw
        .strip_prefix("mcp__")
        .and_then(|rest| {
            let from = rest.chars().next()?.len_utf8();
            let at = from + rest[from..].find("__")?;
            Some(&rest[at + 2..]).filter(|tool| !tool.is_empty())
        })
        .unwrap_or(raw);
    if tool.replace('-', "_").to_lowercase() != "task" {
        return false;
    }
    let parsed = match args {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object),
        Some(Value::Object(map)) => Some(match map.get("input") {
            Some(input) if input.is_object() => input.clone(),
            _ => Value::Object(map.clone()),
        }),
        _ => None,
    };
    let action = parsed.as_ref().and_then(|p| p.get("action")).filter(|a| truthy(a));
    action.is_some_and(|a| js_trim(&mixdog_js::value_to_string(a)).to_lowercase() == "wait")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn control_tools_hide_by_name_and_skills_by_their_result() {
        assert!(is_hidden_tool_item("  Functions.TODO ", ""));
        assert!(is_hidden_tool_item("tool_search", ""));
        assert!(!is_hidden_tool_item("shell", "Loaded built-in skill: x"));
        assert!(is_hidden_tool_item("skill", "\n loaded built-in skill: browser"));
        assert!(!is_hidden_tool_item("skill", "Loaded user skill: x"));
        assert!(!is_hidden_tool_item("skill_x", "Loaded built-in skill: x"));
    }

    #[test]
    fn a_task_wait_is_the_task_tool_with_a_wait_action() {
        assert!(is_task_wait("task", Some(&json!({ "action": " Wait " }))));
        assert!(is_task_wait("functions.task", Some(&json!("{\"action\":\"wait\"}"))));
        assert!(is_task_wait("mcp__srv__task", Some(&json!({ "input": { "action": "wait" } }))));
        assert!(!is_task_wait("task", Some(&json!({ "action": "list" }))));
        assert!(!is_task_wait("shell", Some(&json!({ "action": "wait" }))));
        assert!(!is_task_wait("task", None));
    }
}
