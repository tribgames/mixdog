//! The `process`, `terminal` and `system` domain services over real processes, a mock scoped-feed
//! factory and a mock section publisher.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

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

async fn until(_what: &str, mut ok: impl FnMut() -> bool) {
    while !ok() {
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
async fn process_stdin_input_and_pty_resize_reach_the_process() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = ProcessService::new(manager.clone(), feeds);
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();

    // `sort` reads stdin to its end: one chunk by `process/input`, one by `process/writeStdin`
    // that also closes stdin; the sorted result proves both arrived.
    let sorter = handle("svc-stdin");
    let params = json!({ "processHandle": sorter, "argv": ["sort"], "cwd": cwd, "owner": "internal" });
    service.call(request("process/spawn", params, 1)).await.unwrap();
    service.notify(
        Method("process/input"),
        json!({ "processHandle": sorter, "bytesB64": STANDARD.encode("b\r\n") }),
        ConnectionId(1),
    );
    let write = json!({ "processHandle": sorter, "bytesB64": STANDARD.encode("a\r\n"), "closeStdin": true });
    service.call(request("process/writeStdin", write, 1)).await.unwrap();
    let (output, _) = collect(&manager, &sorter).await;
    let lines: Vec<String> = text(&output).lines().map(str::to_owned).collect();
    assert_eq!(lines, ["a", "b"]);
    // A pipe has no size to change.
    let resize = json!({ "processHandle": sorter, "cols": 90, "rows": 30 });
    assert!(service.call(request("process/resizePty", resize, 1)).await.is_err());

    // A PTY process takes the new size.
    let long = if cfg!(windows) { json!(["ping", "-n", "60", "127.0.0.1"]) } else { json!(["sleep", "60"]) };
    let tty = handle("svc-pty");
    let params = json!({ "processHandle": tty, "argv": long, "cwd": cwd, "owner": "internal", "pty": { "cols": 80, "rows": 24 } });
    service.call(request("process/spawn", params, 1)).await.unwrap();
    let resize = json!({ "processHandle": tty, "cols": 120, "rows": 40 });
    service.call(request("process/resizePty", resize, 1)).await.unwrap();
    service.call(request("process/kill", json!({ "processHandle": tty }), 1)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_size_is_owned_by_the_focusing_connection_and_output_can_pause() {
    let manager = manager();
    let feeds = ProcessFeeds::new(manager.clone(), scoped());
    let service = TerminalService::new(manager, feeds, Arc::new(MockStatePublisher::default()), TerminalServiceConfig::default());
    let cwd = temp_dir().as_path().to_string_lossy().into_owned();
    let Reply::Value(ensured) = service
        .call(request("terminal/ensure", json!({ "tabId": "term_own", "options": { "cwd": cwd } }), 1))
        .await
        .unwrap()
    else {
        panic!("terminal/ensure answers with a value");
    };
    let id = ensured["id"].as_str().unwrap().to_owned();
    let attach = |connection: u64| {
        let service = Arc::clone(&service);
        let id = id.clone();
        async move {
            let Reply::Subscribe(sub) = service.call(request("terminal/attach", json!({ "tabId": id }), connection)).await.unwrap() else {
                panic!("terminal/attach answers with a subscription");
            };
            sub.result["sizeOwner"].clone()
        }
    };
    assert_eq!(attach(1).await, Value::Null, "nobody has focused yet");

    service.call(request("terminal/focus", json!({ "tabId": id }), 1)).await.unwrap();
    assert_eq!(attach(1).await["own"], json!(true));
    assert_eq!(attach(2).await["own"], json!(false));

    // Only the owner's resize applies.
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 100, "rows": 30 }), ConnectionId(2));
    let before = attach(1).await;
    service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 100, "rows": 30 }), ConnectionId(1));
    let after = attach(1).await;
    assert_ne!(before["cols"], json!(100), "a non-owner's resize is ignored");
    assert_eq!((after["cols"].clone(), after["rows"].clone()), (json!(100), json!(30)));

    // The owner's connection closes: ownership ends.
    service.connection_closed(ConnectionId(1));
    assert_eq!(attach(2).await, Value::Null);

    for method in ["terminal/pause", "terminal/resume"] {
        let reply = service.call(request(method, json!({ "tabId": id }), 2)).await.unwrap();
        assert!(matches!(reply, Reply::Value(ref v) if v == &json!({})), "{method} answers with an empty result");
    }
    service.call(request("terminal/dispose", json!({ "tabId": id }), 2)).await.unwrap();
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
