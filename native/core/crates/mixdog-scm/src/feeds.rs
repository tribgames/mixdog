//! The scoped feeds of the SCM domain (`git:<root>`, `login:<flowId>`; DS §2.1): one producer
//! per feed publishes notification frames and keeps the read model its snapshot is built from.

use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use mixdog_app_protocol::rpc::FeedStamp;
use mixdog_app_protocol::rpc::JsonRpcNotification;
use mixdog_app_protocol::v2::feed::FeedSnapshotParams;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_protocol::FeedId;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde_json::Value;

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
