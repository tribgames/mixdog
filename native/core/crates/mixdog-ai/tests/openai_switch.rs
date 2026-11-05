//! When a WebSocket exchange moves to HTTP/SSE, against Node's own predicates
//! run on the same failures (`oracles/openai-transport-switch-golden.json`):
//! the oauth dispatch (`shouldUseHttpFallback`), the direct provider's send,
//! and the transport policy switch.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use mixdog_ai::providers::openai::config::Route;
use mixdog_ai::providers::openai::switch::TransportMode;
use mixdog_ai::providers::openai::switch::decide;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use serde_json::Value;

fn golden() -> Value {
    let path = format!("{}/../../fixtures/providers/oracles/openai-transport-switch-golden.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn error_of(case: &Value) -> ProviderError {
    let mut err = if let Some(code) = case["wsClose"].as_u64() {
        ProviderError::transport(TransportFault::WsClose { code: Some(code as u16) }, DeliveryState::Accepted)
    } else if let Some(fault) = case["fault"].as_str() {
        let fault = match fault {
            "reset" => TransportFault::Reset,
            "dns" => TransportFault::Dns,
            _ => TransportFault::Connect { os_code: None },
        };
        ProviderError::transport(fault, DeliveryState::Accepted)
    } else {
        ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted)
    };
    err.status = case["status"].as_u64().map(|s| s as u16);
    err.exposure.text_emitted = case["exposed"] == true;
    err
}

#[test]
fn the_decision_equals_node_s_for_both_routes() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let err = error_of(case);
        let handshake = case["handshake"] == true;
        // Node's oauth route names the exhausted budget; its direct route sees
        // only errors thrown after the send spent that budget.
        let oauth = decide(Route::Codex, &err, handshake, case["exhausted"] == true);
        assert_eq!(oauth.is_some(), case["oauth"] == true, "oauth: {name}");
        if let Some(fallback) = oauth {
            assert!(fallback.sticky, "oauth switches stay: {name}");
        }
        let direct = decide(Route::ApiKey, &err, handshake, true);
        assert_eq!(direct.is_some(), case["direct"] == true, "direct: {name}");
        if let Some(fallback) = direct {
            assert_eq!(fallback.sticky, case["directSticky"] == true, "direct sticky: {name}");
        }
    }
}

#[test]
fn the_transport_modes_equal_the_policy_switch() {
    let golden = golden();
    for (name, mode) in [("auto", TransportMode::Auto), ("ws-delta", TransportMode::WsDelta), ("ws-full", TransportMode::WsFull)] {
        let node = &golden["modes"][name];
        assert_eq!(node["transport"], "ws", "{name}");
        assert_eq!(mode.delta(), node["delta"] == true, "{name}: delta");
        assert_eq!(mode.http_fallback(), node["allowHttpFallback"] == true, "{name}: fallback");
    }
}
