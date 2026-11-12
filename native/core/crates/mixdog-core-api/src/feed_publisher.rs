//! The producer side of a scoped feed (`git:<root>`, `login:<flowId>`; DS §2.1): one producer per
//! feed publishes notification frames and keeps the read model its snapshot is built from.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use mixdog_app_protocol::rpc::FeedStamp;
use mixdog_app_protocol::rpc::JsonRpcNotification;
use mixdog_app_protocol::v2::feed::FeedSnapshotParams;
use mixdog_protocol::FeedId;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde_json::Value;
use serde_json::json;

use crate::feed::FeedFrame;
use crate::feed::FeedPosition;
use crate::feed::FeedSource;
use crate::feed::FeedView;
use crate::feed::ScopedFeed;
use crate::feed::ScopedFeeds;
use crate::feed::Window;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn encode(method: &str, params: Value, stamp: FeedStamp) -> Bytes {
    let note = JsonRpcNotification {
        method: method.to_owned(),
        params: Some(params),
        emitted_at_ms: Some(now_ms()),
        feed: Some(stamp),
        lone_surrogates: Vec::new(),
    };
    Bytes::from(serde_json::to_vec(&note).expect("a notification serializes"))
}

/// The current read model of a feed; its snapshot is the `feed/snapshot` of that state.
struct StateView {
    id: FeedId,
    state: Value,
}

impl FeedView for StateView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
        let params = FeedSnapshotParams {
            feed_id: self.id.clone(),
            state: self.state.clone(),
        };
        encode(
            "feed/snapshot",
            serde_json::to_value(params).expect("snapshot params serialize"),
            FeedStamp {
                id: self.id.clone(),
                epoch: at.epoch,
                seq: at.seq,
                from: None,
            },
        )
    }
}

/// The single producer of one scoped feed.
pub struct FeedPublisher {
    feed: Arc<dyn ScopedFeed>,
    id: FeedId,
    producer: Mutex<()>,
}

impl FeedPublisher {
    pub fn create(feeds: &dyn ScopedFeeds, id: FeedId, state: Value) -> Self {
        let view = Arc::new(StateView {
            id: id.clone(),
            state,
        });
        Self {
            feed: feeds.create(id.clone(), view),
            id,
            producer: Mutex::new(()),
        }
    }

    pub fn source(&self) -> Arc<dyn FeedSource> {
        let feed: Arc<dyn ScopedFeed> = self.feed.clone();
        feed
    }

    pub fn id(&self) -> &FeedId {
        &self.id
    }

    /// Appends one notification and moves the read model to `state`.
    pub fn publish(&self, method: &str, params: Value, state: Value) {
        let _one_producer = self.producer.lock().expect("feed producer");
        let position = self.feed.position();
        let seq = position.seq + 1;
        let frame = FeedFrame {
            seq,
            bytes: encode(
                method,
                params,
                FeedStamp {
                    id: self.id.clone(),
                    epoch: position.epoch,
                    seq,
                    from: None,
                },
            ),
        };
        let view = Arc::new(StateView {
            id: self.id.clone(),
            state,
        });
        // The only failure is a seq gap, impossible under the producer lock.
        let _ = self.feed.publish(&[frame], Some(view));
    }

    pub fn close(&self) {
        self.feed.close();
    }
}

/// The `login:<flowId>` feeds of one flow registry (DS §5.4): provider and MCP sign-ins publish
/// each state change of a flow as `login/updated {flowId, state}`, and the feed's snapshot is the
/// flow's current status, the answer of its status read. A feed lives as long as its flow stays
/// readable in the registry that opened it.
pub struct LoginFeeds {
    feeds: Arc<dyn ScopedFeeds>,
    open: Mutex<HashMap<String, Arc<FeedPublisher>>>,
}

impl LoginFeeds {
    pub fn new(feeds: Arc<dyn ScopedFeeds>) -> Self {
        Self { feeds, open: Mutex::new(HashMap::new()) }
    }

    fn open_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<FeedPublisher>>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Opens `login:<flow_id>` with `status` as its snapshot.
    pub fn open(&self, flow_id: &str, status: Value) {
        let feed = FeedPublisher::create(self.feeds.as_ref(), FeedId(format!("login:{flow_id}")), status);
        self.open_map().insert(flow_id.to_owned(), Arc::new(feed));
    }

    /// Publishes the flow's new status. A flow whose feed is closed publishes nothing.
    pub fn publish(&self, flow_id: &str, status: Value) {
        let feed = self.open_map().get(flow_id).cloned();
        if let Some(feed) = feed {
            feed.publish("login/updated", json!({ "flowId": flow_id, "state": status }), status);
        }
    }

    /// Ends the flow's feed: its subscribers are detached.
    pub fn close(&self, flow_id: &str) {
        let feed = self.open_map().remove(flow_id);
        if let Some(feed) = feed {
            feed.close();
        }
    }
}
