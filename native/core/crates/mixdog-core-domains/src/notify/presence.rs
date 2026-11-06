//! The real `Presence`: paired phones from the remote runtime's roster and relay legs, the
//! desktop window from the UI's screen-session set.

use std::sync::Arc;

use mixdog_remote::access::runtime::RemoteRuntime;

use super::audience::{PairedClient, Presence};
use super::screen::ScreenSessions;

/// The `browser` the Mixdog phone app reports in its pairing claim (`MIXDOG_APP_CLIENT_BROWSER`).
const APP_BROWSER: &str = "Mixdog App";

pub struct RuntimePresence {
    remote: Arc<RemoteRuntime>,
    screen: Arc<ScreenSessions>,
}

impl RuntimePresence {
    pub fn new(remote: Arc<RemoteRuntime>, screen: Arc<ScreenSessions>) -> Self {
        Self { remote, screen }
    }
}

impl Presence for RuntimePresence {
    fn paired(&self) -> Vec<PairedClient> {
        self.remote
            .paired_clients()
            .into_iter()
            .map(|client| PairedClient {
                phone_app: client.browser == APP_BROWSER,
                // `Number.isSafeInteger(createdAt) && createdAt > 0`
                paired_at: (client.created_at > 0 && client.created_at <= (1 << 53) - 1).then_some(client.created_at),
                id: client.id,
            })
            .collect()
    }

    fn client_shows(&self, client_id: &str, thread_id: &str) -> bool {
        // The paired devices are reached by native and relay Web Push: the credential route.
        self.remote.is_credential_foreground(client_id, thread_id)
    }

    fn host_shows(&self, thread_id: &str) -> bool {
        self.screen.shows(thread_id)
    }
}
