//! The setup tool's desktop request notice (`setup-tool/ui-requests.mjs` `request`):
//! `notifySessionUi(sessionId, 'Desktop settings request', { kind: 'setup-ui', id })` reaches
//! the session surfaces (Desktop, TUI) watching the request's thread as `thread/notification`,
//! and the request goes on only when one is. A thread only `mixdog exec` watches has none: Node's
//! headless listener never takes the notice.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_core_api::SessionSurfaces;
use mixdog_protocol::ThreadId;
use serde_json::json;

use super::SessionDirectory;

const CONTENT: &str = "Desktop settings request";

/// [`SetupUiSurface`] over the session directory.
pub struct SessionSetupUi {
    directory: Arc<SessionDirectory>,
    surfaces: Arc<dyn SessionSurfaces>,
}

impl SessionSetupUi {
    /// `surfaces`: the server's connection table (`Outgoing`).
    pub fn new(directory: Arc<SessionDirectory>, surfaces: Arc<dyn SessionSurfaces>) -> Self {
        Self { directory, surfaces }
    }
}

#[async_trait]
impl SetupUiSurface for SessionSetupUi {
    async fn notify(&self, thread: &ThreadId, request_id: &str) -> bool {
        if !self.surfaces.surface_on(thread) {
            return false;
        }
        self.directory.notify_ui(thread, CONTENT.to_owned(), json!({ "kind": "setup-ui", "id": request_id })).await
    }
}

#[cfg(test)]
#[path = "setup_ui_tests.rs"]
mod tests;
