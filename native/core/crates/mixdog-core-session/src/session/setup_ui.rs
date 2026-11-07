//! The setup tool's desktop request notice (`setup-tool/ui-requests.mjs` `request`):
//! `notifySessionUi(sessionId, 'Desktop settings request', { kind: 'setup-ui', id })` is taken by
//! the session store, which sets `setupUiRequest`; here the request's thread holds it as its
//! `setupUiRequest` section (`thread/setupUiRequest/updated`, and in every snapshot) until the
//! broker settles it or its claim window ends, and the request goes on when the thread is live
//! here. Node's taker is the session runtime's own store, whatever client views it; `mixdog
//! exec`'s headless runtime has none, and its tool profile has no `setup` tool.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_protocol::ThreadId;

use super::SessionDirectory;

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
    async fn notify(&self, thread: &ThreadId, request_id: &str, window: Duration) -> bool {
        self.directory.request_setup_ui(thread, request_id, window).await
    }

    async fn settled(&self, thread: &ThreadId, request_id: &str) {
        self.directory.settle_setup_ui(thread, request_id).await;
    }
}

#[cfg(test)]
#[path = "setup_ui_tests.rs"]
mod tests;
