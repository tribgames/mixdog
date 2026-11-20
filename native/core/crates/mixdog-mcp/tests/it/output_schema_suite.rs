//! A tool's `outputSchema` is enforced on its results: a result must carry structured content that fits the schema, an error result
//! is let through, a tool with no schema is never checked, and a listing whose schema is not an object schema is refused.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_mcp::output_schema::OutputValidators;
use mixdog_mcp::rpc::RpcError;
use serde_json::Value;
use serde_json::json;

fn validators() -> OutputValidators {
    let schema = json!({"type": "object", "properties": {"n": {"type": "integer"}, "tag": {"type": "string"}}, "required": ["n"]});
    OutputValidators::of(&[
        json!({"name": "counted", "inputSchema": {"type": "object"}, "outputSchema": schema}),
        json!({"name": "free", "inputSchema": {"type": "object"}}),
    ])
    .expect("the listing is valid")
}

fn check(tool: &str, result: Value) -> Result<(), RpcError> {
    validators().check(tool, &result, &Arc::new(AtomicBool::new(false)))
}

fn refusal(outcome: Result<(), RpcError>) -> (i64, String) {
    match outcome {
        Err(RpcError::Server { code, message, .. }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn only_a_tool_with_an_output_schema_is_checked() {
    let validators = validators();
    assert!(validators.checks("counted") && !validators.checks("free") && !validators.checks("unknown"));
    assert!(check("free", json!({"content": []})).is_ok());
    assert!(check("unknown", json!({"structuredContent": 5})).is_ok());
}

#[test]
fn structured_content_that_fits_the_schema_passes() {
    assert!(check("counted", json!({"content": [], "structuredContent": {"n": 3, "tag": "x"}})).is_ok());
    assert!(check("counted", json!({"structuredContent": {"n": 0}})).is_ok(), "an optional property may be absent");
}

#[test]
fn a_result_without_structured_content_is_refused_unless_it_is_an_error_result() {
    let expected = (-32600, "Tool counted has an output schema but did not return structured content".to_owned());
    assert_eq!(refusal(check("counted", json!({"content": [{"type": "text", "text": "hi"}]}))), expected);
    assert_eq!(refusal(check("counted", json!({"structuredContent": null}))), expected, "null is no structured content");
    assert_eq!(refusal(check("counted", json!({"isError": false}))), expected);
    assert!(check("counted", json!({"isError": true, "content": [{"type": "text", "text": "failed"}]})).is_ok());
}

#[test]
fn structured_content_that_does_not_fit_is_refused_with_where_it_failed() {
    let prefix = "Structured content does not match the tool's output schema: ";
    let (code, message) = refusal(check("counted", json!({"structuredContent": {"n": "three"}})));
    assert_eq!(code, -32602);
    assert!(message.starts_with(prefix) && message.contains("/n") && message.contains("integer"), "{message}");
    let (code, message) = refusal(check("counted", json!({"structuredContent": {"tag": "x"}})));
    assert_eq!(code, -32602);
    assert!(message.starts_with(prefix) && message.contains("required") && message.contains("n"), "{message}");
    let (_, message) = refusal(check("counted", json!({"structuredContent": "not an object"})));
    assert!(message.starts_with(prefix), "{message}");
}

#[test]
fn a_listing_whose_output_schema_is_not_an_object_schema_is_refused_whole() {
    for schema in [json!({"type": "string"}), json!("object"), json!(7)] {
        let listing = [json!({"name": "bad", "inputSchema": {"type": "object"}, "outputSchema": schema})];
        assert!(OutputValidators::of(&listing).is_err(), "{schema}");
    }
}

#[test]
fn a_check_whose_call_was_cancelled_ends_cancelled() {
    let stop = Arc::new(AtomicBool::new(false));
    stop.store(true, Ordering::Relaxed);
    let outcome = validators().check("counted", &json!({"structuredContent": {"n": 1}}), &stop);
    assert!(matches!(outcome, Err(RpcError::Cancelled)), "{outcome:?}");
}
