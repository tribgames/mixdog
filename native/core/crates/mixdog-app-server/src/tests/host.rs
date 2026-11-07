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
async fn a_claim_that_runs_after_its_connection_closed_is_not_recorded() {
    use mixdog_core_api::ids::{ConnectionId, HostId};
    let rig = Rig::new();
    let host = rig.ready(1, json!({ "host": { "browser": true } }));
    let conn = rig.outgoing.connection(ConnectionId(1)).unwrap();
    rig.outgoing.unregister(&conn);
    rig.outgoing.claim(HostId::from("pc"), &conn);
    assert_eq!(
        rig.outgoing.request(HostCapability::Browser, BROWSER, json!({})).await,
        Err(unavailable("noClaimant"))
    );
    drop(host);
}

#[tokio::test(start_paused = true)]
async fn only_a_connection_that_declared_the_host_role_can_claim() {
    let rig = Rig::new();
    let plain = rig.ready(1, json!({}));
    plain.request(1, "host/claim", json!({ "hostId": "pc" }));
    let refused = plain.response(1).await;
    assert_eq!(reason(&refused), "capabilityUnavailable");
}

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
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

#[tokio::test(start_paused = true)]
async fn only_a_desktop_live_on_the_app_feed_is_a_window() {
    use mixdog_core_api::DesktopPresence;
    let rig = Rig::new();
    assert!(!rig.outgoing.desktop_attached(), "nobody connected");

    // A phone subscribed to the app feed is not a window.
    let phone = rig.ready_as(1, "Pixel", "phone");
    phone.request(1, "app/subscribe", json!({}));
    phone.response(1).await;
    let remote = rig.ready_as(2, "Away", "remoteDesktop");
    remote.request(1, "app/subscribe", json!({}));
    remote.response(1).await;
    assert!(!rig.outgoing.desktop_attached(), "phones and remote desktops never count");

    // A desktop that has not subscribed yet cannot take the request either.
    let desktop = rig.ready_as(3, "PC", "desktop");
    assert!(!rig.outgoing.desktop_attached());
    desktop.request(1, "app/subscribe", json!({}));
    desktop.response(1).await;
    assert!(rig.outgoing.desktop_attached());
}

const EXECUTE: Method = Method("model/proxy/execute");

#[tokio::test(start_paused = true)]
async fn a_model_proxy_serves_from_initialize_and_streams_its_events_ahead_of_the_answer() {
    use mixdog_core_api::ids::ConnectionId;
    let rig = Rig::new();
    let pc = rig.ready(1, json!({ "modelProxy": true }));
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        let mut seen = Vec::new();
        let result = outgoing
            .request_streamed(HostCapability::ModelProxy, EXECUTE, json!({ "call": 1 }), &mut |e| seen.push(e))
            .await;
        (result, seen)
    });
    let request = pc.frames(1).await.remove(0).body;
    assert_eq!(request["method"], json!("model/proxy/execute"));
    for n in 0..3 {
        assert!(rig.outgoing.stream_event(ConnectionId(1), &request["id"], json!({ "n": n })));
    }
    pc.send(json!({ "id": request["id"], "result": "done" }));
    let (result, seen) = call.await.unwrap();
    assert_eq!(result, Ok(json!("done")));
    assert_eq!(seen, vec![json!({ "n": 0 }), json!({ "n": 1 }), json!({ "n": 2 })]);
    // The request is over: a late event is refused, and so is one from another connection.
    assert!(!rig.outgoing.stream_event(ConnectionId(1), &request["id"], json!({})));
    assert!(!rig.outgoing.stream_event(ConnectionId(2), &request["id"], json!({})));
}

#[tokio::test(start_paused = true)]
async fn a_model_proxy_that_closes_mid_call_is_a_closed_claimant() {
    let rig = Rig::new();
    let pc = rig.ready(1, json!({ "modelProxy": true }));
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing
            .request_streamed(HostCapability::ModelProxy, EXECUTE, json!({}), &mut |_| {})
            .await
    });
    pc.frames(1).await;
    drop(pc);
    assert_eq!(call.await.unwrap(), Err(unavailable("claimantClosed")));
    assert_eq!(
        rig.outgoing.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({}), &mut |_| {}).await,
        Err(unavailable("noClaimant"))
    );
}

#[tokio::test(start_paused = true)]
async fn only_a_connection_that_declared_model_proxy_serves_it() {
    let rig = Rig::new();
    let _host = claimed(&rig, 1).await;
    assert_eq!(
        rig.outgoing.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({}), &mut |_| {}).await,
        Err(unavailable("noClaimant"))
    );
}

#[tokio::test]
async fn a_notification_reaches_its_connection_by_id() {
    use mixdog_core_api::ConnectionNotifier;
    use mixdog_core_api::ids::ConnectionId;
    let rig = Rig::new();
    let pc = rig.ready(1, json!({}));
    ConnectionNotifier::notify(rig.outgoing.as_ref(), ConnectionId(1), Method("modelProxy/run/event"), json!({ "runId": "r" })).unwrap();
    assert_eq!(pc.drain()[0].body["method"], json!("modelProxy/run/event"));
    assert_eq!(
        ConnectionNotifier::notify(rig.outgoing.as_ref(), ConnectionId(9), Method("x"), json!({})),
        Err(CoreError::ConnectionClosed)
    );
}

#[tokio::test(start_paused = true)]
async fn a_model_proxy_call_given_up_is_cancelled_on_the_connection_and_an_answered_one_is_not() {
    let rig = Rig::new();
    let pc = rig.ready(1, json!({ "modelProxy": true }));
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({}), &mut |_| {}).await
    });
    let request = pc.frames(1).await.remove(0).body;
    call.abort();
    let _ = call.await;
    let cancel = pc.frames(1).await.remove(0).body;
    assert_eq!(cancel["method"], json!("model/proxy/cancel"));
    assert_eq!(cancel["params"], json!({ "requestId": request["id"] }));

    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move {
        outgoing.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({}), &mut |_| {}).await
    });
    let request = pc.frames(1).await.remove(0).body;
    pc.send(json!({ "id": request["id"], "result": 1 }));
    assert_eq!(call.await.unwrap(), Ok(json!(1)));
    assert!(pc.drain().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_caller_releases_a_host_request_the_claimant_never_answers() {
    let rig = Rig::new();
    let host = claimed(&rig, 1).await;
    let cancel = mixdog_rt::CancellationToken::new();
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn({
        let cancel = cancel.clone();
        async move { outgoing.request_scoped(HostCapability::SystemProxy, RESOLVE, json!({ "url": "u" }), &cancel).await }
    });
    host.frames(1).await;
    cancel.cancel();
    assert_eq!(call.await.unwrap(), Err(unavailable("cancelled")));
}

#[tokio::test(start_paused = true)]
async fn a_host_request_the_claimant_never_answers_ends_at_its_capability_deadline() {
    let rig = Rig::new();
    let host = claimed(&rig, 1).await;
    let outgoing = rig.outgoing.clone();
    let call = tokio::spawn(async move { outgoing.request(HostCapability::SystemProxy, RESOLVE, json!({ "url": "u" })).await });
    host.frames(1).await;
    assert!(!call.is_finished(), "still inside its deadline");
    let limit = HostCapability::SystemProxy.deadline().expect("Node bounds the system proxy read");
    tokio::time::advance(limit + std::time::Duration::from_secs(1)).await;
    assert_eq!(call.await.unwrap(), Err(unavailable("timedOut")));
}