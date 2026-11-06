//! Subscribing replies: the response goes first, then replay or snapshot, then live frames
//! (P §6.4); unsubscribe and close detach.

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::Subscribe;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::mock::event;
use serde_json::json;

use super::Rig;

fn app_epoch() -> String {
    epoch(1).to_string()
}

pub(crate) fn lanes(frames: &[super::Wire]) -> Vec<String> {
    frames
        .iter()
        .map(|wire| match (&wire.lane, wire.body.as_str()) {
            (Some(_), Some(text)) => text.to_owned(),
            (Some(_), None) => wire.body.to_string(),
            (None, _) => "response".to_owned(),
        })
        .collect()
}

#[tokio::test]
async fn app_subscribe_answers_first_then_snapshot_then_live_frames() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    app.publish(&[event(1), event(2)], None).unwrap();
    let client = rig.ready(1, json!({}));

    client.request(1, "app/subscribe", json!({}));
    app.publish(&[event(3)], None).unwrap();
    let frames = client.drain();
    assert_eq!(lanes(&frames), ["response", "snapshot@2", "evt@3"]);
    let subscription = &frames[0].body["result"]["subscription"];
    assert_eq!(subscription["mode"], json!("snapshot"));
    assert_eq!(subscription["epoch"], json!(app_epoch()));
    assert_eq!(subscription["startSeq"], json!(3));
    assert!(subscription["id"].is_string());
}

#[tokio::test]
async fn a_resume_position_in_the_ring_replays() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    app.publish(&[event(1), event(2), event(3)], None).unwrap();
    let client = rig.ready(1, json!({}));
    client.request(
        1,
        "app/subscribe",
        json!({ "resumeFrom": { "epoch": app_epoch(), "seq": 1 } }),
    );
    let frames = client.drain();
    assert_eq!(lanes(&frames), ["response", "evt@2", "evt@3"]);
    let subscription = &frames[0].body["result"]["subscription"];
    assert_eq!(subscription["mode"], json!("replay"));
    assert_eq!(subscription["startSeq"], json!(2));
}

#[tokio::test]
async fn thread_resume_adds_the_subscription_to_the_owners_result() {
    let rig = Rig::new();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    let feed: Arc<dyn FeedSource> = thread.feed().clone();
    thread.set_handler(Arc::new(move |_| {
        Ok(Reply::Subscribe(Subscribe {
            result: json!({ "thread": { "id": "t1" } }),
            feed: feed.clone(),
            window: Window::LastItems(10),
            resume_from: None,
        }))
    }));
    thread.feed().publish(&[event(1)], None).unwrap();
    let client = rig.ready(1, json!({}));

    client.request(
        1,
        "thread/resume",
        json!({ "threadId": "t1", "window": { "lastItems": 10 } }),
    );
    let frames = client.frames(2).await;
    assert_eq!(lanes(&frames), ["response", "snapshot@1"]);
    let response = &frames[0].body;
    assert_eq!(response["result"]["thread"], json!({ "id": "t1" }));
    assert_eq!(response["result"]["subscription"]["startSeq"], json!(2));

    thread.feed().publish(&[event(2)], None).unwrap();
    assert_eq!(lanes(&client.drain()), ["evt@2"]);

    // Unsubscribing ends delivery and never touches the thread's work.
    client.request(2, "thread/unsubscribe", json!({ "threadId": "t1" }));
    assert_eq!(client.response(2).await["result"], json!({}));
    thread.feed().publish(&[event(3)], None).unwrap();
    assert!(client.drain().is_empty());
}

#[tokio::test]
async fn subscribing_again_replaces_the_subscription_of_that_feed() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    let client = rig.ready(1, json!({}));
    client.request(1, "app/subscribe", json!({}));
    client.request(2, "app/subscribe", json!({}));
    client.drain();
    app.publish(&[event(1)], None).unwrap();
    assert_eq!(lanes(&client.drain()), ["evt@1"], "one lane, not two");

    client.request(3, "feed/unsubscribe", json!({ "feedId": "app" }));
    client.drain();
    app.publish(&[event(2)], None).unwrap();
    assert!(client.drain().is_empty());
}

#[tokio::test]
async fn closing_the_connection_detaches_its_subscriptions() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    let client = rig.ready(1, json!({}));
    client.request(1, "app/subscribe", json!({}));
    client.drain();
    let super::Client { handle, wire } = client;
    drop(handle);
    app.publish(&[event(1)], None).unwrap();
    assert!(wire.drain().is_empty());
}

#[tokio::test]
async fn a_failed_attach_is_an_error_response_and_registers_nothing() {
    let rig = Rig::new();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    thread.set_handler(Arc::new(|_| {
        Err(CoreError::ThreadClosing {
            thread_id: ThreadId::from("t1"),
        })
    }));
    let client = rig.ready(1, json!({}));
    client.request(
        1,
        "thread/resume",
        json!({ "threadId": "t1", "window": { "none": true } }),
    );
    assert_eq!(
        super::reason(&client.response(1).await),
        "threadClosing"
    );
}

#[tokio::test]
async fn a_scoped_feed_subscription_answers_first_then_receives_its_frames() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    rig.core.hold_scoped("login:flow1", mixdog_core_api::CoreHandle::app_feed(&rig.core.mock));
    let client = rig.ready(1, json!({}));

    client.request(1, "feed/subscribe", json!({ "feedId": "login:flow1" }));
    app.publish(&[event(1)], None).unwrap();
    let frames = client.drain();
    assert_eq!(lanes(&frames), ["response", "snapshot@0", "evt@1"]);
    assert!(frames[0].body["result"]["subscription"]["id"].is_string());

    // Unsubscribing names the feed's own id (the held feed is the mock's, whose id is `app`).
    client.request(2, "feed/unsubscribe", json!({ "feedId": "app" }));
    client.drain();
    app.publish(&[event(2)], None).unwrap();
    assert!(client.drain().is_empty());
}