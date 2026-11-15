//! The ONE collapsed tool-card text model (`shared/tool-card-model.mjs` and `shared/tool-card-model/`).
//!
//! Every surface (the terminal UI's tool execution row, the desktop tool card) derives its tool-card header label,
//! parenthesized arg summary and collapsed `└ detail` row from [`derive_tool_card_model`], so per-tool formats, casing and
//! status merging ("Failed · cause", "Exited", "Running · 12s") cannot drift between clients. Width fitting and theme colours
//! stay surface-side.
//!
//! - `inline_text`: single-row text hygiene, row budgets
//! - `terminal_status`: status words, tone, the ` · <time>` merge
//! - `shell_surface`: shell/run status and header
//! - `agent_surface`: agent titles, summary, response detection
//! - `background_task`: the `background task` envelope
//! - `generic_detail`: the default completed detail, `load_tool`
//! - `media_result`, `git_result`: the media and git call outcomes
//! - `card_input`: normalised counts, progress and budgets
//! - `aggregate_card`: the tool GROUP card model
//! - `displayed_result`: which result text the card shows
//! - `card_status`: the terminal status and the status fragments
//! - `card_detail`: the collapsed detail row
//! - `card_header`: the header label and the arg summary
//!
//! The model is a `serde_json::Value` with the fields Node builds, so a surface reads it the way the Node surfaces did.

pub mod agent_surface;
pub mod aggregate_card;
pub mod background_task;
pub mod card_detail;
pub mod card_header;
pub mod card_input;
pub mod card_status;
pub mod displayed_result;
pub mod generic_detail;
pub mod git_result;
pub mod inline_text;
pub mod media_result;
pub mod shell_surface;
pub mod terminal_status;

use mixdog_js::js_to_lowercase;
use serde_json::Map;
use serde_json::Value;

use self::agent_surface::SKILL_SURFACE_NAMES;
use self::aggregate_card::derive_aggregate_card_model;
use self::card_detail::derive_card_detail;
use self::card_header::derive_card_header;
use self::card_input::CardOptions;
use self::card_input::common_card_fields;
use self::card_input::read_card_input;
use self::card_status::derive_card_status;
use self::displayed_result::resolve_displayed_result;
use self::shell_surface::is_shell_tool;
use crate::tool_primitives::field;
use crate::tool_primitives::tool_call_display_identity;
use crate::tool_surface::format_tool_surface_default;

pub use self::agent_surface::agent_action_summary;
pub use self::agent_surface::agent_action_title;
pub use self::agent_surface::agent_response_title;
pub use self::agent_surface::agent_terminal_detail;
pub use self::agent_surface::has_agent_response_result;
pub use self::agent_surface::is_agent_response_result;
pub use self::agent_surface::is_agent_tool;
pub use self::background_task::background_task_action_title;
pub use self::background_task::background_task_detail;
pub use self::background_task::background_task_elapsed;
pub use self::background_task::background_task_failure_detail;
pub use self::background_task::background_task_result_title;
pub use self::background_task::is_background_task_response_args;
pub use self::background_task::is_background_task_tool;
pub use self::background_task::resolve_background_task_meta;
pub use self::generic_detail::bridge_describe_result;
pub use self::generic_detail::generic_completed_detail;
pub use self::generic_detail::should_prefix_sync_elapsed;
pub use self::generic_detail::tool_search_loaded_summary;
pub use self::inline_text::HEADER_FAILURE_STATUS_MAX;
pub use self::inline_text::MIN_RESULT_LINE_CHARS;
pub use self::inline_text::RESULT_LINE_HARD_MAX;
pub use self::inline_text::SUMMARY_MAX_CHARS;
pub use self::inline_text::normalize_count_map;
pub use self::inline_text::safe_inline_text;
pub use self::inline_text::split_line_delta_tokens;
pub use self::shell_surface::shell_display_status;
pub use self::shell_surface::shell_header;
pub use self::terminal_status::clamp_failure_count;
pub use self::terminal_status::derive_tool_outcome_tone;
pub use self::terminal_status::display_terminal_status;
pub use self::terminal_status::merge_terminal_detail;
pub use self::terminal_status::normalize_terminal_status;
pub use self::terminal_status::prefix_elapsed;
pub use self::terminal_status::result_terminal_status;
pub use self::terminal_status::shell_result_elapsed;
pub use self::terminal_status::shell_result_status;
pub use self::terminal_status::strip_leading_status_marker_from_text;
pub use self::terminal_status::strip_leading_status_marker_lines;
pub use crate::tool_primitives::pluralize as plural;

/// The tool as the surface names it: its label and arg summary, and the parsed args.
#[derive(Clone, Debug, PartialEq)]
pub struct CardSurface {
    pub label: String,
    pub summary: String,
    pub normalized_name: String,
    pub parsed_args: Value,
    pub is_shell_surface: bool,
    pub is_skill_surface: bool,
}

/// `deriveToolCardModel`: the collapsed tool-card text model shared by every surface.
///
/// `input` holds the tool item fields (`name`, `args`, `result`, `rawResult`, `isError`, `errorCount`, `callErrorCount`,
/// `exitErrorCount`, `count`, `completedCount`, `startedAt`, `completedAt`, `aggregate`, `categories`, `doneCategories`,
/// `headerFinalized`, `nowMs`); `options` carries the surface's width fitting, row budget and catalog. The terminal UI
/// consumes the model and adds width fitting and colours, the desktop adds CSS and ellipsis.
pub fn derive_tool_card_model(input: &Value, options: &CardOptions) -> Value {
    let name = match field(input, "name") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    let raw_args = field(input, "args");
    let identity = tool_call_display_identity(&name, raw_args.unwrap_or(&Value::Null));
    // `args` defaults to `{}` only when the item has none.
    let args = if identity.via.is_none() && raw_args.is_none() { Value::Object(Map::new()) } else { identity.args };
    let base = read_card_input(input, &identity.name, args, options);
    if base.aggregate {
        return derive_aggregate_card_model(&base);
    }

    let shown = format_tool_surface_default(&base.name, &base.args);
    let surface = CardSurface {
        is_shell_surface: is_shell_tool(&shown.normalized_name, &shown.label),
        is_skill_surface: SKILL_SURFACE_NAMES.contains(&js_to_lowercase(&shown.normalized_name).as_str()),
        label: shown.label,
        summary: shown.summary,
        normalized_name: shown.normalized_name,
        parsed_args: shown.args,
    };
    let display = resolve_displayed_result(&base, &surface, options.translate);
    let status = derive_card_status(&base, &surface, &display);
    let detail = derive_card_detail(&base, &surface, &display, &status);
    let header = derive_card_header(&base, &surface, &display, &status, &detail);

    let optional = |text: &Option<String>| text.as_ref().map_or(Value::Null, |text| Value::from(text.clone()));
    let mut model = Map::new();
    model.insert("aggregate".to_owned(), Value::Bool(false));
    model.extend(common_card_fields(&base, status.terminal_status));
    if let Some(via) = identity.via {
        model.insert("via".to_owned(), Value::from(via));
    }
    model.insert("labelText".to_owned(), Value::from(header.label_text));
    model.insert("summaryText".to_owned(), Value::from(header.summary_text));
    model.insert("headerFailureText".to_owned(), Value::from(status.header_failure_text));
    model.insert("detailLine".to_owned(), Value::from(detail.detail_line));
    model.insert("detailIsPlaceholder".to_owned(), Value::Bool(detail.detail_is_placeholder));
    model.insert("hasDisplayResult".to_owned(), Value::Bool(display.has_display_result));
    model.insert("hasDisplayBody".to_owned(), Value::Bool(display.has_display_body));
    model.insert("displayedResultBodyText".to_owned(), Value::from(display.displayed_result_body_text));
    model.insert("firstResultLine".to_owned(), Value::from(display.first_result_line));
    model.insert("totalLines".to_owned(), Value::from(display.total_lines));
    model.insert("resultSummary".to_owned(), optional(&display.result_summary));
    if let Some(translated) = &display.result_summary_display {
        model.insert("resultSummaryDisplay".to_owned(), optional(translated));
    }
    model.insert("shellCollapsedSummary".to_owned(), optional(&detail.shell_collapsed_summary));
    model.insert("agentSurfaceBrief".to_owned(), Value::from(detail.agent_surface_brief));
    model.insert("toolArgPath".to_owned(), Value::from(detail.tool_arg_path));
    model.insert("normalizedName".to_owned(), Value::from(surface.normalized_name));
    model.insert("label".to_owned(), Value::from(surface.label));
    model.insert("parsedArgs".to_owned(), surface.parsed_args);
    model.insert("isShellSurface".to_owned(), Value::Bool(surface.is_shell_surface));
    model.insert("isSkillSurface".to_owned(), Value::Bool(surface.is_skill_surface));
    model.insert("isAgentSurfaceCard".to_owned(), Value::Bool(detail.is_agent_surface_card));
    model.insert("isAgentResponse".to_owned(), Value::Bool(detail.is_agent_response));
    model.insert("isBackgroundResponse".to_owned(), Value::Bool(display.is_background_response));
    model.insert("isBackgroundMetadataResult".to_owned(), Value::Bool(display.is_background_metadata_result));
    model.insert("backgroundMeta".to_owned(), display.background_meta.as_ref().map_or(Value::Null, background_task::BackgroundMeta::to_value));
    Value::Object(model)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn model(input: Value) -> Value {
        derive_tool_card_model(&input, &CardOptions::default())
    }

    #[test]
    fn a_finished_shell_card() {
        let card = model(json!({ "name": "bash", "args": { "command": "ls" }, "result": "a\nb", "startedAt": 1_000, "completedAt": 13_000 }));
        assert_eq!(card["labelText"], json!("Ran 1 command"));
        assert_eq!(card["terminalStatus"], json!("completed"));
        assert_eq!(card["isShellSurface"], json!(true));
        assert!(card["detailLine"].as_str().is_some_and(|line| line.ends_with("\u{b7} 12s")), "{}", card["detailLine"]);
    }

    #[test]
    fn a_pending_card_runs() {
        let card = model(json!({ "name": "read", "args": { "path": "a.rs" }, "completedCount": 0, "startedAt": 1_000, "nowMs": 4_000 }));
        assert_eq!(card["pending"], json!(true));
        assert_eq!(card["terminalStatus"], json!("running"));
        assert_eq!(card["detailLine"], json!("Running \u{b7} 3s"));
        assert_eq!(card["detailIsPlaceholder"], json!(true));
        assert_eq!(card["resultSummary"], Value::Null);
    }

    #[test]
    fn a_call_tool_request_shows_the_tool_it_runs() {
        let card = model(json!({
            "name": "call_tool",
            "args": { "name": "bash", "arguments": { "command": "ls" } },
            "result": "x",
        }));
        assert_eq!(card["via"], json!("call_tool"));
        assert_eq!(card["normalizedName"], json!("bash"));
    }

    #[test]
    fn a_group_card_is_aggregate() {
        let card = model(json!({ "aggregate": true, "count": 2, "result": "ok", "categories": {} }));
        assert_eq!(card["aggregate"], json!(true));
        assert_eq!(card["detailLine"], json!("ok"));
    }

    #[test]
    fn a_catalog_adds_the_translated_summary() {
        let translate = |_key: &str, original: &str, _params: &Value| format!("<{original}>");
        let options = CardOptions { translate: Some(&translate), ..CardOptions::default() };
        let card = derive_tool_card_model(&json!({ "name": "bash", "args": { "command": "ls" }, "result": "[exit code: 0]\nx" }), &options);
        assert!(card.get("resultSummaryDisplay").is_some());
        let plain = model(json!({ "name": "bash", "args": { "command": "ls" }, "result": "x" }));
        assert!(plain.get("resultSummaryDisplay").is_none());
    }

    #[test]
    fn a_failed_agent_names_its_cause() {
        let card = model(json!({
            "name": "agent",
            "args": { "agent": "worker", "prompt": "do it", "status": "failed", "error": "boom" },
            "result": "",
            "isError": true,
        }));
        assert_eq!(card["terminalStatus"], json!("failed"));
        assert!(card["headerFailureText"].as_str().is_some_and(|text| !text.is_empty()));
    }
}
