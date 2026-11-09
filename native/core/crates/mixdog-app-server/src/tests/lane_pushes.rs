//! What a phone's connection receives from a feed before and after it opens the feed. The lanes of the Node relay web app are feeds here: a
//! phone is sent a lane's pushes only once it has opened that lane's feed (`feed/subscribe`), and the app feed only after `app/subscribe`.
//!
//! The test asserts the matrix and prints it as one `@@LANES@@` JSON line, which benchmarks/rust-core/recorders/record-phone-lifecycle.mjs
//! stores (apps/mobile/fixtures/phone-lifecycle/lane-pushes.json) next to Node's push lanes for
//! apps/desktop/src/renderer/remote-shim-lifecycle.slow.test.mjs to compare.

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
fn record(steps: &mut Vec<Value>, phase: &str, feed: &str, client: &Client) -> Vec<String> {
    let frames = lanes(&client.drain());
    steps.push(json!({ "phase": phase, "feed": feed, "frames": frames }));
    frames
}

#[tokio::test]
async fn a_connection_hears_a_feed_only_after_it_opens_it() {
    let rig = Rig::new();
    let app = rig.core.mock.app();
    let thread = rig.core.mock.directory().insert(ThreadId::from("t1"));
    let lane_feed: Arc<dyn FeedSource> = thread.feed().clone();
    rig.core.hold_scoped("terminal:t1", lane_feed);
    let client = rig.ready(1, json!({}));
    let mut steps = Vec::new();
    let (mut app_seq, mut lane_seq) = (0u64, 0u64);
    // Returns the frames the app feed and the lane feed delivered for one publish each.
    let mut pushes = |phase: &str, steps: &mut Vec<Value>| {
        app_seq += 1;
        app.publish(&[event(app_seq)], None).unwrap();
        let from_app = record(steps, phase, "app", &client);
        lane_seq += 1;
        thread.feed().publish(&[event(lane_seq)], None).unwrap();
        (from_app, record(steps, phase, "lane", &client))
    };
    assert!(record(&mut steps, "connected", "none", &client).is_empty());
    assert_eq!(pushes("pushes-before-any-feed", &mut steps), (vec![], vec![]));
    client.request(1, "app/subscribe", json!({}));
    assert_eq!(record(&mut steps, "app-feed-opened", "app", &client), ["response", "snapshot@1"]);
    assert_eq!(pushes("pushes-with-app-feed-only", &mut steps), (vec!["evt@2".to_string()], vec![]));
    client.request(2, "feed/subscribe", json!({ "feedId": "terminal:t1" }));
    assert_eq!(record(&mut steps, "lane-feed-opened", "lane", &client), ["response", "snapshot@2"]);
    assert_eq!(pushes("pushes-with-lane-feed", &mut steps), (vec!["evt@3".to_string()], vec!["evt@3".to_string()]));
    println!("@@LANES@@{}", Value::Array(steps));
}