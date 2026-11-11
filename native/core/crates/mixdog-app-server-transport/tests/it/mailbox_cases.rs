//! The recorded cases of `native/core/fixtures/remote-streaming-mailbox-cases` (Node's phone mailbox on a virtual clock) through
//! the real connection writer of a `feedRanges` phone: each publication Node's mailbox was given is the thread feed frame the core
//! sends for it (a proved text append, `isStreamingTextAppend`, is an `item/agentMessage/delta` of the painted text's growth; any
//! other publication a frame that is no append, carrying the state), on tokio's paused clock. After each step: the time, whether a
//! window is pending and how many frames left; at the end every frame: whether it was critical and the text the phone holds after it.
//! Not replayed here, pending a decision (blocker.md #9): back-pressure's collapse (case 3) and a critical publication that
//! carries the held appends in Node's snapshot (case 2: the feed writes them as their own frame first).

use crate::common;

use std::sync::Arc;

use bytes::Bytes;
use common::Peer;
use common::Wire;
use common::connect;
use common::install_rt;
use common::mock_limits;
use common::small_limits;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::stream_mailbox::BATCH_MS;
use mixdog_app_server_transport::stream_mailbox::is_streaming_text_append;
use mixdog_app_server_transport::stream_mailbox::painted_text;
use mixdog_core_api::Feed;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::EchoView;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::sink::ConnectionSink;
use serde_json::Value;
use serde_json::json;
use tokio::time::Duration;
use tokio::time::Instant;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/remote-streaming-mailbox-cases/golden.json");
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("golden.json")
}

fn case(name: &str) -> Value {
    golden()["cases"].as_array().expect("cases").iter().find(|c| c["case"] == name).unwrap_or_else(|| panic!("no case {name:?}"))["observed"].clone()
}

async fn settle() {
    for _ in 0..40 {
        tokio::task::yield_now().await;
    }
}

/// A frame the phone got: whether it was critical (no append) and the text the phone holds after it.
#[derive(Debug, PartialEq)]
struct Got {
    critical: bool,
    text: String,
}

struct Phone {
    peer: Peer,
    feed: Arc<MockFeed>,
    seq: u64,
    previous: Option<Value>,
    shown: String,
    got: Vec<Got>,
    sent_at: Vec<u64>,
    start: Instant,
}

impl Phone {
    async fn new() -> Self {
        install_rt();
        let limits = small_limits();
        let hub = ConnectionHub::new(limits.clone()).unwrap();
        let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
        peer.connection.sink.coalesce_appends();
        let feed = Arc::new(MockFeed::new(FeedId::from("thread:t"), epoch(9), Arc::new(EchoView), mock_limits(&limits)));
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = subscribe(&source, SubscriptionId::from("p"), Window::Fixed, None, &peer.connection.sink).expect("open connection");
        peer.connection.sink.send_control_release(Bytes::from_static(b"resp"), attached.release).expect("connection open");
        settle().await;
        // The response and the subscription's snapshot are the connection's, not the cases'.
        while peer.wire.try_recv().is_ok() {}
        Self { peer, feed, seq: 0, previous: None, shown: String::new(), got: Vec::new(), sent_at: Vec::new(), start: Instant::now() }
    }

    fn now(&self) -> u64 {
        (Instant::now() - self.start).as_millis() as u64
    }

    /// The thread feed frame the core sends for one of Node's publications.
    fn publish(&mut self, update: &Value) {
        self.seq += 1;
        let at = json!({ "id": "thread:t", "epoch": epoch(9), "seq": self.seq });
        let frame = if is_streaming_text_append(self.previous.as_ref(), update) {
            let before = self.previous.as_ref().and_then(painted_text).unwrap_or_default();
            let after = painted_text(update).expect("an append paints text");
            let item = update["snapshot"]["streamingTail"]["id"].clone();
            let item = if item.is_null() { update["snapshot"]["streamingPartial"]["id"].clone() } else { item };
            json!({ "method": "item/agentMessage/delta", "params": { "threadId": "t", "turnId": "u", "itemId": item, "delta": &after[before.len()..] }, "feed": at })
        } else {
            json!({ "method": "thread/runtime/updated", "params": { "threadId": "t", "value": update }, "feed": at })
        };
        self.previous = Some(update.clone());
        self.feed.publish(&[FeedFrame { seq: self.seq, bytes: Bytes::from(frame.to_string()) }], Some(Arc::new(EchoView) as Arc<dyn FeedView>)).expect("contiguous frames");
    }

    /// The frames the socket took so far, folded into the text the phone holds.
    fn take(&mut self) {
        while let Ok(wire) = self.peer.wire.try_recv() {
            let Wire::Text(text) = wire else { panic!("expected text, got {wire:?}") };
            let frame: Value = serde_json::from_str(&text).expect("a JSON frame");
            let critical = frame["method"] != "item/agentMessage/delta";
            if critical {
                self.shown = painted_text(&frame["params"]["value"]).unwrap_or_default();
            } else {
                self.shown.push_str(frame["params"]["delta"].as_str().expect("a delta"));
            }
            self.got.push(Got { critical, text: self.shown.clone() });
            self.sent_at.push(self.now());
        }
    }

    async fn advance(&mut self, ms: u64) {
        tokio::time::advance(Duration::from_millis(ms)).await;
        settle().await;
        self.take();
    }

    fn observed(&self, step: &Value) -> Value {
        json!({ "step": step["step"], "atMs": self.now(), "pendingTimers": u64::from(self.peer.connection.sink.appends_window_open()), "frameCount": self.got.len() })
    }
}

async fn replay(name: &str) {
    let recorded = case(name);
    let mut phone = Phone::new().await;
    for step in recorded["steps"].as_array().expect("steps") {
        let label = step["step"].as_str().expect("step");
        if label.starts_with("publish ") {
            phone.publish(&step["published"]);
            settle().await;
            phone.take();
        } else if let Some(ms) = label.strip_prefix("advance ") {
            phone.advance(ms.parse().expect("advance ms")).await;
        } else {
            panic!("a step this replay does not take: {label}");
        }
        let mut want = step.clone();
        want.as_object_mut().expect("step").remove("published");
        assert_eq!(phone.observed(step), want, "{name}: after {}", step["step"]);
    }
    let want: Vec<Got> = recorded["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .map(|frame| Got { critical: frame["critical"] == true, text: painted_text(&frame["value"]).unwrap_or_default() })
        .collect();
    assert_eq!(phone.got, want, "{name}: the frames");
}

#[tokio::test(start_paused = true)]
async fn a_text_burst_sends_its_first_append_at_once_then_one_frame_per_window() {
    assert_eq!(case("a text burst sends its first append at once, then one latest snapshot per batch window")["batchMs"], json!(BATCH_MS));
    replay("a text burst sends its first append at once, then one latest snapshot per batch window").await;
}

#[tokio::test(start_paused = true)]
async fn partial_line_growth_is_one_append_and_another_rows_partial_is_not() {
    replay("partial-line growth batches as a text append; a partial for another row does not").await;
}

/// The recorder's burst: 100 publications 4 ms apart. When each packet left and how many, and the whole text at the end. The
/// packets' bytes are an encoding difference (MANIFEST `differences`): Node's compact relay wire against K1's JSON-RPC frame.
#[tokio::test(start_paused = true)]
async fn a_burst_leaves_one_packet_per_window_and_the_phone_ends_with_the_whole_text() {
    let recorded = case("batching reduces real compact packet bytes while preserving decoder state");
    let update = |text: &str| json!({ "sessionId": "s", "frameSource": "live", "snapshot": { "busy": true, "items": [{ "id": "user", "kind": "user", "text": "input" }], "streamingTail": { "id": "tail", "kind": "assistant", "text": text } } });
    let mut phone = Phone::new().await;
    phone.publish(&update(""));
    settle().await;
    phone.take();
    let mut text = String::new();
    for _ in 0..100 {
        text.push_str("응답 ");
        phone.publish(&update(&text));
        settle().await;
        phone.take();
        phone.advance(4).await;
    }
    phone.advance(BATCH_MS).await;
    let recorded_at: Vec<Value> = recorded["sent"].as_array().expect("sent").iter().map(|s| s["atMs"].clone()).collect();
    assert_eq!(phone.sent_at.iter().map(|&ms| json!(ms)).collect::<Vec<_>>(), recorded_at, "when each packet left");
    assert_eq!(json!(phone.got.len()), recorded["packets"], "packets");
    assert_eq!(json!(text), recorded["text"]);
    assert_eq!(phone.got.last().map(|got| got.text.clone()), painted_text(&json!({ "snapshot": recorded["received"] })), "the phone's last text");
}
