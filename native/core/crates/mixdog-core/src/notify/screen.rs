//! The sessions the desktop UI is looking at (`ui/screenSessions/changed`, Node's
//! `isSessionOnScreen` of `screen-sessions.ts`). Each notification carries the whole effective
//! set (focus, visibility and minimize already applied by the host); the latest one wins, and a
//! detached UI is an empty set.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_app_protocol::v2::host::UiScreenSessionsChangedParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use serde_json::Value;

use crate::domains::support::wrong_method;

const CHANGED: &str = "ui/screenSessions/changed";

pub struct ScreenSessions {
    latest: Mutex<Option<(ConnectionId, HashSet<String>)>>,
    /// A paired phone sends the same notification over its relay connection; its set belongs to
    /// that connection in the registry and never replaces the desktop's.
    registry: Arc<DeviceRegistry>,
}

impl ScreenSessions {
    pub fn new(registry: Arc<DeviceRegistry>) -> Self {
        Self { latest: Mutex::new(None), registry }
    }

    fn latest(&self) -> std::sync::MutexGuard<'_, Option<(ConnectionId, HashSet<String>)>> {
        self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn shows(&self, session_id: &str) -> bool {
        self.latest().as_ref().is_some_and(|(_, ids)| ids.contains(session_id))
    }

    /// The composition calls this when a connection closes: the UI that sent the latest set is gone.
    pub fn connection_closed(&self, connection: ConnectionId) {
        let mut latest = self.latest();
        if latest.as_ref().is_some_and(|(owner, _)| *owner == connection) {
            *latest = None;
        }
    }
}

#[async_trait]
impl DomainService for ScreenSessions {
    fn methods(&self) -> &'static [&'static str] {
        &[CHANGED]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Err(wrong_method("ui", req.method.as_str()))
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        if method.as_str() == CHANGED {
            if let Ok(params) = serde_json::from_value::<UiScreenSessionsChangedParams>(params) {
                let ids: HashSet<String> = params.session_ids.into_iter().collect();
                if !self.registry.report_screen(from.0, ids.clone(), params.browser_id.as_deref()) {
                    *self.latest() = Some((from, ids));
                }
            }
        }
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn send(screen: &ScreenSessions, from: u64, ids: Value) {
        screen.notify(Method(CHANGED), json!({ "sessionIds": ids }), ConnectionId(from));
    }

    #[test]
    fn nothing_is_shown_before_the_first_set_and_the_latest_set_replaces_the_last() {
        let screen = ScreenSessions::new(Arc::default());
        assert!(!screen.shows("a"));
        send(&screen, 1, json!(["a", "b"]));
        assert!(screen.shows("a") && screen.shows("b"));
        send(&screen, 1, json!(["b"]));
        assert!(!screen.shows("a") && screen.shows("b"));
        send(&screen, 1, json!([]));
        assert!(!screen.shows("b"));
    }

    #[test]
    fn a_malformed_set_changes_nothing_and_a_detached_ui_shows_nothing() {
        let screen = ScreenSessions::new(Arc::default());
        send(&screen, 1, json!(["a"]));
        send(&screen, 1, json!("nope"));
        assert!(screen.shows("a"));
        screen.connection_closed(ConnectionId(2));
        assert!(screen.shows("a"), "another connection closing leaves the UI attached");
        screen.connection_closed(ConnectionId(1));
        assert!(!screen.shows("a"));
    }

    #[test]
    fn a_phone_reports_into_the_registry_and_never_into_the_desktops_set() {
        let registry = Arc::new(DeviceRegistry::default());
        let screen = ScreenSessions::new(registry.clone());
        registry.connect_local(1, "desk", mixdog_remote::registry::LocalKind::Desktop);
        registry.connect_relay(2, "peer-a");
        registry.attach_peer("peer-a", "cred-a", "Pixel", "Safari");
        send(&screen, 1, json!(["desk-thread"]));
        screen.notify(
            Method(CHANGED),
            json!({ "sessionIds": ["phone-thread"], "browserId": "x".repeat(70) }),
            ConnectionId(2),
        );
        assert!(screen.shows("desk-thread") && !screen.shows("phone-thread"), "the phone does not touch the host's set");
        assert!(registry.credential_shows("cred-a", "phone-thread"));
        assert!(!registry.credential_shows("cred-b", "phone-thread"));
        // The browser id is its own identity: clipped to 64 units, and no credential answers to it.
        assert!(registry.browser_shows(&"x".repeat(64), "phone-thread"));
        assert!(!registry.browser_shows("cred-a", "phone-thread"));
        // A set without a browser id keeps the one stated before; an empty set shows nothing.
        send(&screen, 2, json!([]));
        assert!(!registry.credential_shows("cred-a", "phone-thread"));
        send(&screen, 2, json!(["t2"]));
        assert!(registry.browser_shows(&"x".repeat(64), "t2"));
        // A phone that left shows nothing, even before its connection record goes.
        registry.detach_peer("peer-a");
        assert!(!registry.credential_shows("cred-a", "t2"));
    }
}
