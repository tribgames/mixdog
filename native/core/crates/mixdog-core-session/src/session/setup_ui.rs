//! The setup tool's desktop request notice (`setup-tool/ui-requests.mjs` `request`):
//! `notifySessionUi(sessionId, 'Desktop settings request', { kind: 'setup-ui', id })` goes out
//! on the request's thread feed as `thread/notification`, and the request goes on when the
//! thread is live here. Node's taker is the session runtime's own store, whatever client views
//! it; `mixdog exec`'s headless runtime has none, and its tool profile has no `setup` tool.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_protocol::ThreadId;
use serde_json::json;

use super::SessionDirectory;

const CONTENT: &str = "Desktop settings request";

/// [`SetupUiSurface`] over the session directory.
pub struct SessionSetupUi {
    directory: Arc<SessionDirectory>,
}

impl SessionSetupUi {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

#[async_trait]
impl SetupUiSurface for SessionSetupUi {
    async fn notify(&self, thread: &ThreadId, request_id: &str) -> bool {
        self.directory.notify_ui(thread, CONTENT.to_owned(), json!({ "kind": "setup-ui", "id": request_id })).await
    }
}

#[cfg(test)]
#[path = "setup_ui_tests.rs"]
mod tests;
