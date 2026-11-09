//! What a phone's connection receives from a feed before and after it opens the feed (the lanes of the Node relay web app are feeds here).
//! Recorded, not asserted: the matrix is printed as one JSON line that benchmarks/rust-core/recorders/record-phone-lifecycle.mjs stores and
//! apps/desktop/src/renderer/remote-shim-lifecycle.slow.test.mjs compares with Node's push lanes. Copy this file into
//! crates/mixdog-app-server/src/tests/ and add `mod lane_pushes;` to mod.rs to run it.

use std::sync::Arc;

use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::event;
use serde_json::json;
use serde_json::Value;

use super::Client;
use super::Rig;
use super::subscriptions::lanes;

/// One feed publishes at a time, so the frames each feed delivered are told apart.
fn record(steps: &mut Vec<Value>, phase: &str, feed: &str, client: &Client) {
    steps.push(json!({ "phase": phase, "feed": feed, "frames": lanes(&client.drain()) }));
}

#[tokio::test]
async fn record_what_a_phone_receives_before_and_after_it_opens_feeds() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    let lane_feed: Arc<dyn FeedSource> = thread.feed().clone();
    rig.core.hold_scoped("terminal:t1", lane_feed);
    let client = rig.ready(1, json!({}));
    let mut steps = Vec::new();
    let (mut app_seq, mut lane_seq) = (0u64, 0u64);
    let mut pushes = |phase: &str, steps: &mut Vec<Value>| {
        app_seq += 1;
        app.publish(&[event(app_seq)], None).unwrap();
        record(steps, phase, "app", &client);
        lane_seq += 1;
        thread.feed().publish(&[event(lane_seq)], None).unwrap();
        record(steps, phase, "lane", &client);
    };
    record(&mut steps, "connected", "none", &client);
    pushes("pushes-before-any-feed", &mut steps);
    client.request(1, "app/subscribe", json!({}));
    record(&mut steps, "app-feed-opened", "app", &client);
    pushes("pushes-with-app-feed-only", &mut steps);
    client.request(2, "feed/subscribe", json!({ "feedId": "terminal:t1" }));
    record(&mut steps, "lane-feed-opened", "lane", &client);
    pushes("pushes-with-lane-feed", &mut steps);
    println!("@@LANES@@{}", Value::Array(steps));
}