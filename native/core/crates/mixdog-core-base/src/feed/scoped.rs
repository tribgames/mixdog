//! Scoped feeds (`fs:<watchId>`, `search:<sessionId>`, …; DS §2.1): each one an independent
//! [`CoreFeed`] with its own lock. The factory keeps only a lookup of the live feeds by id
//! ([`CoreScopedFeeds::find`], for `feed/subscribe`), under a lock of its own that attach and
//! publish never take.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::FeedSource;
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
    /// The feeds still held by their owners; a dropped feed leaves its entry until the next
    /// `create` sweeps it.
    live: Mutex<HashMap<FeedId, Weak<CoreFeed>>>,
}

impl CoreScopedFeeds {
    /// `limits` apply to every created feed; `cpu` runs their snapshot encodes.
    pub fn new(limits: FeedLimits, cpu: CpuInteractive) -> Self {
        Self { limits, cpu, live: Mutex::new(HashMap::new()) }
    }

    /// The live scoped feed `id`, for a subscriber that knows its id (`feed/subscribe`).
    pub fn find(&self, id: &FeedId) -> Option<Arc<dyn FeedSource>> {
        let feed = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id)?.upgrade()?;
        Some(feed)
    }
}

impl ScopedFeeds for CoreScopedFeeds {
    fn create(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
        let epoch = FeedEpoch::from(Uuid::new_v4().simple().to_string());
        let feed = Arc::new(CoreFeed::new(id.clone(), epoch, view, self.limits, self.cpu));
        let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        live.retain(|_, feed| feed.strong_count() > 0);
        live.insert(id, Arc::downgrade(&feed));
        feed
    }
}

impl ScopedFeed for CoreFeed {
    /// A subscription racing the close of its scope answers `connectionClosed`.
    fn close(&self) {
        CoreFeed::close(self, CoreError::ConnectionClosed);
    }

    fn subscribers(&self) -> usize {
        CoreFeed::subscribers(self)
    }
}
