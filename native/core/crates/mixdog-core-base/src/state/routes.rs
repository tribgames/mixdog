//! The real [`ScopedRoutes`]: the owner of a scoped feed (the thread actor, the `git:<root>`
//! inspector, `lsp:<root>`, …) registers the publisher that answers for its keys, and the route
//! lives as long as the returned guard.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::feed::Feed;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;

use super::ScopedRoutes;
use super::SectionFeedState;
use super::StateHub;

type Slot = (SectionName, Option<String>);

#[derive(Default)]
pub struct ScopedRouteTable {
    routes: Mutex<HashMap<Slot, Arc<dyn StatePublisher>>>,
}

/// Removes its route when dropped, unless a later registration replaced it.
pub struct RouteGuard {
    table: Arc<ScopedRouteTable>,
    slot: Slot,
    publisher: Arc<dyn StatePublisher>,
}

impl ScopedRouteTable {
    /// Routes `section` for `key` to `publisher`; a `None` key answers for every key that has
    /// no route of its own. A second registration of the same slot replaces the first.
    pub fn register(
        self: &Arc<Self>,
        section: SectionName,
        key: Option<&str>,
        publisher: Arc<dyn StatePublisher>,
    ) -> RouteGuard {
        let slot = (section, key.map(str::to_owned));
        lock(&self.routes).insert(slot.clone(), publisher.clone());
        RouteGuard { table: self.clone(), slot, publisher }
    }
}

impl Drop for RouteGuard {
    fn drop(&mut self) {
        let mut routes = lock(&self.table.routes);
        if routes.get(&self.slot).is_some_and(|now| Arc::ptr_eq(now, &self.publisher)) {
            routes.remove(&self.slot);
        }
    }
}

impl ScopedRoutes for ScopedRouteTable {
    fn route(&self, section: SectionName, key: Option<&str>) -> Option<Arc<dyn StatePublisher>> {
        let routes = lock(&self.routes);
        key.and_then(|key| routes.get(&(section, Some(key.to_owned()))))
            .or_else(|| routes.get(&(section, None)))
            .cloned()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the composition root holds: the one `StatePublisher` every domain receives, the table
/// scoped-feed owners register in, and the app feed's section state.
pub struct StateRuntime {
    pub publisher: Arc<StateHub>,
    pub routes: Arc<ScopedRouteTable>,
    pub app: Arc<SectionFeedState>,
}

impl StateRuntime {
    /// The factory of scoped sections: their feeds come from `feeds`, their routes live in this
    /// runtime's table.
    pub fn scoped_sections(&self, feeds: Arc<dyn mixdog_core_api::feed::ScopedFeeds>) -> super::ScopedSections {
        super::ScopedSections::new(feeds, self.routes.clone())
    }

    /// `app_feed` is the app feed; nothing else may publish to it.
    pub fn new(app_feed: Arc<dyn Feed>) -> Self {
        let app = Arc::new(SectionFeedState::new(app_feed));
        let routes = Arc::new(ScopedRouteTable::default());
        let publisher = Arc::new(StateHub::new(app.clone(), routes.clone()));
        Self { publisher, routes, app }
    }
}
