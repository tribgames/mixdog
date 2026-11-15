//! What the store hears on the thread feed that the fold does not keep: the runtime notification that asks this UI to open a settings
//! surface (`notification-router.mjs` `ui-open`, Node's `uiActions`). The fold itself is the reducer's; this wrapper lets the
//! notification pass to it unchanged and tells the store's subscribers. (The updater's `update-notice` is the app feed's `notice`
//! section entry `update-ready`: the store reads it there.)

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_app_server_client::Json;
use mixdog_app_server_client::RpcNotification;
use mixdog_app_server_client::ThreadReducer;
use tokio::sync::broadcast;

use super::StoreEvent;
use crate::reducer::SessionReducer;

/// The channel the store's events travel on and the counter of the UI-open requests heard (Node's `uiOpenSeq`).
pub struct StoreFeed {
    events: broadcast::Sender<StoreEvent>,
    ui_open_seq: AtomicU64,
}

impl StoreFeed {
    pub(super) fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self { events: broadcast::channel(capacity).0, ui_open_seq: AtomicU64::new(0) })
    }

    pub(super) fn emit(&self, event: StoreEvent) {
        // No subscriber is not an error: the state is read with `state()`.
        let _ = self.events.send(event);
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.events.subscribe()
    }

    /// Whether anyone listens: a standing notice is told once there is someone to tell it to.
    pub(super) fn has_subscribers(&self) -> bool {
        self.events.receiver_count() > 0
    }

    /// The thread reducer to connect with: the session fold, observed.
    pub fn reducer(self: &Arc<Self>) -> Arc<dyn ThreadReducer> {
        Arc::new(Observing { feed: Arc::clone(self) })
    }

    /// `notificationPlan` (`notification-plan.mjs`) for the `ui-open` that reaches this UI: its command without its leading slash,
    /// lower-cased (none is ignored).
    fn observe(&self, notification: &RpcNotification) {
        if notification.method != "thread/notification" {
            return;
        }
        let Some(params) = notification.params.as_ref() else { return };
        let meta = &params["meta"];
        if meta["kind"] != "ui-open" {
            return;
        }
        let command = meta["command"].as_str().unwrap_or_default().trim().trim_start_matches('/').to_lowercase();
        if command.is_empty() {
            return;
        }
        let seq = self.ui_open_seq.fetch_add(1, Ordering::AcqRel) + 1;
        self.emit(StoreEvent::UiOpenRequest { command, seq });
    }
}

struct Observing {
    feed: Arc<StoreFeed>,
}

impl ThreadReducer for Observing {
    fn initial(&self, snapshot: &Json) -> Json {
        SessionReducer.initial(snapshot)
    }

    fn apply(&self, state: &Json, notification: &RpcNotification) -> Json {
        self.feed.observe(notification);
        SessionReducer.apply(state, notification)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn notification(meta: serde_json::Value, content: &str) -> RpcNotification {
        serde_json::from_value(json!({ "method": "thread/notification", "params": { "threadId": "t", "content": content, "meta": meta } })).expect("a notification")
    }

    fn heard(notifications: &[RpcNotification]) -> Vec<StoreEvent> {
        let feed = StoreFeed::new(16);
        let mut events = feed.subscribe();
        let reducer = feed.reducer();
        let state = reducer.initial(&json!({ "thread": { "id": "t" }, "items": [], "state": {} }));
        for each in notifications {
            reducer.apply(&state, each);
        }
        let mut out = Vec::new();
        while let Ok(event) = events.try_recv() {
            out.push(event);
        }
        out
    }

    #[test]
    fn a_ui_open_request_is_a_command_without_its_slash_and_a_rising_seq() {
        let events = heard(&[
            notification(json!({ "kind": "ui-open", "command": " /Settings " }), "open"),
            notification(json!({ "kind": "ui-open", "command": "settings" }), "open"),
            notification(json!({ "kind": "ui-open", "command": "/" }), "open"),
        ]);
        assert_eq!(
            events,
            vec![
                StoreEvent::UiOpenRequest { command: "settings".to_owned(), seq: 1 },
                StoreEvent::UiOpenRequest { command: "settings".to_owned(), seq: 2 },
            ]
        );
    }

    #[test]
    fn other_notifications_pass_to_the_fold_unheard() {
        assert!(heard(&[notification(json!({ "kind": "task" }), "done")]).is_empty());
    }
}
