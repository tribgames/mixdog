//! The session's assembly constructors over real process services: thread feeds, approval ids,
//! the search and memory ingests, the delete purge hooks and the Auto effort prewarm gate.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::RowUpdate;
use mixdog_agent::agent_tool::flow::seams::SessionNames;
use mixdog_agent::agent_tool::flow::seams::TurnListener;
use mixdog_agent::agent_tool::flow::seams::TurnSource;
use mixdog_agent::agent_tool::flow::seams::Unobserve;
use mixdog_agent::agent_tool::flow::seams::WorkerRows;
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::agent_registry::AgentRegistry;
use super::agent_registry::LiveSessions;
use super::agent_registry::ReapWindow;
use super::agent_registry::Row;
use super::agent_registry::WorkerStore;
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
    use crate::approvals::ApprovalIds;
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("core.sqlite");
    let tokens = mixdog_rt::testing::tokens();
    let open = || mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &path).expect("state").0;
    let ids = crate::approvals::StoreApprovalIds::open(open()).await.expect("ids");
    let (a, b) = (ids.next().await.expect("id"), ids.next().await.expect("id"));
    assert!(a.0 < b.0, "{a:?} {b:?}");
    drop(ids);
    let ids = crate::approvals::StoreApprovalIds::open(open()).await.expect("ids");
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
    async fn recall(&self, _: Value) -> String {
        String::new()
    }
}

/// A closing session's model context goes to the memory module's `ingest_session`; with memory
/// off, or nothing to ingest, nothing is called.
#[tokio::test]
async fn a_closing_session_is_ingested_by_the_memory_module() {
    let memory = Arc::new(Memory::default());
    let ingest = super::MemoryCloseIngest::new(Some(memory.clone()));
    let messages = vec![json!({ "role": "user", "content": "hi" })];
    ingest.ingest(&ThreadId::from("sess_1"), "/ws", messages.clone()).await;
    ingest.ingest(&ThreadId::from("sess_2"), "/ws", Vec::new()).await;
    super::MemoryCloseIngest::new(None).ingest(&ThreadId::from("sess_3"), "/ws", messages.clone()).await;
    assert_eq!(
        *lock(&memory.0),
        [json!({ "action": "ingest_session", "sessionId": "sess_1", "cwd": "/ws", "messages": messages })]
    );
}

/// The real thread store opens over a data dir without a `sessions` folder and makes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_thread_store_opens_over_a_fresh_data_dir() {
    let data = tempfile::tempdir().expect("data dir");
    let _store = super::tests::real_store(data.path()).await;
    assert!(data.path().join("sessions").is_dir());
}

struct NoTurns;
impl TurnSource for NoTurns {
    fn observe_session_turns(&self, _: &str, _: Arc<dyn TurnListener>) -> Option<Unobserve> {
        None
    }
}
impl SessionNames for NoTurns {
    fn tag_for_session(&self, _: &str) -> Option<String> {
        None
    }
    fn agent(&self, _: &str) -> Option<String> {
        None
    }
}
impl WorkerRows for NoTurns {
    fn upsert(&self, _: &str, _: Option<&str>, _: RowUpdate) {}
}
impl mixdog_agent::env::Clock for NoTurns {
    fn now_ms(&self) -> i64 {
        0
    }
}

/// The worker index of one deleted session's settled row.
#[derive(Default)]
struct Workers(Mutex<Vec<(String, Row)>>);

#[async_trait]
impl WorkerStore for Workers {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(lock(&self.0).clone())
    }
    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(Vec::new())
    }
    async fn header(&self, _: &str) -> Option<Row> {
        None
    }
    async fn is_directory(&self, _: &str) -> bool {
        false
    }
    fn write(&self, session: &str, worker: Option<Row>) {
        let mut maps = lock(&self.0);
        maps.retain(|(id, _)| id != session);
        if let Some(worker) = worker {
            maps.push((session.to_owned(), worker));
        }
    }
}

impl LiveSessions for Workers {
    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }
    fn header(&self, _: &str) -> Option<Row> {
        None
    }
    fn running(&self, _: &str) -> bool {
        false
    }
    fn has_live_work(&self, _: &str) -> bool {
        false
    }
    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

impl ReapWindow for Workers {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        3_600_000.0
    }
}

/// A provider registry with nothing registered (its release is `mixdog-ai`'s test).
struct NoProviders;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> bool {
        false
    }
}

#[allow(clippy::disallowed_methods, reason = "test setup writes the deleted session's files")]
fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("a parent")).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `_runSessionPurgeHooks` over the real owners: when it returns, the session's offloaded tool
/// results, its conversation transcripts under each known cwd, its connector account choices,
/// its worker row (a tombstone now), its compaction archive and its scratch folders are gone
/// (Node's hooks finish before the delete does); another session's stay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test reads what the hooks left")]
async fn the_purge_hooks_have_dropped_a_deleted_sessions_state_when_they_return() {
    let (data, home) = (tempfile::tempdir().expect("data"), tempfile::tempdir().expect("home"));
    let (d, h) = (data.path(), home.path());
    let id = "sess_gone";
    let cwd = d.join("ws").to_string_lossy().into_owned();
    let transcript = h.join("projects").join(super::purge::project_slug(&cwd)).join(format!("{id}.jsonl"));
    let offloaded = d.join("tool-results").join(id).join("call-1.txt");
    let scratch = mixdog_tools::exec::session_scratch_dir(d, id).expect("a scratch dir");
    let created = [
        offloaded.clone(),
        transcript.clone(),
        transcript.with_extension("jsonl.1"),
        d.join("sessions").join(format!("{id}.compaction-archive.jsonl")),
        scratch.join("note.txt"),
        d.join("scratch").join(id).join("old.txt"),
    ];
    for path in &created {
        write(path, "x");
    }
    let accounts = d.join("connector-accounts-by-conversation.json");
    write(&accounts, &json!({ id: { "accounts": { "gmail": "a" } }, "sess_kept": { "accounts": { "gmail": "b" } } }).to_string());
    let workers = Arc::new(Workers::default());
    let row = json!({ "tag": "w1", "sessionId": id, "agent": "worker", "status": "idle", "parentSessionId": "lead-a" });
    workers.write(id, Some(row.as_object().cloned().unwrap()));
    let agents = Arc::new(AgentRegistry::new(workers.clone(), workers.clone(), workers.clone(), Arc::new(super::SystemClock)));
    let turns = Arc::new(NoTurns);
    let hooks = super::delete::PurgeHooks::new(super::purge::PurgeOwners {
        data_dir: d.to_path_buf(),
        mixdog_home: h.to_path_buf(),
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        read_state: Arc::new(mixdog_tools::fs::ReadState::new(None)),
        warm: mixdog_ai::registry::warm::WarmLedger::new(),
        providers: Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders))),
        worker_turns: WorkerTurns::new(turns.clone(), turns.clone(), turns.clone(), turns, Arc::new(|| {})),
        agents,
    });
    let rig = Rig::new();
    let review = rig.deps_parts(rig.store.clone()).turn_review;
    hooks.run(review.as_ref(), id, &[cwd]).await;

    let left: Vec<_> = created.iter().filter(|path| path.exists()).collect();
    assert!(left.is_empty(), "{left:?}");
    assert!(!offloaded.parent().unwrap().exists() && !scratch.exists());
    let accounts: Value = serde_json::from_str(&std::fs::read_to_string(&accounts).unwrap()).unwrap();
    assert_eq!(accounts, json!({ "sess_kept": { "accounts": { "gmail": "b" } } }));
    let tombstoned = lock(&workers.0).iter().find(|(s, _)| s == id).map(|(_, m)| m.clone()).expect("the row");
    assert!(tombstoned.contains_key("tombstone") && !tombstoned.contains_key("sessionId"), "{tombstoned:?}");
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
