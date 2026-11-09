use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;

use super::*;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;

#[derive(Default)]
struct Spy {
    targets: Mutex<Vec<Option<RemoteTarget>>>,
    power: Mutex<Vec<PowerEvent>>,
    clicks: Mutex<Vec<String>>,
    surfaces: Mutex<Vec<UiOpenBrowser>>,
}

impl BrowserSurfaces for Spy {
    fn requested(&self, request: UiOpenBrowser) {
        self.surfaces.lock().unwrap().push(request);
    }
}

impl RemoteBridge for Spy {
    fn set_target(&self, target: Option<RemoteTarget>) {
        self.targets.lock().unwrap().push(target);
    }
}

impl PowerSink for Spy {
    fn power(&self, event: PowerEvent) {
        self.power.lock().unwrap().push(event);
    }
}

impl NotificationClicks for Spy {
    fn clicked(&self, thread: &ThreadId) {
        self.clicks.lock().unwrap().push(thread.to_string());
    }
}

fn rig() -> (Arc<HostService>, Arc<MockStatePublisher>, Arc<Spy>) {
    let publisher = Arc::new(MockStatePublisher::default());
    let spy = Arc::new(Spy::default());
    (
        HostService::new(publisher.clone(), spy.clone(), spy.clone(), spy.clone(), spy.clone()),
        publisher,
        spy,
    )
}

#[test]
fn a_browser_surface_request_reaches_the_open_feed_and_a_malformed_one_is_dropped() {
    let (service, _, spy) = rig();
    let from = ConnectionId(1);
    service.notify(
        Method("host/browser/surface"),
        json!({ "sessionId": "s1", "reveal": true, "tabId": "p1", "title": "Docs" }),
        from,
    );
    service.notify(Method("host/browser/surface"), json!({ "hide": true }), from);
    let seen = spy.surfaces.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].session_id, "s1");
    assert_eq!(seen[0].reveal, Some(true));
    assert_eq!(seen[0].tab_id.as_deref(), Some("p1"));
    assert_eq!(seen[0].hide, None);
}

fn set(change: &SectionChange) -> Value {
    match change {
        SectionChange::Set(bytes) => serde_json::from_slice(bytes).unwrap(),
        other => panic!("not a set: {other:?}"),
    }
}

#[test]
fn remote_viewing_lists_the_visualize_panels_paired_devices_view() {
    let registry = DeviceRegistry::default();
    registry.connect_local(1, "desk", mixdog_remote::registry::LocalKind::Desktop);
    registry.connect_relay(2, "peer-a");
    let panels = ["b".to_owned(), "a".to_owned()];
    let report = |panels| mixdog_remote::registry::ScreenReport {
        sessions: ["screen".to_owned()].into_iter().collect(),
        browser_id: None,
        visualize: Some(panels),
        foreground: None,
    };
    registry.report_screen(2, report(&panels));
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": [] }), "a peer that is not paired shows nothing");
    registry.attach_peer("peer-a", "cred-a", "Pixel", "Safari");
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": ["a", "b"] }), "the screen set is not the panel set");
    registry.disconnect(2);
    assert_eq!(remote_viewing_value(&registry), json!({ "sessionIds": [] }));
}

#[tokio::test]
async fn desktop_state_is_published_under_its_key() {
    let (service, publisher, _) = rig();
    let tabs =
        json!([{ "id": "t1", "title": "Docs", "url": "https://example.com", "loading": false }]);
    let reply = value(
        &*service,
        request(
            "host/state/set",
            json!({ "key": "browserTabs", "value": tabs }),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(reply, json!({}));
    let published = publisher.published();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].0, SectionName::HostState);
    assert_eq!(published[0].1.as_deref(), Some("browserTabs"));
    assert_eq!(set(&published[0].2), tabs);
    // A key outside the four is not a request.
    assert!(matches!(
        service
            .call(request(
                "host/state/set",
                json!({ "key": "other", "value": 1 }),
                None
            ))
            .await,
        Err(CoreError::InvalidParams { .. })
    ));
}

#[tokio::test]
async fn the_remote_target_is_a_loopback_tunnel_or_absent() {
    let (service, _, spy) = rig();
    value(
        &*service,
        request(
            "host/remoteTarget/set",
            json!({ "endpoint": "ws://127.0.0.1:52100/rpc", "token": "t" }),
            None,
        ),
    )
    .await
    .unwrap();
    value(&*service, request("host/remoteTarget/set", json!({}), None))
        .await
        .unwrap();
    assert_eq!(
        *spy.targets.lock().unwrap(),
        vec![
            Some(RemoteTarget {
                endpoint: "ws://127.0.0.1:52100/rpc".into(),
                token: Some("t".into())
            }),
            None
        ]
    );
    for endpoint in [
        "wss://127.0.0.1:1/rpc",
        "ws://example.com:80/rpc",
        "ws://127.0.0.1/rpc",
        "nonsense",
    ] {
        assert!(
            matches!(
                service
                    .call(request(
                        "host/remoteTarget/set",
                        json!({ "endpoint": endpoint }),
                        None
                    ))
                    .await,
                Err(CoreError::InvalidParams { .. })
            ),
            "{endpoint}"
        );
    }
    assert_eq!(spy.targets.lock().unwrap().len(), 2);
}

#[test]
fn notifications_reach_their_consumers() {
    let (service, publisher, spy) = rig();
    let from = ConnectionId(1);
    service.notify(Method("host/power"), json!({ "event": "suspend" }), from);
    service.notify(Method("host/power"), json!({ "event": "resume" }), from);
    service.notify(Method("host/power"), json!({ "event": "sleep" }), from);
    service.notify(
        Method("host/notification/clicked"),
        json!({ "threadId": "th-1" }),
        from,
    );
    service.notify(
        Method("host/update/report"),
        json!({ "state": { "phase": "downloaded", "version": "1.4.6" } }),
        from,
    );
    assert_eq!(
        *spy.power.lock().unwrap(),
        vec![PowerEvent::Suspend, PowerEvent::Resume]
    );
    assert_eq!(*spy.clicks.lock().unwrap(), vec!["th-1".to_owned()]);
    let published = publisher.published();
    assert_eq!(
        (published[0].0, published[0].1.as_deref()),
        (SectionName::Update, None)
    );
    assert_eq!(
        set(&published[0].2),
        json!({ "phase": "downloaded", "version": "1.4.6" })
    );
}

/// `applyRemoteSessionState` (recorded from Node's `SessionHostPublication`): the id the bridge's state leaves on a snapshot.
#[test]
fn remote_session_keeps_the_id_only_as_node_applies_it() {
    let recorded: serde_json::Value = serde_json::from_str(include_str!("../../../../../fixtures/desktop/phone-chat/remote-session.json")).unwrap();
    for case in recorded["cases"].as_array().unwrap() {
        let state = &case["state"];
        let value = remote_session_value(state["enabled"] == true, state["sessionId"].as_str());
        assert_eq!(value["sessionId"], case["remoteSessionId"], "{}", case["name"]);
    }
}

#[test]
fn the_bridge_binding_is_published_as_host_state_remote_session() {
    let publisher = MockStatePublisher::default();
    publish_remote_session(&publisher, true, Some("phone_1"));
    let published = publisher.published();
    assert_eq!(published.len(), 1);
    assert_eq!((published[0].0, published[0].1.as_deref()), (SectionName::HostState, Some("remoteSession")));
}
