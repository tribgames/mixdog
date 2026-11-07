//! The two places a thread's route is settled that the route service owns and the composition builds
//! after the session directory: the route a new thread begins on, and the pick held for the next turn.
//!
//! - A turn start applies the held pick before anything else it prepares (Node `turn-prepare.mjs`
//!   `prepareSession`: `applyPendingRoute()`, then `applyPendingSessionSwitches`, then
//!   `reconcileTurnSettings`): [`TurnStart`] is the [`TurnSettings`] every turn starts with, and runs
//!   `SessionRoutes::apply_pending` ahead of the settings reconcile.
//! - `thread/start` adopts the draft's route (else the default) and seats it on the created thread
//!   (`NewThreadRoute`, bound to the route service).
//!
//! Both are late cells: the directory and the turn path are built before the route service, which
//! reads the directory. A start or a turn before the bind fails with a typed text instead of running
//! on an unsettled route.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_admin::route_service::port;
use mixdog_core_ports::ports::route::SessionRoutes;
use mixdog_core_session::session::NewThreadRoute;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;

use super::late::Bound;
use super::turn_settings::TurnSettings;

/// `setRoute.applyPendingRoute`: the model pick held for the next turn takes effect.
#[async_trait]
pub trait PendingRoute: Send + Sync + 'static {
    async fn apply(&self, thread: &ThreadId) -> Result<(), String>;
}

#[async_trait]
impl PendingRoute for SessionRoutes {
    async fn apply(&self, thread: &ThreadId) -> Result<(), String> {
        // The recorded boundary is the TUI's `onModelSwitch` notice; the conversation carries it already.
        self.apply_pending(thread).await.map(|_| ()).map_err(port)
    }
}

/// [`PendingRoute`] bound after the route service exists.
#[derive(Default)]
pub struct LatePendingRoute(OnceLock<Arc<dyn PendingRoute>>);

impl LatePendingRoute {
    /// Binds the route; a second bind is refused.
    pub fn bind(&self, route: Arc<dyn PendingRoute>) -> Result<(), Arc<dyn PendingRoute>> {
        self.0.set(route)
    }
}

#[async_trait]
impl PendingRoute for LatePendingRoute {
    async fn apply(&self, thread: &ThreadId) -> Result<(), String> {
        match self.0.get() {
            Some(route) => route.apply(thread).await,
            None => Err("the pending route is not bound yet".to_owned()),
        }
    }
}

impl Bound for LatePendingRoute {
    fn cell(&self) -> &'static str {
        "pending route"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// [`NewThreadRoute`] bound after the route service exists.
#[derive(Default)]
pub struct LateNewRoute(OnceLock<Arc<dyn NewThreadRoute>>);

impl LateNewRoute {
    /// Binds the route service; a second bind is refused.
    pub fn bind(&self, route: Arc<dyn NewThreadRoute>) -> Result<(), Arc<dyn NewThreadRoute>> {
        self.0.set(route)
    }
}

#[async_trait]
impl NewThreadRoute for LateNewRoute {
    async fn adopt(&self, thread: &ThreadId, draft: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
        match self.0.get() {
            Some(route) => route.adopt(thread, draft).await,
            None => Err("the new thread route is not bound yet".to_owned()),
        }
    }

    async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
        match self.0.get() {
            Some(route) => route.seat(thread).await,
            None => Err("the new thread route is not bound yet".to_owned()),
        }
    }
}

impl Bound for LateNewRoute {
    fn cell(&self) -> &'static str {
        "new thread route"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// The workflow and orchestration-mode choices made while the last turn ran, applied at the next turn
/// start (`applyPendingSessionSwitches()`, `turn-prepare.mjs`).
#[async_trait]
pub trait PendingSwitches: Send + Sync + 'static {
    async fn apply(&self, thread: &ThreadId) -> Result<(), String>;
}

#[async_trait]
impl PendingSwitches for mixdog_core_session::session::thread_switches::SessionSwitchAdapter {
    /// What the switches answer (`onSessionSwitches`) has no reader on a turn start here; a refusal is the turn's.
    async fn apply(&self, thread: &ThreadId) -> Result<(), String> {
        self.apply_pending_switches(thread).await.map(|_| ())
    }
}

/// What a turn start does to the thread before its request is built, in Node's order (`prepareSession`):
/// the held route pick takes effect, the held workflow and mode choices apply, then the settings follow the live ones.
pub struct TurnStart {
    pub route: Arc<dyn PendingRoute>,
    pub switches: Arc<dyn PendingSwitches>,
    pub settings: Arc<dyn TurnSettings>,
}

#[async_trait]
impl TurnSettings for TurnStart {
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String> {
        self.route.apply(thread).await?;
        self.switches.apply(thread).await?;
        self.settings.reconcile(thread, conversation).await
    }

    async fn refresh_mcp(&self, thread: &ThreadId) -> Result<(), String> {
        self.settings.refresh_mcp(thread).await
    }

    async fn migrate_exposure(&self, thread: &ThreadId, rows: &[serde_json::Value]) -> Result<Option<Header>, String> {
        self.settings.migrate_exposure(thread, rows).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Steps(Arc<Mutex<Vec<&'static str>>>, Result<(), String>);

    #[async_trait]
    impl PendingRoute for Steps {
        async fn apply(&self, _: &ThreadId) -> Result<(), String> {
            self.0.lock().unwrap().push("route");
            self.1.clone()
        }
    }

    #[async_trait]
    impl PendingSwitches for Steps {
        async fn apply(&self, _: &ThreadId) -> Result<(), String> {
            self.0.lock().unwrap().push("switches");
            Ok(())
        }
    }

    #[async_trait]
    impl TurnSettings for Steps {
        async fn reconcile(&self, _: &ThreadId, _: bool) -> Result<Header, String> {
            self.0.lock().unwrap().push("settings");
            Ok(Header::new())
        }
    }

    /// Node's `prepareSession` applies the held pick before `reconcileTurnSettings`, and a pick that
    /// cannot be applied stops the turn before the settings are touched.
    #[tokio::test]
    async fn a_turn_start_applies_the_held_route_before_the_settings() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let thread = ThreadId::from("t1");
        let start = TurnStart { route: Arc::new(Steps(order.clone(), Ok(()))), switches: Arc::new(Steps(order.clone(), Ok(()))), settings: Arc::new(Steps(order.clone(), Ok(()))) };
        start.reconcile(&thread, false).await.expect("reconciled");
        assert_eq!(*order.lock().unwrap(), ["route", "switches", "settings"]);
        order.lock().unwrap().clear();
        let refused = TurnStart { route: Arc::new(Steps(order.clone(), Err("held pick refused".into()))), switches: Arc::new(Steps(order.clone(), Ok(()))), settings: Arc::new(Steps(order.clone(), Ok(()))) };
        assert_eq!(refused.reconcile(&thread, false).await.expect_err("refused"), "held pick refused");
        assert_eq!(*order.lock().unwrap(), ["route"]);
    }

    /// A cell left unbound refuses with a text and is named by the startup check; it binds once.
    #[tokio::test]
    async fn an_unbound_cell_refuses_and_a_bound_one_answers() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let thread = ThreadId::from("t1");
        let cell = LatePendingRoute::default();
        assert!(!cell.is_bound());
        assert!(cell.apply(&thread).await.is_err());
        assert!(cell.bind(Arc::new(Steps(order.clone(), Ok(())))).is_ok());
        assert!(cell.is_bound());
        cell.apply(&thread).await.expect("applied");
        assert_eq!(*order.lock().unwrap(), ["route"]);
        assert!(cell.bind(Arc::new(Steps(order, Ok(())))).is_err(), "a second bind is refused");
        let start = LateNewRoute::default();
        assert!(!start.is_bound());
        assert!(start.seat(&thread).await.is_err());
        assert!(start.adopt(&thread, None).await.is_err());
    }
}
