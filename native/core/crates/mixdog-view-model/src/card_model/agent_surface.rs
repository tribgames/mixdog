//! The agent tool family: action and response titles, the parenthesized summary and the bridge-envelope response detection
//! (`shared/tool-card-model/agent-surface.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::number_to_string;
use serde_json::Value;

use crate::errors::err_text::background_task_failure_status_label;
use mixdog_protocol::text_class::parse_task_notification;
use crate::tool_primitives::display_model;
use crate::tool_primitives::field;
use crate::tool_primitives::picked_text;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::title_word;
use crate::tool_primitives::truthy;
use crate::tool_status::leading_result_block;

static SEPARATORS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\s_]+", ""));
static NAME_DELIMITERS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_-]+", ""));
static AGENT_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^agent:\s*(\S.*)$", "im"));
static ENVELOPE_TAG: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^</?(?:final-answer|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$",
        "i",
    )
});
static ENVELOPE_HEAD_FIELD: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:agent task|background task|agent message queued\b|agent close:|task_id|surface|operation|label|status|type|target|agent|preset|model|effort|fast|limits|started|finished|error|notification|queueDepth):?\s*",
        "i",
    )
});
static ENVELOPE_START: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:agent task:|background task\b|agent message queued\b|agent close:)", "i"));
static ENVELOPE_COUNTS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:agents|tasks):\s*\d", "i"));
static ENVELOPE_NONE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\(no agents or tasks\)$", "i"));
static ENVELOPE_TASK_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^task_id:\s*\S+", "im"));
static ENVELOPE_SURFACE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:surface|operation|status):\s*", "im"));
static AGENT_RESULT_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^agent result\b", "i"));
static NULLISH_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:undefined|null)$", "i"));
static COUNTS_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:agents|tasks):\s*", "i"));
static LIST_ITEM: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^-\s+\S+", "i"));
static BARE_STATUS_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$",
        "i",
    )
});

/// `isAgentTool`.
pub fn is_agent_tool(normalized_name: &str) -> bool {
    normalized_name == "agent"
}

/// `SKILL_SURFACE_NAMES`.
pub const SKILL_SURFACE_NAMES: [&str; 5] = ["skill", "skill_execute", "skill_view", "skills_list", "use_skill"];

/// `titleizeAgentName`: the display name of an agent id ("heavy-worker" is "Heavy Worker").
pub fn titleize_agent_name(value: &str) -> String {
    let text = js_trim(value);
    if text.is_empty() {
        return String::new();
    }
    let key = SEPARATORS.replace_all_with(&js_to_lowercase(text), |_| "-".to_owned());
    match key.as_str() {
        "maintainer" => return "Maintainer".to_owned(),
        "worker" => return "Worker".to_owned(),
        "heavy-worker" => return "Heavy Worker".to_owned(),
        "reviewer" => return "Reviewer".to_owned(),
        _ => {}
    }
    let spaced = NAME_DELIMITERS.replace_all_with(text, |_| " ".to_owned());
    js_words(&spaced).map(title_word).collect::<Vec<_>>().join(" ")
}

/// The agent a status or read envelope names on its `agent:` line.
fn agent_name_from_result(result_text: &str) -> String {
    AGENT_LINE
        .captures(&leading_result_block(result_text))
        .and_then(|line| line.get(1).map(titleize_agent_name))
        .unwrap_or_default()
}

/// The agent identity a card shows: the call's own fields, else the result envelope when the call only carried a tag or task id.
fn agent_display_name(args: &Value, result_text: &str) -> String {
    let own = titleize_agent_name(&picked_text(args, &["agent", "subagent_type", "name"]));
    if own.is_empty() { agent_name_from_result(result_text) } else { own }
}

fn agent_model_label(args: &Value) -> String {
    let model = js_trim(&text_or_empty(field(args, "model"))).to_owned();
    let hint = js_trim(&picked_text(args, &["modelDisplay", "model_display", "displayModel"])).to_owned();
    display_model(&model, &hint)
}

/// The real spawn tag; never the task id: only the human-meaningful tag belongs in the header parentheses.
fn agent_tag_label(args: &Value) -> String {
    js_trim(&text_or_empty(field(args, "tag"))).to_owned()
}

fn with_model_and_tag(label: &str, args: &Value) -> String {
    let inner: Vec<String> = [agent_model_label(args), agent_tag_label(args)].into_iter().filter(|part| !part.is_empty()).collect();
    if inner.is_empty() { label.to_owned() } else { format!("{label} ({})", inner.join(", ")) }
}

/// An action word followed by the agent, without a trailing space when the agent is unknown.
fn join_action_agent(action: &str, agent: &str) -> String {
    if agent.is_empty() { action.to_owned() } else { format!("{action} {agent}") }
}

/// `agentResponseTitle`.
pub fn agent_response_title(args: &Value, count: f64, result_text: &str) -> String {
    let total = if count.is_nan() || count == 0.0 { 1.0 } else { count }.max(1.0);
    if total > 1.0 {
        return format!("Responses {} agents", number_to_string(total));
    }
    let name = agent_display_name(args, result_text);
    let name = if name.is_empty() { "Agent".to_owned() } else { name };
    // The agent and model identify the responder; the response summary itself is hidden in the collapsed card.
    with_model_and_tag(&join_action_agent("Response", &name), args)
}

/// `isAgentResponseResult`: a response is a completion notification (envelope or explicit result type); status and read
/// checks never become one, whatever text their result carries.
pub fn is_agent_response_result(args: &Value, result_text: &str) -> bool {
    if js_to_lowercase(&picked_text(args, &["type", "action"])) == "result" {
        return true;
    }
    parse_task_notification(js_trim(result_text)).is_some()
}

/// `agentActionTitle`: the fixed action verb with the agent, model and tag; empty for an action without a verb.
pub fn agent_action_title(args: &Value, result_text: &str) -> String {
    let name = agent_display_name(args, result_text);
    // The runtime treats an omitted type as "spawn".
    let picked = picked_text(args, &["type", "action"]);
    let action = js_to_lowercase(if picked.is_empty() { "spawn" } else { &picked });
    if action == "list" {
        return "Agent status".to_owned();
    }
    let verb = match action.as_str() {
        "spawn" => "Spawn",
        "send" => "Send",
        "cancel" => "Cancel",
        "close" => "Close",
        "cleanup" => "Cleanup",
        "read" => "Read",
        "status" => "Status",
        _ => return String::new(),
    };
    with_model_and_tag(&join_action_agent(verb, &name), args)
}

/// `agentActionSummary`: the parenthesized summary without what the header already says.
pub fn agent_action_summary(args: &Value, summary: &str) -> String {
    let text = js_trim(summary);
    if text.is_empty() {
        return String::new();
    }
    let name = agent_display_name(args, "");
    if !name.is_empty() && text == name {
        return String::new();
    }
    let name_prefix = format!("{name} \u{b7} ");
    let mut rest = if !name.is_empty() && text.starts_with(&name_prefix) { js_trim(&text[name_prefix.len()..]).to_owned() } else { text.to_owned() };
    // The action word is already the header verb (Status, Read, Send, ...).
    let action = js_trim(&picked_text(args, &["type", "action"])).to_owned();
    if !action.is_empty() && rest == action {
        return String::new();
    }
    let action_prefix = format!("{action} \u{b7} ");
    if !action.is_empty() && rest.starts_with(&action_prefix) {
        rest = js_trim(&rest[action_prefix.len()..]).to_owned();
    }
    // The agent, model and tag are folded into the header label itself, so the parenthesized summary drops them.
    let model = agent_model_label(args);
    if !model.is_empty() && rest == model {
        return String::new();
    }
    let tag = agent_tag_label(args);
    if !tag.is_empty() && rest == tag {
        return String::new();
    }
    rest
}

fn is_bridge_envelope(text: &str) -> bool {
    ENVELOPE_START.is_match(text)
        || ENVELOPE_COUNTS.is_match(text)
        || ENVELOPE_NONE.is_match(text)
        || (ENVELOPE_TASK_ID.is_match(text) && ENVELOPE_SURFACE.is_match(text))
}

/// True when a bridge envelope carries a line the model actually authored.
fn envelope_has_response_line(text: &str) -> bool {
    let mut saw_blank = false;
    for line in text.split('\n') {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            saw_blank = true;
            continue;
        }
        if AGENT_RESULT_LINE.is_match(trimmed) || NULLISH_LINE.is_match(trimmed) || ENVELOPE_TAG.is_match(trimmed) {
            continue;
        }
        if !saw_blank && ENVELOPE_HEAD_FIELD.is_match(trimmed) {
            continue;
        }
        if !saw_blank && COUNTS_HEAD.is_match(trimmed) {
            continue;
        }
        if ENVELOPE_NONE.is_match(trimmed) {
            continue;
        }
        if !saw_blank && LIST_ITEM.is_match(trimmed) {
            continue;
        }
        return true;
    }
    false
}

/// `hasAgentResponseResult`: whether the result carries a response beyond the status envelope.
pub fn has_agent_response_result(value: &str) -> bool {
    let text = js_trim(value);
    if text.is_empty() {
        return false;
    }
    if let Some(notification) = parse_task_notification(text) {
        return !notification.result.is_empty();
    }
    if NULLISH_LINE.is_match(text) || BARE_STATUS_LINE.is_match(text) {
        return false;
    }
    if !is_bridge_envelope(text) {
        return true;
    }
    envelope_has_response_line(text)
}

/// `agentTerminalDetail`: "Finished · 12s", "Cancelled", or the compact failure label.
pub fn agent_terminal_detail(status: Option<&Value>, is_error: bool, elapsed: &str, error: Option<&Value>) -> String {
    let failure = if is_error && truthy(error) {
        background_task_failure_status_label(status, error, "agent", None)
    } else {
        String::new()
    };
    if !failure.is_empty() {
        return failure;
    }
    let s = js_to_lowercase(&text_or_empty(status));
    let word = if s.contains("cancel") {
        "Cancelled"
    } else if s.contains("error") || s.contains("fail") || s.contains("killed") || s.contains("timeout") || is_error {
        "Failed"
    } else if s.contains("done") || s.contains("success") || s.contains("complete") || s.contains("closed") {
        "Finished"
    } else {
        ""
    };
    // The unified ` · <time>` convention.
    if word.is_empty() {
        String::new()
    } else if elapsed.is_empty() {
        word.to_owned()
    } else {
        format!("{word} \u{b7} {elapsed}")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn agent_names_are_titleized() {
        assert_eq!(titleize_agent_name("heavy_worker"), "Heavy Worker");
        assert_eq!(titleize_agent_name(" my-custom_agent "), "My Custom Agent");
        assert_eq!(titleize_agent_name(""), "");
    }

    #[test]
    fn titles_carry_the_model_and_tag() {
        let args = json!({ "agent": "worker", "tag": "t1" });
        assert_eq!(agent_action_title(&args, ""), "Spawn Worker (t1)");
        assert_eq!(agent_action_title(&json!({ "action": "list" }), ""), "Agent status");
        assert_eq!(agent_action_title(&json!({ "action": "weird" }), ""), "");
        assert_eq!(agent_action_title(&json!({}), ""), "Spawn");
        assert_eq!(agent_response_title(&args, 1.0, ""), "Response Worker (t1)");
        assert_eq!(agent_response_title(&args, 3.0, ""), "Responses 3 agents");
        assert_eq!(agent_response_title(&json!({}), 1.0, "agent: reviewer\nstatus: done"), "Response Reviewer");
        assert_eq!(agent_response_title(&json!({}), 1.0, ""), "Response Agent");
    }

    #[test]
    fn summaries_drop_what_the_header_says() {
        let args = json!({ "agent": "worker", "action": "send", "tag": "t1" });
        assert_eq!(agent_action_summary(&args, "Worker"), "");
        assert_eq!(agent_action_summary(&args, "Worker \u{b7} send \u{b7} hello"), "hello");
        assert_eq!(agent_action_summary(&args, "send"), "");
        assert_eq!(agent_action_summary(&args, "t1"), "");
        assert_eq!(agent_action_summary(&args, "other"), "other");
    }

    #[test]
    fn responses_are_told_from_status_envelopes() {
        assert!(!has_agent_response_result(""));
        assert!(!has_agent_response_result("null"));
        assert!(!has_agent_response_result("status: running \u{b7} task_id: T1"));
        assert!(has_agent_response_result("The answer."));
        assert!(!has_agent_response_result("agent task: a1\nstatus: done\nmodel: x"));
        assert!(has_agent_response_result("agent task: a1\nstatus: done\n\nWhat went wrong"));
        assert!(is_agent_response_result(&json!({ "type": "Result" }), ""));
        assert!(!is_agent_response_result(&json!({ "type": "status" }), "plain"));
    }

    #[test]
    fn terminal_details() {
        assert_eq!(agent_terminal_detail(Some(&json!("done")), false, "12s", None), "Finished \u{b7} 12s");
        assert_eq!(agent_terminal_detail(Some(&json!("canceled")), false, "", None), "Cancelled");
        assert_eq!(agent_terminal_detail(None, true, "", None), "Failed");
        assert_eq!(agent_terminal_detail(Some(&json!("running")), false, "", None), "");
    }
}
