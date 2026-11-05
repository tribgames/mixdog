//! Routing by exact method name: requests and notifications reach the service that claims the
//! method, whatever its namespace; a method nobody claims is `capabilityUnavailable`.

use serde_json::json;

use super::Inbound;
use super::Rig;
use super::reason;
use super::sample::Samples;
use super::settle;

#[tokio::test]
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

#[tokio::test]
async fn an_unclaimed_method_is_capability_unavailable_naming_the_method() {
    let rig = Rig::routed(&["config/read"], Vec::new());
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();

    client.request(1, "config/getNetworkProxy", samples.params("config/getNetworkProxy"));
    let refused = client.response(1).await;
    assert_eq!(reason(&refused), "capabilityUnavailable");
    assert_eq!(refused["error"]["data"]["capability"], "config/getNetworkProxy");
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
