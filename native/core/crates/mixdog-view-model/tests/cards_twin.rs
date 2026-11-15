//! Replays tests/goldens/cards.json (recorded from the Node tool-card model by tests/recorders/record-cards.mjs) through the
//! Rust port: every card of the corpus (the recorded tool rows in every state, the product's own cases, the tool grid, the
//! group cards) is the model Node derived, and every helper gives what Node gave. An output Node recorded as an exception
//! is skipped.

use mixdog_js::json_number;
use mixdog_js::slice_utf16;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_view_model::card_model::CardSurface;
use mixdog_view_model::card_model::agent_surface;
use mixdog_view_model::card_model::background_task;
use mixdog_view_model::card_model::background_task::BackgroundMeta;
use mixdog_view_model::card_model::card_input::CardOptions;
use mixdog_view_model::card_model::derive_tool_card_model;
use mixdog_view_model::card_model::generic_detail;
use mixdog_view_model::card_model::generic_detail::GenericDetailInput;
use mixdog_view_model::card_model::git_result;
use mixdog_view_model::card_model::inline_text;
use mixdog_view_model::card_model::media_result;
use mixdog_view_model::card_model::shell_surface;
use mixdog_view_model::card_model::shell_surface::ShellStatusInput;
use mixdog_view_model::card_model::terminal_status;
use mixdog_view_model::card_model::terminal_status::OutcomeToneInput;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/cards.json")).expect("the golden is JSON")
}

fn describe(value: &impl std::fmt::Display) -> String {
    value.to_string().chars().take(300).collect()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value || '')`.
fn text(value: &Value) -> String {
    if truthy(value) { value_to_string(value) } else { String::new() }
}

fn arg(args: &[Value], at: usize) -> &Value {
    args.get(at).unwrap_or(&Value::Null)
}

fn number(value: &Value) -> f64 {
    to_number_of(Some(value))
}

/// The keys of two objects whose values differ.
fn differing(expected: &Value, actual: &Value) -> Vec<String> {
    let (Some(expected), Some(actual)) = (expected.as_object(), actual.as_object()) else { return vec!["(not objects)".to_owned()] };
    let mut keys: Vec<String> =
        expected.iter().filter(|(key, value)| actual.get(*key) != Some(*value)).map(|(key, _)| key.clone()).collect();
    keys.extend(actual.keys().filter(|key| !expected.contains_key(*key)).cloned());
    keys
}

/// The surface row fitter the recorder used: cut to the width with a `~`.
fn tilde(text: &str, width: usize) -> String {
    if utf16_len(text) <= width { text.to_owned() } else { format!("{}~", slice_utf16(text, width.saturating_sub(1))) }
}

fn catalog(key: &str, original: &str, _params: &Value) -> String {
    format!("[{key}|{original}]")
}

#[test]
fn every_card_is_the_model_node_derived() {
    let golden = golden();
    let options = golden["options"].as_array().expect("options");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 4000, "the golden holds the corpus");
    let fit: &dyn Fn(&str, usize) -> String = &tilde;
    let translate: &dyn Fn(&str, &str, &Value) -> String = &catalog;
    for case in cases {
        let (input, option, expected) = (&case[0], &options[case[1].as_u64().expect("option") as usize], &case[2]);
        if expected.get("threw").is_some() {
            continue;
        }
        let card_options = CardOptions {
            truncate: truthy(&option["fit"]).then_some(fit),
            max_result_chars: option["max"].as_f64(),
            translate: truthy(&option["translate"]).then_some(translate),
        };
        let actual = derive_tool_card_model(input, &card_options);
        assert!(
            &actual == expected,
            "card of {}\noptions {option}\ndiffering keys {:?}\nexpected {}\nactual   {}",
            describe(input),
            differing(expected, &actual),
            describe(expected),
            describe(&actual)
        );
    }
}

fn meta_of(value: &Value) -> BackgroundMeta {
    let get = |key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    BackgroundMeta {
        task_id: text(&get("taskId")),
        surface: get("surface"),
        operation: get("operation"),
        label: get("label"),
        status: text(&get("status")),
        started_at: get("startedAt"),
        finished_at: get("finishedAt"),
        body: text(&get("body")),
        error: get("error"),
        kind: value.get("type").cloned(),
        has_response: truthy(&get("hasResponse")),
    }
}

fn optional_meta(meta: Option<BackgroundMeta>) -> Value {
    meta.map_or(Value::Null, |meta| meta.to_value())
}

fn word(status: &str) -> Value {
    Value::from(status.to_owned())
}

/// What the Rust function of a helper gives for the recorded arguments.
fn replay(name: &str, args: &[Value]) -> Value {
    let (a, b, c, d) = (arg(args, 0), arg(args, 1), arg(args, 2), arg(args, 3));
    match name {
        "safeInlineText" => word(&inline_text::safe_inline_text(&text(a))),
        "splitLineDeltaTokens" => Value::Array(inline_text::split_line_delta_tokens(&text(a)).iter().map(|part| part.to_value()).collect()),
        "normalizeCountMap" => inline_text::normalize_count_map(a),
        "deriveToolOutcomeTone" => {
            let status = text(&a["terminalStatus"]);
            let defaulted = |key: &str, fallback: f64| a.get(key).map_or(fallback, number);
            word(terminal_status::derive_tool_outcome_tone(&OutcomeToneInput {
                pending: truthy(&a["pending"]),
                group_count: defaulted("groupCount", 1.0),
                call_failed_count: defaulted("callFailedCount", 0.0),
                exit_failed_count: defaulted("exitFailedCount", 0.0),
                terminal_status: &status,
                partial_mutation: truthy(&a["partialMutation"]),
            }))
        }
        "displayTerminalStatus" => word(terminal_status::display_terminal_status(&text(a))),
        "normalizeTerminalStatus" => word(terminal_status::normalize_terminal_status(&text(a))),
        "mergeTerminalDetail" => word(&terminal_status::merge_terminal_detail(&text(a), &text(b))),
        "prefixElapsed" => word(&terminal_status::prefix_elapsed(&text(a), &text(b))),
        "clampFailureCount" => json_number(terminal_status::clamp_failure_count(Some(a), number(b), truthy(c))),
        "clampFailureCountAbsent" => json_number(terminal_status::clamp_failure_count(None, number(b), truthy(c))),
        "shellResultStatus" => word(&terminal_status::shell_result_status(&text(a))),
        "shellResultElapsed" => word(&terminal_status::shell_result_elapsed(&text(a))),
        "stripLeadingStatusMarkerFromText" => word(&terminal_status::strip_leading_status_marker_from_text(&text(a))),
        "resultTerminalStatus" => word(terminal_status::result_terminal_status(&text(a))),
        "resultEnvelopeStatus" => word(terminal_status::result_envelope_status(&text(a))),
        "resultControlStatus" => word(terminal_status::result_control_status(&text(a))),
        "isShellTool" => Value::Bool(shell_surface::is_shell_tool(&text(a), &text(b))),
        "shellDisplayStatus" => {
            let result = text(&a["result"]);
            word(shell_surface::shell_display_status(&ShellStatusInput {
                pending: truthy(&a["pending"]),
                failed_count: number(&a["failedCount"]),
                exit_failed_count: number(&a["exitFailedCount"]),
                is_error: truthy(&a["isError"]),
                result: &result,
            }))
        }
        "shellHeader" => word(&shell_surface::shell_header(&text(a), number(b), truthy(c))),
        "genericCompletedDetail" => word(&generic_detail::generic_completed_detail(&GenericDetailInput {
            normalized_name: &text(&a["normalizedName"]),
            label: &text(&a["label"]),
            has_result: truthy(&a["hasResult"]),
            first_result_line: &text(&a["firstResultLine"]),
            is_error: truthy(&a["isError"]),
        })),
        "bridgeDescribeResult" => generic_detail::bridge_describe_result(&text(a)).map_or(Value::Null, |describe| {
            json!({ "described": describe.described, "missing": describe.missing, "blocked": describe.blocked })
        }),
        "toolSearchLoadedSummary" => word(&generic_detail::tool_search_loaded_summary(&text(a))),
        "shouldPrefixSyncElapsed" => Value::Bool(generic_detail::should_prefix_sync_elapsed(&text(a), &text(b))),
        "agentActionTitle" => word(&agent_surface::agent_action_title(a, &text(b))),
        "agentActionSummary" => word(&agent_surface::agent_action_summary(a, &text(b))),
        "agentResponseTitle" => word(&agent_surface::agent_response_title(a, number(b), &text(c))),
        "isAgentResponseResult" => Value::Bool(agent_surface::is_agent_response_result(a, &text(b))),
        "hasAgentResponseResult" => Value::Bool(agent_surface::has_agent_response_result(&text(a))),
        "titleizeAgentName" => word(&agent_surface::titleize_agent_name(&text(a))),
        "agentTerminalDetail" => word(&agent_surface::agent_terminal_detail(Some(a), truthy(b), &text(c), Some(d))),
        "parseBackgroundTaskResult" => optional_meta(background_task::parse_background_task_result(&text(a))),
        "isBackgroundTaskTool" => Value::Bool(background_task::is_background_task_tool(&text(a))),
        "isBackgroundTaskResponseArgs" => Value::Bool(background_task::is_background_task_response_args(&text(a), b)),
        "taskControlTitle" => word(background_task::task_control_title(&text(a), b)),
        "resolveBackgroundTaskMeta" => optional_meta(background_task::resolve_background_task_meta(a, &text(b))),
        "backgroundTaskResultTitle" => word(&background_task::background_task_result_title(&text(a), &meta_of(b))),
        "backgroundTaskActionTitle" => word(&background_task::background_task_action_title(&text(a), &meta_of(b))),
        "backgroundTaskDetail" => word(&background_task::background_task_detail(&meta_of(a), &text(b))),
        "backgroundTaskFailureDetail" => word(&background_task::background_task_failure_detail(&meta_of(a), b)),
        "backgroundTaskElapsed" => word(&background_task::background_task_elapsed(&meta_of(a), &text(b))),
        "backgroundTaskArgsElapsed" => word(&background_task::background_task_args_elapsed(a, &text(b))),
        "mediaTerminalStatus" => word(media_result::media_terminal_status(a, &text(b))),
        "mediaResultSummary" => media_result::media_result_summary(a, &text(b)).map_or(Value::Null, Value::from),
        "gitTerminalStatus" => word(git_result::git_terminal_status(&text(a))),
        other => panic!("the golden holds a helper this twin does not replay: {other}"),
    }
}

#[test]
fn every_helper_gives_what_node_gave() {
    let golden = golden();
    let helpers = golden["helpers"].as_object().expect("helpers");
    let mut calls = 0;
    for (name, rows) in helpers {
        for row in rows.as_array().expect("rows") {
            let (args, expected) = (row[0].as_array().expect("args"), &row[1]);
            if expected.get("threw").is_some() {
                continue;
            }
            calls += 1;
            let actual = replay(name, args);
            assert!(&actual == expected, "{name}({}) gave {} but Node gave {}", describe(&Value::Array(args.to_vec())), describe(&actual), describe(expected));
        }
    }
    assert!(calls > 8000, "the golden holds the corpus");
}

#[test]
fn the_surface_value_is_the_one_the_card_reports() {
    let card = derive_tool_card_model(&json!({ "name": "bash", "args": { "command": "ls" }, "result": "x", "nowMs": 20_000 }), &CardOptions::default());
    let surface = CardSurface {
        label: card["label"].as_str().expect("label").to_owned(),
        summary: String::new(),
        normalized_name: card["normalizedName"].as_str().expect("name").to_owned(),
        parsed_args: card["parsedArgs"].clone(),
        is_shell_surface: truthy(&card["isShellSurface"]),
        is_skill_surface: truthy(&card["isSkillSurface"]),
    };
    assert!(surface.is_shell_surface && !surface.is_skill_surface);
    assert_eq!(surface.normalized_name, "bash");
}
