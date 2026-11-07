//! What the daemon releases when a connection ends (`CoreHandle::connection_closed`): the five owners of per-connection state.
//!
//! The server calls the hook once per opened connection, on every end path. [`ConnectionOwners::new`] takes all five owners as required
//! arguments, so a composition cannot leave one out; [`ConnectionOwnersCell`] is the bind-once cell the composed core holds until the
//! composition has built them (they come from different stages), and `compose::verify_bound` refuses to start with it unbound.

use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_core::run_host::late::Bound;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_domains::notify::screen::ScreenSessions;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_spawn::service::SystemService;
use mixdog_spawn::service::TerminalService;
use mixdog_workspace::service::WorkspaceService;

/// One owner of state held per connection.
pub trait ConnectionOwner: Send + Sync {
    fn connection_closed(&self, connection: ConnectionId);
}

impl ConnectionOwner for TerminalService {
    /// Focus and size ownership on every tab.
    fn connection_closed(&self, connection: ConnectionId) {
        TerminalService::connection_closed(self, connection);
    }
}

impl ConnectionOwner for ScreenSessions {
    /// The UI that sent the latest screen-session set is gone.
    fn connection_closed(&self, connection: ConnectionId) {
        ScreenSessions::connection_closed(self, connection);
    }
}

impl ConnectionOwner for WorkspaceService {
    /// Watches, searches and transfers of the connection.
    fn connection_closed(&self, connection: ConnectionId) {
        WorkspaceService::connection_closed(self, &connection);
    }
}

impl ConnectionOwner for SystemService {
    /// The connection's ports view (the sampler stops with the last viewer).
    fn connection_closed(&self, connection: ConnectionId) {
        SystemService::connection_closed(self, connection);
    }
}

impl ConnectionOwner for DeviceRegistry {
    /// The paired-device row the connection was reporting into.
    fn connection_closed(&self, connection: ConnectionId) {
        self.disconnect(connection.0);
    }
}

pub struct ConnectionOwners {
    owners: Vec<Arc<dyn ConnectionOwner>>,
}

impl ConnectionOwners {
    pub fn new(
        terminal: Arc<TerminalService>,
        screen: Arc<ScreenSessions>,
        workspace: Arc<WorkspaceService>,
        system: Arc<SystemService>,
        devices: Arc<DeviceRegistry>,
    ) -> Self {
        Self { owners: vec![terminal, screen, workspace, system, devices] }
    }

    /// Every owner releases what `connection` held, in a fixed order.
    pub fn connection_closed(&self, connection: ConnectionId) {
        for owner in &self.owners {
            owner.connection_closed(connection);
        }
    }

    #[cfg(test)]
    fn of(owners: Vec<Arc<dyn ConnectionOwner>>) -> Self {
        Self { owners }
    }
}

/// Bound once by the composition, after the five owners exist.
#[derive(Default)]
pub struct ConnectionOwnersCell(OnceLock<ConnectionOwners>);

impl ConnectionOwnersCell {
    pub fn bind(&self, owners: ConnectionOwners) -> Result<(), &'static str> {
        self.0.set(owners).map_err(|_| "connection owners")
    }

    /// An unbound cell is a startup bug (`verify_bound` makes it unreachable once the server accepts); the close is then written to `log`
    /// instead of vanishing.
    pub fn connection_closed(&self, connection: ConnectionId, log: &crate::daemon_log::DaemonLog) {
        match self.0.get() {
            Some(owners) => owners.connection_closed(connection),
            None => log.log(&format!("connection {} closed before the connection owners were bound; its state was not released", connection.0)),
        }
    }
}

impl Bound for ConnectionOwnersCell {
    fn cell(&self) -> &'static str {
        "connection owners"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::service::DomainService;
    use mixdog_protocol::Origin;
    use mixdog_spawn::LocalProcessManager;
    use mixdog_spawn::ProcessConfig;
    use mixdog_spawn::service::ProcessFeeds;
    use mixdog_spawn::service::TerminalServiceConfig;
    use serde_json::Value;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn request(method: &'static str, mut params: Value, connection: u64) -> CoreRequest {
        if let Some(map) = params.as_object_mut().filter(|m| !m.is_empty()) {
            map.entry("opId").or_insert_with(|| json!(format!("op-{method}")));
        }
        CoreRequest {
            method: Method(method),
            params,
            op: None,
            ctx: CallContext::connection(ConnectionId(connection), Origin::Local, CancellationToken::new()),
        }
    }

    struct Recorder(Mutex<Vec<ConnectionId>>);

    impl ConnectionOwner for Recorder {
        fn connection_closed(&self, connection: ConnectionId) {
            self.0.lock().unwrap().push(connection);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_closed_connection_releases_its_terminal_ownership_and_screen_sessions() {
        let tokens = mixdog_rt::testing::tokens();
        let manager = LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager.clone(), Arc::new(MockScopedFeeds::new(MockLimits::default())));
        let terminal = TerminalService::new(manager, feeds, Arc::new(MockStatePublisher::default()), TerminalServiceConfig::default());
        let registry = Arc::new(DeviceRegistry::default());
        let screen = Arc::new(ScreenSessions::new(registry.clone()));
        let recorder = Arc::new(Recorder(Mutex::default()));
        let owners = ConnectionOwners::of(vec![terminal.clone(), screen.clone(), registry, recorder.clone()]);

        // Connection 5 opens a tab, focuses it (so owns its size) and reports a screen set; connection 6 only watches.
        let cwd = std::env::temp_dir();
        let ensure = json!({ "tabId": "tab_close", "options": { "cwd": cwd.to_string_lossy() } });
        terminal.call(request("terminal/ensure", ensure, 5)).await.unwrap();
        terminal.call(request("terminal/focus", json!({ "tabId": "tab_close" }), 5)).await.unwrap();
        screen.notify(Method("ui/screenSessions/changed"), json!({ "sessionIds": ["s1", "s2"] }), ConnectionId(5));
        let owner = terminal.tabs().size_owner("tab_close").expect("the focused tab has a size owner");
        assert_eq!(owner.owner, "5");
        assert!(screen.shows("s1") && screen.shows("s2"));

        // Another connection closing releases nothing of connection 5's.
        owners.connection_closed(ConnectionId(6));
        assert_eq!(terminal.tabs().size_owner("tab_close").map(|o| o.owner), Some("5".to_owned()));
        assert!(screen.shows("s1"));

        owners.connection_closed(ConnectionId(5));
        assert_eq!(terminal.tabs().size_owner("tab_close").map(|o| o.owner), None, "the closed connection no longer owns the tab's size");
        assert!(!screen.shows("s1") && !screen.shows("s2"), "a closed UI shows no session");
        assert_eq!(*recorder.0.lock().unwrap(), vec![ConnectionId(6), ConnectionId(5)], "every owner is told, once per close");
        terminal.tabs().dispose_all();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    #[test]
    fn an_unbound_cell_is_named_and_a_bound_one_passes() {
        let cell = ConnectionOwnersCell::default();
        assert_eq!(cell.cell(), "connection owners");
        assert!(!cell.is_bound());
        assert!(cell.bind(ConnectionOwners::of(Vec::new())).is_ok());
        assert!(cell.is_bound());
        assert!(cell.bind(ConnectionOwners::of(Vec::new())).is_err(), "a second bind is refused");
    }
}