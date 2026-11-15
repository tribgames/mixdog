//! Which text of the tool result the collapsed card actually shows: the background-task body over its envelope, never an
//! error-only body, with the leading status marker stripped (`shared/tool-card-model/displayed-result.mjs`).

use super::CardSurface;
use super::background_task::BackgroundMeta;
use super::background_task::is_background_task_response_args;
use super::background_task::is_background_task_tool;
use super::background_task::resolve_background_task_meta;
use super::card_input::CardBase;
use super::terminal_status::strip_leading_status_marker_from_text;
use crate::errors::err_text::is_background_error_only_body;
use crate::results::read_rows::read_rows_for_display;
use crate::results::summary::Translate;
use crate::results::summary::summarize_tool_result;
use crate::results::summary::summarize_tool_result_translated;
use crate::tool_primitives::field;
use crate::tool_primitives::text_or_empty;
use crate::tool_primitives::truthy;
use crate::tool_status::is_user_control_cancellation;
use mixdog_js::js_trim;

/// What [`resolve_displayed_result`] reads off a result.
pub struct DisplayedResult {
    pub background_meta: Option<BackgroundMeta>,
    pub displayed_result_text: String,
    pub has_display_result: bool,
    pub displayed_result_body_text: String,
    pub has_display_body: bool,
    pub total_lines: usize,
    pub result_summary: Option<String>,
    /// The summary through the surface's catalog; present only when the surface gave one (`Some(None)`: nothing to say).
    pub result_summary_display: Option<Option<String>>,
    pub first_result_line: String,
    pub is_background_result: bool,
    pub is_background_response: bool,
    pub is_background_metadata_result: bool,
}

/// `resolveDisplayedResult`.
pub fn resolve_displayed_result(base: &CardBase, surface: &CardSurface, translate: Option<Translate>) -> DisplayedResult {
    let rt = base.rt.as_deref();
    let is_background_tool = is_background_task_tool(&surface.normalized_name);
    let background_meta =
        if !base.pending && is_background_tool { resolve_background_task_meta(&surface.parsed_args, rt.unwrap_or_default()) } else { None };
    let background_error = match &background_meta {
        Some(meta) if truthy(Some(&meta.error)) => text_or_empty(Some(&meta.error)),
        _ => text_or_empty(field(&surface.parsed_args, "error")),
    };
    // Only a real background envelope's bare error line is redundant with its failure label; any other tool's error body is
    // the cause the card shows.
    let error_only_result = rt.is_some_and(|text| {
        !text.is_empty()
            && ((background_meta.is_some() && is_background_error_only_body(text, &background_error, None))
                || is_user_control_cancellation(text))
    });
    let background_result_text = background_meta.as_ref().filter(|meta| meta.has_response).map(|meta| meta.body.clone()).unwrap_or_default();
    let displayed_result_text = if !background_result_text.is_empty() {
        background_result_text
    } else if error_only_result {
        String::new()
    } else {
        rt.unwrap_or_default().to_owned()
    };
    let has_display_result = !js_trim(&displayed_result_text).is_empty();
    let mut displayed_result_body_text = if surface.normalized_name == "git" {
        displayed_result_text.clone()
    } else {
        strip_leading_status_marker_from_text(&displayed_result_text)
    };
    if surface.normalized_name == "read" {
        displayed_result_body_text = read_rows_for_display(&displayed_result_body_text);
    }
    let has_display_body = !js_trim(&displayed_result_body_text).is_empty();
    let lines: Vec<&str> = if displayed_result_body_text.is_empty() { Vec::new() } else { displayed_result_body_text.split('\n').collect() };
    let is_background_result = !base.pending && is_background_tool && background_meta.is_some();
    let is_background_response = is_background_result
        && (background_meta.as_ref().is_some_and(|meta| meta.has_response)
            || is_background_task_response_args(&surface.normalized_name, &surface.parsed_args));
    let summarizable = !base.pending && (has_display_body || surface.normalized_name == "git");
    let result_summary = if summarizable {
        summarize_tool_result(&base.name, &base.args, &displayed_result_body_text, base.is_error)
    } else {
        None
    };
    let result_summary_display = translate.map(|translate| {
        if summarizable {
            summarize_tool_result_translated(&base.name, &base.args, &displayed_result_body_text, base.is_error, translate)
        } else {
            None
        }
    });
    DisplayedResult {
        is_background_metadata_result: is_background_result && !is_background_response && background_meta.is_some(),
        background_meta,
        has_display_result,
        has_display_body,
        total_lines: lines.len(),
        result_summary,
        result_summary_display,
        first_result_line: if has_display_result { lines.first().copied().unwrap_or_default().to_owned() } else { String::new() },
        is_background_result,
        is_background_response,
        displayed_result_body_text,
        displayed_result_text,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::card_model::card_input::CardOptions;
    use crate::card_model::card_input::read_card_input;

    fn surface(name: &str, args: Value) -> CardSurface {
        CardSurface {
            label: String::new(),
            summary: String::new(),
            normalized_name: name.to_owned(),
            parsed_args: args,
            is_shell_surface: false,
            is_skill_surface: false,
        }
    }

    fn resolve(name: &str, args: Value, input: Value) -> DisplayedResult {
        let base = read_card_input(&input, name, args.clone(), &CardOptions::default());
        resolve_displayed_result(&base, &surface(name, args), None)
    }

    #[test]
    fn the_status_marker_is_not_shown() {
        let shown = resolve("bash", json!({}), json!({ "result": "[status: done]\nout\nmore" }));
        assert_eq!((shown.displayed_result_body_text.as_str(), shown.first_result_line.as_str(), shown.total_lines), ("out\nmore", "out", 2));
        let git = resolve("git", json!({}), json!({ "result": "[status: done]\nout" }));
        assert_eq!(git.displayed_result_body_text, "[status: done]\nout");
    }

    #[test]
    fn a_user_takeover_hides_its_body() {
        let shown = resolve("shell", json!({}), json!({ "result": "computer_user_control_active: the user is typing", "isError": true }));
        assert!(!shown.has_display_result && shown.displayed_result_text.is_empty());
    }

    #[test]
    fn a_background_response_shows_its_body() {
        let result = "background task\nstatus: done\ntask_id: T1\n\nline one";
        let shown = resolve("task", json!({ "type": "result" }), json!({ "result": result }));
        assert!(shown.is_background_response && !shown.is_background_metadata_result);
        assert_eq!(shown.displayed_result_text, "line one");
        let running = resolve("task", json!({}), json!({ "result": "background task\nstatus: running\ntask_id: T1" }));
        assert!(running.is_background_metadata_result && !running.is_background_response);
    }

    #[test]
    fn a_pending_call_has_no_summary() {
        let shown = resolve("read", json!({ "path": "a" }), json!({ "completedCount": 0, "count": 1, "result": "1\u{2192}x" }));
        assert!(shown.result_summary.is_none() && shown.background_meta.is_none());
    }
}
