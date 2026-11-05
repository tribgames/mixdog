use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;

use super::*;
use crate::domains::support::testing::request;
use crate::domains::support::testing::value;

#[derive(Default)]
struct Spy {
    targets: Mutex<Vec<Option<RemoteTarget>>>,
    power: Mutex<Vec<PowerEvent>>,
    clicks: Mutex<Vec<String>>,
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
    (HostService::new(publisher.clone(), spy.clone(), spy.clone(), spy.clone()), publisher, spy)
}

fn set(change: &SectionChange) -> Value {
    match change {
        SectionChange::Set(bytes) => serde_json::from_slice(bytes).unwrap(),
        other => panic!("not a set: {other:?}"),
    }
}

#[tokio::test]
async fn desktop_state_is_published_under_its_key() {
    let (service, publisher, _) = rig();
    let tabs = json!([{ "id": "t1", "title": "Docs", "url": "https://example.com", "loading": false }]);
    let reply = value(&*service, request("host/state/set", json!({ "key": "browserTabs", "value": tabs }), None))
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
        service.call(request("host/state/set", json!({ "key": "other", "value": 1 }), None)).await,
        Err(CoreError::InvalidParams { .. })
    ));
}

#[tokio::test]
async fn the_remote_target_is_a_loopback_tunnel_or_absent() {
    let (service, _, spy) = rig();
    value(
        &*service,
        request("host/remoteTarget/set", json!({ "endpoint": "ws://127.0.0.1:52100/rpc", "token": "t" }), None),
    )
    .await
    .unwrap();
    value(&*service, request("host/remoteTarget/set", json!({}), None)).await.unwrap();
    assert_eq!(
        *spy.targets.lock().unwrap(),
        vec![
            Some(RemoteTarget { endpoint: "ws://127.0.0.1:52100/rpc".into(), token: Some("t".into()) }),
            None
        ]
    );
    for endpoint in ["wss://127.0.0.1:1/rpc", "ws://example.com:80/rpc", "ws://127.0.0.1/rpc", "nonsense"] {
        assert!(
            matches!(
                service.call(request("host/remoteTarget/set", json!({ "endpoint": endpoint }), None)).await,
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
    service.notify(Method("host/notification/clicked"), json!({ "threadId": "th-1" }), from);
    service.notify(Method("host/update/report"), json!({ "state": { "phase": "downloaded", "version": "1.4.6" } }), from);
    assert_eq!(*spy.power.lock().unwrap(), vec![PowerEvent::Suspend, PowerEvent::Resume]);
    assert_eq!(*spy.clicks.lock().unwrap(), vec!["th-1".to_owned()]);
    let published = publisher.published();
    assert_eq!((published[0].0, published[0].1.as_deref()), (SectionName::Update, None));
    assert_eq!(set(&published[0].2), json!({ "phase": "downloaded", "version": "1.4.6" }));
}
