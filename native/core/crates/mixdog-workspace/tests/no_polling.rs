#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
//! DS-WS-5: no polling. With a watch, a search session and a download open, the core runs no
//! lane job at all while nothing happens (a `stat` would be one), and an external write
//! reaches the subscriber as `fs/changed` within 400 ms. It counts the lane jobs the core starts (the
//! `count-jobs` feature), which must be exactly zero over the idle run. The default run idles 20 s;
//! the gate sets `MIXDOG_IDLE_SECS=600` for the full ten minutes.

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::feed::subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::Origin;
use mixdog_store::state::CoreState;
use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::service::Deps;
use mixdog_workspace::service::WorkspaceService;
use mixdog_workspace::zip::TrackedFiles;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use mixdog_workspace::lanes::idle_window_violation;
use mixdog_workspace::lanes::job_snapshot;

// The count is of lane jobs this crate started: the clippy ban on `std::fs` sends the crate's
// blocking file-system bodies to lane jobs, and each is submitted through `lanes::counted`. A
// file-system call from a thread outside a lane job (the notify backend's own watch thread, the
// store's writer thread) is not seen; see the report. Each reading is one atomic snapshot of
// started and running together.

struct NoGit;

#[async_trait::async_trait]
impl TrackedFiles for NoGit {
    async fn files(&self, _: &std::path::Path, _: &CancellationToken) -> Option<Vec<String>> {
        None
    }
    async fn ignored(&self, _: &std::path::Path, _: &CancellationToken) -> Option<u64> {
        None
    }
}

fn request(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new()) }
}

async fn idle_run(idle: Duration) {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(root.join("big.bin"), vec![7u8; 1 << 20]).unwrap();
    let limits = MockLimits::default();
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &base.join("core.sqlite")).unwrap();
    let service = WorkspaceService::new(Deps {
        lanes: Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk },
        feeds: Arc::new(MockScopedFeeds::new(limits)),
        processes: Arc::new(MockProcessManager::default()),
        tracked: Arc::new(NoGit),
        state,
        recovery_dir: base.join("recovery"),
        user_data_dir: base.join("userdata"),
        sources: Vec::new(),
        code_graph: None,
        turn_review: None,
    })
    .unwrap();
    service.catalog().add(&root.to_string_lossy(), &CancellationToken::new(), None).await.unwrap();
    let conn = MockConnection::new(ConnectionId(1), limits);

    let Reply::Subscribe(watch) = service
        .call(request("fs/watch", json!({ "watchId": "w", "path": root.to_string_lossy(), "recursive": true })))
        .await
        .unwrap()
    else {
        panic!("fs/watch subscribes")
    };
    let attached = subscribe(&watch.feed, SubscriptionId::from("s-fs"), watch.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    let Reply::Subscribe(search) =
        service.call(request("search/start", json!({ "sessionId": "q", "roots": [root.to_string_lossy()] }))).await.unwrap()
    else {
        panic!("search/start subscribes")
    };
    let attached = subscribe(&search.feed, SubscriptionId::from("s-search"), search.window, None, &conn).unwrap();
    conn.send_control_release(bytes::Bytes::from_static(b"ok"), attached.release).unwrap();
    service.call(request("search/update", json!({ "sessionId": "q", "query": "main" }))).await.unwrap();
    let Reply::Value(opened) = service
        .call(request("transfer/beginRead", json!({ "source": { "kind": "file", "root": root.to_string_lossy(), "rel": "big.bin" } })))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(opened["transferId"].is_string());

    // The editor is "open": everything above has settled. From here on nothing may run.
    tokio::time::sleep(Duration::from_secs(2)).await;
    conn.drain_text();
    // Calibration: a stat run through the crate's entry point shows in the counter, so a zero below
    // means something.
    let calibrate = job_snapshot();
    mixdog_workspace::lanes::run(tokens.interactive_io, &CancellationToken::new(), {
        let big = root.join("big.bin");
        move || std::fs::metadata(big)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(job_snapshot().started, calibrate.started + 1, "the counter cannot see a lane job");
    let open = job_snapshot();
    tokio::time::sleep(idle).await;
    let close = job_snapshot();
    if let Some(violation) = idle_window_violation(open, close) {
        panic!("{violation} over an idle window of {idle:?}: something polls");
    }
    assert!(conn.drain_text().is_empty(), "frames arrived while idle");

    // An external write is pushed, not found by a poll.
    let started = Instant::now();
    std::fs::write(root.join("src/main.rs"), "fn main() { /* edited */ }\n").unwrap();
    let latency = loop {
        if conn.drain_text().iter().any(|f| f.contains("fs/changed") && f.contains("main.rs")) {
            break started.elapsed();
        }
        assert!(started.elapsed() < Duration::from_secs(3), "no fs/changed after an external write");
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert!(latency <= Duration::from_millis(400), "fs/changed took {latency:?}");
    eprintln!("idle {idle:?}: 0 file-system jobs started; external write pushed after {latency:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_runs_while_idle_and_external_writes_are_pushed() {
    let seconds: u64 = std::env::var("MIXDOG_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    idle_run(Duration::from_secs(seconds)).await;
}
