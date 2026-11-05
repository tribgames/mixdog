//! The `process`, `terminal` and `system` domain services over real processes, a mock scoped-feed
//! factory and a mock section publisher.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use common::*;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::Origin;
use mixdog_protocol::SectionName;
use mixdog_spawn::ports::ListeningPort;
use mixdog_spawn::service::ProcessFeeds;
use mixdog_spawn::service::ProcessService;
use mixdog_spawn::service::SystemService;
use mixdog_spawn::service::TerminalService;
use mixdog_spawn::service::TerminalServiceConfig;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn request(method: &'static str, mut params: Value, connection: u64) -> CoreRequest {
    // Mutating methods carry an op id in their params; the other methods ignore it.
    if let Some(map) = params.as_object_mut().filter(|m| !m.is_empty()) {
        map.entry("opId").or_insert_with(|| json!(format!("op-{method}")));
    }
    CoreRequest {
        method: Method(method),
        params,
        op: None,
        ctx: CallContext::connection(ConnectionId(connection), Origin::Local, CancellationToken::new()),
    }
}

fn scoped() -> Arc<MockScopedFeeds> {
    Arc::new(MockScopedFeeds::new(MockLimits::default()))
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ok() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn process_spawn_streams_on_a_feed_and_kill_ends_it() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = ProcessService::new(manager.clone(), feeds);
    let name = handle("svc-spawn");
    let long = if cfg!(windows) { json!(["ping", "-n", "60", "127.0.0.1"]) } else { json!(["sleep", "60"]) };
    let params = json!({
        "processHandle": name,
        "argv": long,
        "cwd": temp_dir().as_path().to_string_lossy(),
        "owner": { "kind": "internal" },
    });
    let Reply::Subscribe(sub) = service.call(request("process/spawn", params, 1)).await.unwrap() else {
        panic!("process/spawn answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), format!("process:{name}"));
    let pid = sub.result["pid"].as_u64().expect("the reply carries the pid") as u32;
    assert!(pid_alive(pid));

    // A second spawn under the live handle is refused, not a second process.
    let again = json!({ "processHandle": name, "argv": ["x"], "cwd": temp_dir().as_path().to_string_lossy(), "owner": "internal" });
    assert!(service.call(request("process/spawn", again, 1)).await.is_err());

    service
        .call(request("process/kill", json!({ "processHandle": name }), 1))
        .await
        .unwrap();
    until("the killed process to end", || !pid_alive(pid)).await;
    // A malformed request is a typed error, never a panic.
    assert!(service.call(request("process/spawn", json!({}), 1)).await.is_err());
    assert!(service.call(request("process/nope", json!({}), 1)).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn ports_are_sampled_only_while_a_connection_views_them() {
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&reads);
    let service = SystemService::with_source(scoped(), Duration::from_millis(20), move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(vec![ListeningPort { port: 8080, addresses: vec!["127.0.0.1".into()], process: Some("x".into()), pid: Some(1) }])
    });
    assert_eq!(service.sampler_threads(), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0, "nothing is read before someone views");

    let Reply::Subscribe(sub) = service.call(request("system/ports/subscribe", json!({}), 7)).await.unwrap() else {
        panic!("system/ports/subscribe answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), "ports");
    until("the first sample", || reads.load(Ordering::SeqCst) > 0).await;
    assert_eq!(service.sampler_threads(), 1);

    // A second viewer shares the one sampler; the first leaving keeps it, the last stops it.
    service.call(request("system/ports/subscribe", json!({}), 8)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.call(request("system/ports/unsubscribe", json!({}), 7)).await.unwrap();
    assert_eq!(service.sampler_threads(), 1);
    service.connection_closed(ConnectionId(8));
    until("the sampler to stop", || service.sampler_threads() == 0).await;
    let settled = reads.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(reads.load(Ordering::SeqCst), settled, "no sampling once nobody views");
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_service_ensures_publishes_tabs_and_disposes() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let publisher = Arc::new(MockStatePublisher::default());
    let service = TerminalService::new(manager, feeds, publisher.clone(), TerminalServiceConfig::default());

    let Reply::Value(profiles) = service.call(request("terminal/profiles", json!({}), 1)).await.unwrap() else {
        panic!("terminal/profiles answers with a value");
    };
    assert_eq!(profiles.as_array().unwrap().iter().filter(|p| p["default"] == json!(true)).count(), 1);

    let ensure = json!({ "tabId": "term_svc", "options": { "cwd": temp_dir().as_path().to_string_lossy() } });
    let Reply::Value(ensured) = service.call(request("terminal/ensure", ensure, 1)).await.unwrap() else {
        panic!("terminal/ensure answers with a value");
    };
    let id = ensured["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("term_"));

    let Reply::Subscribe(sub) = service
        .call(request("terminal/attach", json!({ "tabId": id }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/attach answers with a subscription");
    };
    assert_eq!(sub.feed.feed_id().to_string(), format!("process:{id}"));
    until("the tab list section", || {
        publisher.published().iter().any(|(s, _, _)| *s == SectionName::TerminalTabs)
    })
    .await;

    service.call(request("terminal/dispose", json!({ "tabId": id }), 1)).await.unwrap();
    let gone = service.call(request("terminal/attach", json!({ "tabId": id }), 1)).await;
    assert!(gone.is_err(), "a disposed tab cannot be attached");
}
