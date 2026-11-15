//! The connection of a session store to a core the caller has ensured (`mixdog_launch::ensure_core` is the caller's: this crate does
//! not depend on it): the websocket connector over the discovery file, the client the desktop declares for an interactive client
//! (approvals included), the session fold as the thread reducer and the default reconnect ladder.

use std::sync::Arc;

use mixdog_app_server_client::ClientInfo;
use mixdog_app_server_client::ConnectOptions;
use mixdog_app_server_client::Connector;
use mixdog_app_server_client::InitializeCapabilities;
use mixdog_app_server_client::Target;
use mixdog_app_server_client::connect;
use mixdog_app_server_client::ws::WsConnector;

use crate::store::SessionStore;
use crate::store::StoreError;
use crate::store::StoreFeed;
use crate::store::StoreOptions;

/// The connection's target: the one local (or tunnelled) core.
const TARGET: &str = "local";

/// What this client says of itself at `initialize`: a terminal UI of the version of this build (the core's version gate admits the
/// version it is, and no other).
pub fn client_info() -> ClientInfo {
    serde_json::from_value(serde_json::json!({
        "name": "mixdog-tui",
        "version": env!("CARGO_PKG_VERSION"),
        "kind": "tui",
    }))
    .expect("the client info is a valid ClientInfo")
}

/// An interactive client: every pending approval reaches it, whether or not it views the session that asked (an approval of an agent
/// session is answered from the terminal too).
pub fn capabilities() -> InitializeCapabilities {
    InitializeCapabilities { approvals_inbox: Some(true), ..InitializeCapabilities::default() }
}

/// The options a store's client is connected with: `connector`, the session fold observing `feed` as the thread reducer, the default
/// ladder and the wall clock.
pub fn connect_options(connector: Arc<dyn Connector>, feed: &Arc<StoreFeed>) -> ConnectOptions {
    ConnectOptions {
        capabilities: capabilities(),
        thread_reducer: Some(feed.reducer()),
        ..ConnectOptions::new(Target { id: TARGET.to_owned() }, connector, client_info())
    }
}

/// Connects over `connector` and opens the session `options` describe.
pub async fn connect_with(connector: Arc<dyn Connector>, options: StoreOptions) -> Result<SessionStore, StoreError> {
    let feed = SessionStore::new_feed();
    let client = connect(connect_options(connector, &feed)).await?;
    SessionStore::open(Arc::new(client), feed, options).await
}

/// Connects to the running core through its discovery file and opens the session.
pub async fn connect_core(options: StoreOptions) -> Result<SessionStore, StoreError> {
    connect_with(Arc::new(WsConnector::local()), options).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_is_an_interactive_terminal_that_receives_every_approval() {
        let info = serde_json::to_value(client_info()).expect("serializable");
        assert_eq!((info["name"].clone(), info["kind"].clone()), (serde_json::json!("mixdog-tui"), serde_json::json!("tui")));
        assert_eq!(capabilities().approvals_inbox, Some(true));
        assert!(capabilities().host.is_none());
    }
}
