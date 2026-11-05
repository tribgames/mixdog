//! The host channel (DS §12): claim, requests to the claimant, loss of the claimant.

use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use serde_json::json;

use super::Rig;
use super::reason;

const RESOLVE: Method = Method("host/systemProxy/resolve");

fn unavailable(detail: &str) -> HostError {
    HostError::Core(CoreError::CapabilityUnavailable {
        capability: "desktopHost".into(),
        detail: detail.into(),
    })
}

async fn claimed(rig: &Rig, id: u64) -> super::Client {
    claimed_as(rig, id, "pc", json!({ "systemProxy": true, "notifications": true })).await
}

async fn claimed_as(
    rig: &Rig,
    id: u64,
    host_id: &str,
    declared: serde_json::Value,
) -> super::Client {
    let host = rig.ready(id, json!({ "host": declared }));
    host.request(1, "host/claim", json!({ "hostId": host_id }));
    assert_eq!(host.response(1).await["result"], json!({}));
    host
}

const BROWSER: Method = Method("host/browser/command");

#[tokio::test]
async fn only_a_connection_that_declared_the_host_role_can_claim() {
    let rig = Rig::new();
    let plain = rig.ready(1, json!({}));
    plain.request(1, "host/claim", json!({ "hostId": "pc" }));
    let refused = plain.response(1).await;
    assert_eq!(reason(&refused), "capabilityUnavailable");
}

#[tokio::test]
async fn a_host_request_is_answered_by_the_claimant() {
    let rig = Rig::new();
    let host = claimed(&rig, 1).await;
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing
            .request(HostCapability::SystemProxy, RESOLVE, json!({ "url": "https://example.com" }))
            .await
    });
    let request = host.frames(1).await.remove(0).body;
    assert_eq!(request["method"], json!("host/systemProxy/resolve"));
    assert_eq!(request["params"], json!({ "url": "https://example.com" }));
    host.send(json!({ "id": request["id"], "result": { "rules": "DIRECT" } }));
    assert_eq!(call.await.unwrap(), Ok(json!({ "rules": "DIRECT" })));
}

#[tokio::test]
async fn a_failed_host_request_is_a_domain_error() {
    let rig = Rig::new();
    let host = claimed(&rig, 1).await;
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing
            .request(HostCapability::SystemProxy, RESOLVE, json!({ "url": "u" }))
            .await
    });
    let request = host.frames(1).await.remove(0).body;
    host.send(json!({ "id": request["id"], "error": { "code": -32603, "message": "no" } }));
    assert_eq!(
        call.await.unwrap(),
        Err(HostError::Rpc {
            code: -32603,
            message: "no".into(),
            data: None,
        })
    );
}

#[tokio::test]
async fn without_a_claimant_or_after_it_leaves_the_host_is_unavailable() {
    let rig = Rig::new();
    let params = json!({ "url": "u" });
    assert_eq!(
        rig.outgoing.request(HostCapability::SystemProxy, RESOLVE, params.clone()).await,
        Err(unavailable("noClaimant"))
    );

    let host = claimed(&rig, 1).await;
    let outgoing = rig.outgoing.clone();
    let waiting = {
        let params = params.clone();
        tokio::spawn(async move {
            outgoing.request(HostCapability::SystemProxy, RESOLVE, params).await
        })
    };
    host.frames(1).await;
    drop(host);
    assert_eq!(waiting.await.unwrap(), Err(unavailable("claimantClosed")));
    assert_eq!(
        rig.outgoing.request(HostCapability::SystemProxy, RESOLVE, params).await,
        Err(unavailable("noClaimant"))
    );
}

#[tokio::test]
async fn a_capability_the_claimant_did_not_declare_is_unavailable_at_once() {
    let rig = Rig::new();
    let _host = claimed(&rig, 1).await;
    assert_eq!(
        rig.outgoing.request(HostCapability::Browser, BROWSER, json!({})).await,
        Err(unavailable("noClaimant"))
    );
    assert_eq!(
        rig.outgoing.notify(HostCapability::Visualize, Method("host/x"), json!({})),
        Err(CoreError::CapabilityUnavailable {
            capability: "desktopHost".into(),
            detail: "noClaimant".into(),
        })
    );
}

#[tokio::test]
async fn the_latest_claim_of_a_capability_serves_it_and_an_earlier_one_takes_over_when_it_leaves() {
    let rig = Rig::new();
    let old = claimed_as(&rig, 1, "old", json!({ "browser": true })).await;
    let new = claimed_as(&rig, 2, "new", json!({ "browser": true, "visualize": true })).await;

    let outgoing = rig.outgoing.clone();
    let first = tokio::spawn(async move {
        outgoing.request(HostCapability::Browser, BROWSER, json!({ "n": 1 })).await
    });
    let request = new.frames(1).await.remove(0).body;
    assert!(old.drain().is_empty(), "only the latest claimant is asked");
    new.send(json!({ "id": request["id"], "result": "new" }));
    assert_eq!(first.await.unwrap(), Ok(json!("new")));

    drop(new);
    let outgoing = rig.outgoing.clone();
    let second = tokio::spawn(async move {
        outgoing.request(HostCapability::Browser, BROWSER, json!({ "n": 2 })).await
    });
    let request = old.frames(1).await.remove(0).body;
    old.send(json!({ "id": request["id"], "result": "old" }));
    assert_eq!(second.await.unwrap(), Ok(json!("old")));
}

#[tokio::test]
async fn each_capability_goes_to_the_latest_claimant_that_declared_it() {
    let rig = Rig::new();
    let both = claimed_as(&rig, 1, "a", json!({ "browser": true, "visualize": true })).await;
    let browser_only = claimed_as(&rig, 2, "b", json!({ "browser": true })).await;

    let outgoing = rig.outgoing.clone();
    let viz = tokio::spawn(async move {
        outgoing
            .request(HostCapability::Visualize, Method("host/visualize/command"), json!({}))
            .await
    });
    let request = both.frames(1).await.remove(0).body;
    assert!(browser_only.drain().is_empty(), "a later claimant without the capability is skipped");
    both.send(json!({ "id": request["id"], "result": "viz" }));
    assert_eq!(viz.await.unwrap(), Ok(json!("viz")));

    let outgoing = rig.outgoing.clone();
    let browser = tokio::spawn(async move {
        outgoing.request(HostCapability::Browser, BROWSER, json!({})).await
    });
    let request = browser_only.frames(1).await.remove(0).body;
    assert!(both.drain().is_empty());
    browser_only.send(json!({ "id": request["id"], "result": "br" }));
    assert_eq!(browser.await.unwrap(), Ok(json!("br")));
}

#[tokio::test]
async fn a_reclaimed_host_id_replaces_its_stale_connection() {
    let rig = Rig::new();
    let stale = claimed_as(&rig, 1, "pc", json!({ "browser": true })).await;
    let fresh = claimed_as(&rig, 2, "pc", json!({ "browser": true })).await;
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing.request(HostCapability::Browser, BROWSER, json!({})).await
    });
    let request = fresh.frames(1).await.remove(0).body;
    fresh.send(json!({ "id": request["id"], "result": 1 }));
    assert_eq!(call.await.unwrap(), Ok(json!(1)));
    assert!(stale.drain().is_empty());
}

#[tokio::test]
async fn a_host_notification_goes_to_the_claimant() {
    let rig = Rig::new();
    let host = claimed(&rig, 1).await;
    rig.outgoing
        .notify(
            HostCapability::Notifications,
            Method("host/notification/show"),
            json!({ "title": "t", "body": "b" }),
        )
        .unwrap();
    let frames = host.drain();
    assert_eq!(frames[0].body["method"], json!("host/notification/show"));
    assert!(frames[0].body.get("id").is_none());
}
