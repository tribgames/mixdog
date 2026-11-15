//! The collapsed `└ detail` row of a single tool card and the agent brief it is gated by
//! (`shared/tool-card-model/card-detail.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use serde_json::Value;

use super::CardSurface;
use super::agent_surface::is_agent_response_result;
use super::agent_surface::is_agent_tool;
use super::background_task::background_task_detail;
use super::card_input::CardBase;
use super::card_status::CardStatus;
use super::displayed_result::DisplayedResult;
use super::generic_detail::GenericDetailInput;
use super::generic_detail::generic_completed_detail;
use super::generic_detail::should_prefix_sync_elapsed;
use super::terminal_status::merge_terminal_detail;
use super::terminal_status::prefix_elapsed;
use crate::results::summary::AgentBriefOptions;
use crate::results::summary::summarize_agent_surface_brief;
use crate::tool_primitives::AGENT_SURFACE_BRIEF_MAX;
use crate::tool_primitives::coalesce;
use crate::tool_primitives::text_or_empty;

static SETTLED_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(Cancelled|Failed|Finished)$", "i"));
static FAILURE_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(Cancelled|Canceled|Failed)\b", "i"));

/// What [`derive_card_detail`] derives.
pub struct CardDetail {
    pub tool_arg_path: String,
    pub detail_line: String,
    pub detail_is_placeholder: bool,
    pub shell_collapsed_summary: Option<String>,
    pub agent_surface_brief: String,
    pub is_agent_surface_card: bool,
    pub is_agent_response: bool,
}

/// `parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? ''` as text (`String(x || '')`).
fn tool_arg_path_of(parsed_args: &Value) -> String {
    text_or_empty(coalesce(parsed_args, &["path", "file_path", "file"]))
}

/// The completed detail of every non-shell tool, first match wins.
fn non_shell_detail(base: &CardBase, surface: &CardSurface, display: &DisplayedResult, status: &CardStatus, image_detail: &str) -> String {
    let result_summary = display.result_summary.as_deref().unwrap_or_default();
    let generic_detail = if !base.pending && !surface.is_shell_surface && status.agent_detail.is_empty() && image_detail.is_empty() && result_summary.is_empty()
    {
        generic_completed_detail(&GenericDetailInput {
            normalized_name: &surface.normalized_name,
            label: &surface.label,
            has_result: display.has_display_result,
            first_result_line: &display.first_result_line,
            is_error: base.is_error,
        })
    } else {
        String::new()
    };
    let background_metadata_detail = match &display.background_meta {
        Some(meta) if display.is_background_metadata_result && status.background_metadata_header_failure.is_empty() => {
            background_task_detail(meta, &status.background_elapsed)
        }
        _ => String::new(),
    };
    let background_response_detail = if display.is_background_response && !result_summary.is_empty() {
        prefix_elapsed(result_summary, &status.background_elapsed)
    } else {
        result_summary.to_owned()
    };
    let sync_elapsed_detail = if !display.is_background_response && should_prefix_sync_elapsed(&surface.normalized_name, &surface.label) {
        prefix_elapsed(&background_response_detail, &base.elapsed)
    } else {
        background_response_detail
    };
    let settled = if SETTLED_WORD.is_match(result_summary) && !status.agent_completion_detail.is_empty() {
        status.agent_completion_detail.clone()
    } else {
        sync_elapsed_detail
    };
    [background_metadata_detail, settled, status.agent_detail.clone(), image_detail.to_owned(), generic_detail]
        .into_iter()
        .find(|detail| !detail.is_empty())
        .unwrap_or_default()
}

/// Agent cards only keep their detail row for failures; the brief replaces it.
fn agent_detail_line(
    base: &CardBase,
    collapsed_detail: &str,
    pending_detail_placeholder: &str,
    agent_surface_brief: &str,
    status: &CardStatus,
) -> String {
    let width = AGENT_SURFACE_BRIEF_MAX.min(base.max_result_chars);
    let fallback = if !collapsed_detail.is_empty() {
        collapsed_detail
    } else if base.pending {
        if pending_detail_placeholder.is_empty() { "Running" } else { pending_detail_placeholder }
    } else {
        "Finished"
    };
    let line = if agent_surface_brief.is_empty() { (base.truncate)(fallback, width) } else { agent_surface_brief.to_owned() };
    let failure_source = if agent_surface_brief.is_empty() { collapsed_detail } else { agent_surface_brief };
    let agent_failure_text = FAILURE_WORD.is_match(failure_source);
    let keep = (base.is_error || agent_failure_text) && !(!status.agent_header_failure.is_empty() && agent_surface_brief.is_empty());
    if !keep {
        return String::new();
    }
    // A failed call's brief is its cause: say what failed before why.
    if base.is_error && !agent_surface_brief.is_empty() { merge_terminal_detail(status.terminal_status, &line) } else { line }
}

/// `deriveCardDetail`.
pub fn derive_card_detail(base: &CardBase, surface: &CardSurface, display: &DisplayedResult, status: &CardStatus) -> CardDetail {
    let CardSurface { normalized_name, parsed_args, is_shell_surface, is_skill_surface, .. } = surface;
    let tool_arg_path = tool_arg_path_of(parsed_args);
    let image_detail = if normalized_name == "view_image" && !tool_arg_path.is_empty() && !base.is_error { tool_arg_path.clone() } else { String::new() };
    let running_label = if base.elapsed.is_empty() { "Running".to_owned() } else { format!("Running \u{b7} {}", base.elapsed) };
    let pending_detail_placeholder = if base.pending && !is_skill_surface { running_label } else { String::new() };
    let result_summary = display.result_summary.as_deref().filter(|summary| !summary.is_empty());
    let shell_collapsed_summary = if *is_shell_surface && !base.pending && display.has_display_result {
        Some(match result_summary {
            Some(summary) => summary.to_owned(),
            None => (base.truncate)(&display.first_result_line, 120usize.min(base.max_result_chars)),
        })
    } else {
        display.result_summary.clone()
    };
    let collapsed_detail = if base.pending {
        pending_detail_placeholder.clone()
    } else if *is_shell_surface {
        prefix_elapsed(
            &merge_terminal_detail(status.shell_status, shell_collapsed_summary.as_deref().unwrap_or_default()),
            &status.shell_elapsed,
        )
    } else {
        merge_terminal_detail(status.terminal_status, &non_shell_detail(base, surface, display, status, &image_detail))
    };

    let is_agent_result = !display.is_background_result && !base.pending && is_agent_tool(normalized_name) && display.has_display_result;
    let is_agent_response = is_agent_result && is_agent_response_result(parsed_args, base.rt.as_deref().unwrap_or_default());
    let is_agent_surface_card = is_agent_tool(normalized_name);
    let agent_surface_brief_raw = if is_agent_surface_card {
        summarize_agent_surface_brief(
            &base.name,
            parsed_args,
            &display.displayed_result_text,
            AgentBriefOptions { is_error: base.is_error, is_response: is_agent_response },
        )
    } else {
        String::new()
    };
    let agent_surface_brief = if agent_surface_brief_raw.is_empty() {
        String::new()
    } else {
        (base.truncate)(&agent_surface_brief_raw, AGENT_SURFACE_BRIEF_MAX.min(base.max_result_chars))
    };

    // The collapsed visible detail line (skill and agent gating identical across surfaces).
    let detail_line = if *is_skill_surface {
        if base.is_error && !collapsed_detail.is_empty() { collapsed_detail } else { String::new() }
    } else if display.is_background_metadata_result && !status.background_metadata_header_failure.is_empty() {
        String::new()
    } else if is_agent_surface_card {
        agent_detail_line(base, &collapsed_detail, &pending_detail_placeholder, &agent_surface_brief, status)
    } else {
        collapsed_detail
    };

    CardDetail {
        detail_is_placeholder: !pending_detail_placeholder.is_empty() && detail_line == pending_detail_placeholder,
        tool_arg_path,
        detail_line,
        shell_collapsed_summary,
        agent_surface_brief,
        is_agent_surface_card,
        is_agent_response,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::card_model::card_input::CardOptions;
    use crate::card_model::card_input::read_card_input;
    use crate::card_model::card_status::derive_card_status;
    use crate::card_model::displayed_result::resolve_displayed_result;
    use crate::card_model::shell_surface::is_shell_tool;

    fn detail_of(name: &str, label: &str, args: Value, input: Value) -> CardDetail {
        let base = read_card_input(&input, name, args.clone(), &CardOptions::default());
        let surface = CardSurface {
            label: label.to_owned(),
            summary: String::new(),
            normalized_name: name.to_owned(),
            parsed_args: args,
            is_shell_surface: is_shell_tool(name, label),
            is_skill_surface: matches!(name, "skill" | "use_skill"),
        };
        let display = resolve_displayed_result(&base, &surface, None);
        let status = derive_card_status(&base, &surface, &display);
        derive_card_detail(&base, &surface, &display, &status)
    }

    #[test]
    fn a_pending_card_shows_its_placeholder() {
        let detail = detail_of("read", "Read", json!({}), json!({ "completedCount": 0, "startedAt": 1_000, "nowMs": 6_000 }));
        assert_eq!(detail.detail_line, "Running \u{b7} 5s");
        assert!(detail.detail_is_placeholder);
        let skill = detail_of("skill", "Skill", json!({}), json!({ "completedCount": 0 }));
        assert_eq!(skill.detail_line, "");
    }

    #[test]
    fn an_output_tool_shows_its_first_line_and_a_view_image_its_path() {
        let search = detail_of("custom", "Search", json!({}), json!({ "result": "first
second" }));
        assert_eq!(search.detail_line, "first");
        let image = detail_of("view_image", "Image", json!({ "path": "a/b.png" }), json!({ "result": "" }));
        assert_eq!(image.detail_line, "a/b.png");
        assert_eq!(image.tool_arg_path, "a/b.png");
    }

    #[test]
    fn a_failed_shell_merges_status_and_elapsed() {
        let shell = detail_of("bash", "Run", json!({}), json!({ "result": "boom", "isError": true, "errorCount": 1 }));
        assert!(shell.detail_line.starts_with("Failed"), "{}", shell.detail_line);
        let exited = detail_of("bash", "Run", json!({}), json!({ "result": "out", "errorCount": 1, "exitErrorCount": 1 }));
        assert!(exited.detail_line.starts_with("Exited"), "{}", exited.detail_line);
    }

    #[test]
    fn an_agent_keeps_its_row_only_for_failures() {
        let ok = detail_of("agent", "Agent", json!({ "agent": "worker", "prompt": "do it" }), json!({ "result": "agent task: a\nstatus: done" }));
        assert_eq!(ok.detail_line, "");
        assert_eq!(ok.agent_surface_brief, "do it");
        let failed = detail_of("agent", "Agent", json!({ "agent": "worker", "prompt": "do it" }), json!({ "result": "Error: nope", "isError": true }));
        assert!(failed.detail_line.starts_with("Failed"), "{}", failed.detail_line);
    }

    #[test]
    fn a_skill_keeps_its_row_only_for_errors() {
        let ok = detail_of("skill", "Skill", json!({}), json!({ "result": "Loaded built-in skill: x" }));
        assert_eq!(ok.detail_line, "");
        let failed = detail_of("skill", "Skill", json!({}), json!({ "result": "no such skill", "isError": true }));
        assert!(failed.detail_line.starts_with("Failed"), "{}", failed.detail_line);
    }
}
