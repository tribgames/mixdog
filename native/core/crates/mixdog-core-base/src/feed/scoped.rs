//! Scoped feeds (`fs:<watchId>`, `search:<sessionId>`, …; DS §2.1): each one an independent
//! [`CoreFeed`] with its own lock, so the factory keeps no registry that attach or publish
//! could contend on.

use std::sync::Arc;

use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_rt::CpuInteractive;
use uuid::Uuid;

use super::CoreFeed;
use super::FeedLimits;

/// Creates [`CoreFeed`]s with one set of limits, each under a freshly drawn random epoch.
pub struct CoreScopedFeeds {
    limits: FeedLimits,
    cpu: CpuInteractive,
}

impl CoreScopedFeeds {
    /// `limits` apply to every created feed; `cpu` runs their snapshot encodes.
    pub fn new(limits: FeedLimits, cpu: CpuInteractive) -> Self {
        Self { limits, cpu }
    }
}

impl ScopedFeeds for CoreScopedFeeds {
    fn create(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
        let epoch = FeedEpoch::from(Uuid::new_v4().simple().to_string());
        Arc::new(CoreFeed::new(id, epoch, view, self.limits, self.cpu))
    }
}

impl ScopedFeed for CoreFeed {
    /// A subscription racing the close of its scope answers `connectionClosed`.
    fn close(&self) {
        CoreFeed::close(self, CoreError::ConnectionClosed);
    }
}
