//! The initialize latch, the version gate and the frame rules (P §3, §4.2, §4.4; §14.3).

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::Origin;
use serde_json::json;

use super::Rig;
use super::VERSION;
use super::reason;
use super::settle;
use crate::Inbound;

#[tokio::test(start_paused = true)]
async fn a_request_before_initialize_is_not_initialized() {
    let rig = Rig::new();
    let client = rig.connect(1, Origin::Local);
    assert!(matches!(
        client.request(1, "thread/list", json!({})),
        Inbound::Continue
    ));
    let response = client.response(1).await;
    assert_eq!(reason(&response), "notInitialized");
    assert_eq!(response["error"]["code"], json!(-32600));
}

#[tokio::test(start_paused = true)]
async fn initialize_reports_the_core_and_latches() {
    let rig = Rig::new();
    let client = rig.connect(1, Origin::Ssh);
    assert!(matches!(
        client.initialize(VERSION, json!({})),
        Inbound::Continue
    ));
    let response = client.response(0).await;
    let result = &response["result"];
    assert_eq!(result["serverVersion"], json!(VERSION));
    assert_eq!(result["serverInstanceId"], json!("instance-1"));
    assert_eq!(result["coreState"], json!({ "state": "serving" }));
    assert_eq!(result["connection"]["origin"], json!("ssh"));
    assert_eq!(result["limits"]["inflight"]["c2"], json!(8));

    client.initialize(VERSION, json!({}));
    let again = client.response(0).await;
    assert_eq!(reason(&again), "alreadyInitialized");
}

#[tokio::test(start_paused = true)]
async fn initialized_changes_nothing() {
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    assert!(matches!(
        client.send(json!({ "method": "initialized" })),
        Inbound::Continue
    ));
    settle().await;
    assert!(client.drain().is_empty());
    client.request(1, "thread/list", json!({}));
    assert!(client.response(1).await.get("result").is_some());
}

#[tokio::test(start_paused = true)]
async fn a_version_mismatch_is_refused_and_closes_with_4002() {
    for (version, expected) in [("1.4.5", "clientOutdated"), ("1.5.0", "serverOutdated")] {
        let rig = Rig::new();
        let client = rig.connect(1, Origin::Local);
        let Inbound::Close(code) = client.initialize(version, json!({})) else {
            panic!("a refusal ends the connection");
        };
        assert_eq!(code, CloseCode::VersionRefused);
        assert_eq!(code.code(), 4002);
        let response = client.response(0).await;
        assert_eq!(reason(&response), expected);
        assert_eq!(response["error"]["code"], json!(-32600));
        assert_eq!(
            response["error"]["data"],
            json!({ "reason": expected, "serverVersion": VERSION, "clientVersion": version })
        );
        // The refused connection never initialized.
        client.request(1, "thread/list", json!({}));
        assert_eq!(reason(&client.response(1).await), "notInitialized");
    }
}

#[tokio::test(start_paused = true)]
async fn unknown_methods_and_bad_params_are_typed_errors() {
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    client.request(1, "nope/never", json!({}));
    let unknown = client.response(1).await;
    assert_eq!(unknown["error"]["code"], json!(-32601));
    assert_eq!(unknown["error"]["data"]["method"], json!("nope/never"));

    client.request(2, "thread/read", json!({}));
    let bad = client.response(2).await;
    assert_eq!(bad["error"]["code"], json!(-32602));
    assert_eq!(reason(&bad), "invalidParams");
}

#[tokio::test]
async fn bad_frames_end_the_connection() {
    let rig = Rig::new();
    let client = rig.ready(1, json!({}));
    assert!(matches!(
        client.handle.on_text("this is not json"),
        Inbound::Close(CloseCode::InvalidFrame)
    ));
    let huge = format!(
        "{{\"id\":1,\"method\":\"thread/list\",\"params\":{{\"pad\":\"{}\"}}}}",
        "x".repeat(300 * 1024)
    );
    assert!(matches!(
        client.handle.on_text(&huge),
        Inbound::Close(CloseCode::FrameTooBig)
    ));
}

#[tokio::test(start_paused = true)]
async fn binary_frames_need_the_host_media_role() {
    let rig = Rig::new();
    let plain = rig.ready(1, json!({}));
    assert_eq!(
        plain.handle.on_binary(Bytes::from_static(b"frame")),
        Err(CloseCode::UnsupportedData)
    );
    let host = rig.ready(2, json!({ "host": { "media": true } }));
    assert_eq!(host.handle.on_binary(Bytes::from_static(b"frame")), Ok(()));
    let frames = rig.core.mock.media().frames();
    assert_eq!(frames, vec![(ConnectionId(2), Bytes::from_static(b"frame"))]);
    let _: &dyn HostMediaSink = rig.core.mock.media();
}

#[tokio::test]
async fn opt_out_is_exposed_to_the_transport() {
    let rig = Rig::new();
    let client = rig.ready(
        1,
        json!({ "optOutNotificationMethods": ["thread/tokenUsage/updated"] }),
    );
    assert!(client.handle.opted_out("thread/tokenUsage/updated"));
    assert!(!client.handle.opted_out("thread/started"));
}
