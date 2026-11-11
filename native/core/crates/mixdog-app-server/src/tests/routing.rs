//! Routing by exact method name: requests and notifications reach the service that claims the
//! method, whatever its namespace; a method nobody claims is `capabilityUnavailable`.

use mixdog_app_protocol::free_text::FREE_TEXT;
use mixdog_app_protocol::free_text::Kind;
use serde_json::json;

use super::Inbound;
use super::Rig;
use super::reason;
use super::sample::Samples;
use super::settle;

#[tokio::test(start_paused = true)]
async fn a_request_goes_to_the_service_that_claims_its_exact_method() {
    // Two services share the `config` namespace.
    let rig = Rig::routed(&["config/read"], vec![("update", &["config/getUpdateSettings"])]);
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();

    client.request(1, "config/read", samples.params("config/read"));
    let read = client.response(1).await;
    assert_eq!(read["result"]["method"], "config/read");

    client.request(2, "config/getUpdateSettings", samples.params("config/getUpdateSettings"));
    settle().await;
    let gate = rig.gate("update");
    assert_eq!(gate.log(), ["start config/getUpdateSettings:"]);
    gate.permits.add_permits(1);
    let reply = client.response(2).await;
    assert_eq!(reply["result"]["done"], "config/getUpdateSettings:");
}

#[tokio::test(start_paused = true)]
async fn an_unclaimed_method_is_capability_unavailable_naming_the_method() {
    let rig = Rig::routed(&["config/read"], Vec::new());
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();

    client.request(1, "config/getNetworkProxy", samples.params("config/getNetworkProxy"));
    let refused = client.response(1).await;
    assert_eq!(reason(&refused), "capabilityUnavailable");
    assert_eq!(refused["error"]["data"]["capability"], "config/getNetworkProxy");
}

/// A notification holding a lone surrogate outside its free-text fields is dropped before its service (a `modelProxy/cancel`
/// whose `runId` held one cancels nothing, not even a run whose id holds a real U+FFFD); terminal input, free text, reaches
/// its service with U+FFFD.
#[tokio::test]
async fn a_notification_holding_a_lone_surrogate_outside_free_text_is_dropped() {
    let rig = Rig::routed(&["modelProxy/cancel", "ui/screenSessions/changed", "terminal/input"], Vec::new());
    let client = rig.ready(1, json!({}));
    client.send_text(r#"{"method":"modelProxy/cancel","params":{"runId":"r\ud800"}}"#);
    client.send_text(r#"{"method":"ui/screenSessions/changed","params":{"sessionIds":["a","b\ud800"]}}"#);
    client.send_text(r#"{"method":"terminal/input","params":{"tabId":"t","data":"k\ud800"}}"#);
    client.send_text(r#"{"method":"terminal/input","params":{"tabId":"t\udc00","data":"k"}}"#);
    client.send_text(r#"{"method":"modelProxy/cancel","params":{"runId":"r\ufffd"}}"#);
    let recorded: Vec<(String, serde_json::Value)> =
        rig.core.mock.mock_domain().notifications().into_iter().map(|(method, params, _)| (method.as_str().to_owned(), params)).collect();
    assert_eq!(
        recorded,
        [
            ("terminal/input".to_owned(), json!({ "tabId": "t", "data": "k\u{fffd}" })),
            ("modelProxy/cancel".to_owned(), json!({ "runId": "r\u{fffd}" })),
        ]
    );
}

/// Every free-text field of a notification ([`FREE_TEXT`]): a lone surrogate in it reaches the service as U+FFFD, the
/// params whole as with a real U+FFFD there.
#[tokio::test]
async fn every_free_text_field_of_a_notification_reaches_its_service_as_u_fffd() {
    const MARK: &str = "lone-surrogate-mark";
    let listed: Vec<(&'static str, &'static str)> = FREE_TEXT
        .iter()
        .filter(|(kind, ..)| *kind == Kind::Notification)
        .flat_map(|(_, method, patterns)| patterns.iter().map(move |pattern| (*method, *pattern)))
        .collect();
    let mut methods: Vec<&'static str> = listed.iter().map(|(method, _)| *method).collect();
    methods.dedup();
    let rig = Rig::routed(Box::leak(methods.into_boxed_slice()), Vec::new());
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();
    for (method, pattern) in &listed {
        let frame = json!({ "method": method, "params": samples.untyped_with_text(pattern, MARK) })
            .to_string()
            .replace(&format!("\"{MARK}\""), r#""a\ud800""#);
        client.send_text(&frame);
    }
    let recorded: Vec<(String, serde_json::Value)> =
        rig.core.mock.mock_domain().notifications().into_iter().map(|(method, params, _)| (method.as_str().to_owned(), params)).collect();
    let expected: Vec<(String, serde_json::Value)> =
        listed.iter().map(|(method, pattern)| ((*method).to_owned(), samples.untyped_with_text(pattern, "a\u{fffd}"))).collect();
    assert_eq!(recorded, expected);
}

#[tokio::test]
async fn a_notification_routes_by_exact_method_like_a_request() {
    let rig = Rig::routed(&["client/activity"], Vec::new());
    let client = rig.ready(1, json!({}));

    assert!(matches!(
        client.send(json!({ "method": "client/activity", "params": { "at": 5 } })),
        Inbound::Continue
    ));
    // `client/perfLog` is in the table but nobody claims it: dropped, there is no reply to carry
    // a refusal.
    assert!(matches!(
        client.send(json!({ "method": "client/perfLog", "params": { "line": "x" } })),
        Inbound::Continue
    ));
    let recorded = rig.core.mock.mock_domain().notifications();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0.as_str(), "client/activity");
}
