//! `notification_clicks`: a click on a desktop toast, reported by the host as
//! `host/notification/clicked{threadId}`.
//!
//! In Node the whole reaction is the desktop's own: `createNativePresenter`
//! (`desktop-turn-notifier.ts`) releases the toast, reports `clicked` to the desktop diagnostics
//! log as `turn-notification-clicked {sessionId}` and calls `openSession`, which raises the
//! window and opens the thread in the renderer. The host process keeps doing all three at the
//! click, so the core owes only the trace of it that Node's diagnostics log carries (decisions.md,
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
    use crate::domain_seams::golden;

    #[test]
    fn a_click_is_reported_as_nodes_notifier_reports_it() {
        let golden = golden();
        let clicks = &golden["clicks"];
        assert_eq!(EVENT_PREFIX, clicks["prefix"].as_str().unwrap());
        let reported = clicks["reported"].as_array().unwrap().iter().find(|report| report["event"] == "clicked").unwrap();
        let session = reported["sessionId"].as_str().unwrap();
        let mut details = serde_json::Map::from_iter([("sessionId".to_owned(), json!(session))]);
        details.extend(reported["details"].as_object().unwrap().clone());
        let (event, shown) = click_report(&ThreadId::from(session));
        assert_eq!(event, format!("{}{}", clicks["prefix"].as_str().unwrap(), reported["event"].as_str().unwrap()));
        assert_eq!(shown, Value::Object(details));
        assert_eq!(clicks["opened"], json!([session]));
    }
}