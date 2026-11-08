use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use bytes::Bytes;
use mixdog_core_api::feed::AttachMode;
use mixdog_core_api::feed::Feed;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::Window;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::EchoView;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::sink::ConnectionSink;
use serde_json::Value;
use serde_json::json;

use super::*;

type Store = BTreeMap<(String, Option<String>), (u64, Value)>;

struct Rig {
    state: Arc<SectionFeedState>,
    feed: Arc<MockFeed>,
    limits: MockLimits,
}

impl Rig {
    fn new(limits: MockLimits) -> Self {
        let feed = Arc::new(MockFeed::new(
            FeedId::from("app"),
            epoch(7),
            Arc::new(EchoView),
            limits,
        ));
        let state = Arc::new(SectionFeedState::new(feed.clone()));
        Self {
            state,
            feed,
            limits,
        }
    }

    fn attach(&self, n: u64) -> MockConnection {
        let conn = MockConnection::new(ConnectionId(n), self.limits);
        let source: Arc<dyn FeedSource> = self.feed.clone();
        let attached = subscribe(
            &source,
            SubscriptionId::from("app"),
            Window::Fixed,
            None,
            &conn,
        )
        .unwrap();
        assert_eq!(attached.decision.mode, AttachMode::Snapshot);
        conn.send_control_release(Bytes::from_static(b"{}"), attached.release)
            .unwrap();
        conn
    }
}

fn fold(store: &mut Store, frame: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(frame) else {
        return;
    };
    fn apply(store: &mut Store, u: &Value) {
        let slot = (
            u["section"].as_str().unwrap().to_owned(),
            u["key"].as_str().map(str::to_owned),
        );
        let revision = u["revision"].as_u64().unwrap();
        if store.get(&slot).is_none_or(|(r, _)| revision > *r) {
            if u.get("removed").is_some() {
                store.remove(&slot);
            } else {
                let value = u.get("value").cloned().unwrap_or_else(|| u["stub"].clone());
                store.insert(slot, (revision, value));
            }
        }
    }
    if frame["method"] == "app/snapshot" {
        // The snapshot replaces the whole store.
        store.clear();
        for u in frame["params"]["sections"].as_array().unwrap() {
            apply(store, u);
        }
    } else if frame["method"].is_string() {
        apply(store, &frame["params"]);
    }
}

/// Drains `conn` until `done` holds for the folded store (snapshots are encoded off-thread).
fn converge(conn: &MockConnection, done: impl Fn(&Store) -> bool) -> Store {
    let mut store = Store::new();
    loop {
        for text in conn.drain_text() {
            if let Some((_, frame)) = text.split_once(':') {
                fold(&mut store, frame);
            }
        }
        if done(&store) {
            return store;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn set(state: &SectionFeedState, section: SectionName, key: Option<&str>, value: Value) {
    state.publish(section, key.map(str::to_owned), change_of(&value));
}

#[test]
fn late_attacher_sees_what_a_watcher_saw() {
    let rig = Rig::new(MockLimits::default());
    let early = rig.attach(1);
    for i in 0..30u64 {
        let key = format!("k{}", i % 4);
        set(&rig.state, SectionName::Usage, Some(&key), json!({ "n": i }));
        set(&rig.state, SectionName::AgentPool, None, json!({ "rows": i }));
    }
    rig.state
        .publish(SectionName::Usage, Some("k0".into()), SectionChange::Removed);
    let late = rig.attach(2);

    let want = |store: &Store| {
        store.get(&("agentPool".into(), None)).map(|e| e.1.clone()) == Some(json!({ "rows": 29 }))
            && !store.contains_key(&("usage".into(), Some("k0".into())))
            && store.len() == 4
    };
    let watched = converge(&early, want);
    let attached = converge(&late, want);
    assert_eq!(watched, attached);
}

#[test]
fn revision_is_strictly_increasing_per_key_across_removal() {
    let rig = Rig::new(MockLimits::default());
    set(&rig.state, SectionName::Notice, Some("a"), json!(1));
    let (r1, _) = rig.state.current(SectionName::Notice, Some("a")).unwrap();
    rig.state
        .publish(SectionName::Notice, Some("a".into()), SectionChange::Removed);
    assert!(rig.state.current(SectionName::Notice, Some("a")).is_none());
    set(&rig.state, SectionName::Notice, Some("a"), json!(2));
    let (r3, _) = rig.state.current(SectionName::Notice, Some("a")).unwrap();
    assert!(r3 > r1 + 1);
    set(&rig.state, SectionName::Notice, Some("b"), json!(3));
    assert_eq!(rig.state.current(SectionName::Notice, Some("b")).unwrap().0, 1);
}

#[test]
fn large_value_publishes_a_stub_in_frames_and_snapshot() {
    let rig = Rig::new(MockLimits::default());
    let models: Vec<Value> = (0..4000)
        .map(|i| json!({ "id": format!("model-{i}"), "pad": "x".repeat(120) }))
        .collect();
    set(&rig.state, SectionName::ModelCatalog, None, Value::Array(models));
    let (_, change) = rig.state.current(SectionName::ModelCatalog, None).unwrap();
    assert_eq!(change, SectionChange::Stub { count: 4000 });
    let conn = rig.attach(1);
    let store = converge(&conn, |s| !s.is_empty());
    assert_eq!(
        store[&("modelCatalog".into(), None)].1,
        json!({ "count": 4000, "stub": true })
    );
}

#[test]
fn snapshot_with_1000_models_500_agents_50_providers_fits_the_budget() {
    let limits = MockLimits::default();
    let rig = Rig::new(limits);
    let models: Vec<Value> = (0..1000)
        .map(|i| json!({ "id": format!("model-{i}"), "provider": "p", "contextWindow": 200000 }))
        .collect();
    set(&rig.state, SectionName::ModelCatalog, None, Value::Array(models));
    let agents: Vec<Value> = (0..500).map(|i| json!({ "id": format!("agent-{i}") })).collect();
    set(&rig.state, SectionName::Agents, None, Value::Array(agents));
    for i in 0..50 {
        let key = format!("provider-{i}");
        set(&rig.state, SectionName::ProviderAccounts, Some(&key), json!({ "accounts": [] }));
    }
    let conn = rig.attach(1);
    let mut seen = 0usize;
    let deadline = Instant::now() + Duration::from_secs(10);
    while seen == 0 {
        for w in conn.drain() {
            if w.lane.is_some() {
                seen = w.frame.len();
            }
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(seen <= limits.max_snapshot_bytes, "snapshot is {seen} bytes");
}

#[test]
fn stalled_client_resnapshots_and_converges() {
    let limits = MockLimits {
        queue_bytes: 64 << 10,
        control_reserve_bytes: 4 << 10,
        max_snapshot_bytes: 16 << 10,
        ring_bytes: 1 << 20,
    };
    let rig = Rig::new(limits);
    let conn = rig.attach(1);
    for round in 0..12u64 {
        for k in 0..20 {
            let key = format!("scope-{k}");
            set(
                &rig.state,
                SectionName::Usage,
                Some(&key),
                json!({ "round": round, "pad": "y".repeat(400) }),
            );
        }
    }
    let store = converge(&conn, |s| {
        s.len() == 20 && s.values().all(|(_, v)| v["round"] == 11)
    });
    assert_eq!(store.len(), 20);
}

#[test]
fn a_registered_route_gets_its_scoped_sections_until_its_guard_drops() {
    let app = Rig::new(MockLimits::default());
    let owner = Rig::new(MockLimits::default());
    let other = Rig::new(MockLimits::default());
    let table = Arc::new(ScopedRouteTable::default());
    let hub = StateHub::new(app.state.clone(), table.clone());
    let publish = |key: &str| {
        hub.publish(SectionName::GitStatus, Some(key.into()), SectionChange::Removed);
    };

    let repo = table.register(SectionName::GitStatus, Some("/repo"), owner.state.clone());
    let _any = table.register(SectionName::GitStatus, None, other.state.clone());
    publish("/repo");
    publish("/elsewhere");
    assert_eq!(owner.feed.position().seq, 1, "its own key");
    assert_eq!(other.feed.position().seq, 1, "the keyless route takes the rest");

    drop(repo);
    publish("/repo");
    assert_eq!(owner.feed.position().seq, 1);
    assert_eq!(other.feed.position().seq, 2);
    assert_eq!(app.feed.position().seq, 0);
}

struct NoScoped;

impl ScopedRoutes for NoScoped {
    fn route(&self, _: SectionName, _: Option<&str>) -> Option<Arc<dyn StatePublisher>> {
        None
    }
}

#[test]
fn hub_sends_app_sections_to_the_app_feed_and_drops_unrouted_scoped_ones() {
    let rig = Rig::new(MockLimits::default());
    let hub = StateHub::new(rig.state.clone(), Arc::new(NoScoped));
    hub.publish(SectionName::GitStatus, Some("/repo".into()), SectionChange::Removed);
    assert_eq!(rig.feed.position().seq, 0);
    hub.publish(SectionName::Core, None, change_of(&json!({ "state": "ready" })));
    assert_eq!(rig.feed.position().seq, 1);
}

/// Drains `conn` until a frame satisfies `want`; the snapshot is encoded off-thread.
fn frame_where(conn: &MockConnection, want: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline, "the awaited frame never arrived");
        for text in conn.drain_text() {
            if let Some((_, frame)) = text.split_once(':') {
                if let Ok(frame) = serde_json::from_str::<Value>(frame) {
                    if want(&frame) {
                        return frame;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_scoped_section_is_routed_to_its_feed_only_while_it_is_open() {
    use mixdog_core_api::mock::MockScopedFeeds;
    let limits = MockLimits::default();
    let app = Rig::new(limits);
    let routes = Arc::new(ScopedRouteTable::default());
    let hub = StateHub::new(app.state.clone(), routes.clone());
    let scoped = ScopedSections::new(Arc::new(MockScopedFeeds::new(limits)), routes);
    let publish = |value: SectionChange| hub.publish(SectionName::MediaJobs, Some("j1".into()), value);

    // Nobody owns the key yet: the publication has no route and goes nowhere, the app feed included.
    publish(change_of(&json!({ "id": "j1", "progress": 0 })));
    assert!(app.state.current(SectionName::MediaJobs, Some("j1")).is_none());

    let section = scoped.open(FeedId::from("media:j1"), SectionName::MediaJobs, "j1");
    publish(change_of(&json!({ "id": "j1", "progress": 10 })));
    assert!(app.state.current(SectionName::MediaJobs, Some("j1")).is_none(), "the app snapshot never holds a scoped section");

    // A subscriber that comes late is given the section's current value as the feed's snapshot.
    let conn = MockConnection::new(ConnectionId(1), limits);
    let attached = subscribe(&section.source(), SubscriptionId::from("sub"), Window::Fixed, None, &conn).unwrap();
    conn.send_control_release(Bytes::from_static(b"{}"), attached.release).unwrap();
    let snapshot = frame_where(&conn, |frame| frame["method"] == "feed/snapshot");
    assert_eq!(snapshot["params"]["feedId"], "media:j1");
    assert_eq!(snapshot["params"]["state"]["sections"][0]["section"], "mediaJobs");
    assert_eq!(snapshot["params"]["state"]["sections"][0]["key"], "j1");
    assert_eq!(snapshot["params"]["state"]["sections"][0]["value"], json!({ "id": "j1", "progress": 10 }));

    // Later publications follow it as the section's own notification, then the removal.
    publish(change_of(&json!({ "id": "j1", "progress": 100 })));
    let live = frame_where(&conn, |frame| frame["method"] == "media/job/updated");
    assert_eq!(live["params"]["value"], json!({ "id": "j1", "progress": 100 }));
    publish(SectionChange::Removed);
    let removed = frame_where(&conn, |frame| frame["params"]["removed"] == true);
    assert_eq!(removed["params"]["key"], "j1");

    // Dropping the section ends the route: later publications reach no feed.
    drop(section);
    publish(change_of(&json!({ "id": "j1", "progress": 5 })));
    assert!(app.state.current(SectionName::MediaJobs, Some("j1")).is_none());
}