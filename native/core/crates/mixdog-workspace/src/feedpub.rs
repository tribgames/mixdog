//! The producer side of this domain's scoped feeds (`fs:<watchId>`,
//! `search:<sessionId>`): encodes notification frames with their `feed`
//! stamp, keeps the read model the `feed/snapshot` frame is built from, and
//! publishes under one lock so seq stays contiguous.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedId;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde_json::Value;
use serde_json::json;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The read model of one scoped feed, replaced by the producer on every publish.
struct Model {
    id: FeedId,
    state: Mutex<Value>,
}

impl FeedView for Model {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
        let state = self.state.lock().expect("feed model").clone();
        let frame = json!({
            "method": "feed/snapshot",
            "params": { "feedId": self.id, "state": state },
            "emittedAtMs": now_ms(),
            "feed": { "id": self.id, "epoch": at.epoch, "seq": at.seq },
        });
        Bytes::from(serde_json::to_vec(&frame).expect("snapshot frame"))
    }
}

/// One scoped feed and its single producer.
pub struct Publisher {
    feed: Arc<dyn ScopedFeed>,
    model: Arc<Model>,
    // Serializes the producers of one feed: contiguous seq.
    lock: Mutex<()>,
}

impl Publisher {
    pub fn create(feeds: &dyn ScopedFeeds, id: &str, initial_state: Value) -> Self {
        let id = FeedId::from(id);
        let model = Arc::new(Model { id: id.clone(), state: Mutex::new(initial_state) });
        let feed = feeds.create(id, model.clone());
        Self { feed, model, lock: Mutex::new(()) }
    }

    /// [`Self::create`] for a feed of the ordered class: `fs:<watchId>` (Node's `folderChanged`,
    /// `remote-relay-push-lanes.ts:169-170`) and `lsp:<root>` (`:171-174`) are never dropped.
    pub fn create_ordered(feeds: &dyn ScopedFeeds, id: &str, initial_state: Value) -> Self {
        let id = FeedId::from(id);
        let model = Arc::new(Model { id: id.clone(), state: Mutex::new(initial_state) });
        let feed = feeds.create_ordered(id, model.clone());
        Self { feed, model, lock: Mutex::new(()) }
    }

    pub fn source(&self) -> Arc<dyn FeedSource> {
        self.feed.clone()
    }

    /// Publishes one notification and, if given, the read model after it.
    pub fn publish(&self, method: &str, params: Value, state: Option<Value>) {
        let _producer = self.lock.lock().expect("feed producer");
        if let Some(state) = state {
            *self.model.state.lock().expect("feed model") = state;
        }
        let at = self.feed.position();
        let seq = at.seq + 1;
        let frame = json!({
            "method": method,
            "params": params,
            "emittedAtMs": now_ms(),
            "feed": { "id": self.model.id, "epoch": at.epoch, "seq": seq },
        });
        let bytes = Bytes::from(serde_json::to_vec(&frame).expect("feed frame"));
        // A seq gap cannot occur under the producer lock.
        let _ = self.feed.publish(&[FeedFrame { seq, bytes }], Some(self.model.clone()));
    }

    /// The last published position.
    pub fn position(&self) -> FeedPosition {
        self.feed.position()
    }

    /// The current read model (what a snapshot frame carries).
    pub fn state(&self) -> Value {
        self.model.state.lock().expect("feed model").clone()
    }

    /// Ends the feed with its scope (unwatch, stop, connection close).
    pub fn close(&self) {
        self.feed.close();
    }
}
