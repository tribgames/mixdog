//! A click on a desktop toast, reported by the host as `host/notification/clicked{threadId}`.
//! The host already raises the window and opens the session; the core only owes the
//! `turn-notification-clicked {sessionId}` trace that Node's diagnostics log carries.

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
