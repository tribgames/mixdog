//! The header label and the parenthesized arg summary of a single tool card (`shared/tool-card-model/card-header.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;

use super::CardSurface;
use super::agent_surface::agent_action_summary;
use super::agent_surface::agent_action_title;
use super::agent_surface::agent_response_title;
use super::agent_surface::is_agent_tool;
use super::background_task::background_task_action_title;
use super::background_task::background_task_result_title;
use super::background_task::task_control_title;
use super::card_detail::CardDetail;
use super::card_input::CardBase;
use super::card_status::CardStatus;
use super::displayed_result::DisplayedResult;
use super::generic_detail::bridge_described_tool_names;
use super::generic_detail::tool_search_loaded_summary;
use super::inline_text::safe_inline_text;
use super::shell_surface::shell_header;
use crate::tool_primitives::display_tool_search_target;
use crate::tool_surface::HeaderOptions;
use crate::tool_surface::format_tool_action_header;
use crate::tool_surface::tool_loading_targets;

static COUNT_SUMMARY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d+\s+\S+$", ""));

/// What [`derive_card_header`] derives.
pub struct CardHeader {
    pub label_text: String,
    pub summary_text: String,
}

fn header_label(base: &CardBase, surface: &CardSurface, display: &DisplayedResult, status: &CardStatus, detail: &CardDetail) -> String {
    let CardSurface { normalized_name, parsed_args, is_shell_surface, .. } = surface;
    let task_control = task_control_title(normalized_name, parsed_args);
    if !task_control.is_empty() {
        return task_control.to_owned();
    }
    if detail.is_agent_response {
        return agent_response_title(parsed_args, base.group_count, base.rt.as_deref().unwrap_or_default());
    }
    if display.is_background_response {
        if let Some(meta) = &display.background_meta {
            return background_task_result_title(normalized_name, meta);
        }
    }
    if display.is_background_metadata_result {
        if let Some(meta) = &display.background_meta {
            return background_task_action_title(normalized_name, meta);
        }
    }
    if *is_shell_surface {
        return shell_header(status.shell_status, base.group_count, parsed_args.get("verifyShell") == Some(&serde_json::Value::Bool(true)));
    }
    // Bridge load_tool describes definitions; it never loads a tool.
    let described = if normalized_name == "load_tool" && !base.header_pending { bridge_described_tool_names(&display.displayed_result_text) } else { None };
    if let Some(names) = described {
        return if names.is_empty() {
            "Described".to_owned()
        } else {
            format!("Described {}", names.iter().map(|name| display_tool_search_target(name)).collect::<Vec<_>>().join(", "))
        };
    }
    if is_agent_tool(normalized_name) {
        let title = agent_action_title(parsed_args, &display.displayed_result_text);
        if !title.is_empty() {
            return title;
        }
    }
    format_tool_action_header(
        &base.name,
        &base.args,
        &HeaderOptions {
            pending: base.header_pending,
            failed: !base.pending && base.failed_count > 0.0 && base.failed_count >= base.group_count,
            ..HeaderOptions::default()
        },
    )
}

/// `deriveCardHeader`.
pub fn derive_card_header(base: &CardBase, surface: &CardSurface, display: &DisplayedResult, status: &CardStatus, detail: &CardDetail) -> CardHeader {
    let CardSurface { normalized_name, parsed_args, summary, .. } = surface;
    let label_text = safe_inline_text(&header_label(base, surface, display, status, detail));
    let tool_search_summary = if !base.pending && normalized_name == "load_tool" && base.has_result {
        tool_search_loaded_summary(&display.displayed_result_text)
    } else {
        String::new()
    };
    let raw_summary = if detail.is_agent_response || display.is_background_response {
        String::new()
    } else if !tool_search_summary.is_empty() {
        tool_search_summary
    } else if is_agent_tool(normalized_name) {
        agent_action_summary(parsed_args, summary)
    } else {
        summary.clone()
    };
    let raw_summary_text = safe_inline_text(&raw_summary);
    // Drop the parenthesized arg summary when it is a bare "<n> <unit>" count that the header verb already spells out.
    let summary_is_header_count = !raw_summary_text.is_empty() && COUNT_SUMMARY.is_match(&raw_summary_text) && label_text.ends_with(&raw_summary_text);
    let loading_targets = tool_loading_targets(normalized_name, parsed_args);
    let summary_is_loading_targets = !loading_targets.is_empty() && raw_summary_text == loading_targets.join(", ");
    CardHeader { label_text, summary_text: if summary_is_header_count || summary_is_loading_targets { String::new() } else { raw_summary_text } }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::card_model::card_detail::derive_card_detail;
    use crate::card_model::card_input::CardOptions;
    use crate::card_model::card_input::read_card_input;
    use crate::card_model::card_status::derive_card_status;
    use crate::card_model::displayed_result::resolve_displayed_result;
    use crate::card_model::shell_surface::is_shell_tool;
    use crate::tool_surface::format_tool_surface_default;

    fn header_of(name: &str, args: Value, input: Value) -> CardHeader {
        let base = read_card_input(&input, name, args.clone(), &CardOptions::default());
        let shown = format_tool_surface_default(&base.name, &base.args);
        let surface = CardSurface {
            is_shell_surface: is_shell_tool(&shown.normalized_name, &shown.label),
            label: shown.label,
            summary: shown.summary,
            normalized_name: shown.normalized_name,
            parsed_args: shown.args,
            is_skill_surface: false,
        };
        let display = resolve_displayed_result(&base, &surface, None);
        let status = derive_card_status(&base, &surface, &display);
        let detail = derive_card_detail(&base, &surface, &display, &status);
        derive_card_header(&base, &surface, &display, &status, &detail)
    }

    #[test]
    fn a_shell_header_counts_commands() {
        let header = header_of("bash", json!({ "command": "ls" }), json!({ "result": "x" }));
        assert_eq!(header.label_text, "Ran 1 command");
        let running = header_of("bash", json!({ "command": "ls" }), json!({ "completedCount": 0 }));
        assert_eq!(running.label_text, "Running 1 command");
    }

    #[test]
    fn an_agent_header_names_the_action_and_the_agent() {
        let header = header_of("agent", json!({ "agent": "worker", "tag": "t1", "prompt": "go" }), json!({ "result": "agent task: a" }));
        assert_eq!(header.label_text, "Spawn Worker (t1)");
        let response = header_of("agent", json!({ "agent": "worker", "type": "result" }), json!({ "result": "the answer" }));
        assert_eq!(response.label_text, "Response Worker");
        assert_eq!(response.summary_text, "");
    }

    #[test]
    fn a_task_control_keeps_its_verb() {
        let header = header_of("task", json!({ "action": "wait", "task_id": "T1" }), json!({ "result": "background task\nstatus: running\ntask_id: T1" }));
        assert_eq!(header.label_text, "Wait for task");
    }

    #[test]
    fn a_bridge_describe_result_is_not_a_load() {
        let header = header_of("load_tool", json!({ "names": ["x"] }), json!({ "result": r#"{"entries":[{"name":"x"}]}"# }));
        assert_eq!(header.label_text, "Described x");
    }
}
