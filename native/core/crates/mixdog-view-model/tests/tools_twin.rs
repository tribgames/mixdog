//! Replays tests/goldens/tools.json (recorded from the Node tool surface by tests/recorders/record-tools.mjs) through the Rust
//! port: every call and every result text gives what Node gave. An output Node recorded as an exception is skipped.

use mixdog_view_model::tool_contract;
use mixdog_view_model::tool_status;
use mixdog_view_model::tool_surface;
use mixdog_view_model::tool_surface::AggregateHeaderOptions;
use mixdog_view_model::tool_surface::HeaderOptions;
use mixdog_view_model::tool_work_units;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/tools.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).expect("the golden is JSON")
}

/// The recorded output for `key` of a case, or `None` when Node did not give one (absent) or threw.
fn recorded<'a>(case: &'a Value, key: &str) -> Option<&'a Value> {
    case.get(key).filter(|value| value.get("threw").is_none())
}

fn text_of<'a>(case: &'a Value, key: &str) -> &'a str {
    case.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn describe(case: &Value) -> String {
    let text = case.to_string();
    text.chars().take(240).collect()
}

fn assert_same(case: &Value, what: &str, expected: &Value, actual: &Value) {
    assert_eq!(expected, actual, "{what} of {}", describe(case));
}

fn values(items: Vec<Value>) -> Value {
    Value::Array(items)
}

fn header_options(index: usize) -> HeaderOptions<'static> {
    match index {
        0 => HeaderOptions::default(),
        1 => HeaderOptions { pending: true, ..HeaderOptions::default() },
        2 => HeaderOptions { failed: true, ..HeaderOptions::default() },
        3 => HeaderOptions { pending: true, stable_verb_width: true, ..HeaderOptions::default() },
        4 => HeaderOptions { stable_verb_width: true, failed: true, ..HeaderOptions::default() },
        _ => HeaderOptions { category: "Shell", ..HeaderOptions::default() },
    }
}

#[test]
fn calls_give_what_node_gave() {
    let golden = golden();
    assert_eq!(golden["step"], json!(tool_surface::STEP));
    assert_eq!(golden["categoryOrder"], json!(tool_work_units::CATEGORY_ORDER));
    for (category, copy) in golden["categoryCopy"].as_object().expect("categoryCopy") {
        let rust = tool_work_units::category_copy(category);
        let mut expected = json!({ "active": rust.active, "done": rust.done, "noun": rust.noun });
        if let Some(plural) = rust.plural_noun {
            expected["pluralNoun"] = json!(plural);
        }
        assert_eq!(copy, &expected, "copy of {category}");
    }
    let calls = golden["calls"].as_array().expect("calls");
    assert!(calls.len() > 2000, "the golden holds the corpus");
    for case in calls {
        let name = text_of(case, "name");
        let args = &case["args"];
        if let Some(expected) = recorded(case, "category") {
            assert_same(case, "category", expected, &json!(tool_work_units::classify_tool_category(name, args)));
        }
        if let Some(expected) = recorded(case, "unit") {
            assert_same(case, "unit", expected, &tool_work_units::tool_work_unit(name, args, "").to_value());
        }
        if let Some(expected) = recorded(case, "unitFor") {
            assert_same(case, "unitFor", expected, &tool_work_units::tool_work_unit(name, args, "Browser").to_value());
        }
        if let Some(expected) = recorded(case, "entries") {
            let entries = tool_surface::aggregate_tool_category_entries(name, args, "");
            assert_same(case, "entries", expected, &values(entries.iter().map(tool_surface::AggregateEntry::to_value).collect()));
        }
        if let Some(expected) = recorded(case, "patchUnits") {
            let units = tool_work_units::patch_mutation_units(args);
            assert_same(case, "patchUnits", expected, &values(units.iter().map(tool_work_units::WorkUnit::to_value).collect()));
        }
        if let Some(expected) = recorded(case, "patchProfile") {
            let profile = tool_work_units::patch_operation_profile(args);
            let rows = profile.iter().map(|(kind, count)| json!([kind, mixdog_js::json_number(*count)])).collect();
            assert_same(case, "patchProfile", expected, &values(rows));
        }
        if let Some(expected) = recorded(case, "summary") {
            assert_same(case, "summary", expected, &json!(tool_surface::summarize_tool_args(name, args, 80)));
        }
        if let Some(expected) = recorded(case, "summaryNarrow") {
            assert_same(case, "summaryNarrow", expected, &json!(tool_surface::summarize_tool_args(name, args, 12)));
        }
        let shown = tool_surface::format_tool_surface_default(name, args);
        if let Some(expected) = recorded(case, "label") {
            assert_same(case, "label", expected, &json!(shown.label));
        }
        if let Some(expected) = recorded(case, "normalizedName") {
            assert_same(case, "normalizedName", expected, &json!(shown.normalized_name));
        }
        if let Some(expected) = recorded(case, "parsedArgs") {
            assert_same(case, "parsedArgs", expected, &shown.args);
        }
        if let Some(expected) = recorded(case, "loading") {
            assert_same(case, "loading", expected, &json!(tool_surface::tool_loading_targets(name, args)));
        }
        if let Some(expected) = recorded(case, "taskWait") {
            assert_same(case, "taskWait", expected, &json!(tool_surface::is_task_wait_tool_call(name, args)));
        }
        if let Some(expected) = recorded(case, "headers") {
            let headers = (0..6).map(|index| json!(tool_surface::format_tool_action_header(name, args, &header_options(index)))).collect();
            assert_same(case, "headers", expected, &values(headers));
        }
    }
}

#[test]
fn result_texts_give_what_node_gave() {
    let golden = golden();
    let texts = golden["texts"].as_array().expect("texts");
    assert!(texts.len() > 60);
    for case in texts {
        let text = text_of(case, "text");
        let checks: [(&str, Value); 9] = [
            ("normalized", json!(tool_status::normalize_tool_terminal_status(text))),
            ("leading", json!(tool_status::leading_result_block(text))),
            ("userControl", json!(tool_status::is_user_control_cancellation(text))),
            ("benign", json!(tool_status::has_benign_exit_outcome(text))),
            ("envelope", json!(tool_status::tool_result_envelope_status(text))),
            ("control", json!(tool_status::tool_result_control_status(text))),
            ("terminal", json!(tool_status::tool_result_terminal_status(text))),
            ("controlMarker", json!(tool_contract::is_control_marker(text))),
            ("cancelledText", json!(tool_contract::is_transcript_cancelled_status_text(text))),
        ];
        for (key, actual) in checks {
            if let Some(expected) = recorded(case, key) {
                assert_same(case, key, expected, &actual);
            }
        }
    }
}

#[test]
fn hidden_items_and_markers_give_what_node_gave() {
    let golden = golden();
    for case in golden["hidden"].as_array().expect("hidden") {
        let item = &case["item"];
        if let Some(expected) = recorded(case, "hiddenItem") {
            assert_same(case, "hiddenItem", expected, &json!(tool_contract::is_transcript_hidden_tool_item(item)));
        }
        if let Some(name) = item.get("name").and_then(Value::as_str) {
            if let Some(expected) = recorded(case, "hiddenName") {
                assert_same(case, "hiddenName", expected, &json!(tool_contract::is_transcript_hidden_control_tool_name(name)));
            }
            if let Some(expected) = recorded(case, "skillName") {
                assert_same(case, "skillName", expected, &json!(tool_contract::is_transcript_skill_tool_name(name)));
            }
        }
    }
    for case in golden["markers"].as_array().expect("markers") {
        let text = text_of(case, "text");
        assert_same(case, "controlMarker", &case["controlMarker"], &json!(tool_contract::is_control_marker(text)));
        assert_same(case, "cancelledText", &case["cancelledText"], &json!(tool_contract::is_transcript_cancelled_status_text(text)));
    }
}

fn aggregate_header_options(index: usize) -> AggregateHeaderOptions<'static> {
    match index {
        0 => AggregateHeaderOptions::default(),
        1 => AggregateHeaderOptions { pending: true, ..AggregateHeaderOptions::default() },
        2 => AggregateHeaderOptions { failed: true, ..AggregateHeaderOptions::default() },
        3 => AggregateHeaderOptions { pending: true, failed: true, ..AggregateHeaderOptions::default() },
        4 => AggregateHeaderOptions { stable_verb_width: true, ..AggregateHeaderOptions::default() },
        5 => AggregateHeaderOptions { order: Some(&["Shell", "Read", "Nope"]), failed: true, ..AggregateHeaderOptions::default() },
        _ => AggregateHeaderOptions { order: Some(&[]), pending: true, stable_verb_width: true, ..AggregateHeaderOptions::default() },
    }
}

#[test]
fn aggregates_give_what_node_gave() {
    let golden = golden();
    for case in golden["aggregates"].as_array().expect("aggregates") {
        let calls = case["calls"].as_array().expect("calls");
        let Some(result) = recorded(case, "result") else { continue };
        let mut yields = 0;
        let tallies = tool_surface::aggregate_done_categories_steps(calls, || yields += 1);
        assert_eq!(result["yields"], json!(yields), "yields of {}", describe(case));
        let map: Map<String, Value> = tallies.iter().map(|entry| (entry.key.clone(), entry.to_value())).collect();
        let expected = result["tallies"].as_object().expect("tallies");
        assert_eq!(expected.keys().collect::<Vec<_>>(), map.keys().collect::<Vec<_>>(), "tally order of {}", describe(case));
        assert_same(case, "tallies", &result["tallies"], &Value::Object(map.clone()));
        assert_same(case, "sync", &case["sync"], &Value::Object(tool_surface::aggregate_done_categories(calls).iter().map(|e| (e.key.clone(), e.to_value())).collect()));
        let headers = case["headers"].as_array().expect("headers");
        for (index, expected) in headers.iter().enumerate() {
            let actual = tool_surface::format_aggregate_header(&result["tallies"], &aggregate_header_options(index));
            assert_same(case, "header", expected, &json!(actual));
        }
    }
    for case in golden["headerMaps"].as_array().expect("headerMaps") {
        for (index, expected) in case["headers"].as_array().expect("headers").iter().enumerate() {
            if expected.get("threw").is_some() {
                continue;
            }
            let actual = tool_surface::format_aggregate_header(&case["map"], &aggregate_header_options(index));
            assert_same(case, "header", expected, &json!(actual));
        }
    }
}
