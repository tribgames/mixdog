//! `notification_clicks`: a click on a desktop toast, reported by the host as
//! `host/notification/clicked{threadId}`.
//!
//! In Node the whole reaction is the desktop's own: the toast is released, the click is reported to the desktop diagnostics log as
//! `turn-notification-clicked {sessionId}`, and the session is opened in the renderer after the window is raised. The host process
//! still does all three at the click (`apps/desktop/src/main/host/notification.ts`: the presenter's `activate(threadId)` raises the
//! window and opens the session it names), so the core owes only the trace of it that Node's diagnostics log carries (decisions.md,
//! "Notification clicks").

use mixdog_core_domains::domains::host::NotificationClicks;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

/// index.ts names the diagnostic `turn-notification-${event}`.
pub const EVENT_PREFIX: &str = "turn-notification-";

/// The diagnostic Node writes for a click: its name and details (`{ sessionId, ...details }`,
/// the details of a click being empty).
pub fn click_report(thread: &ThreadId) -> (String, Value) {
    (format!("{EVENT_PREFIX}clicked"), json!({ "sessionId": thread.as_str() }))
}

pub struct LoggedClicks;

impl NotificationClicks for LoggedClicks {
    fn clicked(&self, thread: &ThreadId) {
        let (event, details) = click_report(thread);
        tracing::info!(target: "turn-notification", %event, %details, "notification clicked");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_is_reported_as_the_clicked_event_of_its_session() {
        let (event, shown) = click_report(&ThreadId::from("sess_click"));
        assert_eq!(event, "turn-notification-clicked");
        assert_eq!(shown, json!({ "sessionId": "sess_click" }));
    }
}
