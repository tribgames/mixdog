//! What the transcript decides from the tool execution contract (`shared/tool-execution-contract.mjs`): which tool calls and
//! control rows it never shows. The completion-notification helpers of that module belong to the runtime that delivers
//! them, not to a row projection.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use serde_json::Value;

use crate::tool_primitives::field;
use crate::tool_primitives::text_of;
use crate::tool_primitives::truthy;

/// Every runtime control row written as a user turn when a turn is cut short (including the bare `[Request interrupted]` a
/// kept Stop prompt gets): not real conversation, for the real-turn count and the preview and title noise filter alike.
static CONTROL_MARKER: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^\[(?:truncated|request interrupted(?: by user(?: for tool use)?| by process restart)?)\]$", "i")
});
static CANCELLED_STATUS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[request interrupted(?: by process restart)?\]$", "i"));
static BUILTIN_SKILL_RESULT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Loaded built-in skill:", "i"));

/// Calls the transcript never shows as cards.
const TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES: [&str; 9] = [
    "goal",
    "create_goal",
    "get_goal",
    "set_goal_tasks",
    "update_goal",
    // The step list shows in its own composer panel, not as transcript cards.
    "todo",
    "load_tool",
    "tool_search",
    // A bot's reaction shows as its emoji under the user's message, not as a card.
    "react",
];

/// `normalizeTranscriptToolName`.
fn normalize_transcript_tool_name(name: &str) -> String {
    let lower = js_to_lowercase(js_trim(name));
    match lower.strip_prefix("functions.") {
        Some(rest) => rest.to_owned(),
        None => lower,
    }
}

/// `isTranscriptHiddenControlToolName`.
pub fn is_transcript_hidden_control_tool_name(name: &str) -> bool {
    TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES.contains(&normalize_transcript_tool_name(name).as_str())
}

/// `isTranscriptSkillToolName`.
pub fn is_transcript_skill_tool_name(name: &str) -> bool {
    matches!(normalize_transcript_tool_name(name).as_str(), "skill" | "skill_view" | "use_skill" | "skill_execute")
}

/// `isTranscriptHiddenToolItem`: a settled tool item (name and result) the transcript must not show. Skill loads are visible
/// cards EXCEPT for built-in skills: those ride a built-in feature whose own card (Browser Use, Document work, ...) follows
/// immediately, so the skill card would only repeat it.
pub fn is_transcript_hidden_tool_item(item: &Value) -> bool {
    if !truthy(Some(item)) {
        return false;
    }
    let name = text_of(field(item, "name"));
    if is_transcript_hidden_control_tool_name(&name) {
        return true;
    }
    is_transcript_skill_tool_name(&name) && BUILTIN_SKILL_RESULT.is_match(js_trim(&text_of(field(item, "result"))))
}

/// `CONTROL_MARKER_RE.test(text)`.
pub fn is_control_marker(text: &str) -> bool {
    CONTROL_MARKER.is_match(text)
}

/// `isTranscriptCancelledStatusText`: crash and implicit interruption markers stay in the model-visible history for
/// recovery, but every human transcript renders them as a Cancelled status row.
pub fn is_transcript_cancelled_status_text(text: &str) -> bool {
    CANCELLED_STATUS.is_match(js_trim(text))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn control_tools_are_hidden() {
        assert!(is_transcript_hidden_control_tool_name(" Functions.Todo "));
        assert!(is_transcript_hidden_control_tool_name("load_tool"));
        assert!(!is_transcript_hidden_control_tool_name("read"));
        assert!(!is_transcript_hidden_control_tool_name(""));
    }

    #[test]
    fn a_builtin_skill_load_is_hidden_but_a_user_skill_is_not() {
        assert!(is_transcript_hidden_tool_item(&json!({ "name": "skill", "result": "Loaded built-in skill: browser" })));
        assert!(!is_transcript_hidden_tool_item(&json!({ "name": "skill", "result": "Loaded skill: mine" })));
        assert!(is_transcript_hidden_tool_item(&json!({ "name": "react" })));
        assert!(!is_transcript_hidden_tool_item(&json!(null)));
        assert!(!is_transcript_hidden_tool_item(&json!({ "name": "read", "result": "Loaded built-in skill: x" })));
    }

    #[test]
    fn control_markers() {
        assert!(is_control_marker("[Request interrupted by user for tool use]"));
        assert!(is_control_marker("[truncated]"));
        assert!(!is_control_marker("[Request interrupted] x"));
        assert!(is_transcript_cancelled_status_text(" [Request interrupted by process restart] "));
        assert!(!is_transcript_cancelled_status_text("[Request interrupted by user]"));
    }
}
