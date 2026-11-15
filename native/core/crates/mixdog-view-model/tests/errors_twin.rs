//! Replays tests/goldens/errors.json (recorded from the Node error modules by tests/recorders/record-errors.mjs) through the
//! Rust port: every failure of the corpus gives what Node gave from every function, with the clock and the zone pinned as
//! the recorder pinned them. An output Node recorded as an exception fails the test
//! instead of being skipped: the golden holds none. Three long texts (13000 x, a data URI, a JSON blob) carry only `safeDetails`: the
//! recorder ran no other function on them, so only that field exists to compare (`texts_give_what_node_gave` counts them).

use mixdog_js::json_number;
use mixdog_js::time::Tz;
use mixdog_js::time::with_local_zone;
use mixdog_view_model::errors::err_text;
use mixdog_view_model::errors::err_text::PresentOptions;
use mixdog_view_model::errors::error_presentation;
use mixdog_view_model::errors::js_value::is_object;
use mixdog_view_model::errors::provider_error_kind;
use mixdog_view_model::errors::provider_error_kind::KindOptions;
use mixdog_view_model::errors::provider_timeout_phase;
use mixdog_view_model::errors::transport_error_text;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/errors.json")).expect("the golden is JSON")
}

/// The recorded output of one call. An output without a value is a Node exception and fails the test.
fn recorded(output: &Value) -> Option<&Value> {
    Some(output.get("value").unwrap_or_else(|| panic!("a recorded output has no value (Node threw, which the twin does not list): {output}")))
}

fn describe(case: &Value) -> String {
    case.to_string().chars().take(240).collect()
}

fn check(case: &Value, what: &str, expected: Option<&Value>, actual: Value) {
    if let Some(expected) = expected {
        assert_eq!(expected, &actual, "{what} of {}", describe(case));
    }
}

fn option_number(value: Option<f64>) -> Value {
    value.map_or(Value::Null, json_number)
}

fn present_options(options: &Value, now: f64) -> PresentOptions<'_> {
    PresentOptions {
        surface: options.get("surface").and_then(Value::as_str).unwrap_or(""),
        max: options.get("max").and_then(Value::as_f64),
        provider_label: options.get("providerLabel").and_then(Value::as_str),
        now_ms: Some(now),
    }
}

fn kind_options(options: &Value, now: f64) -> KindOptions {
    let flag = |key: &str, default: bool| options.get(key).and_then(Value::as_bool).unwrap_or(default);
    KindOptions { text: flag("text", true), quota_flags: flag("quotaFlags", true), legacy_quota_wording: flag("legacyQuotaWording", false), now_ms: Some(now) }
}

#[test]
fn failures_give_what_node_gave() {
    with_local_zone(Tz::UTC, || {
        let golden = golden();
        let now = golden["now"].as_f64().expect("now");
        let cases = golden["cases"].as_array().expect("cases");
        assert!(cases.len() > 2000, "the golden holds the corpus");
        let present = golden["presentOptions"].as_array().expect("presentOptions");
        let kinds = golden["kindOptions"].as_array().expect("kindOptions");
        let statuses = golden["statuses"].as_array().expect("statuses");
        for case in cases {
            let input = if case.get("undef").is_some() { None } else { case.get("error") };
            check(case, "errText", recorded(&case["errText"]), json!(err_text::err_text(input)));
            check(case, "httpStatus", recorded(&case["httpStatus"]), json_number(err_text::error_http_status(input)));
            check(case, "cancelLike", recorded(&case["cancelLike"]), json!(err_text::is_cancel_like_error(input)));
            for (index, options) in present.iter().enumerate() {
                let text = err_text::present_error_text(input, &present_options(options, now));
                check(case, "present", recorded(&case["present"][index]), json!(text));
            }
            for (index, options) in [json!({}), json!({ "surface": "turn" })].iter().enumerate() {
                let line = err_text::error_line(input, &present_options(options, now));
                check(case, "line", recorded(&case["line"][index]), json!(line));
            }
            check(case, "describe", recorded(&case["describe"]), error_presentation::describe_error(input, Some(now)).to_value());
            check(case, "rejected429", recorded(&case["rejected429"]), json!(error_presentation::is_rejected_429(input)));
            check(case, "namesModel", recorded(&case["namesModel"]), json!(error_presentation::names_unavailable_model(input)));
            for (index, options) in kinds.iter().enumerate() {
                let descriptor = provider_error_kind::provider_error_kind(input, &kind_options(options, now));
                check(case, "kind", recorded(&case["kind"][index]), descriptor.to_value());
            }
            check(case, "typedCodeKind", recorded(&case["typedCodeKind"]), json!(provider_error_kind::typed_code_kind(input)));
            if is_object(input) {
                check(case, "typedErrorCode", recorded(&case["typedErrorCode"]), json!(provider_error_kind::typed_error_code(input)));
            }
            check(case, "retryAfter", recorded(&case["retryAfter"]), option_number(provider_error_kind::retry_after_ms_from_error(input, now)));
            check(case, "retryCode", recorded(&case["retryCode"]), json!(provider_error_kind::safe_retry_error_code(input, now)));
            check(case, "retryClass", recorded(&case["retryClass"]), json!(provider_error_kind::retry_reason_class(input, now)));
            check(case, "toolSurface", recorded(&case["toolSurface"]), json!(provider_error_kind::is_tool_surface_exceeds_context_error(input)));
            check(case, "chainLength", recorded(&case["chainLength"]), json!(provider_error_kind::bounded_cause_chain(input).len()));
            for (index, name) in ["retry-after", "retry-after-ms", "x-missing"].iter().enumerate() {
                let value = provider_error_kind::error_header_value(input, name).cloned().unwrap_or(Value::Null);
                check(case, "headers", recorded(&case["headers"][index]), value);
            }
            let verdict = transport_error_text::classify_transport_error(input)
                .map_or(Value::Null, |verdict| json!({ "kind": verdict.kind, "code": verdict.code, "status": verdict.status }));
            check(case, "transportKind", recorded(&case["transportKind"]), verdict);
            check(case, "transportText", recorded(&case["transportText"]), json!(transport_error_text::transport_error_text(input)));
            check(case, "firstByte", recorded(&case["firstByte"]), json!(provider_timeout_phase::is_first_byte_timeout(input)));
            let retry_timeouts = [("first_response_timeout", None), ("first_response_timeout", Some("Anthropic")), ("stalled", None), ("other", None)];
            for (index, (class, label)) in retry_timeouts.iter().enumerate() {
                check(case, "retryTimeout", recorded(&case["retryTimeout"][index]), json!(err_text::retry_timeout_text(input, class, *label)));
            }
            let mut index = 0;
            for status in statuses {
                for surface in ["", "agent"] {
                    let label = err_text::background_task_failure_status_label(Some(status), input, surface, Some(now));
                    check(case, "background", recorded(&case["background"][index]), json!(label));
                    index += 1;
                }
            }
        }
    });
}

#[test]
fn texts_give_what_node_gave() {
    let golden = golden();
    let now = golden["now"].as_f64().expect("now");
    let texts = golden["texts"].as_array().expect("texts");
    assert!(texts.len() > 150);
    let mut only_safe_details = 0;
    for case in texts {
        let text = case["text"].as_str().expect("text");
        let value = json!(text);
        check(case, "safeDetails", recorded(&case["safeDetails"]), json!(error_presentation::safe_error_details(text)));
        if case.get("namesModel").is_none() {
            only_safe_details += 1;
            continue;
        }
        check(case, "namesModel", recorded(&case["namesModel"]), json!(error_presentation::names_unavailable_model(Some(&value))));
        check(case, "rejected429", recorded(&case["rejected429"]), json!(error_presentation::is_rejected_429(Some(&value))));
        check(case, "tokenOverflow", Some(&case["tokenOverflow"]), json!(provider_error_kind::is_token_context_overflow_text(text)));
        check(case, "requestSize", Some(&case["requestSize"]), json!(provider_error_kind::is_request_size_text(text)));
        check(case, "bareFetch", Some(&case["bareFetch"]), json!(provider_error_kind::is_bare_fetch_transport_message(text)));
        check(case, "transientCode", Some(&case["transientCode"]), json!(provider_error_kind::is_transient_error_code(Some(&value))));
        check(case, "transientName", Some(&case["transientName"]), json!(provider_error_kind::is_transient_sdk_name(text)));
        for (index, error) in ["", "boom", text].iter().enumerate() {
            let only = err_text::is_background_error_only_body(text, error, Some(now));
            check(case, "backgroundBody", recorded(&case["backgroundBody"][index]), json!(only));
        }
    }
    assert_eq!(only_safe_details, 3, "the texts the recorder ran only safeDetails on are the three long ones");
}

#[test]
fn retry_lines_and_durations_give_what_node_gave() {
    let golden = golden();
    let now = golden["now"].as_f64().expect("now");
    let rows = golden["retryStatus"].as_array().expect("retryStatus");
    assert!(rows.len() > 1000);
    for row in rows {
        let number = |key: &str| row[key].as_f64().unwrap_or(f64::NAN);
        let line = err_text::retry_status_line(row["reason"].as_str().expect("reason"), number("attempt"), number("maxAttempts"), number("delayMs"));
        assert_eq!(row["line"], json!(line), "retry line of {row}");
    }
    with_local_zone(Tz::UTC, || {
        let options = PresentOptions { now_ms: Some(now), ..PresentOptions::default() };
        let agent = PresentOptions { surface: "agent", ..options };
        for row in golden["durations"].as_array().expect("durations") {
            let ms = row["ms"].as_u64().expect("ms");
            let said = |text: String| json!(text);
            let first_byte = json!(format!("first byte timed out after {ms}ms"));
            assert_eq!(row["label"], said(err_text::error_line(Some(&first_byte), &options)), "label of {row}");
            let stale = json!(format!("agent task stale ({ms}ms)"));
            assert_eq!(row["stale"], said(err_text::present_error_text(Some(&stale), &agent)), "stale of {row}");
            let background = |error: String| err_text::background_task_failure_status_label(Some(&json!("failed")), Some(&json!(error)), "", Some(now));
            assert_eq!(row["background"], said(background(format!("agent first response stale ({ms}ms)"))), "background of {row}");
            assert_eq!(row["backgroundStale"], said(background(format!("agent task stale ({ms}ms)"))), "background stale of {row}");
        }
    });
}

#[test]
fn gateway_error_types_give_what_node_gave() {
    let golden = golden();
    let rows = golden["gateway"].as_array().expect("gateway");
    assert!(rows.len() > 100);
    for row in rows {
        let detail = if row["detailUndefined"] == json!(true) { None } else { Some(&row["detail"]) };
        let envelope = if row["envelopeUndefined"] == json!(true) { None } else { Some(&row["envelope"]) };
        let result = provider_error_kind::normalize_gateway_error_detail(detail, envelope).unwrap_or(Value::Null);
        check(row, "gateway", recorded(&row["result"]), result);
    }
}

#[test]
fn the_kind_lists_are_what_node_lists() {
    let golden = golden();
    assert_eq!(golden["kinds"], json!(provider_error_kind::PROVIDER_ERROR_KINDS));
    assert_eq!(golden["quotaKinds"], json!(provider_error_kind::QUOTA_KINDS));
    assert_eq!(golden["deterministicKinds"], json!(provider_error_kind::DETERMINISTIC_KINDS));
}
