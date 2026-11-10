//! The production owner of a scoped section (SPEC R14): the scoped feed a section's key is delivered
//! on, the section state of that feed, and the route that sends the section's publications to it.
//!
//! A domain that owns a keyed, scoped section (`mediaJobs` on `media:<jobId>`, `reviewDiff`, …)
//! opens one [`ScopedSection`] per key and keeps publishing through the core's one
//! `StatePublisher`; [`StateHub`](super::StateHub) finds the feed by the route. A client that knows
//! the feed id subscribes with `feed/subscribe` ([`CoreScopedFeeds::find`](crate::feed::CoreScopedFeeds::find))
//! and gets the section's current value as the `feed/snapshot`, then every later publication.

use std::sync::Arc;

use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::ids::FeedId;
use mixdog_protocol::SectionName;

use super::RouteGuard;
use super::ScopedRouteTable;
use super::SectionFeedState;
use super::scoped_empty_view;

/// Opens scoped sections: the factory of their feeds and the table their routes live in.
#[derive(Clone)]
pub struct ScopedSections {
    feeds: Arc<dyn ScopedFeeds>,
    routes: Arc<ScopedRouteTable>,
}

impl ScopedSections {
    pub fn new(feeds: Arc<dyn ScopedFeeds>, routes: Arc<ScopedRouteTable>) -> Self {
        Self { feeds, routes }
    }

    /// The scoped feed `feed_id` carrying `section` for `key`. Its route lasts as long as the
    /// returned value.
    pub fn open(&self, feed_id: FeedId, section: SectionName, key: &str) -> ScopedSection {
        let view = scoped_empty_view(&feed_id);
        let feed = if section.feed().ordered() {
            self.feeds.create_ordered(feed_id, view)
        } else {
            self.feeds.create(feed_id, view)
        };
        let state = Arc::new(SectionFeedState::scoped(feed.clone()));
        let route = self.routes.register(section, Some(key), state);
        ScopedSection { feed, _route: route }
    }
}

/// One open scoped section. Publications to its `(section, key)` reach the feed's subscribers
/// while this is held; dropping it removes the route. The feed is not closed by that: closing
/// releases the frames a lane has not written yet, and the last of them is usually the removal
/// the subscriber is waiting for. A subscriber that has seen it unsubscribes; [`close`](Self::close)
/// ends a feed whose scope itself ends.
pub struct ScopedSection {
    feed: Arc<dyn ScopedFeed>,
    _route: RouteGuard,
}

impl ScopedSection {
    /// Ends the feed: every subscription is detached and its unwritten frames are released.
    pub fn close(&self) {
        self.feed.close();
    }

    /// The subscriber side of the feed, for the `feed/subscribe` that names its id.
    pub fn source(&self) -> Arc<dyn FeedSource> {
        let source: Arc<dyn FeedSource> = self.feed.clone();
        source
    }
}
