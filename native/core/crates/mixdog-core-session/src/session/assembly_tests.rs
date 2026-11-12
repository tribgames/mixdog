//! The session's assembly constructors over real process services: thread feeds, approval ids,
//! the search and memory ingests and the Auto effort prewarm gate (the delete purge hooks are
//! tested against a recorded Node delete in `mixdog-core`'s `purge_populated_delete`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::seams::CloseIngest;
use super::testing::Rig;
use super::testing::lock;
use super::tests::start_thread;

/// Thread feeds take the core's wire limits (`ringBytes` 4 MiB, `maxSnapshotBytes` 3 MiB) and
/// serve a thread's subscription.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_feeds_take_the_wire_limits_and_serve_a_thread() {
    let limits = mixdog_app_protocol::limits::Limits::default();
    let feeds = super::CoreThreadFeeds::new(&limits, mixdog_rt::testing::tokens().cpu_interactive);
    assert_eq!((feeds.limits.ring_bytes, feeds.limits.max_snapshot_bytes), (4 << 20, 3 << 20));
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.feeds = Arc::new(feeds);
    let directory = super::SessionDirectory::new(Arc::new(deps));
    // `start_thread` asserts the subscription over the thread's feed.
    let handle = start_thread(&directory).await;
    assert!(handle.cell.view.load_full().items.is_empty());
}

/// Approval ids come from the `approval` counter of `state/core.sqlite`: increasing, and never
/// repeated across a reopen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_ids_increase_across_a_reopen() {
    use mixdog_core_base::approvals::ApprovalIds;
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("core.sqlite");
    let tokens = mixdog_rt::testing::tokens();
    let open = || mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &path).expect("state").0;
    let ids = mixdog_core_base::approvals::StoreApprovalIds::open(open()).await.expect("ids");
    let (a, b) = (ids.next().await.expect("id"), ids.next().await.expect("id"));
    assert!(a.0 < b.0, "{a:?} {b:?}");
    drop(ids);
    let ids = mixdog_core_base::approvals::StoreApprovalIds::open(open()).await.expect("ids");
    assert!(ids.next().await.expect("id").0 > b.0);
}

/// A completed turn reaches the search writer as its session and model context, agent-only when
/// the header says so (`isAgentOnlySession`).
#[test]
fn a_turn_reaches_session_search_with_its_visibility() {
    let id = ThreadId::from("sess_1");
    let header = |value: Value| value.as_object().cloned().expect("a header");
    let messages = vec![json!({ "role": "user", "content": "hi" })];
    let ordinary = super::store::search_session(&id, &header(json!({ "id": "sess_1" })), messages.clone());
    assert_eq!((ordinary.id.as_str(), ordinary.agent_only, ordinary.messages.len()), ("sess_1", false, 1));
    let hidden = super::store::search_session(&id, &header(json!({ "id": "sess_1", "visibility": "agent-only" })), messages);
    assert!(hidden.agent_only);
}

#[derive(Default)]
struct Memory(Mutex<Vec<Value>>);

#[async_trait]
impl mixdog_services::memory::service::MemoryModule for Memory {
    async fn memory(&self, args: Value) -> String {
        lock(&self.0).push(args);
        String::new()
    }
    async fn recall(&self, _: Value, _: &tokio_util::sync::CancellationToken) -> String {
        String::new()
    }
}

/// A closing session's model context goes to the memory module's `ingest_session`; with memory
/// off, or nothing to ingest, nothing is called.
#[tokio::test]
async fn a_closing_session_is_ingested_by_the_memory_module() {
    let memory = Arc::new(Memory::default());
    let sensitive = Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default());
    let ingest = super::MemoryCloseIngest::new(Some(memory.clone()), sensitive.clone());
    let messages = vec![json!({ "role": "user", "content": "hi" })];
    ingest.ingest(&ThreadId::from("sess_1"), "/ws", messages.clone()).await;
    ingest.ingest(&ThreadId::from("sess_2"), "/ws", Vec::new()).await;
    super::MemoryCloseIngest::new(None, sensitive).ingest(&ThreadId::from("sess_3"), "/ws", messages.clone()).await;
    assert_eq!(
        *lock(&memory.0),
        [json!({ "action": "ingest_session", "sessionId": "sess_1", "cwd": "/ws", "messages": messages })]
    );
}

/// What goes to memory carries the session's sensitive values redacted as Node redacts them
/// (`fixtures/tools/memory/sensitive/golden.json`), on every route that feeds memory: they all
/// go through this seam (unload, live feed, session switch).
#[tokio::test]
async fn memory_is_fed_with_the_sessions_sensitive_values_redacted() {
    let golden: Value =
        serde_json::from_str(include_str!("../../../../fixtures/tools/memory/sensitive/golden.json")).expect("golden");
    let sessions = golden["sessions"].as_array().expect("sessions");
    let session = sessions.iter().find(|s| !s["messages"].is_null()).expect("a recorded message redaction");
    let id = session["id"].as_str().expect("id");
    let sensitive = Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default());
    for s in sessions.iter().filter(|s| s["id"] == session["id"]) {
        sensitive.remember(id, s["calls"].as_array().map(Vec::as_slice).unwrap_or_default());
    }
    let memory = Arc::new(Memory::default());
    let ingest = super::MemoryCloseIngest::new(Some(memory.clone()), sensitive);
    let input = session["messages"]["input"].as_array().expect("input").clone();
    ingest.ingest(&ThreadId::from(id), "/ws", input).await;
    assert_eq!(lock(&memory.0)[0]["messages"], session["messages"]["output"]);
}

/// The real thread store opens over a data dir without a `sessions` folder and makes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_thread_store_opens_over_a_fresh_data_dir() {
    let data = tempfile::tempdir().expect("data dir");
    let _store = super::tests::real_store(data.path()).await;
    use mixdog_rt::LaneToken;
    let tokens = mixdog_rt::testing::tokens();
    let sessions = data.path().join("sessions");
    let meta = tokens
        .interactive_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &sessions))
        .expect("lane has room")
        .await
        .expect("job ran")
        .expect("sessions exists");
    assert!(meta.is_dir());
}

/// `autoEffortMode`: a set `MIXDOG_AUTO_EFFORT` wins (an unknown spelling is off), else the
/// `autoEffort` module of the agent config.
#[test]
fn auto_effort_mode_follows_the_env_then_the_config() {
    let no_env = |_: &str| None;
    let on = json!({ "modules": { "autoEffort": { "enabled": true } } }).as_object().cloned().unwrap();
    let off = json!({ "modules": { "autoEffort": { "enabled": false } } }).as_object().cloned().unwrap();
    let mode = super::effort_prewarm::auto_effort_mode;
    assert_eq!(mode(Some(" ON "), &off, &no_env), "on");
    assert_eq!(mode(Some("observe"), &off, &no_env), "observe");
    assert_eq!(mode(Some("sometimes"), &on, &no_env), "off");
    assert_eq!(mode(Some(""), &off, &no_env), "off");
    let supported = mixdog_services::tool_state::onnx_runtime_supported();
    assert_eq!(mode(None, &on, &no_env), if supported { "on" } else { "off" });
    let forced = |name: &str| (name == "MIXDOG_FEATURE_AUTO_EFFORT").then(|| "0".to_owned());
    assert_eq!(mode(None, &on, &forced), "off");
}
