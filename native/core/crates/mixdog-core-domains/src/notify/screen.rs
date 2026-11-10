//! The sessions the desktop UI is looking at (`ui/screenSessions/changed`, Node's
//! `isSessionOnScreen` of `screen-sessions.ts`). Each notification carries the whole effective
//! set (focus, visibility and minimize already applied by the host); the latest one wins, and a
//! detached UI is an empty set.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_remote::registry::{DeviceRegistry, ScreenReport};
use mixdog_app_protocol::v2::host::UiScreenSessionsChangedParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use serde_json::Value;

use mixdog_core_base::support::wrong_method;

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
                let ids: Option<HashSet<String>> = params.session_ids.map(|ids| ids.into_iter().collect());
                let report = ScreenReport {
                    sessions: ids.clone(),
                    browser_id: params.browser_id.as_deref(),
                    visualize: params.visualize_session_ids.as_deref(),
                    foreground: params.foreground,
                };
                if !self.registry.report_screen(from.0, report)
                    && let Some(ids) = ids
                {
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

    const GOLDEN: &str = include_str!("../../../../fixtures/remote-viewing/golden.json");

    /// The sessions `hostState.remoteViewing` names, as the desktop reads them.
    fn viewed(registry: &DeviceRegistry) -> Vec<String> {
        let published = crate::domains::host::remote_viewing_value(registry);
        published["sessionIds"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
    }

    /// Node's `clientViewsSessionLane` for the visualize lane, recorded over its whole input domain
    /// (`fixtures/remote-viewing/golden.json`, recorded from `b6f10295a`): one phone, with or without a live channel,
    /// in the foreground or not, with each set of reported panels. Node reads `lanes` and `visibleSessionIds` too
    /// and ignores them for this lane; the notification carries neither, and still agrees with every row.
    #[test]
    fn one_phone_counts_as_viewing_a_visualize_panel_exactly_when_node_counts_it() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let rows = golden["table"].as_array().unwrap();
        assert_eq!(rows.len(), 320);
        for row in rows {
            let registry = Arc::new(DeviceRegistry::default());
            let screen = ScreenSessions::new(registry.clone());
            registry.connect_relay(1, "peer-a");
            if row["channel"].as_bool().unwrap() {
                registry.attach_peer("peer-a", "cred-a", "Pixel", "Chrome");
            }
            let mut params = json!({ "sessionIds": [], "foreground": !row["background"].as_bool().unwrap() });
            if !row["panels"].is_null() {
                params["visualizeSessionIds"] = row["panels"].clone();
            }
            screen.notify(Method(CHANGED), params, ConnectionId(1));
            let session = row["sessionId"].as_str().unwrap().to_owned();
            assert_eq!(viewed(&registry).contains(&session), row["views"].as_bool().unwrap(), "{row}");
        }
    }

    /// The real Node relay handle after each call of two or three phones, a `client-close` and a lost leg: the sessions
    /// `viewsSessionLane` said are viewed are the sessions the core publishes as `remoteViewing`.
    #[test]
    fn remote_viewing_follows_the_phones_calls_as_nodes_relay_does() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let steps = golden["scenarios"].as_array().unwrap();
        assert_eq!(steps.len(), 19);
        let registry = Arc::new(DeviceRegistry::default());
        let screen = ScreenSessions::new(registry.clone());
        let mut connections: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut next_connection = 0;
        for step in steps {
            let client = step["client"].as_str().unwrap_or_default();
            let peer = format!("peer-{client}");
            match step["op"].as_str().unwrap() {
                "open" => {
                    next_connection += 1;
                    connections.insert(client.to_owned(), next_connection);
                    registry.connect_relay(next_connection, &peer);
                    registry.attach_peer(&peer, &format!("cred-{client}"), "Phone", "Chrome");
                }
                "panels" => {
                    let params = json!({ "sessionIds": [], "visualizeSessionIds": step["ids"] });
                    screen.notify(Method(CHANGED), params, ConnectionId(connections[client]));
                }
                "foreground" => {
                    let params = json!({ "sessionIds": [], "foreground": step["visible"], "browserId": step["browserId"] });
                    screen.notify(Method(CHANGED), params, ConnectionId(connections[client]));
                }
                "close" => {
                    registry.detach_peer(&peer);
                    registry.disconnect(connections.remove(client).unwrap());
                }
                "leg-lost" => {
                    registry.detach_all_peers();
                    for (_, connection) in connections.drain() {
                        registry.disconnect(connection);
                    }
                }
                other => panic!("unknown step {other}"),
            }
            let now = viewed(&registry);
            for (session, views) in step["views"].as_object().unwrap() {
                assert_eq!(now.contains(session), views.as_bool().unwrap(), "{session} after {step}");
            }
        }
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
        // Any paired device (`visualizeRemoteViewing`), not the desktop's own set.
        assert!(registry.any_device_shows("phone-thread") && !registry.any_device_shows("desk-thread"));
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
        assert!(!registry.credential_shows("cred-a", "t2") && !registry.any_device_shows("t2"));
    }

    const PLUMBING: &str = include_str!("../../../../../../apps/mobile/fixtures/phone-plumbing/golden.json");

    /// JS `String(item || '')`, as remote-protocol-screen.ts reads each id the page gave.
    fn page_ids(value: Option<&Value>) -> Value {
        let Some(items) = value.and_then(Value::as_array) else { return json!([]) };
        items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                Value::Number(number) if number.as_f64() != Some(0.0) => number.to_string(),
                Value::Bool(true) => "true".to_owned(),
                _ => String::new(),
            })
            .collect()
    }

    /// The phone's relay plumbing calls (list 1 unit G, recorded from Node's relay dispatch: apps/mobile/fixtures/phone-plumbing,
    /// benchmarks/rust-core/recorders/record-phone-plumbing.mjs), sent as remote-protocol-screen.ts sends them: after each, the
    /// sessions a push is held back for (by credential and by browser id) and the visualize panels viewed are Node's. The push
    /// columns are not readable over the protocol, so the mixdogd replay of the same recording compares the rest.
    #[test]
    fn the_phones_plumbing_calls_decide_what_nodes_relay_decided() {
        let golden: Value = serde_json::from_str(PLUMBING).unwrap();
        let credential = golden["credential"].as_str().unwrap();
        let sessions: Vec<&str> = golden["sessions"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        let browsers: Vec<&str> = golden["browsers"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        let registry = Arc::new(DeviceRegistry::default());
        let screen = ScreenSessions::new(registry.clone());
        registry.connect_relay(1, "peer-a");
        registry.attach_peer("peer-a", credential, "Pixel", "Chrome");
        let steps = golden["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 21);
        for step in steps {
            let params = step["params"].as_array().unwrap();
            let report = match step["call"].as_str().unwrap() {
                "setForeground" => {
                    let mut report = json!({ "foreground": params.first() != Some(&Value::Bool(false)) });
                    if let Some(id) = params.get(1).and_then(Value::as_str) {
                        report["browserId"] = json!(id);
                    }
                    Some(report)
                }
                "setScreenSessions" => Some(json!({ "sessionIds": page_ids(params.first()) })),
                "setVisualizePanels" => Some(json!({ "visualizeSessionIds": page_ids(params.first()) })),
                _ => None,
            };
            if let Some(report) = report {
                screen.notify(Method(CHANGED), report, ConnectionId(1));
            }
            let shown = |which: &dyn Fn(&str) -> bool| json!(sessions.iter().copied().filter(|id| which(id)).collect::<Vec<_>>());
            let viewed = registry.visualize_viewed_sessions();
            assert_eq!(shown(&|id| viewed.contains(id)), step["viewing"], "viewing after {step}");
            assert_eq!(shown(&|id| registry.credential_shows(credential, id)), step["credential"], "credential after {step}");
            for browser in &browsers {
                assert_eq!(shown(&|id| registry.browser_shows(browser, id)), step["browser"][*browser], "browser {browser} after {step}");
            }
        }
    }
}
