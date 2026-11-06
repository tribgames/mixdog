//! `notification_clicks`: a click on a desktop toast, reported by the host as
//! `host/notification/clicked{threadId}`.
//!
//! In Node the whole reaction is the desktop's own: `createNativePresenter`
//! (`desktop-turn-notifier.ts`) releases the toast, writes the `turn-notification-clicked`
//! diagnostic and calls `openSession`, which raises the window and opens the thread in the
//! renderer. The host process keeps doing all three at the click, so the core owes only the
//! trace of it that Node's diagnostics log carries (decisions.md, "Notification clicks").

use mixdog_core_domains::domains::host::NotificationClicks;
use mixdog_protocol::ThreadId;

pub struct LoggedClicks;

impl NotificationClicks for LoggedClicks {
    fn clicked(&self, thread: &ThreadId) {
        tracing::info!(target: "turn-notification", event = "clicked", session_id = %thread);
    }
}
