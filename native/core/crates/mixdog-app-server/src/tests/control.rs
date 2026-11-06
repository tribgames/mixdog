//! Which inbound frames are control frames (the ones a paused reader still hands on).

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::RequestClass;
use serde_json::json;

use crate::is_control;

fn message(value: serde_json::Value) -> JsonRpcMessage {
    serde_json::from_value(value).unwrap()
}

#[test]
fn c0_requests_and_answers_are_control_and_the_rest_is_data() {
    let c0 = CLIENT_METHODS.iter().find(|spec| spec.class == RequestClass::C0).expect("a C0 method").method;
    let other = CLIENT_METHODS.iter().find(|spec| spec.class != RequestClass::C0).expect("a non-C0 method").method;
    assert!(is_control(&message(json!({"id": 1, "method": c0, "params": {}}))));
    assert!(!is_control(&message(json!({"id": 2, "method": other, "params": {}}))));
    assert!(!is_control(&message(json!({"id": 3, "method": "no/such/method"}))));
    assert!(is_control(&message(json!({"id": 4, "result": {}}))));
    assert!(is_control(&message(json!({"id": 5, "error": {"code": -32000, "message": "no"}}))));
    assert!(!is_control(&message(json!({"method": "process/input", "params": {}}))));
}
