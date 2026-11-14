//! Replays tests/goldens/results.json (recorded from the Node tool result modules by tests/recorders/record-results.mjs)
//! through the Rust port: every summary, status, text, classification and read-row case gives what Node gave. An output Node
//! recorded as an exception is skipped.

use mixdog_js::json_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use mixdog_view_model::results::aggregate_detail;
use mixdog_view_model::results::classification;
use mixdog_view_model::results::read_rows;
use mixdog_view_model::results::status;
use mixdog_view_model::results::summary;
use mixdog_view_model::results::text;
use mixdog_view_model::tool_surface::AggregateEntry;
use mixdog_view_model::tool_surface::STEP;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/results.json")).expect("the golden is JSON")
}

/// The recorded output, or `None` when Node threw.
fn recorded(value: &Value) -> Option<&Value> {
    value.get("threw").is_none().then_some(value)
}

fn describe(value: &impl std::fmt::Debug) -> String {
    format!("{value:?}").chars().take(240).collect()
}

fn opt(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::from)
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

fn js_text(value: &Value) -> String {
    if truthy(value) { value_to_string(value) } else { String::new() }
}

fn texts(golden: &Value) -> Vec<&str> {
    golden["texts"].as_array().expect("texts").iter().map(|text| text.as_str().expect("text")).collect()
}

fn catalog(key: &str, original: &str, _params: &Value) -> String {
    format!("[{key}|{original}]")
}

#[test]
fn the_catalog_keys_and_constants_match() {
    let golden = golden();
    assert_eq!(golden["step"], json!(STEP));
    assert_eq!(golden["uiKeys"], json!(summary::tool_result_ui_keys()));
    assert_eq!(golden["readLineNoSep"], json!(read_rows::READ_LINE_NO_SEP.to_string()));
    for case in golden["memorySurface"].as_array().expect("memorySurface") {
        assert_eq!(case["is"], json!(summary::is_memory_surface(case["label"].as_str().expect("label"))));
    }
}

#[test]
fn summaries_give_what_node_gave() {
    let golden = golden();
    let (texts, args_list) = (texts(&golden), golden["argsList"].as_array().expect("argsList"));
    let rows = golden["summaries"].as_array().expect("summaries");
    assert!(rows.len() > 5000, "the golden holds the corpus");
    for row in rows {
        let (name, args, text) = (row[0].as_str().expect("name"), &args_list[row[1].as_u64().expect("args") as usize], texts[row[2].as_u64().expect("text") as usize]);
        let what = format!("{name} {args} {text:?}");
        if let Some(expected) = recorded(&row[3]) {
            assert_eq!(expected, &opt(summary::summarize_tool_result(name, args, text, false)), "summary of {}", describe(&what));
        }
        if let Some(expected) = recorded(&row[4]) {
            assert_eq!(expected, &opt(summary::summarize_tool_result(name, args, text, true)), "error summary of {}", describe(&what));
        }
        // `1` stands for "the catalog changed nothing".
        let expected = if row[5] == json!(1) { &row[3] } else { &row[5] };
        if let Some(expected) = recorded(expected) {
            let actual = opt(summary::summarize_tool_result_translated(name, args, text, false, &catalog));
            assert_eq!(expected, &actual, "translated summary of {}", describe(&what));
        }
    }
}

#[test]
fn agent_briefs_give_what_node_gave() {
    let golden = golden();
    let (texts, args_list) = (texts(&golden), golden["argsList"].as_array().expect("argsList"));
    let options = [
        summary::AgentBriefOptions::default(),
        summary::AgentBriefOptions { is_error: true, is_response: false },
        summary::AgentBriefOptions { is_error: false, is_response: true },
        summary::AgentBriefOptions { is_error: true, is_response: true },
    ];
    for row in golden["briefs"].as_array().expect("briefs") {
        let (name, args, text) = (row[0].as_str().expect("name"), &args_list[row[1].as_u64().expect("args") as usize], texts[row[2].as_u64().expect("text") as usize]);
        for (index, options) in options.iter().enumerate() {
            if let Some(expected) = recorded(&row[3 + index]) {
                let actual = summary::summarize_agent_surface_brief(name, args, text, *options);
                assert_eq!(expected, &json!(actual), "brief {index} of {name} {args} {}", describe(&text));
            }
        }
    }
}

fn delta_value(delta: &summary::LineDelta) -> Value {
    json!({ "added": json_number(delta.added), "removed": json_number(delta.removed), "seen": delta.seen })
}

fn update_value(update: Option<summary::UpdateSummary>) -> Value {
    update.map_or(Value::Null, |u| {
        json!({ "action": u.action, "file": u.file, "fileCount": json_number(u.file_count), "added": json_number(u.added), "removed": json_number(u.removed), "seen": u.seen })
    })
}

fn window_value(window: Option<read_rows::SourceWindow>) -> Value {
    window.map_or(Value::Null, |w| w.to_value())
}

#[test]
fn text_probes_give_what_node_gave() {
    let golden = golden();
    let texts = texts(&golden);
    let probes = golden["textProbes"].as_array().expect("textProbes");
    assert_eq!(probes.len(), texts.len());
    for (text, probe) in texts.iter().zip(probes) {
        let check = |key: &str, actual: Value| {
            if let Some(expected) = recorded(&probe[key]) {
                assert_eq!(expected, &actual, "{key} of {}", describe(text));
            }
        };
        check("extractErrorCause", json!(summary::extract_error_cause(text)));
        check("parseLineDelta", delta_value(&summary::parse_line_delta(text)));
        check("parseUpdateSummary", update_value(summary::parse_update_summary(text)));
        check("finalAnswer", json!(summary::text_between_tag(text, "final-answer")));
        check("result", json!(summary::text_between_tag(text, "result")));
        check("stripShellExitHeader", json!(text::strip_shell_exit_header(text)));
        check("shellCommandExitCode", status::shell_command_exit_code(text).map_or(Value::Null, json_number));
        check("isShellFailureResult", json!(classification::is_shell_failure_result(text)));
        check("readRowsForModel", json!(read_rows::read_rows_for_model(text)));
        check("readRowsForDisplay", json!(read_rows::read_rows_for_display(text)));
        check("readSourceWindow", window_value(read_rows::read_source_window(text)));
    }
}

#[test]
fn line_deltas_and_tags() {
    let golden = golden();
    for case in golden["deltas"].as_array().expect("deltas") {
        let parsed = summary::parse_line_delta(case["text"].as_str().expect("text"));
        assert_eq!(case["parsed"], delta_value(&parsed), "parse of {}", describe(&case["text"]));
        assert_eq!(case["formatted"], json!(summary::format_line_delta(&parsed)), "format of {}", describe(&case["text"]));
    }
    for case in golden["formatCases"].as_array().expect("formatCases") {
        let totals = &case["totals"];
        let delta = summary::LineDelta {
            added: to_number_of(totals.get("added")),
            removed: to_number_of(totals.get("removed")),
            seen: totals.get("seen").is_some_and(truthy),
        };
        assert_eq!(case["formatted"], json!(summary::format_line_delta(&delta)), "format of {}", describe(totals));
    }
    for case in golden["tagCases"].as_array().expect("tagCases") {
        let (text, tag) = (case["text"].as_str().expect("text"), case["tag"].as_str().expect("tag"));
        assert_eq!(case["found"], json!(summary::text_between_tag(text, tag)), "tag {tag} of {}", describe(&text));
    }
}

#[test]
fn classification_gives_what_node_gave() {
    let golden = golden();
    let texts = texts(&golden);
    for row in golden["classification"].as_array().expect("classification") {
        let (text, tool) = (texts[row[0].as_u64().expect("text") as usize], row[1].as_str().expect("tool"));
        if row[3].is_null() {
            let kind = classification::classify_result_kind(text, true, tool);
            assert_eq!(row[2], json!(kind.as_str()), "explicit success of {}", describe(&text));
            continue;
        }
        let kind = classification::classify_result_kind(text, false, tool);
        assert_eq!(row[2], json!(kind.as_str()), "kind of {tool} {}", describe(&text));
        assert_eq!(row[3], json!(classification::is_read_only_navigation_miss(tool, text)), "miss of {tool} {}", describe(&text));
    }
}

#[test]
fn result_text_gives_what_node_gave() {
    let golden = golden();
    for case in golden["resultText"].as_array().expect("resultText") {
        if let Some(expected) = recorded(&case["text"]) {
            assert_eq!(expected, &json!(text::tool_result_text(&case["content"])), "text of {}", describe(&case["content"]));
        }
    }
    for case in golden["fallbacks"].as_array().expect("fallbacks") {
        let s = |key: &str| case.get(key).and_then(Value::as_str).map(str::to_owned);
        if let (Some(detail), Some(raw)) = (s("detail"), s("raw")) {
            assert_eq!(case["aggregate"], json!(text::tool_aggregate_detail_fallback(&detail, &raw)), "aggregate fallback of {}", describe(case));
            assert_eq!(case["grouped"], json!(text::tool_grouped_display_fallback(&detail, &raw, "raw text")), "grouped fallback of {}", describe(case));
        }
        if let (Some(result), Some(body)) = (s("result"), s("text")) {
            assert_eq!(case["grouped3"], json!(text::tool_grouped_display_fallback(&result, &body, "detail")), "grouped fallback of {}", describe(case));
        }
    }
    let golden_texts = texts(&golden);
    for row in golden["errorDisplays"].as_array().expect("errorDisplays") {
        let (value, surface) = (golden_texts[row[0].as_u64().expect("text") as usize], row[1].as_str().expect("surface"));
        let presented = row[2].as_str().unwrap_or_default().to_owned();
        if let Some(expected) = recorded(&row[3]) {
            let actual = text::tool_error_display(value, surface, &|_, _| presented.clone());
            assert_eq!(expected, &json!(actual), "error display of {surface} {}", describe(&value));
        }
    }
}

#[test]
fn outcomes_and_displays_give_what_node_gave() {
    let golden = golden();
    let (texts, messages) = (texts(&golden), golden["messages"].as_array().expect("messages"));
    for row in golden["outcomes"].as_array().expect("outcomes") {
        let (message, text) = (&messages[row[0].as_u64().expect("message") as usize], texts[row[1].as_u64().expect("text") as usize]);
        if let Some(expected) = recorded(&row[2]) {
            assert_eq!(expected, &status::tool_call_outcome(message, text).to_value(), "outcome of {message} {}", describe(&text));
        }
    }
    for row in golden["displays"].as_array().expect("displays") {
        let (message, text) = (&messages[row[0].as_u64().expect("message") as usize], texts[row[1].as_u64().expect("text") as usize]);
        let (tool, presented) = (row[2].as_str().expect("tool"), row[3].as_str().unwrap_or_default().to_owned());
        if let Some(expected) = recorded(&row[4]) {
            let actual = status::tool_result_display(message, text, tool, &|_, _| presented.clone());
            assert_eq!(expected, &actual, "display of {message} {tool} {}", describe(&text));
        }
    }
    for case in golden["failureDetails"].as_array().expect("failureDetails") {
        let args = &case["args"];
        let count = |key: &str| args.get(key).and_then(Value::as_u64).unwrap_or(0) as usize;
        let counts = status::FailureCounts {
            succeeded: count("succeeded"),
            real_errors: count("realErrors"),
            exit_errors: count("exitErrors"),
            exit_code: args.get("exitCode").and_then(Value::as_f64),
        };
        if let Some(expected) = recorded(&case["text"]) {
            assert_eq!(expected, &json!(status::failure_detail_text(&counts)), "failure detail of {}", describe(args));
        }
    }
    let items = golden["items"].as_array().expect("items");
    for row in golden["markers"].as_array().expect("markers") {
        let (text, item) = (texts[row[0].as_u64().expect("text") as usize], &items[row[1].as_u64().expect("item") as usize]);
        if let Some(expected) = recorded(&row[2]) {
            assert_eq!(expected, &json!(status::with_cancelled_result_marker(text, item)), "marker of {item} {}", describe(&text));
        }
    }
}

/// The records of a stepped pass: its output and how many times it yielded.
fn stepped(case: &Value, key: &str) -> Option<(u64, Value)> {
    let record = recorded(&case[key])?;
    Some((record["yields"].as_u64().expect("yields"), record["value"].clone()))
}

fn list<'a>(case: &'a Value, key: &str) -> &'a [Value] {
    case[key].as_array().expect("list")
}

#[test]
fn aggregates_give_what_node_gave() {
    let golden = golden();
    for case in golden["aggregateRaw"].as_array().expect("aggregateRaw") {
        let calls = list(case, "calls");
        if let Some((yields, value)) = stepped(case, "steps") {
            let mut seen = 0;
            assert_eq!(value, json!(status::aggregate_raw_result_steps(calls, || seen += 1)), "raw of {}", describe(&case["calls"]));
            assert_eq!(yields, seen, "raw yields of {}", describe(&case["calls"]));
        }
        if let Some(expected) = recorded(&case["raw"]) {
            assert_eq!(expected, &json!(status::aggregate_raw_result(calls)), "raw of {}", describe(&case["calls"]));
        }
        if let Some((yields, value)) = stepped(case, "memberSteps") {
            let mut seen = 0;
            assert_eq!(value, Value::Array(status::aggregate_tool_members_steps(calls, || seen += 1)), "members of {}", describe(&case["calls"]));
            assert_eq!(yields, seen, "member yields of {}", describe(&case["calls"]));
        }
        if let Some(expected) = recorded(&case["members"]) {
            assert_eq!(expected, &Value::Array(status::aggregate_tool_members(calls)), "members of {}", describe(&case["calls"]));
        }
    }
    for case in golden["buckets"].as_array().expect("buckets") {
        let category = js_text(&case["category"]);
        let batch = case["options"].get("agentBatch").and_then(Value::as_str).unwrap_or_default();
        assert_eq!(case["bucket"], json!(status::aggregate_bucket_for_category(&category, batch)), "bucket of {}", describe(case));
    }
    for case in golden["loading"].as_array().expect("loading") {
        let calls = list(case, "calls");
        if let Some((yields, value)) = stepped(case, "steps") {
            let mut seen = 0;
            assert_eq!(value, json!(status::aggregate_loading_targets_steps(calls, || seen += 1)), "targets of {}", describe(&case["calls"]));
            assert_eq!(yields, seen, "target yields of {}", describe(&case["calls"]));
        }
        if let Some(expected) = recorded(&case["targets"]) {
            assert_eq!(expected, &json!(status::aggregate_loading_targets(calls)), "targets of {}", describe(&case["calls"]));
        }
    }
}

fn entry_of(value: &Value) -> AggregateEntry {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    AggregateEntry {
        key: text("key"),
        category: text("category"),
        active: text("active"),
        done: text("done"),
        noun: text("noun"),
        plural_noun: text("pluralNoun"),
        effect: value.get("effect").is_some_and(truthy),
        count: to_number_of(value.get("count")),
    }
}

#[test]
fn entries_merge_as_node_merged_them() {
    let golden = golden();
    for case in golden["merges"].as_array().expect("merges") {
        let Some(merged) = recorded(&case["merged"]) else { continue };
        let mut categories: Vec<AggregateEntry> = Vec::new();
        for batch in list(case, "batches") {
            let entries: Vec<AggregateEntry> = batch.as_array().expect("batch").iter().map(entry_of).collect();
            status::merge_aggregate_category_entries(&mut categories, &entries);
        }
        let order: Vec<Value> = categories.iter().map(|entry| json!(entry.key)).collect();
        assert_eq!(merged["order"], Value::Array(order), "order of {}", describe(&case["batches"]));
        let values: Vec<Value> = categories.iter().map(AggregateEntry::to_value).collect();
        assert_eq!(merged["entries"], Value::Array(values), "entries of {}", describe(&case["batches"]));
    }
}

#[test]
fn ui_diffs() {
    let golden = golden();
    for case in golden["uiDiffs"].as_array().expect("uiDiffs") {
        let source = &case["source"];
        if let Some(expected) = recorded(&case["from"]) {
            assert_eq!(expected, &opt(status::ui_diff_from_message(source)), "uiDiff of {}", describe(source));
        }
        if let Some(expected) = recorded(&case["patch"]) {
            assert_eq!(expected, &Value::Object(status::ui_diff_patch_from_message(source)), "uiDiff patch of {}", describe(source));
        }
        if let Some(expected) = recorded(&case["stringPatch"]) {
            let value = case["hasSource"].as_bool().unwrap_or(false).then_some(source);
            assert_eq!(expected, &Value::Object(status::string_ui_diff_patch(value)), "string patch of {}", describe(source));
        }
        if let Some(Value::Object(expected)) = recorded(&case["patch"]) {
            let mut target = json!({ "kept": 1 });
            status::assign_ui_diff_from_message(&mut target, source);
            let mut want = Map::new();
            want.insert("kept".to_owned(), json!(1));
            want.extend(expected.clone());
            assert_eq!(target, Value::Object(want), "assigned uiDiff of {}", describe(source));
        }
    }
}

#[test]
fn settled_aggregates_take_what_node_gave() {
    let golden = golden();
    for case in golden["patches"].as_array().expect("patches") {
        let (calls, all, done) = (list(case, "calls"), list(case, "all"), case["done"].as_u64().expect("done") as usize);
        if let Some((yields, value)) = stepped(case, "steps") {
            let mut seen = 0;
            let actual = status::aggregate_result_patch_steps(calls, all, done, || seen += 1);
            assert_eq!(value, actual, "patch of {}", describe(&case["calls"]));
            assert_eq!(yields, seen, "patch yields of {}", describe(&case["calls"]));
        }
        if let Some(expected) = recorded(&case["sync"]) {
            assert_eq!(expected, &status::aggregate_result_patch(calls, all, done), "patch of {}", describe(&case["calls"]));
        }
    }
    for case in golden["details"].as_array().expect("details") {
        let summaries: Vec<String> = list(case, "summaries").iter().map(js_text).collect();
        if let Some((yields, value)) = stepped(case, "steps") {
            let mut seen = 0;
            assert_eq!(value, json!(aggregate_detail::format_aggregate_detail_steps(&summaries, || seen += 1)), "detail of {}", describe(&case["summaries"]));
            assert_eq!(yields, seen, "detail yields of {}", describe(&case["summaries"]));
        }
        if let Some(expected) = recorded(&case["sync"]) {
            assert_eq!(expected, &json!(aggregate_detail::format_aggregate_detail(&summaries)), "detail of {}", describe(&case["summaries"]));
        }
    }
}

#[test]
fn read_rows_give_what_node_gave() {
    let golden = golden();
    for case in golden["readRows"].as_array().expect("readRows") {
        let text = case["text"].as_str().expect("text");
        let check = |key: &str, actual: Value| {
            if let Some(expected) = recorded(&case[key]) {
                assert_eq!(expected, &actual, "{key} of {}", describe(&text));
            }
        };
        check("model", json!(read_rows::read_rows_for_model(text)));
        check("display", json!(read_rows::read_rows_for_display(text)));
        check("window", window_value(read_rows::read_source_window(text)));
        check("roundTrip", json!(read_rows::read_rows_for_display(&read_rows::read_rows_for_model(text))));
    }
}
