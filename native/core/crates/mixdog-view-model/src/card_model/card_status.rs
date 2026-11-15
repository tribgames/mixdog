//! The terminal status of a single tool card and the status-derived fragments (shell status, header failure, agent
//! completion) the detail and header rows are built from (`shared/tool-card-model/card-status.mjs`).

use super::CardSurface;
use super::agent_surface::agent_terminal_detail;
use super::agent_surface::is_agent_tool;
use super::background_task::background_task_args_elapsed;
use super::background_task::background_task_elapsed;
use super::background_task::background_task_failure_detail;
use super::background_task::is_background_task_tool;
use super::card_input::CardBase;
use super::displayed_result::DisplayedResult;
use super::git_result::git_terminal_status;
use super::media_result::media_terminal_status;
use super::shell_surface::ShellStatusInput;
use super::shell_surface::shell_display_status;
use super::terminal_status::normalize_terminal_status;
use super::terminal_status::result_control_status;
use super::terminal_status::result_envelope_status;
use super::terminal_status::shell_result_elapsed;
use crate::errors::err_text::background_task_failure_status_label;
use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::truthy;
use crate::tool_status::is_user_control_cancellation;

/// The tools whose result opens with a task or bridge envelope that reports the call's status.
const ENVELOPE_STATUS_TOOLS: [&str; 7] = ["agent", "bridge", "task", "web_search", "search_query", "image_query", "web_search_call"];

/// What [`derive_card_status`] derives.
pub struct CardStatus {
    pub shell_status: &'static str,
    pub shell_elapsed: String,
    pub background_elapsed: String,
    pub background_metadata_header_failure: String,
    pub agent_header_failure: String,
    pub header_failure_text: String,
    pub agent_completion_detail: String,
    pub agent_detail: String,
    pub terminal_status: &'static str,
    pub call_failed: bool,
}

/// `deriveCardStatus`.
pub fn derive_card_status(base: &CardBase, surface: &CardSurface, display: &DisplayedResult) -> CardStatus {
    let CardSurface { normalized_name, parsed_args, is_shell_surface, .. } = surface;
    let (shell_status, shell_elapsed) = if *is_shell_surface {
        let status = shell_display_status(&ShellStatusInput {
            pending: base.pending,
            failed_count: base.failed_count,
            exit_failed_count: base.exit_failed_count,
            is_error: base.is_error,
            result: &display.displayed_result_text,
        });
        let own_elapsed = shell_result_elapsed(&display.displayed_result_text);
        (status, if own_elapsed.is_empty() { base.elapsed.clone() } else { own_elapsed })
    } else {
        ("", String::new())
    };
    let background_elapsed = match &display.background_meta {
        Some(meta) => background_task_elapsed(meta, &base.elapsed),
        None if is_background_task_tool(normalized_name) => background_task_args_elapsed(parsed_args, &base.elapsed),
        None => String::new(),
    };
    let metadata_failure = match &display.background_meta {
        Some(meta) if display.is_background_metadata_result => background_task_failure_detail(meta, parsed_args),
        _ => String::new(),
    };
    let background_metadata_header_failure = if display.has_display_result { String::new() } else { metadata_failure };
    let agent_header_failure =
        if !base.pending && is_agent_tool(normalized_name) && base.is_error && truthy(field(parsed_args, "error")) && !display.has_display_result {
            background_task_failure_status_label(field(parsed_args, "status"), field(parsed_args, "error"), "agent", None)
        } else {
            String::new()
        };
    let agent_completion_detail = if !base.pending && is_agent_tool(normalized_name) && agent_header_failure.is_empty() {
        agent_terminal_detail(field(parsed_args, "status"), base.is_error, &base.elapsed, field(parsed_args, "error"))
    } else {
        String::new()
    };
    let git_status = if normalized_name == "git" { git_terminal_status(&display.displayed_result_text) } else { "" };
    let call_failed = !base.pending && (base.is_error || base.failed_count > 0.0);
    // A reported "completed" never outranks a failed call; every other reported outcome (cancelled, denied, failed) still
    // describes the call.
    let reported = |value: &str| {
        let status = normalize_terminal_status(value);
        if call_failed && status == "completed" { "" } else { status }
    };
    let failed_or_completed = if call_failed { "failed" } else { "completed" };
    let envelope_status =
        if ENVELOPE_STATUS_TOOLS.contains(&normalized_name.as_str()) { result_envelope_status(&display.displayed_result_text) } else { "" };
    let terminal_status = if base.pending {
        "running"
    } else {
        let candidates = [
            shell_status,
            git_status,
            if normalized_name == "media" { media_terminal_status(parsed_args, &display.displayed_result_text) } else { "" },
            reported(display.background_meta.as_ref().map_or("", |meta| meta.status.as_str())),
            reported(&text_or_empty(field(parsed_args, "status"))),
            reported(envelope_status),
            result_control_status(&display.displayed_result_text),
            // A one-line error body is hidden from display, so read the raw result.
            if is_user_control_cancellation(base.rt.as_deref().unwrap_or_default()) { "cancelled" } else { "" },
        ];
        candidates.into_iter().find(|status| !status.is_empty()).unwrap_or(failed_or_completed)
    };
    CardStatus {
        shell_status,
        shell_elapsed,
        background_elapsed,
        header_failure_text: if background_metadata_header_failure.is_empty() { agent_header_failure.clone() } else { background_metadata_header_failure.clone() },
        agent_detail: if !base.pending && is_agent_tool(normalized_name) && !display.has_display_result {
            agent_completion_detail.clone()
        } else {
            String::new()
        },
        background_metadata_header_failure,
        agent_header_failure,
        agent_completion_detail,
        terminal_status,
        call_failed,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::card_model::card_input::CardOptions;
    use crate::card_model::card_input::read_card_input;
    use crate::card_model::displayed_result::resolve_displayed_result;
    use crate::card_model::shell_surface::is_shell_tool;

    fn status_of(name: &str, args: Value, input: Value) -> CardStatus {
        let base = read_card_input(&input, name, args.clone(), &CardOptions::default());
        let surface = CardSurface {
            label: String::new(),
            summary: String::new(),
            normalized_name: name.to_owned(),
            parsed_args: args,
            is_shell_surface: is_shell_tool(name, ""),
            is_skill_surface: false,
        };
        let display = resolve_displayed_result(&base, &surface, None);
        derive_card_status(&base, &surface, &display)
    }

    #[test]
    fn a_pending_call_is_running() {
        assert_eq!(status_of("read", json!({}), json!({ "completedCount": 0 })).terminal_status, "running");
    }

    #[test]
    fn a_reported_completion_never_outranks_a_failure() {
        let failed = status_of("agent", json!({ "status": "done" }), json!({ "result": "x", "isError": true }));
        assert_eq!(failed.terminal_status, "failed");
        let done = status_of("agent", json!({ "status": "done" }), json!({ "result": "x" }));
        assert_eq!(done.terminal_status, "completed");
        let cancelled = status_of("agent", json!({ "status": "cancelled" }), json!({ "result": "x", "isError": true }));
        assert_eq!(cancelled.terminal_status, "cancelled");
    }

    #[test]
    fn shell_and_git_exits_are_their_own_status() {
        let shell = status_of("bash", json!({}), json!({ "result": "out", "errorCount": 1, "exitErrorCount": 1 }));
        assert_eq!(shell.terminal_status, "exit");
        let git = status_of("git", json!({}), json!({ "result": "## main\nexit 1\n", "isError": false }));
        assert_eq!(git.terminal_status, "exit");
    }

    #[test]
    fn a_user_takeover_is_cancelled() {
        let taken = status_of("computer", json!({}), json!({ "result": "computer_session_aborted: stop", "isError": true }));
        assert_eq!(taken.terminal_status, "cancelled");
    }

    #[test]
    fn an_agent_failure_label_replaces_the_detail() {
        let failed = status_of("agent", json!({ "status": "failed", "error": "boom" }), json!({ "isError": true, "result": "" }));
        assert!(!failed.agent_header_failure.is_empty());
        assert_eq!(failed.header_failure_text, failed.agent_header_failure);
        assert!(failed.agent_completion_detail.is_empty());
    }
}
